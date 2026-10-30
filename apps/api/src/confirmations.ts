import { createHash, randomUUID } from 'node:crypto';
import { IdentityProviderError, type Authenticator, type GateIdentity } from '@memory/auth';
import {
  changeSetSchema,
  connectorAuthorizationSchema,
  CoreError,
  databaseCompartments,
  forgetRequestSchema,
  grantMutationSchema,
  retentionPolicySchema,
  reviewDecisionSchema,
  sourceRightsSchema,
  type ActorContext,
  type ChangeOp,
} from '@memory/contracts';
import { setDatabaseContext, withTransaction } from '@memory/db';
import { withAuthorizedActor, type CompartmentService, type CoreService } from '@memory/domain';
import type { ConnectorService } from '@memory/connectors';
import type { ForgetService } from '@memory/governance';
import type { CurationReviewService } from '@memory/jobs';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

/**
 * A change only the User may make. Another actor's request is approved by its binding's policy:
 * at once and recorded as a policy approval, or by the person through a Gate confirmation.
 */
export type ProtectedChange =
  | { readonly operation: 'commit_changeset'; readonly changesetId: string }
  | { readonly operation: 'forget'; readonly request: unknown }
  | { readonly operation: 'decide_review'; readonly reviewId: string; readonly decision: unknown }
  | {
      readonly operation: 'change_source_rights';
      readonly sourceId: string;
      readonly request: unknown;
    }
  | {
      readonly operation: 'change_scope_grant';
      readonly scopeId: string;
      readonly request: unknown;
    }
  | {
      readonly operation: 'set_retention_policy';
      readonly scopeId: string;
      readonly request: unknown;
    }
  | { readonly operation: 'configure_source'; readonly request: unknown }
  | { readonly operation: 'change_connection_allowance'; readonly request: unknown };

type Operation = ProtectedChange['operation'];

export interface ProtectedChangeResult {
  readonly result: unknown;
  /** True when the change waits for the person's approval at Gate instead of running now. */
  readonly confirmationRequired: boolean;
}

export interface ChangeConfirmationOptions {
  readonly pool: Pool;
  readonly core: CoreService;
  readonly governance?: ForgetService;
  readonly reviews?: CurationReviewService;
  readonly connectors?: ConnectorService;
  readonly compartments?: CompartmentService;
}

interface Summary {
  readonly title: string;
  readonly lines: readonly string[];
}

interface PreparedChange {
  readonly scopeId: string;
  readonly payload: Record<string, unknown>;
  readonly summary: Summary;
  readonly memoryIds: readonly string[];
  /**
   * The union of the labels of what the summary shows, so a connection that cannot see that
   * data cannot read the record either.
   */
  readonly label: readonly string[];
}

interface ConfirmationRow {
  readonly id: string;
  readonly scope_id: string;
  readonly gate_subject: string;
  readonly connection_id: string;
  readonly gate_audience: string;
  readonly operation: Operation;
  readonly payload: Record<string, unknown> | null;
  readonly summary: Summary | null;
  readonly change_hash: string;
  readonly request_hash: string;
  readonly memory_ids: string[];
  readonly idempotency_key: string;
  /** Who approved the change: the person at Gate, or the binding's approval policy. */
  readonly approval: 'person' | 'policy';
  readonly gate_confirmation_id: string | null;
  readonly gate_url: string | null;
  readonly status:
    'pending' | 'approved' | 'committed' | 'denied' | 'expired' | 'cancelled' | 'failed';
  readonly response: unknown;
}

type MemoryInput = Extract<ChangeOp, { op: 'CREATE' }>['memory'];
type Evidence = MemoryInput['evidence'];

const COLUMNS = `id, scope_id, gate_subject, connection_id, gate_audience, operation, payload, summary,
  change_hash, request_hash, memory_ids, idempotency_key, approval, gate_confirmation_id, gate_url,
  status, response`;
const TITLE_LIMIT = 120;
const LINE_LIMIT = 64;
const CHARACTER_LIMIT = 4000;
const uuid = z.uuid();

export class ChangeConfirmationService {
  constructor(private readonly options: ChangeConfirmationOptions) {}

  /** Runs a protected change for the User, approves it by policy, or asks the person at Gate. */
  async run(
    auth: Authenticator,
    actor: ActorContext,
    change: ProtectedChange,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<ProtectedChangeResult> {
    if (actor.actorKind === 'user') {
      if (change.operation === 'change_connection_allowance') {
        throw new CoreError(400, 'connection_required', 'Only an AI connection has an allowance');
      }
      const result = await this.apply(actor, change.operation, directPayload(change), {
        idempotencyKey,
        requestId,
      });
      if (change.operation === 'forget') {
        const request = forgetRequestSchema.safeParse(change.request);
        if (request.success) {
          await this.cancelAtGate(
            auth,
            actor,
            request.data.scope_id,
            request.data.selector.memory_ids ?? [],
          );
        }
      }
      return { result, confirmationRequired: false };
    }
    const identity = auth.gateIdentity(actor);
    if (identity === undefined) {
      throw new CoreError(403, 'user_required', 'Only the User may make this change');
    }
    if (identity.approvalPolicy === 'auto') {
      return this.approveByPolicy(auth, actor, identity, change, idempotencyKey, requestId);
    }
    return {
      result: await this.request(auth, actor, identity, change, idempotencyKey),
      confirmationRequired: true,
    };
  }

  async get(actor: ActorContext, confirmationId: string): Promise<Record<string, unknown>> {
    return view(await this.load(actor, confirmationId));
  }

  /**
   * Applies an approved confirmation once. The Gate approval is consumed first, together with
   * the local transition to `approved`; the change then runs as the User under an idempotency key
   * derived from the confirmation, so a retry after a failure never needs a second approval.
   */
  async complete(
    auth: Authenticator,
    actor: ActorContext,
    confirmationId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    let row = await this.load(actor, confirmationId);
    if (row.status === 'pending' || row.status === 'approved') {
      if (row.gate_audience !== auth.audience) {
        throw new CoreError(
          409,
          'confirmation_endpoint_mismatch',
          'Complete this confirmation through the endpoint that requested it',
        );
      }
    }
    if (row.status === 'pending') {
      row = await this.consume(auth, actor, row);
      if (row.status !== 'approved') return view(row);
    }
    if (row.status !== 'approved') return view(row);
    return view(await this.applyApproved(auth, actor, row, requestId));
  }

  /**
   * Applies an approved change once as the User, under an idempotency key derived from the record,
   * so a retry after a failure applies it at most once. A permanent failure resolves it as failed.
   */
  private async applyApproved(
    auth: Authenticator,
    actor: ActorContext,
    row: ConfirmationRow,
    requestId: string,
  ): Promise<ConfirmationRow> {
    const userActor = await auth.userActorFor(actor);
    let result: unknown;
    try {
      await this.assertUnchanged(userActor, row);
      result = await this.apply(userActor, row.operation, row.payload!, {
        idempotencyKey: `confirmation:${row.id}`,
        requestId,
        confirmation: { id: row.id, approval: row.approval },
      });
    } catch (error) {
      if (error instanceof CoreError && isPermanent(error)) {
        return this.resolve(actor, row, 'failed', {
          error: { code: error.code, message: error.message },
        });
      }
      throw error;
    }
    if (row.operation === 'forget') {
      await this.cancelAtGate(auth, actor, row.scope_id, row.memory_ids);
    }
    return this.resolve(actor, row, 'committed', result);
  }

  /**
   * Applies a protected change that the binding's policy approves without asking the person. The
   * record names the requesting connection and that the policy, not the person, approved it. The
   * response is the change's own result with that approval attached.
   */
  private async approveByPolicy(
    auth: Authenticator,
    actor: ActorContext,
    identity: GateIdentity,
    change: ProtectedChange,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<ProtectedChangeResult> {
    const prepared = await this.prepare(actor, change, identity);
    const requestHash = sha256(
      canonical({ operation: change.operation, payload: prepared.payload }),
    );
    // Without a client key every request is new, as it is for the User's direct changes.
    const key = idempotencyKey ?? `policy:${randomUUID()}`;
    let row = await withAuthorizedActor(
      this.options.pool,
      actor,
      [prepared.scopeId],
      'write',
      async (client) => {
        const existing = await client.query<ConfirmationRow>(
          `SELECT ${COLUMNS} FROM change_confirmations
           WHERE user_id = $1 AND requested_by = $2 AND idempotency_key = $3`,
          [actor.userId, actor.principalId, key],
        );
        const found = existing.rows[0];
        if (found !== undefined) {
          if (found.request_hash !== requestHash) throw keyReused();
          return found;
        }
        const id = randomUUID();
        const inserted = await client.query<ConfirmationRow>(
          `INSERT INTO change_confirmations(user_id, scope_id, id, requested_by, gate_subject,
             client_id, connection_id, gate_audience, operation, payload, summary, change_hash,
             request_hash, memory_ids, idempotency_key, approval, status, approved_at, compartment_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13,
             $14::uuid[], $15, 'policy', 'approved', clock_timestamp(), $16::uuid[])
           RETURNING ${COLUMNS}`,
          [
            actor.userId,
            prepared.scopeId,
            id,
            actor.principalId,
            identity.subject,
            identity.clientId,
            identity.connectionId,
            auth.audience,
            change.operation,
            JSON.stringify(prepared.payload),
            JSON.stringify(prepared.summary),
            changeHashOf(id, actor, prepared, change.operation),
            requestHash,
            prepared.memoryIds,
            key,
            prepared.label,
          ],
        );
        return inserted.rows[0]!;
      },
    );
    if (row.approval === 'person') {
      // The key was used for a Gate request made while the binding asked the person.
      return {
        result: { status: 'confirmation_required', confirmation: view(row) },
        confirmationRequired: row.status === 'pending',
      };
    }
    if (row.status === 'approved') row = await this.applyApproved(auth, actor, row, requestId);
    if (row.status === 'failed') {
      const failure = (row.response as { error?: { code?: string; message?: string } } | null)
        ?.error;
      throw new CoreError(
        409,
        failure?.code ?? 'change_failed',
        failure?.message ?? 'The change could not be applied',
      );
    }
    return { result: withPolicyApproval(row), confirmationRequired: false };
  }

  private async request(
    auth: Authenticator,
    actor: ActorContext,
    identity: GateIdentity,
    change: ProtectedChange,
    idempotencyKey: string | undefined,
  ): Promise<Record<string, unknown>> {
    const prepared = await this.prepare(actor, change, identity);
    const requestHash = sha256(
      canonical({ operation: change.operation, payload: prepared.payload }),
    );
    const key = idempotencyKey ?? `request:${requestHash}`;
    const row = await withAuthorizedActor(
      this.options.pool,
      actor,
      [prepared.scopeId],
      'write',
      async (client) => {
        const existing = await client.query<ConfirmationRow>(
          `SELECT ${COLUMNS} FROM change_confirmations
           WHERE user_id = $1 AND requested_by = $2
             AND (idempotency_key = $3 OR (status = 'pending' AND request_hash = $4))
           ORDER BY (idempotency_key = $3) DESC LIMIT 1`,
          [actor.userId, actor.principalId, key, requestHash],
        );
        const found = existing.rows[0];
        if (found !== undefined) {
          if (found.idempotency_key === key && found.request_hash !== requestHash)
            throw keyReused();
          return found;
        }
        const id = randomUUID();
        const changeHash = changeHashOf(id, actor, prepared, change.operation);
        let created: { id: string; url: string };
        try {
          created = await auth.confirmations.create({
            subject: identity.subject,
            connectionId: identity.connectionId,
            reference: id,
            changeHash,
            summary: prepared.summary,
          });
        } catch (error) {
          throw gateFailure(error);
        }
        try {
          const inserted = await client.query<ConfirmationRow>(
            `INSERT INTO change_confirmations(user_id, scope_id, id, requested_by, gate_subject,
               client_id, connection_id, gate_audience, operation, payload, summary, change_hash,
               request_hash, memory_ids, idempotency_key, gate_confirmation_id, gate_url, status,
               compartment_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13,
               $14::uuid[], $15, $16, $17, 'pending', $18::uuid[])
             RETURNING ${COLUMNS}`,
            [
              actor.userId,
              prepared.scopeId,
              id,
              actor.principalId,
              identity.subject,
              identity.clientId,
              identity.connectionId,
              auth.audience,
              change.operation,
              JSON.stringify(prepared.payload),
              JSON.stringify(prepared.summary),
              changeHash,
              requestHash,
              prepared.memoryIds,
              key,
              created.id,
              created.url,
              prepared.label,
            ],
          );
          return inserted.rows[0]!;
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw keyReused();
          throw error;
        }
      },
    );
    return { status: 'confirmation_required', confirmation: view(row) };
  }

  private async consume(
    auth: Authenticator,
    actor: ActorContext,
    row: ConfirmationRow,
  ): Promise<ConfirmationRow> {
    return withAuthorizedActor(
      this.options.pool,
      actor,
      [row.scope_id],
      'write',
      async (client) => {
        const locked = await client.query<ConfirmationRow>(
          `SELECT ${COLUMNS} FROM change_confirmations
         WHERE user_id = $1 AND scope_id = $2 AND id = $3 FOR UPDATE`,
          [actor.userId, row.scope_id, row.id],
        );
        const current = locked.rows[0];
        if (current === undefined) throw notFound();
        // Only a confirmation the person approves at Gate is ever pending.
        if (current.status !== 'pending' || current.gate_confirmation_id === null) return current;
        const gateConfirmationId = current.gate_confirmation_id;
        let result: Awaited<ReturnType<Authenticator['confirmations']['consume']>>;
        try {
          result = await auth.confirmations.consume(
            gateConfirmationId,
            current.id,
            current.change_hash,
          );
        } catch (error) {
          throw gateFailure(error);
        }
        if (result.status === 'pending') return current;
        if (result.status === 'consumed') {
          if (
            result.subject !== current.gate_subject ||
            result.connectionId !== current.connection_id
          ) {
            return update(client, actor, current, 'failed', {
              error: {
                code: 'confirmation_mismatch',
                message: 'Gate approved a different request',
              },
            });
          }
          const approved = await client.query<ConfirmationRow>(
            `UPDATE change_confirmations SET status = 'approved', approved_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND status = 'pending'
           RETURNING ${COLUMNS}`,
            [actor.userId, current.scope_id, current.id],
          );
          return approved.rows[0]!;
        }
        return update(
          client,
          actor,
          current,
          result.status === 'denied' ? 'denied' : 'expired',
          null,
        );
      },
    );
  }

  /**
   * Records the outcome of a change that was already authorized and applied. Forget advances the
   * scope's authorization epoch, so this runs under row-level security without re-checking grants.
   */
  private record<T>(
    actor: ActorContext,
    scopeId: string,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.options.pool, async (client) => {
      await setDatabaseContext(client, {
        userId: actor.userId,
        principalId: actor.principalId,
        scopeIds: [scopeId],
        compartments: databaseCompartments(actor.compartments),
      });
      return run(client);
    });
  }

  private async resolve(
    actor: ActorContext,
    row: ConfirmationRow,
    status: 'committed' | 'failed',
    response: unknown,
  ): Promise<ConfirmationRow> {
    return this.record(actor, row.scope_id, async (client) => {
      const resolved = await client.query<ConfirmationRow>(
        `UPDATE change_confirmations
         SET status = $4, response = $5::jsonb, resolved_at = clock_timestamp(),
           payload = NULL, summary = NULL
         WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND status = 'approved'
         RETURNING ${COLUMNS}`,
        [actor.userId, row.scope_id, row.id, status, JSON.stringify(response)],
      );
      if (resolved.rows[0] !== undefined) return resolved.rows[0];
      const current = await client.query<ConfirmationRow>(
        `SELECT ${COLUMNS} FROM change_confirmations WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, row.scope_id, row.id],
      );
      if (current.rows[0] === undefined) throw notFound();
      return current.rows[0];
    });
  }

  private async load(actor: ActorContext, confirmationId: string): Promise<ConfirmationRow> {
    if (!uuid.safeParse(confirmationId).success) throw notFound();
    const row = await withAuthorizedActor(
      this.options.pool,
      actor,
      actor.scopeIds,
      'read',
      async (client) =>
        (
          await client.query<ConfirmationRow>(
            `SELECT ${COLUMNS} FROM change_confirmations WHERE user_id = $1 AND id = $2`,
            [actor.userId, confirmationId],
          )
        ).rows[0],
    );
    if (row === undefined) throw notFound();
    return row;
  }

  /** Refuses to apply a change whose shown state moved after the person saw it. */
  private async assertUnchanged(actor: ActorContext, row: ConfirmationRow): Promise<void> {
    const payload = row.payload!;
    const stale = await withAuthorizedActor(
      this.options.pool,
      actor,
      [row.scope_id],
      'read',
      async (client) => {
        if (row.operation === 'commit_changeset') {
          const current = await client.query<{ proposal_hash: string | null; status: string }>(
            'SELECT proposal_hash, status FROM changesets WHERE user_id = $1 AND scope_id = $2 AND id = $3',
            [actor.userId, row.scope_id, payload['changeset_id']],
          );
          const changeset = current.rows[0];
          return (
            changeset !== undefined &&
            changeset.status === 'proposed' &&
            changeset.proposal_hash !== payload['proposal_hash']
          );
        }
        const revisions = payload['revisions'] as Record<string, number> | undefined;
        if (revisions !== undefined && Object.keys(revisions).length > 0) {
          const current = await client.query<{ id: string; revision: number }>(
            'SELECT id, revision FROM memories WHERE user_id = $1 AND scope_id = $2 AND id = ANY($3::uuid[])',
            [actor.userId, row.scope_id, Object.keys(revisions)],
          );
          return current.rows.some((memory) => revisions[memory.id] !== memory.revision);
        }
        return false;
      },
    );
    if (stale) {
      throw new CoreError(
        409,
        'confirmation_stale',
        'The data shown for approval changed afterwards; request the change again',
      );
    }
  }

  /**
   * After a Forget, withdraws at Gate the confirmations the suppression trigger just cancelled,
   * so their summaries leave Gate too. Best effort: Gate also drops a summary once the requesting
   * connection ends, and only confirmations created through this endpoint can be cancelled here.
   */
  private async cancelAtGate(
    auth: Authenticator,
    actor: ActorContext,
    scopeId: string,
    memoryIds: readonly string[],
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    const cancelled = await this.record(
      actor,
      scopeId,
      async (client) =>
        (
          await client.query<{ id: string; gate_confirmation_id: string }>(
            `SELECT id, gate_confirmation_id FROM change_confirmations
             WHERE user_id = $1 AND scope_id = $2 AND status = 'cancelled' AND approval = 'person'
               AND gate_audience = $3
               AND memory_ids && $4::uuid[] AND resolved_at > clock_timestamp() - interval '5 minutes'`,
            [actor.userId, scopeId, auth.audience, memoryIds],
          )
        ).rows,
    );
    await Promise.allSettled(
      cancelled.map((item) => auth.confirmations.cancel(item.gate_confirmation_id, item.id)),
    );
  }

  private async apply(
    actor: ActorContext,
    operation: Operation,
    payload: Record<string, unknown>,
    context: {
      readonly idempotencyKey: string | undefined;
      readonly requestId: string;
      readonly confirmation?: { readonly id: string; readonly approval: 'person' | 'policy' };
    },
  ): Promise<unknown> {
    const key = () => {
      if (context.idempotencyKey === undefined) {
        throw new CoreError(400, 'invalid_request', 'An idempotency key is required');
      }
      return context.idempotencyKey;
    };
    switch (operation) {
      case 'commit_changeset':
        return this.options.core.commitProposedChangeSet(
          actor,
          String(payload['changeset_id']),
          context.requestId,
          key(),
        );
      case 'forget':
        return this.governance().forget(actor, payload['request'], key());
      case 'decide_review':
        return this.reviews().decide(
          actor,
          String(payload['review_id']),
          payload['decision'],
          context.requestId,
          key(),
        );
      case 'change_source_rights':
        return this.governance().updateSourceRights(
          actor,
          String(payload['source_id']),
          payload['request'],
        );
      case 'change_scope_grant':
        return this.governance().mutateGrant(
          actor,
          String(payload['scope_id']),
          payload['request'],
        );
      case 'set_retention_policy':
        return this.governance().updateRetention(
          actor,
          String(payload['scope_id']),
          payload['request'],
        );
      case 'configure_source':
        return this.connectors().configure(actor, payload['request']);
      case 'change_connection_allowance': {
        if (context.confirmation === undefined) {
          throw new CoreError(400, 'connection_required', 'Only an AI connection has an allowance');
        }
        const connection = payload['connection'] as Record<string, string>;
        return this.compartmentService().widenAccess(
          actor,
          {
            issuer: String(connection['issuer']),
            subject: String(connection['subject']),
            connectionId: String(connection['connection_id']),
            clientId: String(connection['client_id']),
          },
          (payload['compartments'] as { id: string }[]).map((compartment) => compartment.id),
          { by: context.confirmation.approval, confirmationId: context.confirmation.id },
        );
      }
    }
  }

  private async prepare(
    actor: ActorContext,
    change: ProtectedChange,
    identity: GateIdentity,
  ): Promise<PreparedChange> {
    const prepared = await this.prepareOperation(actor, change, identity);
    const label = await this.read(actor, [prepared.scopeId], (client) =>
      shownLabel(client, actor, change.operation, prepared),
    );
    return { ...prepared, label };
  }

  private async prepareOperation(
    actor: ActorContext,
    change: ProtectedChange,
    identity: GateIdentity,
  ): Promise<Omit<PreparedChange, 'label'>> {
    switch (change.operation) {
      case 'commit_changeset':
        return this.prepareCommit(actor, change.changesetId);
      case 'forget':
        return this.prepareForget(actor, change.request);
      case 'decide_review':
        return this.prepareReview(actor, change.reviewId, change.decision);
      case 'change_source_rights':
        return this.prepareSourceRights(actor, change.sourceId, change.request);
      case 'change_scope_grant':
        return this.prepareGrant(actor, change.scopeId, change.request);
      case 'set_retention_policy':
        return this.prepareRetention(actor, change.scopeId, change.request);
      case 'configure_source':
        return this.prepareSource(actor, change.request);
      case 'change_connection_allowance':
        return this.prepareAllowance(actor, identity, change.request);
    }
  }

  private async prepareAllowance(
    actor: ActorContext,
    identity: GateIdentity,
    raw: unknown,
  ): Promise<Omit<PreparedChange, 'label'>> {
    const requested = await this.compartmentService().resolveRequestedCompartments(actor, raw);
    const current = actor.compartments.kind === 'allowance' ? actor.compartments.ids : [];
    const added = requested
      .filter((compartment) => !current.includes(compartment.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (added.length === 0) {
      throw new CoreError(
        409,
        'already_allowed',
        'This connection already receives these compartments',
      );
    }
    const scopeId = [...actor.scopeIds.filter((id) => actor.tokenScopeIds.includes(id))].sort()[0];
    if (scopeId === undefined)
      throw new CoreError(403, 'forbidden', 'An authorized scope is required');
    return {
      scopeId,
      payload: {
        connection: {
          issuer: identity.issuer,
          subject: identity.subject,
          connection_id: identity.connectionId,
          client_id: identity.clientId,
        },
        compartments: added,
      },
      summary: checkedSummary('Let an AI connection receive more memories', [
        ...labelled('AI client: ', identity.clientId),
        ...labelled('Add compartments: ', added.map((compartment) => compartment.name).join(', ')),
        'This connection will receive, and may write, memories in these compartments until it is disconnected at Gate or narrows its access.',
      ]),
      memoryIds: [],
    };
  }

  private async prepareCommit(
    actor: ActorContext,
    changesetId: string,
  ): Promise<Omit<PreparedChange, 'label'>> {
    if (!uuid.safeParse(changesetId).success) throw notFound('ChangeSet not found');
    return this.read(actor, actor.scopeIds, async (client) => {
      const found = await client.query<{
        scope_id: string;
        status: string;
        proposal: unknown;
        proposal_hash: string | null;
        held: boolean;
      }>(
        `SELECT c.scope_id, c.status, c.proposal, c.proposal_hash,
           EXISTS (SELECT 1 FROM curation_reviews r WHERE r.user_id = c.user_id
             AND r.scope_id = c.scope_id AND r.change_set_id = c.id AND r.status = 'held') AS held
         FROM changesets c WHERE c.user_id = $1 AND c.id = $2`,
        [actor.userId, changesetId],
      );
      const changeset = found.rows[0];
      if (changeset === undefined) throw notFound('ChangeSet not found');
      if (changeset.held) {
        throw new CoreError(
          409,
          'user_review_required',
          'This ChangeSet must be decided through its User review',
        );
      }
      const proposal = changeSetSchema.safeParse(changeset.proposal);
      if (
        changeset.status !== 'proposed' ||
        !proposal.success ||
        changeset.proposal_hash === null
      ) {
        throw new CoreError(409, 'changeset_not_committable', 'ChangeSet is not awaiting commit');
      }
      const targets = await memoryTargets(
        client,
        actor,
        changeset.scope_id,
        proposal.data.operations,
      );
      const lines = [
        ...(await scopeLine(client, actor, changeset.scope_id)),
        'Recorded with your authority, except items marked proposed',
        ...proposal.data.operations.flatMap((op, index) => changeLines(op, index, targets)),
      ];
      return {
        scopeId: changeset.scope_id,
        payload: { changeset_id: changesetId, proposal_hash: changeset.proposal_hash },
        summary: checkedSummary(
          `Apply ${proposal.data.operations.length === 1 ? 'a change' : `${proposal.data.operations.length} changes`} with your authority`,
          lines,
        ),
        memoryIds: [...targets.keys()],
      };
    });
  }

  private async prepareForget(
    actor: ActorContext,
    raw: unknown,
  ): Promise<Omit<PreparedChange, 'label'>> {
    const request = parse(forgetRequestSchema, raw, 'Forget request is invalid');
    const memoryIds = request.selector.memory_ids ?? [];
    const sourceIds = request.selector.source_ids ?? [];
    const subjectIds = request.selector.subject_ids ?? [];
    return this.read(actor, [request.scope_id], async (client) => {
      const memories = await client.query<{
        id: string;
        kind: string;
        statement: string;
        revision: number;
      }>(
        'SELECT id, kind, statement, revision FROM memories WHERE user_id = $1 AND scope_id = $2 AND id = ANY($3::uuid[]) ORDER BY id',
        [actor.userId, request.scope_id, memoryIds],
      );
      const sources = await client.query<{ id: string; kind: string; external_id: string }>(
        'SELECT id, kind, external_id FROM sources WHERE user_id = $1 AND scope_id = $2 AND id = ANY($3::uuid[]) ORDER BY id',
        [actor.userId, request.scope_id, sourceIds],
      );
      const subjects = await client.query<{ id: string; canonical_name: string }>(
        'SELECT id, canonical_name FROM subjects WHERE user_id = $1 AND scope_id = $2 AND id = ANY($3::uuid[]) ORDER BY id',
        [actor.userId, request.scope_id, subjectIds],
      );
      const found = new Set(memories.rows.map((memory) => memory.id));
      const lines = [
        ...(await scopeLine(client, actor, request.scope_id)),
        ...memories.rows.flatMap((memory) =>
          labelled(`Memory (${memory.kind}): `, memory.statement),
        ),
        ...memoryIds.filter((id) => !found.has(id)).map((id) => `Memory not found: ${id}`),
        ...sources.rows.flatMap((source) =>
          labelled('Every memory from source: ', `${source.kind} ${source.external_id}`),
        ),
        ...subjects.rows.flatMap((subject) =>
          labelled('Every memory about: ', subject.canonical_name),
        ),
        `Reason: ${request.reason_code.replaceAll('_', ' ')}`,
        'Hidden from recall immediately',
        'Permanently deleted from storage and backups later',
        'This cannot be undone',
      ];
      return {
        scopeId: request.scope_id,
        payload: {
          request,
          revisions: Object.fromEntries(
            memories.rows.map((memory) => [memory.id, memory.revision]),
          ),
        },
        summary: checkedSummary('Forget memories', lines),
        memoryIds,
      };
    });
  }

  private async prepareReview(
    actor: ActorContext,
    reviewId: string,
    rawDecision: unknown,
  ): Promise<Omit<PreparedChange, 'label'>> {
    if (!uuid.safeParse(reviewId).success) throw notFound('Review not found');
    const decision = parse(reviewDecisionSchema, rawDecision, 'Review decision is invalid');
    return this.read(actor, actor.scopeIds, async (client) => {
      const found = await client.query<{
        scope_id: string;
        status: string;
        reason_codes: string[];
        rationale: string;
        proposal: unknown;
      }>(
        `SELECT r.scope_id, r.status, r.reason_codes, r.rationale, c.proposal
         FROM curation_reviews r JOIN changesets c
           ON c.user_id = r.user_id AND c.scope_id = r.scope_id AND c.id = r.change_set_id
         WHERE r.user_id = $1 AND r.id = $2`,
        [actor.userId, reviewId],
      );
      const review = found.rows[0];
      if (review === undefined) throw notFound('Review not found');
      if (review.status !== 'held') {
        throw new CoreError(
          409,
          'review_not_held',
          'The review is no longer waiting for a decision',
        );
      }
      const proposal = changeSetSchema.safeParse(review.proposal);
      const operations = proposal.success ? proposal.data.operations : [];
      const targets = await memoryTargets(client, actor, review.scope_id, operations);
      const approve = decision.decision === 'approve';
      const lines = [
        ...(await scopeLine(client, actor, review.scope_id)),
        approve
          ? decision.confirmation === 'user_statement'
            ? 'Approve and record the candidate as your own statement'
            : 'Approve the held change'
          : 'Reject the held change',
        ...(review.reason_codes.length > 0
          ? [`Held because: ${review.reason_codes.join(', ').replaceAll('_', ' ')}`]
          : []),
        ...labelled('Curator rationale: ', review.rationale),
        ...(approve ? operations.flatMap((op, index) => changeLines(op, index, targets)) : []),
        ...labelled('Your note: ', decision.reason ?? ''),
      ];
      return {
        scopeId: review.scope_id,
        payload: { review_id: reviewId, decision },
        summary: checkedSummary(approve ? 'Approve a held change' : 'Reject a held change', lines),
        memoryIds: [...targets.keys()],
      };
    });
  }

  private async prepareSourceRights(
    actor: ActorContext,
    sourceId: string,
    raw: unknown,
  ): Promise<Omit<PreparedChange, 'label'>> {
    if (!uuid.safeParse(sourceId).success) throw notFound('Source not found');
    const request = parse(sourceRightsSchema, raw, 'Source rights are invalid');
    return this.read(actor, [request.scope_id], async (client) => {
      const found = await client.query<{
        kind: string;
        external_id: string;
        rights_status: string;
      }>(
        'SELECT kind, external_id, rights_status FROM sources WHERE user_id = $1 AND scope_id = $2 AND id = $3',
        [actor.userId, request.scope_id, sourceId],
      );
      const source = found.rows[0];
      if (source === undefined) throw notFound('Source not found');
      const lines = [
        ...(await scopeLine(client, actor, request.scope_id)),
        ...labelled('Source: ', `${source.kind} ${source.external_id}`),
        `Rights: ${source.rights_status} → ${request.rights_status}`,
        `Consent: ${request.consent ? 'given' : 'not given'}`,
        ...(request.rights_status === 'revoked'
          ? ['Memories that depend only on this source are hidden']
          : []),
      ];
      return {
        scopeId: request.scope_id,
        payload: { source_id: sourceId, request },
        summary: checkedSummary('Change source rights', lines),
        memoryIds: [],
      };
    });
  }

  private async prepareGrant(
    actor: ActorContext,
    scopeId: string,
    raw: unknown,
  ): Promise<Omit<PreparedChange, 'label'>> {
    if (!uuid.safeParse(scopeId).success) throw notFound('Scope not found');
    const request = parse(grantMutationSchema, raw, 'Grant mutation is invalid');
    return this.read(actor, [scopeId], async (client) => {
      const principal = await client.query<{ actor_kind: string }>(
        'SELECT actor_kind FROM principals WHERE user_id = $1 AND id = $2',
        [actor.userId, request.principal_id],
      );
      const kind = principal.rows[0]?.actor_kind;
      const lines = [
        ...(await scopeLine(client, actor, scopeId)),
        `Principal: ${request.principal_id}${kind === undefined ? '' : ` (${kind})`}`,
        request.revoke ? 'Revoke all access' : `Access: ${(request.capabilities ?? []).join(', ')}`,
        ...(request.revoke ? [] : [`Expires: ${request.expires_at ?? 'never'}`]),
      ];
      return {
        scopeId,
        payload: { scope_id: scopeId, request },
        summary: checkedSummary('Change scope access', lines),
        memoryIds: [],
      };
    });
  }

  private async prepareRetention(
    actor: ActorContext,
    scopeId: string,
    raw: unknown,
  ): Promise<Omit<PreparedChange, 'label'>> {
    if (!uuid.safeParse(scopeId).success) throw notFound('Scope not found');
    const request = parse(retentionPolicySchema, raw, 'Retention policy is invalid');
    return this.read(actor, [scopeId], async (client) => {
      const lines = [
        ...(await scopeLine(client, actor, scopeId)),
        `Keep observations for ${request.observation_days} days`,
        request.memory_days === null || request.memory_days === undefined
          ? 'Keep memories without an age limit'
          : `Keep memories for ${request.memory_days} days`,
        'Older items are forgotten through the normal Forget process',
      ];
      return {
        scopeId,
        payload: { scope_id: scopeId, request },
        summary: checkedSummary('Set retention', lines),
        memoryIds: [],
      };
    });
  }

  private async prepareSource(
    actor: ActorContext,
    raw: unknown,
  ): Promise<Omit<PreparedChange, 'label'>> {
    const request = parse(connectorAuthorizationSchema, raw, 'Connector authorization is invalid');
    return this.read(actor, [request.scope_id], async (client) => {
      const found = await client.query<{ enabled: boolean; consent: boolean }>(
        `SELECT enabled, consent FROM connector_authorizations
         WHERE user_id = $1 AND scope_id = $2 AND source_kind = $3 AND external_id = $4`,
        [actor.userId, request.scope_id, request.source_kind, request.external_id],
      );
      const current = found.rows[0];
      const state = (enabled: boolean, consent: boolean) =>
        enabled && consent ? 'enabled with consent' : enabled ? 'enabled' : 'disabled';
      const lines = [
        ...(await scopeLine(client, actor, request.scope_id)),
        ...labelled('Source: ', `${request.source_kind} ${request.external_id}`),
        `Capture: ${current === undefined ? 'not configured' : state(current.enabled, current.consent)} → ${state(request.enabled, request.consent)}`,
        request.enabled
          ? 'Your AIs may send this source to Lore, and Lore may propose memories from it'
          : 'Lore stops accepting and using observations from this source',
        ...(Object.keys(request.metadata).length === 0
          ? []
          : labelled('Settings: ', canonical(request.metadata))),
      ];
      return {
        scopeId: request.scope_id,
        payload: { request },
        summary: checkedSummary(
          request.enabled ? 'Enable capture from a source' : 'Disable capture from a source',
          lines,
        ),
        memoryIds: [],
      };
    });
  }

  private read<T>(
    actor: ActorContext,
    scopeIds: readonly string[],
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withAuthorizedActor(this.options.pool, actor, scopeIds, 'read', run);
  }

  private governance(): ForgetService {
    if (this.options.governance === undefined) {
      throw new CoreError(503, 'feature_unavailable', 'Governance is not configured', true);
    }
    return this.options.governance;
  }

  private connectors(): ConnectorService {
    if (this.options.connectors === undefined) {
      throw new CoreError(503, 'feature_unavailable', 'Connector capture is not configured', true);
    }
    return this.options.connectors;
  }

  private compartmentService(): CompartmentService {
    if (this.options.compartments === undefined) {
      throw new CoreError(503, 'feature_unavailable', 'Compartments are not configured', true);
    }
    return this.options.compartments;
  }

  private reviews(): CurationReviewService {
    if (this.options.reviews === undefined) {
      throw new CoreError(503, 'feature_unavailable', 'Curation review is not configured', true);
    }
    return this.options.reviews;
  }
}

function directPayload(change: ProtectedChange): Record<string, unknown> {
  switch (change.operation) {
    case 'commit_changeset':
      return { changeset_id: change.changesetId };
    case 'forget':
      return { request: change.request };
    case 'decide_review':
      return { review_id: change.reviewId, decision: change.decision };
    case 'change_source_rights':
      return { source_id: change.sourceId, request: change.request };
    case 'change_scope_grant':
    case 'set_retention_policy':
      return { scope_id: change.scopeId, request: change.request };
    case 'configure_source':
    case 'change_connection_allowance':
      return { request: change.request };
  }
}

/** The union of the labels of what a confirmation shows. */
async function shownLabel(
  client: PoolClient,
  actor: ActorContext,
  operation: Operation,
  prepared: Omit<PreparedChange, 'label'>,
): Promise<string[]> {
  const labels = await client.query<{ label: string[] }>(
    `SELECT compartment_ids::text[] AS label FROM memories
     WHERE user_id = $1 AND id = ANY($2::uuid[])
     UNION ALL
     SELECT compartment_ids::text[] FROM changesets
     WHERE user_id = $1 AND $3::text = 'commit_changeset' AND id::text = $4::text
     UNION ALL
     SELECT compartment_ids::text[] FROM curation_reviews
     WHERE user_id = $1 AND $3::text = 'decide_review' AND id::text = $5::text`,
    [
      actor.userId,
      prepared.memoryIds,
      operation,
      String(prepared.payload['changeset_id'] ?? ''),
      String(prepared.payload['review_id'] ?? ''),
    ],
  );
  return [...new Set(labels.rows.flatMap((row) => row.label))].sort();
}

/** Binds a confirmation's identity, scope, operation, payload and summary in one hash. */
function changeHashOf(
  id: string,
  actor: ActorContext,
  prepared: PreparedChange,
  operation: Operation,
): string {
  return `sha256:${sha256(
    canonical({
      v: 1,
      confirmation_id: id,
      user_id: actor.userId,
      scope_id: prepared.scopeId,
      operation,
      payload: prepared.payload,
      summary: prepared.summary,
    }),
  )}`;
}

/** A policy-approved change's own result, with the approval that let it run. */
function withPolicyApproval(row: ConfirmationRow): Record<string, unknown> {
  const approval = { by: 'policy', confirmation_id: row.id };
  const result = row.response;
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), approval }
    : { result, approval };
}

function view(row: ConfirmationRow): Record<string, unknown> {
  const base = {
    confirmation_id: row.id,
    scope_id: row.scope_id,
    operation: row.operation,
    status: row.status,
    approval: row.approval,
  };
  if (row.status === 'pending') return { ...base, url: row.gate_url, summary: row.summary };
  if (row.status === 'committed') return { ...base, result: row.response };
  if (row.status === 'failed') return { ...base, ...(row.response as object | null) };
  return base;
}

async function update(
  client: PoolClient,
  actor: ActorContext,
  row: ConfirmationRow,
  status: 'denied' | 'expired' | 'failed',
  response: unknown,
): Promise<ConfirmationRow> {
  const updated = await client.query<ConfirmationRow>(
    `UPDATE change_confirmations
     SET status = $4, response = $5::jsonb, resolved_at = clock_timestamp(), payload = NULL,
       summary = NULL
     WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND status = 'pending'
     RETURNING ${COLUMNS}`,
    [
      actor.userId,
      row.scope_id,
      row.id,
      status,
      response === null ? null : JSON.stringify(response),
    ],
  );
  return updated.rows[0]!;
}

async function scopeLine(
  client: PoolClient,
  actor: ActorContext,
  scopeId: string,
): Promise<string[]> {
  const scope = await client.query<{ name: string }>(
    'SELECT name FROM scopes WHERE user_id = $1 AND id = $2',
    [actor.userId, scopeId],
  );
  return labelled('Scope: ', scope.rows[0]?.name ?? scopeId);
}

async function memoryTargets(
  client: PoolClient,
  actor: ActorContext,
  scopeId: string,
  operations: readonly ChangeOp[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      operations.flatMap((op) =>
        op.op === 'RELATE'
          ? [op.from_memory_id, op.to_memory_id]
          : 'memory_id' in op
            ? [op.memory_id]
            : [],
      ),
    ),
  ];
  const found = await client.query<{ id: string; statement: string }>(
    'SELECT id, statement FROM memories WHERE user_id = $1 AND scope_id = $2 AND id = ANY($3::uuid[])',
    [actor.userId, scopeId, ids],
  );
  const statements = new Map(found.rows.map((memory) => [memory.id, memory.statement]));
  return new Map(ids.map((id) => [id, statements.get(id) ?? `memory ${id}`]));
}

function changeLines(op: ChangeOp, index: number, targets: Map<string, string>): string[] {
  const n = `${index + 1}.`;
  const target = (id: string, revision: number) =>
    `${targets.get(id) ?? `memory ${id}`} (expected revision ${revision})`;
  switch (op.op) {
    case 'CREATE':
      return memoryLines(`${n} Create`, op.memory);
    case 'CORROBORATE':
      return [
        ...labelled(`${n} Add evidence to: `, target(op.memory_id, op.expected_revision)),
        ...evidenceLines(op.evidence),
      ];
    case 'REFINE':
      return [
        ...labelled(`${n} Refine: `, target(op.memory_id, op.expected_revision)),
        ...labelled('New statement: ', op.statement ?? ''),
        ...(op.epistemic_status === undefined ? [] : [`Status: ${op.epistemic_status}`]),
        ...validity(op.valid_from, op.valid_to),
        ...(op.context === undefined ? [] : labelled('Context: ', canonical(op.context))),
        ...evidenceLines(op.evidence),
      ];
    case 'SUPERSEDE':
      return [
        ...labelled(`${n} Replace: `, target(op.memory_id, op.expected_revision)),
        ...memoryLines('With', op.replacement),
      ];
    case 'CONTEST':
      return [
        ...labelled(`${n} Contest: `, target(op.memory_id, op.expected_revision)),
        ...labelled('Reason: ', op.reason),
        ...evidenceLines(op.evidence),
      ];
    case 'RELATE':
      return [
        ...labelled(`${n} Relate: `, target(op.from_memory_id, op.from_expected_revision)),
        `Relation: ${op.relation.replaceAll('_', ' ')}`,
        ...labelled('To: ', target(op.to_memory_id, op.to_expected_revision)),
        ...(Object.keys(op.context).length === 0
          ? []
          : labelled('Context: ', canonical(op.context))),
      ];
    case 'RETRACT':
      return [
        ...labelled(`${n} Retract: `, target(op.memory_id, op.expected_revision)),
        ...labelled('Reason: ', op.reason),
      ];
    case 'NO_OP':
      return labelled(`${n} No change: `, op.reason);
    case 'RECLASSIFY':
      return [
        ...labelled(`${n} Change who may receive: `, target(op.memory_id, op.expected_revision)),
        ...labelled(
          'New compartments: ',
          op.compartments.length === 0
            ? 'General (every connected AI)'
            : op.compartments.join(', '),
        ),
      ];
  }
}

function memoryLines(prefix: string, memory: MemoryInput): string[] {
  return [
    ...labelled(`${prefix} ${memory.kind}: `, memory.statement),
    ...(memory.epistemic_status === 'asserted' ? [] : [`Status: ${memory.epistemic_status}`]),
    ...(memory.contested ? ['Marked as contested'] : []),
    ...(memory.subjects.length === 0
      ? []
      : labelled('Subjects: ', memory.subjects.map((subject) => subject.name).join(', '))),
    ...validity(memory.valid_from, memory.valid_to),
    ...(Object.keys(memory.context).length === 0
      ? []
      : labelled('Context: ', canonical(memory.context))),
    ...evidenceLines(memory.evidence),
  ];
}

function evidenceLines(evidence: Evidence): string[] {
  return evidence.flatMap((item) =>
    labelled(
      'Evidence: ',
      `${item.source.kind} ${item.source.external_id} at ${item.source.locator}`,
    ),
  );
}

function validity(from: string | null | undefined, to: string | null | undefined): string[] {
  if ((from ?? null) === null && (to ?? null) === null) return [];
  return [`Valid: ${from ?? 'any time'} to ${to ?? 'open'}`];
}

/** Gate shows plain, trimmed lines without control characters: split text, never shorten it. */
function labelled(label: string, text: string): string[] {
  return text
    .split(/\r\n|\r|\n/u)
    .map((part) => part.replace(/\p{Cc}/gu, ' ').trim())
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? `${label}${part}` : part));
}

function checkedSummary(title: string, lines: readonly string[]): Summary {
  const total = lines.reduce((sum, line) => sum + line.length, title.length);
  if (
    title.length > TITLE_LIMIT ||
    lines.length === 0 ||
    lines.length > LINE_LIMIT ||
    total > CHARACTER_LIMIT
  ) {
    throw new CoreError(
      413,
      'summary_too_large',
      'This change is too large to show in full for approval; split it into smaller changes',
    );
  }
  return Object.freeze({ title, lines: Object.freeze([...lines]) });
}

/** RFC 8785-style canonical JSON for the plain JSON values stored here. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parse<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CoreError(400, 'invalid_request', message, false, parsed.error.issues);
  }
  return parsed.data;
}

function isPermanent(error: CoreError): boolean {
  return (
    !error.retryable &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 403
  );
}

function gateFailure(error: unknown): CoreError {
  if (error instanceof IdentityProviderError && error.status === 401) {
    return new CoreError(401, 'unauthorized', 'The Gate connection is no longer active');
  }
  return new CoreError(
    503,
    'authorization_unavailable',
    'Gate confirmations are temporarily unavailable',
    true,
  );
}

function keyReused(): CoreError {
  return new CoreError(
    409,
    'idempotency_key_reused',
    'The idempotency key was already used for a different change',
  );
}

function notFound(message = 'Confirmation not found'): CoreError {
  return new CoreError(404, 'not_found', message);
}
