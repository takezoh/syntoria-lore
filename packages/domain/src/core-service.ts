import { encodeIdentityProvenanceV1 } from '@memory/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  CoreError,
  databaseCompartments,
  getActorAuthorizationGuard,
  changeFeedQuerySchema,
  changeSetSchema,
  memoryInputSchema,
  recallQuerySchema,
  rememberRequestSchema,
  uuidSchema,
  LEGACY_SCOPE_WRITE_LOCK_PREFIX,
  type ActorContext,
  type Capability,
  type ChangeOp,
  type ChangeSet,
  type EvidenceInput,
  type MemoryInput,
} from '@memory/contracts';
import { setDatabaseContext, withTransaction } from '@memory/db';
import type { Pool, PoolClient } from 'pg';
import {
  allowanceIds,
  canonicalLabel,
  isSubsetLabel,
  resolveCompartments,
  resolveWriteLabel,
  unionLabels,
  type LabelOrigin,
  type WriteLabel,
} from './compartments.js';
import { CursorCodec, type CursorState } from './cursor.js';
import { observationLocatorDigest, sourceIdentityDigest } from './governance-keys.js';

interface ScopeAccessRow {
  id: string;
  auth_epoch: string;
  capabilities: string[];
}

interface MutableMemoryRow {
  id: string;
  user_id: string;
  scope_id: string;
  kind: string;
  statement: string;
  context: Record<string, unknown>;
  actor_kind: ActorContext['actorKind'];
  authority: string;
  epistemic_status: string;
  contested: boolean;
  lifecycle: string;
  valid_from: Date | null;
  valid_to: Date | null;
  recorded_at: Date;
  superseded_at: Date | null;
  revision: number;
  committed_revision: number;
  indexed_revision: number;
  compartment_ids: string[];
}

interface EventToWrite {
  readonly op: string;
  readonly memoryId: string | null;
  readonly revision: number | null;
  readonly tombstone: boolean;
  /** For a narrowing, the label the memory had before, so a reader that lost it is told. */
  readonly previousLabel?: readonly string[];
}

interface OperationResult {
  readonly op: string;
  readonly memory_ids: readonly string[];
  readonly revisions: readonly number[];
  readonly changed: boolean;
  /** For a CREATE, the label the new memory received and whether a General write was held. */
  readonly compartment_ids?: readonly string[];
  readonly held?: boolean;
}

interface EvidenceRow {
  id: string;
  source_id: string;
  source_revision: string;
  locator: string;
  span: string | null;
  speaker: string | null;
  captured_at: Date;
  event_time: Date | null;
  lineage_root: string;
  snippet: string | null;
  snippet_allowed: boolean;
  created_at: Date;
}

export interface CuratedEvidenceAnchor {
  readonly observationId: string;
  readonly spanStart: number;
  readonly spanEnd: number;
}

interface InternalCommitOptions {
  readonly writerActorKind?: ActorContext['actorKind'];
  readonly activate?: boolean;
  readonly userStatement?: boolean;
  readonly anchorsByOperation?: readonly (readonly CuratedEvidenceAnchor[])[];
  readonly jobFence?: { readonly jobId: string; readonly leaseToken: string };
  /** The label of a reviewed proposal, applied instead of the approving connection's default. */
  readonly label?: { readonly ids: readonly string[]; readonly origin: LabelOrigin };
  readonly review?: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly confirmation: 'accept_candidate' | 'user_statement';
    readonly reason: string | null;
    readonly principalId: string;
    readonly expectedRevisions: Readonly<Record<string, number>>;
    readonly decisionPayloadHash: string;
  };
}

const writeCapability: Capability = 'write';
const readCapability: Capability = 'read';

export interface CoreServiceOptions {
  readonly maxPageSize?: number;
  readonly forgetHmacKey?: string;
}

export class CoreService {
  private readonly maxPageSize: number;
  private readonly forgetHmacKey: string | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly cursors: CursorCodec,
    options: CoreServiceOptions = {},
  ) {
    this.maxPageSize = options.maxPageSize ?? 200;
    this.forgetHmacKey = options.forgetHmacKey ?? process.env['FORGET_HMAC_KEY'];
  }

  async remember(
    actor: ActorContext,
    rawRequest: unknown,
    requestId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const parsed = rememberRequestSchema.safeParse(rawRequest);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Remember request does not match the API contract',
        false,
        parsed.error.issues,
      );
    return this.applyChangeSet(
      actor,
      {
        scope_id: parsed.data.scope_id ?? soleWritableScope(actor),
        operations: [{ op: 'CREATE', memory: parsed.data.memory }],
      },
      requestId,
      idempotencyKey,
    );
  }

  async proposeChangeSet(
    actor: ActorContext,
    rawChangeSet: unknown,
    requestId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const parsed = changeSetSchema.safeParse(rawChangeSet);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'The ChangeSet does not match the API contract',
        false,
        parsed.error.issues,
      );
    const changeSet = parsed.data;
    validateChangeSetTime(changeSet);
    validateIdempotencyKey(idempotencyKey);
    const payloadHash = sha256(stableJson(changeSet));
    return this.withActor(actor, [changeSet.scope_id], writeCapability, async (client) => {
      await client.query(
        'INSERT INTO scope_offsets(user_id, scope_id) VALUES ($1, $2) ON CONFLICT (user_id, scope_id) DO NOTHING',
        [actor.userId, changeSet.scope_id],
      );
      await client.query(
        'SELECT last_seq FROM scope_offsets WHERE user_id = $1 AND scope_id = $2 FOR UPDATE',
        [actor.userId, changeSet.scope_id],
      );
      const prior = await client.query<{
        id: string;
        proposal_hash: string | null;
        response: Record<string, unknown>;
      }>(
        `SELECT id, proposal_hash, coalesce(proposal_response, response) AS response FROM changesets
         WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3 AND proposal_idempotency_key = $4`,
        [actor.userId, changeSet.scope_id, actor.principalId, idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing !== undefined) {
        if (existing.proposal_hash !== payloadHash) {
          throw new CoreError(
            409,
            'idempotency_conflict',
            'This proposal key was already used for a different request',
          );
        }
        return existing.response;
      }
      const label = await this.validateProposal(client, actor, changeSet);
      const changeSetId = randomUUID();
      const response = {
        change_set_id: changeSetId,
        scope_id: changeSet.scope_id,
        status: 'proposed',
      };
      await client.query(
        `INSERT INTO changesets(user_id, scope_id, id, principal_id, request_id, operation_count,
           response, status, proposal, proposal_hash, proposal_idempotency_key, proposal_response, client_id,
           compartment_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'proposed', $8::jsonb, $9, $10, $7::jsonb, $11, $12::uuid[])`,
        [
          actor.userId,
          changeSet.scope_id,
          changeSetId,
          actor.principalId,
          requestId,
          changeSet.operations.length,
          JSON.stringify(response),
          JSON.stringify(changeSet),
          payloadHash,
          idempotencyKey,
          actor.clientId ?? null,
          label,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(user_id, scope_id, principal_id, event_type, request_id, object_id, metadata)
         VALUES ($1, $2, $3, 'changeset.proposed', $4, $5, $6::jsonb)`,
        [
          actor.userId,
          changeSet.scope_id,
          actor.principalId,
          requestId,
          changeSetId,
          JSON.stringify({ operation_count: changeSet.operations.length }),
        ],
      );
      return response;
    });
  }

  async commitProposedChangeSet(
    actor: ActorContext,
    changeSetId: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    validateUuid(changeSetId, 'change_set_id');
    validateIdempotencyKey(idempotencyKey);
    const authorizedScopes = normalizeScopes(
      actor.scopeIds.filter((scopeId) => actor.tokenScopeIds.includes(scopeId)),
    );
    if (authorizedScopes.length === 0)
      throw new CoreError(403, 'forbidden', 'An authorized scope is required');
    const proposalGuard = getActorAuthorizationGuard(actor);
    const proposal = await withTransaction(
      this.pool,
      async (client) => {
        await setDatabaseContext(client, {
          userId: actor.userId,
          principalId: actor.principalId,
          scopeIds: authorizedScopes,
          compartments: databaseCompartments(actor.compartments),
        });
        const result = await client.query<{
          scope_id: string;
          status: string;
          principal_id: string;
          proposal: ChangeSet | null;
          response: Record<string, unknown>;
          held_review_id: string | null;
        }>(
          `SELECT c.scope_id, c.status, c.principal_id, c.proposal, c.response, r.id AS held_review_id
         FROM changesets c LEFT JOIN curation_reviews r ON r.user_id = c.user_id AND r.scope_id = c.scope_id
           AND r.change_set_id = c.id AND r.status = 'held'
         WHERE c.user_id = $1 AND c.id = $2 AND c.scope_id = ANY($3::uuid[])`,
          [actor.userId, changeSetId, authorizedScopes],
        );
        const row = result.rows[0];
        if (row === undefined) throw new CoreError(404, 'not_found', 'ChangeSet not found');
        if (row.held_review_id !== null)
          throw new CoreError(
            409,
            'user_review_required',
            'This ChangeSet must be decided through its User review',
          );
        if (actor.actorKind !== 'user' && actor.principalId !== row.principal_id) {
          throw new CoreError(
            403,
            'forbidden',
            'Only the proposing principal or User may commit this ChangeSet',
          );
        }
        if (row.status === 'committed')
          return { scopeId: row.scope_id, proposal: null, response: row.response };
        if (row.status !== 'proposed' || row.proposal === null)
          throw new CoreError(409, 'changeset_not_committable', 'ChangeSet is not awaiting commit');
        return { scopeId: row.scope_id, proposal: row.proposal, response: null };
      },
      proposalGuard === undefined ? {} : { beforeCommit: (client) => proposalGuard(client) },
    );
    await this.withActor(actor, [proposal.scopeId], writeCapability, async () => undefined);
    if (proposal.proposal === null) {
      return this.withActor(actor, [proposal.scopeId], writeCapability, async (client) => {
        const result = await client.query<{ response: Record<string, unknown> }>(
          `SELECT response FROM changesets WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND status = 'committed'`,
          [actor.userId, proposal.scopeId, changeSetId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new CoreError(404, 'not_found', 'ChangeSet not found');
        return row.response;
      });
    }
    return this.applyChangeSet(actor, proposal.proposal, requestId, idempotencyKey, changeSetId);
  }

  /** Validates a proposal and returns the union of the labels it would read or write. */
  private async validateProposal(
    client: PoolClient,
    actor: ActorContext,
    changeSet: ChangeSet,
  ): Promise<string[]> {
    const labels: (readonly string[])[] = [];
    const writeLabel = async (refs: readonly string[] | undefined) =>
      resolveWriteLabel(
        actor,
        refs === undefined ? undefined : await resolveCompartments(client, actor, refs),
      ).ids;
    for (const operation of changeSet.operations) {
      if (operation.op === 'CREATE') {
        labels.push(
          await writeLabel(operation.memory.compartments),
          await this.validateEvidenceSources(
            client,
            actor,
            changeSet.scope_id,
            operation.memory.evidence,
          ),
        );
        continue;
      }
      if (operation.op === 'NO_OP') continue;
      if (operation.op === 'RELATE') {
        const targets = [
          { id: operation.from_memory_id, revision: operation.from_expected_revision },
          { id: operation.to_memory_id, revision: operation.to_expected_revision },
        ].sort((a, b) => a.id.localeCompare(b.id));
        if (targets[0]?.id === targets[1]?.id)
          throw new CoreError(400, 'invalid_request', 'A memory cannot be related to itself');
        for (const target of targets)
          labels.push(
            (
              await this.lockMutableMemory(
                client,
                actor,
                changeSet.scope_id,
                target.id,
                target.revision,
              )
            ).compartment_ids,
          );
        continue;
      }
      if (operation.op === 'SUPERSEDE' && actor.actorKind !== 'user') {
        throw new CoreError(403, 'forbidden', 'Only the User may supersede an active memory');
      }
      if (operation.op === 'RETRACT' && actor.actorKind !== 'user') {
        throw new CoreError(403, 'forbidden', 'Only the User may retract a memory');
      }
      const memory = await this.lockMutableMemory(
        client,
        actor,
        changeSet.scope_id,
        operation.memory_id,
        operation.expected_revision,
      );
      labels.push(memory.compartment_ids);
      if (operation.op === 'RECLASSIFY') {
        labels.push(await resolveCompartments(client, actor, operation.compartments));
        continue;
      }
      if (
        operation.op === 'REFINE' &&
        actor.actorKind !== 'user' &&
        ['user_decision', 'user_preference', 'user_assertion'].includes(memory.authority)
      ) {
        throw new CoreError(
          403,
          'user_confirmation_required',
          'Only the User may refine an User-attributed active memory',
        );
      }
      if (
        operation.op === 'CORROBORATE' ||
        operation.op === 'REFINE' ||
        operation.op === 'CONTEST'
      ) {
        labels.push(
          await this.validateEvidenceSources(client, actor, changeSet.scope_id, operation.evidence),
        );
      }
      if (operation.op === 'SUPERSEDE') {
        validateMemoryTime(operation.replacement);
        labels.push(
          await writeLabel(operation.replacement.compartments),
          await this.validateEvidenceSources(
            client,
            actor,
            changeSet.scope_id,
            operation.replacement.evidence,
          ),
        );
      }
    }
    return unionLabels(...labels);
  }

  private async validateEvidenceSources(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    evidence: readonly EvidenceInput[],
  ): Promise<string[]> {
    const labels: string[][] = [];
    for (const item of evidence) {
      const source = await client.query<{ id: string }>(
        `SELECT id FROM sources
         WHERE user_id = $1 AND scope_id = $2 AND kind = $3 AND external_id = $4 AND revision = $5`,
        [actor.userId, scopeId, item.source.kind, item.source.external_id, item.source.revision],
      );
      const sourceId = source.rows[0]?.id;
      if (sourceId === undefined && item.source.kind === 'explicit_remember') continue;
      if (sourceId === undefined) {
        throw new CoreError(
          403,
          'source_not_authorized',
          'The source is not authorized for this proposal',
        );
      }
      await this.lockSourcesForShare(client, [sourceId]);
      const rights = await client.query<{
        rights_status: string;
        consent: boolean;
        compartment_ids: string[];
      }>(
        `SELECT rights_status, consent, compartment_ids::text[] AS compartment_ids FROM sources
         WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, scopeId, sourceId],
      );
      const row = rights.rows[0];
      if (row === undefined || row.rights_status !== 'granted' || !row.consent) {
        throw new CoreError(
          403,
          'source_not_authorized',
          'The source is not authorized for this proposal',
        );
      }
      labels.push(row.compartment_ids);
    }
    return unionLabels(...labels);
  }

  async applyChangeSet(
    actor: ActorContext,
    rawChangeSet: unknown,
    requestId: string,
    idempotencyKey: string,
    existingProposalId?: string,
    internalOptions?: InternalCommitOptions,
  ): Promise<Record<string, unknown>> {
    const parsed = changeSetSchema.safeParse(rawChangeSet);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'The ChangeSet does not match the API contract',
        false,
        parsed.error.issues,
      );
    const changeSet = parsed.data;
    validateChangeSetTime(changeSet);
    validateIdempotencyKey(idempotencyKey);
    const scopeIds = [changeSet.scope_id];
    const payloadHash = sha256(stableJson(changeSet));
    const idempotencyPayloadHash = internalOptions?.review?.decisionPayloadHash ?? payloadHash;

    return this.withActor(actor, scopeIds, writeCapability, async (client) => {
      await client.query(
        'INSERT INTO scope_offsets(user_id, scope_id) VALUES ($1, $2) ON CONFLICT (user_id, scope_id) DO NOTHING',
        [actor.userId, changeSet.scope_id],
      );
      await client.query(
        'SELECT last_seq FROM scope_offsets WHERE user_id = $1 AND scope_id = $2 FOR UPDATE',
        [actor.userId, changeSet.scope_id],
      );

      const prior = await client.query<{ payload_hash: string; response: Record<string, unknown> }>(
        `SELECT payload_hash, response FROM idempotency_keys
         WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [actor.userId, changeSet.scope_id, actor.principalId, idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing !== undefined) {
        if (existing.payload_hash !== idempotencyPayloadHash) {
          throw new CoreError(
            409,
            'idempotency_conflict',
            'This Idempotency-Key was already used for a different request',
          );
        }
        return existing.response;
      }

      let changeSetId: string = randomUUID();
      if (existingProposalId !== undefined) {
        const existingProposal = await client.query<{
          status: string;
          proposal_hash: string | null;
          response: Record<string, unknown>;
        }>(
          `SELECT status, proposal_hash, response FROM changesets
           WHERE user_id = $1 AND scope_id = $2 AND id = $3 FOR UPDATE`,
          [actor.userId, changeSet.scope_id, existingProposalId],
        );
        const row = existingProposal.rows[0];
        if (row === undefined) throw new CoreError(404, 'not_found', 'ChangeSet not found');
        if (row.status === 'committed') return row.response;
        if (row.status !== 'proposed' || row.proposal_hash !== payloadHash) {
          throw new CoreError(
            409,
            'changeset_not_committable',
            'The stored proposal changed or is no longer awaiting commit',
          );
        }
        changeSetId = existingProposalId;
      } else {
        await client.query(
          `INSERT INTO changesets(user_id, scope_id, id, principal_id, request_id, operation_count,
             response, status, committed_at, client_id, compartment_ids)
           VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'committed', clock_timestamp(), $7, '{}')`,
          [
            actor.userId,
            changeSet.scope_id,
            changeSetId,
            actor.principalId,
            requestId,
            changeSet.operations.length,
            actor.clientId ?? null,
          ],
        );
      }

      if (internalOptions?.review !== undefined) {
        const review = await client.query<{ id: string }>(
          `SELECT id FROM curation_reviews WHERE user_id = $1 AND scope_id = $2 AND id = $3
             AND change_set_id = $4 AND status = 'held' AND revision = $5 FOR UPDATE`,
          [
            actor.userId,
            changeSet.scope_id,
            internalOptions.review.id,
            changeSetId,
            internalOptions.review.expectedRevision,
          ],
        );
        if (review.rows[0] === undefined)
          throw new CoreError(
            409,
            'review_revision_conflict',
            'Curation review changed before approval',
          );
        for (const [memoryId, expectedRevision] of Object.entries(
          internalOptions.review.expectedRevisions,
        ).sort(([left], [right]) => left.localeCompare(right))) {
          const current = await client.query<{ committed_revision: number }>(
            `SELECT committed_revision FROM memories
             WHERE user_id = $1 AND scope_id = $2 AND id = $3 FOR UPDATE`,
            [actor.userId, changeSet.scope_id, memoryId],
          );
          if (current.rows[0]?.committed_revision !== expectedRevision)
            throw new CoreError(
              409,
              'review_candidate_stale',
              'A candidate memory changed after this review was created',
            );
        }
      }
      if (internalOptions?.jobFence !== undefined) {
        await this.assertCurrentJobLease(
          client,
          actor,
          changeSet.scope_id,
          internalOptions.jobFence.jobId,
          internalOptions.jobFence.leaseToken,
        );
      }

      const events: EventToWrite[] = [];
      const operationResults: OperationResult[] = [];
      for (let ordinal = 0; ordinal < changeSet.operations.length; ordinal += 1) {
        const operation = changeSet.operations[ordinal];
        if (operation === undefined) continue;
        const applied = await this.applyOperation(
          client,
          actor,
          changeSet.scope_id,
          changeSetId,
          operation,
          internalOptions,
          ordinal,
        );
        events.push(...applied.events);
        operationResults.push(applied.result);
        await client.query(
          `INSERT INTO change_ops(user_id, scope_id, change_set_id, ordinal, op, memory_id, memory_revision, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            actor.userId,
            changeSet.scope_id,
            changeSetId,
            ordinal,
            operation.op,
            applied.result.memory_ids[0] ?? null,
            applied.result.revisions[0] ?? null,
            JSON.stringify({
              memory_ids: applied.result.memory_ids,
              changed: applied.result.changed,
              ...('reason' in operation ? { reason: operation.reason } : {}),
            }),
          ],
        );
      }

      // Each event carries the label of the version it records; the changeset and its stored
      // response carry the union of every label it touched.
      const eventLabels = await client.query<{
        memory_id: string;
        revision: number;
        label: string[];
      }>(
        `SELECT memory_id::text AS memory_id, revision, compartment_ids::text[] AS label
         FROM memory_versions
         WHERE user_id = $1 AND scope_id = $2 AND change_set_id = $3`,
        [actor.userId, changeSet.scope_id, changeSetId],
      );
      const labelOf = new Map(
        eventLabels.rows.map((row) => [`${row.memory_id}:${row.revision}`, row.label]),
      );
      const versionLabel = (event: EventToWrite): string[] =>
        labelOf.get(`${event.memoryId}:${event.revision}`) ?? [];
      const changeSetLabel = unionLabels(
        ...events.map(versionLabel),
        ...operationResults.map((result) => result.compartment_ids ?? []),
      );
      const seqResult = await client.query<{ last_seq: string }>(
        `UPDATE scope_offsets SET last_seq = last_seq + $3, updated_at = clock_timestamp()
         WHERE user_id = $1 AND scope_id = $2 RETURNING last_seq`,
        [actor.userId, changeSet.scope_id, events.length],
      );
      const lastSeq = BigInt(seqResult.rows[0]?.last_seq ?? '0');
      const firstSeq = events.length === 0 ? null : lastSeq - BigInt(events.length) + 1n;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event === undefined || firstSeq === null) continue;
        const seq = (firstSeq + BigInt(index)).toString();
        const changeId = randomUUID();
        await client.query(
          `INSERT INTO change_log(user_id, scope_id, id, seq, change_set_id, op, memory_id, memory_revision, tombstone,
             compartment_ids, previous_compartment_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11::uuid[])`,
          [
            actor.userId,
            changeSet.scope_id,
            changeId,
            seq,
            changeSetId,
            event.op,
            event.memoryId,
            event.revision,
            event.tombstone,
            versionLabel(event),
            event.previousLabel === undefined ? null : canonicalLabel(event.previousLabel),
          ],
        );
        await client.query(
          `INSERT INTO outbox(user_id, scope_id, id, event_type, aggregate_id, payload)
           VALUES ($1, $2, $3, 'memory.change', $4, $5::jsonb)`,
          [
            actor.userId,
            changeSet.scope_id,
            randomUUID(),
            changeSetId,
            JSON.stringify({ change_id: changeId, seq, op: event.op }),
          ],
        );
      }

      const response = {
        change_set_id: changeSetId,
        scope_id: changeSet.scope_id,
        sequence_from: firstSeq?.toString() ?? null,
        sequence_to: events.length === 0 ? null : lastSeq.toString(),
        operations: operationResults,
        ...(internalOptions?.review === undefined
          ? {}
          : {
              review_id: internalOptions.review.id,
              review_status: 'approved',
              confirmation: internalOptions.review.confirmation,
            }),
      };
      await client.query(
        `UPDATE changesets SET response = $4::jsonb, status = 'committed', proposal = NULL,
        committed_at = clock_timestamp(), compartment_ids = $5::uuid[]
        WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, changeSet.scope_id, changeSetId, JSON.stringify(response), changeSetLabel],
      );
      await client.query(
        `INSERT INTO idempotency_keys(user_id, scope_id, principal_id, idempotency_key, payload_hash, response, change_set_id,
           compartment_ids)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid[])`,
        [
          actor.userId,
          changeSet.scope_id,
          actor.principalId,
          idempotencyKey,
          idempotencyPayloadHash,
          JSON.stringify(response),
          changeSetId,
          changeSetLabel,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(user_id, scope_id, principal_id, event_type, request_id, object_id, metadata)
         VALUES ($1, $2, $3, 'changeset.committed', $4, $5, $6::jsonb)`,
        [
          actor.userId,
          changeSet.scope_id,
          actor.principalId,
          requestId,
          changeSetId,
          JSON.stringify({
            operation_count: changeSet.operations.length,
            change_count: events.length,
          }),
        ],
      );
      if (internalOptions?.review !== undefined) {
        const review = internalOptions.review;
        const updated = await client.query<{ id: string }>(
          `UPDATE curation_reviews SET status = 'approved', revision = revision + 1,
             decision_reason = $6, decision_by = $5, decision_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND status = 'held' AND revision = $4
           RETURNING id`,
          [
            actor.userId,
            changeSet.scope_id,
            review.id,
            review.expectedRevision,
            actor.principalId,
            review.reason,
          ],
        );
        if (updated.rows[0] === undefined)
          throw new CoreError(
            409,
            'review_revision_conflict',
            'Curation review changed before approval',
          );
        const memoryIds = operationResults.flatMap((result) => result.memory_ids);
        if (review.confirmation === 'user_statement') {
          await client.query(
            `INSERT INTO user_confirmations(user_id, scope_id, review_id, principal_id, confirmation_type, memory_ids)
             VALUES ($1, $2, $3, $4, 'user_statement', $5::uuid[])`,
            [actor.userId, changeSet.scope_id, review.id, actor.principalId, memoryIds],
          );
        }
        await client.query(
          `UPDATE capture_jobs SET state = 'committed', lease_until = NULL, lease_token = NULL,
             next_retry_at = NULL, updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND review_id = $3`,
          [actor.userId, changeSet.scope_id, review.id],
        );
      }
      return response;
    });
  }

  async commitCuratedFacts(
    actor: ActorContext,
    scopeId: string,
    entries: readonly {
      readonly memory: MemoryInput;
      readonly anchors: readonly CuratedEvidenceAnchor[];
    }[],
    requestId: string,
    idempotencyKey: string,
    jobFence: { readonly jobId: string; readonly leaseToken: string },
  ): Promise<Record<string, unknown>> {
    validateUuid(scopeId, 'scope_id');
    if (entries.length < 1 || entries.length > 32)
      throw new CoreError(400, 'invalid_request', 'Curated commit must include 1 to 32 candidates');
    const operations: ChangeOp[] = [];
    const anchorsByOperation: CuratedEvidenceAnchor[][] = [];
    for (const entry of entries) {
      const parsed = memoryInputSchema.safeParse(entry.memory);
      if (
        !parsed.success ||
        parsed.data.kind !== 'fact' ||
        !['observed', 'inferred'].includes(parsed.data.epistemic_status) ||
        parsed.data.contested
      ) {
        throw new CoreError(
          400,
          'curated_policy_violation',
          'Only uncontested observed or inferred facts can be committed automatically',
        );
      }
      if (entry.anchors.length !== parsed.data.evidence.length)
        throw new CoreError(
          400,
          'invalid_evidence_anchor',
          'Every curated evidence item must have one source observation anchor',
        );
      for (const anchor of entry.anchors) {
        validateUuid(anchor.observationId, 'observation_id');
        if (
          !Number.isSafeInteger(anchor.spanStart) ||
          !Number.isSafeInteger(anchor.spanEnd) ||
          anchor.spanStart < 0 ||
          anchor.spanEnd <= anchor.spanStart
        )
          throw new CoreError(400, 'invalid_evidence_anchor', 'Evidence span offsets are invalid');
      }
      operations.push({ op: 'CREATE', memory: parsed.data });
      anchorsByOperation.push([...entry.anchors]);
    }
    return this.applyChangeSet(
      actor,
      { scope_id: scopeId, operations },
      requestId,
      idempotencyKey,
      undefined,
      {
        writerActorKind: 'curator',
        activate: true,
        anchorsByOperation,
        jobFence,
      },
    );
  }

  async createCurationReview(
    actor: ActorContext,
    rawChangeSet: unknown,
    requestId: string,
    idempotencyKey: string,
    jobFence: { readonly jobId: string; readonly leaseToken: string },
    draft: {
      readonly reasonCodes: readonly string[];
      readonly rationale: string;
      readonly candidateSummary: Record<string, unknown>;
      readonly evidenceAnchors: readonly (readonly CuratedEvidenceAnchor[])[];
      readonly expectedRevisions: Readonly<Record<string, number>>;
      readonly checkpoint: Record<string, unknown>;
    },
  ): Promise<{ readonly review_id: string; readonly change_set_id: string }> {
    const parsed = changeSetSchema.safeParse(rawChangeSet);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'The curation review proposal is invalid',
        false,
        parsed.error.issues,
      );
    const changeSet = parsed.data;
    validateChangeSetTime(changeSet);
    validateIdempotencyKey(idempotencyKey);
    validateUuid(jobFence.jobId, 'job_id');
    validateUuid(jobFence.leaseToken, 'lease_token');
    if (
      changeSet.operations.length < 1 ||
      changeSet.operations.length > 32 ||
      changeSet.operations.some((operation) => operation.op !== 'CREATE') ||
      draft.evidenceAnchors.length !== changeSet.operations.length
    ) {
      throw new CoreError(
        400,
        'invalid_review_proposal',
        'Curation reviews must contain one anchored CREATE per candidate',
      );
    }
    for (const [index, operation] of changeSet.operations.entries()) {
      if (
        operation.op !== 'CREATE' ||
        operation.memory.evidence.length !== draft.evidenceAnchors[index]?.length
      ) {
        throw new CoreError(
          400,
          'invalid_review_proposal',
          'Curation evidence anchors must match the proposal evidence',
        );
      }
    }
    if (draft.reasonCodes.length > 32 || draft.rationale.length > 4_000) {
      throw new CoreError(
        400,
        'invalid_review_proposal',
        'Curation review explanation exceeds its bounds',
      );
    }
    for (const [memoryId, revision] of Object.entries(draft.expectedRevisions)) {
      validateUuid(memoryId, 'expected_memory_id');
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new CoreError(
          400,
          'invalid_review_revisions',
          'Expected memory revision must be positive',
        );
    }
    const payloadHash = sha256(stableJson(changeSet));
    return this.withActor(actor, [changeSet.scope_id], writeCapability, async (client) => {
      await client.query(
        'INSERT INTO scope_offsets(user_id, scope_id) VALUES ($1, $2) ON CONFLICT (user_id, scope_id) DO NOTHING',
        [actor.userId, changeSet.scope_id],
      );
      await client.query(
        'SELECT last_seq FROM scope_offsets WHERE user_id = $1 AND scope_id = $2 FOR UPDATE',
        [actor.userId, changeSet.scope_id],
      );
      await this.assertCurrentJobLease(
        client,
        actor,
        changeSet.scope_id,
        jobFence.jobId,
        jobFence.leaseToken,
      );
      const prior = await client.query<{ id: string; proposal_hash: string | null }>(
        `SELECT id, proposal_hash FROM changesets WHERE user_id = $1 AND scope_id = $2
         AND principal_id = $3 AND proposal_idempotency_key = $4 FOR UPDATE`,
        [actor.userId, changeSet.scope_id, actor.principalId, idempotencyKey],
      );
      if (prior.rows[0] !== undefined) {
        throw new CoreError(
          409,
          'review_proposal_exists',
          'A curation proposal already exists for this job',
        );
      }
      const label = await this.validateProposal(client, actor, changeSet);
      const changeSetId = randomUUID();
      const response = {
        change_set_id: changeSetId,
        scope_id: changeSet.scope_id,
        status: 'proposed',
      };
      await client.query(
        `INSERT INTO changesets(user_id, scope_id, id, principal_id, request_id, operation_count,
           response, status, proposal, proposal_hash, proposal_idempotency_key, proposal_response, client_id,
           compartment_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'proposed', $8::jsonb, $9, $10, $7::jsonb, $11, $12::uuid[])`,
        [
          actor.userId,
          changeSet.scope_id,
          changeSetId,
          actor.principalId,
          requestId,
          changeSet.operations.length,
          JSON.stringify(response),
          JSON.stringify(changeSet),
          payloadHash,
          idempotencyKey,
          actor.clientId ?? null,
          label,
        ],
      );
      const reviewId = randomUUID();
      await client.query(
        `INSERT INTO curation_reviews(user_id, scope_id, id, job_id, change_set_id, reason_codes, rationale,
           candidate_summary, evidence_anchors, expected_revisions, compartment_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::uuid[])`,
        [
          actor.userId,
          changeSet.scope_id,
          reviewId,
          jobFence.jobId,
          changeSetId,
          [...new Set(draft.reasonCodes)],
          draft.rationale,
          JSON.stringify(draft.candidateSummary),
          JSON.stringify(draft.evidenceAnchors),
          JSON.stringify(draft.expectedRevisions),
          label,
        ],
      );
      const held = await client.query(
        `UPDATE capture_jobs SET state = 'held', review_id = $5, checkpoint = checkpoint || $6::jsonb,
           lease_until = NULL, lease_token = NULL, next_retry_at = NULL, updated_at = clock_timestamp()
         WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND lease_token = $4
           AND state = 'processing' AND lease_until > clock_timestamp()`,
        [
          actor.userId,
          changeSet.scope_id,
          jobFence.jobId,
          jobFence.leaseToken,
          reviewId,
          JSON.stringify(draft.checkpoint),
        ],
      );
      if (held.rowCount !== 1)
        throw new CoreError(
          409,
          'job_lease_lost',
          'Capture job lease expired before review creation',
          true,
        );
      await client.query(
        `INSERT INTO audit_events(user_id, scope_id, principal_id, event_type, request_id, object_id, metadata)
         VALUES ($1, $2, $3, 'curation.review_held', $4::uuid, $5, $6::jsonb)`,
        [
          actor.userId,
          changeSet.scope_id,
          actor.principalId,
          requestId,
          reviewId,
          JSON.stringify({ job_id: jobFence.jobId, reason_codes: [...new Set(draft.reasonCodes)] }),
        ],
      );
      return { review_id: reviewId, change_set_id: changeSetId };
    });
  }

  async corroborateCuratedMemory(
    actor: ActorContext,
    scopeId: string,
    memoryId: string,
    expectedRevision: number,
    evidence: readonly EvidenceInput[],
    anchors: readonly CuratedEvidenceAnchor[],
    requestId: string,
    idempotencyKey: string,
    jobFence: { readonly jobId: string; readonly leaseToken: string },
  ): Promise<Record<string, unknown>> {
    validateUuid(scopeId, 'scope_id');
    validateUuid(memoryId, 'memory_id');
    if (evidence.length < 1 || evidence.length > 64 || evidence.length !== anchors.length)
      throw new CoreError(
        400,
        'invalid_evidence_anchor',
        'Every corroborating evidence item must have one source observation anchor',
      );
    const operation: ChangeOp = {
      op: 'CORROBORATE',
      memory_id: memoryId,
      expected_revision: expectedRevision,
      evidence: [...evidence],
    };
    return this.applyChangeSet(
      actor,
      { scope_id: scopeId, operations: [operation] },
      requestId,
      idempotencyKey,
      undefined,
      {
        writerActorKind: 'curator',
        anchorsByOperation: [[...anchors]],
        jobFence,
      },
    );
  }

  async decideCurationReview(
    actor: ActorContext,
    reviewId: string,
    expectedRevision: number,
    decision: 'approve' | 'reject',
    confirmation: 'accept_candidate' | 'user_statement',
    reason: string | null,
    requestId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may decide a curation review');
    validateUuid(reviewId, 'review_id');
    validateIdempotencyKey(idempotencyKey);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new CoreError(400, 'invalid_request', 'expected_revision must be a positive integer');
    const authorizedScopes = normalizeScopes(
      actor.scopeIds.filter((scopeId) => actor.tokenScopeIds.includes(scopeId)),
    );
    if (authorizedScopes.length === 0)
      throw new CoreError(403, 'forbidden', 'An authorized scope is required');
    const decisionPayloadHash = sha256(
      stableJson({
        review_id: reviewId,
        expected_revision: expectedRevision,
        decision,
        confirmation,
        reason,
      }),
    );
    const review = await this.withActor(
      actor,
      authorizedScopes,
      writeCapability,
      async (client) => {
        const result = await client.query<{
          scope_id: string;
          change_set_id: string;
          status: string;
          revision: number;
          job_id: string;
          proposal: ChangeSet | null;
          evidence_anchors: unknown;
          expected_revisions: unknown;
          candidate_summary: Record<string, unknown>;
          compartment_ids: string[];
        }>(
          `SELECT r.scope_id, r.change_set_id, r.status, r.revision, r.job_id, c.proposal, r.evidence_anchors,
           r.expected_revisions, r.candidate_summary, r.compartment_ids::text[] AS compartment_ids
         FROM curation_reviews r JOIN changesets c ON c.user_id = r.user_id AND c.scope_id = r.scope_id AND c.id = r.change_set_id
         WHERE r.user_id = $1 AND r.scope_id = ANY($2::uuid[]) AND r.id = $3 FOR UPDATE OF r`,
          [actor.userId, authorizedScopes, reviewId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new CoreError(404, 'not_found', 'Curation review not found');

        const sourceIdentity = await client.query<{ source_id: string }>(
          `SELECT s.id AS source_id
           FROM capture_jobs j
           JOIN sources s ON s.user_id = j.user_id AND s.scope_id = j.scope_id AND s.id = j.source_id
           WHERE j.user_id = $1 AND j.scope_id = $2 AND j.id = $3`,
          [actor.userId, row.scope_id, row.job_id],
        );
        const sourceId = sourceIdentity.rows[0]?.source_id;
        if (sourceId === undefined)
          throw new CoreError(403, 'source_not_authorized', 'The review source is unavailable');
        await this.lockSourcesForShare(client, [sourceId]);
        const sourceRights = await client.query<{ authorized: boolean }>(
          `SELECT (s.rights_status = 'granted' AND s.consent AND ca.enabled AND ca.consent
             AND NOT EXISTS (
               SELECT 1 FROM suppressions sp
               WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id
                 AND (sp.object_id = s.id OR sp.object_id IN (
                   SELECT jo.observation_id FROM capture_job_observations jo
                   WHERE jo.user_id = j.user_id AND jo.scope_id = j.scope_id AND jo.job_id = j.id
                 ))
             )) AS authorized
           FROM capture_jobs j
           JOIN sources s ON s.user_id = j.user_id AND s.scope_id = j.scope_id AND s.id = j.source_id
           JOIN connector_authorizations ca ON ca.user_id = s.user_id AND ca.scope_id = s.scope_id
             AND ca.source_kind = s.kind AND ca.external_id = s.external_id
           WHERE j.user_id = $1 AND j.scope_id = $2 AND j.id = $3`,
          [actor.userId, row.scope_id, row.job_id],
        );
        if (sourceRights.rows[0]?.authorized !== true)
          throw new CoreError(
            403,
            'source_not_authorized',
            'The review source is no longer authorized',
          );

        const prior = await client.query<{
          payload_hash: string;
          response: Record<string, unknown>;
        }>(
          `SELECT payload_hash, response FROM idempotency_keys
           WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
          [actor.userId, row.scope_id, actor.principalId, idempotencyKey],
        );
        const existing = prior.rows[0];
        if (existing !== undefined) {
          if (existing.payload_hash !== decisionPayloadHash)
            throw new CoreError(
              409,
              'idempotency_conflict',
              'This Idempotency-Key was already used for a different request',
            );
          return { replayedResponse: existing.response };
        }

        if (row.revision !== expectedRevision || row.status !== 'held')
          throw new CoreError(
            409,
            'review_revision_conflict',
            'Curation review is no longer awaiting this decision',
          );
        if (decision === 'reject') {
          await client.query(
            `UPDATE curation_reviews SET status = 'rejected', revision = revision + 1, decision_reason = $5,
             decision_by = $4, decision_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
            [actor.userId, row.scope_id, reviewId, actor.principalId, reason],
          );
          await client.query(
            `UPDATE capture_jobs SET state = 'held', last_error_code = 'user_rejected', lease_until = NULL,
             lease_token = NULL, updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND review_id = $3`,
            [actor.userId, row.scope_id, reviewId],
          );
          await client.query(
            `INSERT INTO audit_events(user_id, scope_id, principal_id, event_type, request_id, object_id, metadata)
           VALUES ($1, $2, $3, 'curation.review_rejected', $4::uuid, $5, $6::jsonb)`,
            [
              actor.userId,
              row.scope_id,
              actor.principalId,
              requestId,
              reviewId,
              JSON.stringify({ reason }),
            ],
          );
          const response = { review_id: reviewId, scope_id: row.scope_id, status: 'rejected' };
          await client.query(
            `INSERT INTO idempotency_keys(user_id, scope_id, principal_id, idempotency_key, payload_hash, response, change_set_id,
               compartment_ids)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid[])`,
            [
              actor.userId,
              row.scope_id,
              actor.principalId,
              idempotencyKey,
              decisionPayloadHash,
              JSON.stringify(response),
              row.change_set_id,
              row.compartment_ids,
            ],
          );
          return { replayedResponse: response };
        }
        if (
          row.proposal === null ||
          row.proposal.operations.some((operation) => operation.op !== 'CREATE')
        )
          throw new CoreError(
            409,
            'review_proposal_invalid',
            'Curation review does not contain a create-only proposal',
          );
        if (hasExistingCandidateMatch(row.candidate_summary))
          throw new CoreError(
            409,
            'manual_reconciliation_required',
            'This candidate matched existing memories. Reject this review, then use a Core ChangeSet such as CORROBORATE or SUPERSEDE.',
          );
        if (
          confirmation === 'user_statement' &&
          row.proposal.operations.some(
            (operation) =>
              operation.op !== 'CREATE' ||
              !['decision', 'preference'].includes(operation.memory.kind),
          )
        )
          throw new CoreError(
            400,
            'user_confirmation_not_allowed',
            'User statement confirmation only applies to decisions and preferences',
          );
        return {
          scopeId: row.scope_id,
          changeSetId: row.change_set_id,
          proposal: row.proposal,
          anchors: decodeCuratedAnchors(row.evidence_anchors),
          expectedRevisions: decodeExpectedRevisions(row.expected_revisions),
          label: row.compartment_ids,
        };
      },
    );
    if ('replayedResponse' in review) return review.replayedResponse;
    const result = await this.applyChangeSet(
      actor,
      review.proposal,
      requestId,
      idempotencyKey,
      review.changeSetId,
      {
        writerActorKind: 'curator',
        activate: true,
        userStatement: confirmation === 'user_statement',
        anchorsByOperation: review.anchors,
        // The reviewed proposal keeps the label of the observations it came from, not the
        // approving connection's default.
        label: { ids: review.label, origin: 'derived' },
        review: {
          id: reviewId,
          expectedRevision,
          confirmation,
          reason,
          principalId: actor.principalId,
          expectedRevisions: review.expectedRevisions,
          decisionPayloadHash,
        },
      },
    );
    return result;
  }

  async getMemory(
    actor: ActorContext,
    scopeId: string,
    memoryId: string,
    query: { readonly valid_at?: string | undefined; readonly known_at?: string | undefined },
  ): Promise<Record<string, unknown>> {
    validateUuid(scopeId, 'scope_id');
    validateUuid(memoryId, 'memory_id');
    return this.withActor(actor, [scopeId], readCapability, async (client) => {
      const memory = await this.loadMemory(client, actor, scopeId, memoryId, query);
      if (memory === null) throw new CoreError(404, 'not_found', 'Memory not found');
      return memory;
    });
  }

  async recall(actor: ActorContext, rawQuery: unknown): Promise<Record<string, unknown>> {
    const parsed = recallQuerySchema.safeParse(rawQuery);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Recall query does not match the API contract',
        false,
        parsed.error.issues,
      );
    const query = parsed.data;
    if (query.mode !== 'precise') {
      throw new CoreError(
        400,
        'unsupported_recall_mode',
        'This core endpoint currently supports exact precise recall only',
      );
    }
    const scopeIds = normalizeScopes(
      query.scope_ids.length === 0 ? actor.scopeIds : query.scope_ids,
    );
    if (scopeIds.length === 0)
      throw new CoreError(403, 'forbidden', 'Recall requires at least one authorized scope');

    return this.withActor(actor, scopeIds, readCapability, async (client) => {
      const normalizedQuery = normalizeName(query.query);
      const matchingRows = await client.query<MutableMemoryRow>(
        `SELECT m.id, m.user_id, m.scope_id,
           coalesce(v.kind, m.kind) AS kind,
           coalesce(v.statement, m.statement) AS statement,
           coalesce(v.context, m.context) AS context,
           coalesce(v.actor_kind, m.actor_kind) AS actor_kind,
           coalesce(v.authority, m.authority) AS authority,
           coalesce(v.epistemic_status, m.epistemic_status) AS epistemic_status,
           coalesce(v.contested, m.contested) AS contested,
           coalesce(v.lifecycle, m.lifecycle) AS lifecycle,
           CASE WHEN $6::timestamptz IS NULL THEN m.valid_from ELSE v.valid_from END AS valid_from,
           CASE WHEN $6::timestamptz IS NULL THEN m.valid_to ELSE v.valid_to END AS valid_to,
           coalesce(v.recorded_at, m.recorded_at) AS recorded_at,
           CASE WHEN $6::timestamptz IS NULL THEN m.superseded_at ELSE v.superseded_at END AS superseded_at,
           coalesce(v.revision, m.revision) AS revision,
           coalesce(v.revision, m.committed_revision) AS committed_revision,
           m.indexed_revision
         FROM memories AS m
         LEFT JOIN LATERAL (
           SELECT version.* FROM memory_versions AS version
           WHERE version.user_id = m.user_id AND version.scope_id = m.scope_id
             AND version.memory_id = m.id AND version.recorded_at <= $6
           ORDER BY version.revision DESC LIMIT 1
         ) AS v ON $6::timestamptz IS NOT NULL
         WHERE m.user_id = $1 AND m.scope_id = ANY($2::uuid[])
           AND ($6::timestamptz IS NULL OR v.revision IS NOT NULL)
           AND coalesce(v.lifecycle, m.lifecycle) = 'active'
           AND (lower(btrim(coalesce(v.statement, m.statement))) = lower(btrim($3)) OR EXISTS (
             SELECT 1 FROM memory_subjects AS ms
             JOIN subjects AS sub ON sub.user_id = ms.user_id AND sub.scope_id = ms.scope_id AND sub.id = ms.subject_id
             WHERE ms.user_id = m.user_id AND ms.scope_id = m.scope_id AND ms.memory_id = m.id
               AND sub.normalized_name = $4
           ) OR EXISTS (
             SELECT 1 FROM memory_subjects AS ms
             JOIN subject_aliases AS sa ON sa.user_id = ms.user_id AND sa.scope_id = ms.scope_id AND sa.subject_id = ms.subject_id
             WHERE ms.user_id = m.user_id AND ms.scope_id = m.scope_id AND ms.memory_id = m.id
               AND sa.normalized_alias = $4
               AND ($5::timestamptz IS NULL OR (sa.valid_from <= $5 AND (sa.valid_to IS NULL OR sa.valid_to > $5)))
           ))
           AND ($5::timestamptz IS NULL OR (CASE WHEN $6::timestamptz IS NULL THEN m.valid_from ELSE v.valid_from END) IS NULL
             OR (CASE WHEN $6::timestamptz IS NULL THEN m.valid_from ELSE v.valid_from END) <= $5)
           AND ($5::timestamptz IS NULL OR (CASE WHEN $6::timestamptz IS NULL THEN m.valid_to ELSE v.valid_to END) IS NULL
             OR (CASE WHEN $6::timestamptz IS NULL THEN m.valid_to ELSE v.valid_to END) > $5)
           AND NOT EXISTS (
             SELECT 1 FROM memory_version_evidence AS me
             JOIN evidence AS e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
             JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
             WHERE me.user_id = m.user_id AND me.scope_id = m.scope_id AND me.memory_id = m.id
               AND me.revision = coalesce(v.revision, m.revision)
               AND (src.rights_status <> 'granted' OR NOT src.consent
                 OR EXISTS (SELECT 1 FROM suppressions AS sp WHERE sp.user_id = src.user_id AND sp.scope_id = src.scope_id AND sp.object_id IN (m.id, src.id, e.id)))
           )
         ORDER BY coalesce(v.recorded_at, m.recorded_at) DESC, m.id
         LIMIT $7`,
        [
          actor.userId,
          scopeIds,
          query.query,
          normalizedQuery,
          query.valid_at ?? null,
          query.known_at ?? null,
          query.limit,
        ],
      );
      const matches: Record<string, unknown>[] = [];
      let tokenEstimate = 0;
      for (const row of matchingRows.rows) {
        let memory: Record<string, unknown>;
        try {
          memory = await this.hydrateMemory(client, row, query);
        } catch (error) {
          if (error instanceof CoreError && error.status === 404) continue;
          throw error;
        }
        const estimate = estimateTokens(memory);
        if (tokenEstimate + estimate > query.token_budget) continue;
        tokenEstimate += estimate;
        matches.push(memory);
      }
      return {
        query: query.query,
        mode: 'precise',
        exact: true,
        unknown: matches.length === 0,
        token_budget: query.token_budget,
        estimated_tokens: tokenEstimate,
        matches,
      };
    });
  }

  async getChanges(
    actor: ActorContext,
    rawQuery: unknown,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const parsed = changeFeedQuerySchema.safeParse(rawQuery);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Change feed query does not match the API contract',
        false,
        parsed.error.issues,
      );
    const query = parsed.data;
    const scopeIds = normalizeScopes(
      query.scope_ids.length === 0 ? actor.scopeIds : query.scope_ids,
    );
    if (scopeIds.length === 0)
      throw new CoreError(403, 'forbidden', 'Change feed requires at least one authorized scope');
    if (query.limit > this.maxPageSize)
      throw new CoreError(
        400,
        'invalid_request',
        `Change feed limit may not exceed ${this.maxPageSize}`,
      );

    return this.withActor(actor, scopeIds, readCapability, async (client) => {
      const cursor =
        query.cursor === undefined
          ? initialCursor(actor, scopeIds)
          : this.cursors.decode(query.cursor, {
              user: actor.userId,
              principal: actor.principalId,
              scopes: scopeIds,
            });
      // A cursor is bound to the allowance it was read under; another allowance starts afresh.
      if (!sameCompartmentBinding(cursor.compartments, cursorCompartments(actor))) {
        throw new CoreError(
          410,
          'cursor_expired',
          'The connection allowance changed; resynchronize this cursor',
          false,
          { resync_required: true },
        );
      }
      for (const scopeId of scopeIds) {
        const currentEpoch = actor.authEpochs[scopeId];
        if (currentEpoch === undefined || cursor.auth_epochs[scopeId] !== currentEpoch) {
          throw new CoreError(
            410,
            'cursor_expired',
            'Scope authorization changed; resynchronize this cursor',
            false,
            { resync_required: true },
          );
        }
      }
      const result = await client.query<{
        id: string;
        scope_id: string;
        seq: string;
        op: string;
        memory_id: string | null;
        memory_revision: number | null;
        tombstone: boolean;
        created_at: Date;
        label: string[];
        previous: string[] | null;
      }>(
        `SELECT id, scope_id, seq, op, memory_id, memory_revision, tombstone, created_at,
           compartment_ids::text[] AS label, previous_compartment_ids::text[] AS previous
         FROM change_log
         WHERE user_id = $1 AND scope_id = ANY($2::uuid[])
           AND seq > coalesce(($3::jsonb ->> scope_id::text)::bigint, 0)
         ORDER BY scope_id, seq
         LIMIT $4`,
        [actor.userId, scopeIds, JSON.stringify(cursor.offsets), query.limit + 1],
      );
      const hasMore = result.rows.length > query.limit;
      const page = result.rows.slice(0, query.limit);
      const offsets: Record<string, string> = { ...cursor.offsets };
      for (const row of page) offsets[row.scope_id] = row.seq;
      const nextCursor = this.cursors.encode({
        user: actor.userId,
        principal: actor.principalId,
        scopes: scopeIds,
        offsets,
        auth_epochs: Object.fromEntries(
          scopeIds.map((scopeId) => [scopeId, actor.authEpochs[scopeId]!]),
        ),
        compartments: cursorCompartments(actor),
      });
      // Events outside the reader's compartments are skipped; a narrowing that took a memory
      // out of them is reported once, without content.
      const allowed = allowanceIds(actor);
      const visible = page.flatMap((row) => {
        if (allowed === null || isSubsetLabel(row.label, allowed))
          return [{ row, withdrawn: false }];
        if (row.previous !== null && isSubsetLabel(row.previous, allowed))
          return [{ row, withdrawn: true }];
        return [];
      });
      await client.query(
        `INSERT INTO audit_events(user_id, scope_id, principal_id, event_type, request_id, metadata)
         SELECT $1, requested.scope_id, $2, 'changes.read', $3, $4::jsonb FROM unnest($5::uuid[]) AS requested(scope_id)`,
        [
          actor.userId,
          actor.principalId,
          requestId,
          JSON.stringify({ returned: page.length }),
          scopeIds,
        ],
      );
      return {
        changes: visible.map(({ row, withdrawn }) => ({
          id: row.id,
          scope_id: row.scope_id,
          sequence: row.seq,
          operation: withdrawn ? 'WITHDRAWN' : row.op,
          memory_id: row.memory_id,
          revision: withdrawn ? null : row.memory_revision,
          tombstone: withdrawn ? true : row.tombstone,
          occurred_at: row.created_at.toISOString(),
        })),
        next_cursor: nextCursor,
        has_more: hasMore,
      };
    });
  }

  private async applyOperation(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    changeSetId: string,
    operation: ChangeOp,
    internalOptions?: InternalCommitOptions,
    operationOrdinal = 0,
  ): Promise<{ events: EventToWrite[]; result: OperationResult }> {
    switch (operation.op) {
      case 'CREATE': {
        const label =
          internalOptions?.label === undefined
            ? await this.writeLabelFor(client, actor, operation.memory.compartments)
            : { ...internalOptions.label, held: false };
        const created = await this.createMemory(
          client,
          actor,
          scopeId,
          changeSetId,
          operation.memory,
          label,
          internalOptions,
          operationOrdinal,
        );
        const memory = await this.loadMemory(client, actor, scopeId, created.id, {});
        if (memory === null)
          throw new CoreError(500, 'internal_error', 'The committed memory could not be read');
        return {
          events: [{ op: 'CREATE', memoryId: created.id, revision: 1, tombstone: false }],
          result: {
            op: operation.op,
            memory_ids: [created.id],
            revisions: [1],
            changed: true,
            compartment_ids: created.label,
            held: label.held,
          },
        };
      }
      case 'CORROBORATE': {
        const memory = await this.lockMutableMemory(
          client,
          actor,
          scopeId,
          operation.memory_id,
          operation.expected_revision,
        );
        const added: (readonly string[])[] = [];
        for (let evidenceIndex = 0; evidenceIndex < operation.evidence.length; evidenceIndex += 1) {
          const evidence = operation.evidence[evidenceIndex];
          if (evidence === undefined) continue;
          const attached = await this.attachEvidence(
            client,
            actor,
            scopeId,
            memory.id,
            evidence,
            memory.compartment_ids,
            internalOptions?.anchorsByOperation?.[operationOrdinal]?.[evidenceIndex],
          );
          added.push(attached.label);
        }
        const revision = await this.incrementRevision(
          client,
          actor,
          memory,
          changeSetId,
          unionLabels(...added),
        );
        return {
          events: [{ op: operation.op, memoryId: memory.id, revision, tombstone: false }],
          result: {
            op: operation.op,
            memory_ids: [memory.id],
            revisions: [revision],
            changed: true,
          },
        };
      }
      case 'REFINE': {
        const memory = await this.lockMutableMemory(
          client,
          actor,
          scopeId,
          operation.memory_id,
          operation.expected_revision,
        );
        if (
          actor.actorKind !== 'user' &&
          ['user_decision', 'user_preference', 'user_assertion'].includes(memory.authority)
        ) {
          throw new CoreError(
            403,
            'user_confirmation_required',
            'Only the User may refine an User-attributed active memory',
          );
        }
        const refineLabels: (readonly string[])[] = [];
        for (const evidence of operation.evidence)
          refineLabels.push(
            (
              await this.attachEvidence(
                client,
                actor,
                scopeId,
                memory.id,
                evidence,
                memory.compartment_ids,
              )
            ).label,
          );
        const lifecycle =
          actor.actorKind === 'user' && operation.epistemic_status !== 'proposed'
            ? memory.lifecycle === 'candidate'
              ? 'active'
              : memory.lifecycle
            : 'candidate';
        const status =
          actor.actorKind === 'user'
            ? (operation.epistemic_status ?? memory.epistemic_status)
            : 'proposed';
        const authority = deriveAuthority(actor.actorKind, memory.kind, status);
        const nextRevision = memory.revision + 1;
        await client.query(
          `UPDATE memories SET statement = $4, context = $5::jsonb, valid_from = $6, valid_to = $7,
             actor_kind = $8, authority = $9, epistemic_status = $10, lifecycle = $11,
             revision = $12, committed_revision = $12, updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
          [
            actor.userId,
            scopeId,
            memory.id,
            operation.statement ?? memory.statement,
            JSON.stringify(operation.context ?? memory.context),
            operation.valid_from === undefined ? memory.valid_from : operation.valid_from,
            operation.valid_to === undefined ? memory.valid_to : operation.valid_to,
            actor.actorKind,
            authority,
            status,
            lifecycle,
            nextRevision,
          ],
        );
        await this.writeVersion(
          client,
          actor,
          scopeId,
          memory.id,
          changeSetId,
          'inherited',
          unionLabels(...refineLabels),
        );
        return {
          events: [
            { op: operation.op, memoryId: memory.id, revision: nextRevision, tombstone: false },
          ],
          result: {
            op: operation.op,
            memory_ids: [memory.id],
            revisions: [nextRevision],
            changed: true,
          },
        };
      }
      case 'SUPERSEDE': {
        if (actor.actorKind !== 'user')
          throw new CoreError(403, 'forbidden', 'Only the User may supersede an active memory');
        const oldMemory = await this.lockMutableMemory(
          client,
          actor,
          scopeId,
          operation.memory_id,
          operation.expected_revision,
        );
        const replacement = parseMemory(operation.replacement);
        const cutover =
          replacement.valid_from === null
            ? (await client.query<{ cutover: Date }>('SELECT clock_timestamp() AS cutover')).rows[0]
                ?.cutover
            : new Date(replacement.valid_from);
        if (cutover === undefined || Number.isNaN(cutover.getTime())) {
          throw new CoreError(503, 'database_error', 'Unable to determine supersede valid time');
        }
        if (oldMemory.valid_from !== null && cutover <= oldMemory.valid_from) {
          throw new CoreError(
            409,
            'invalid_supersede_interval',
            'The replacement must start after the existing memory starts',
          );
        }
        if (
          replacement.valid_to !== null &&
          new Date(replacement.valid_to).getTime() <= cutover.getTime()
        ) {
          throw new CoreError(
            409,
            'invalid_supersede_interval',
            'The replacement must remain valid after its start time',
          );
        }
        const replacementAt = { ...replacement, valid_from: cutover.toISOString() };
        // A replacement is derived from what it replaces, so it keeps at least its label.
        const replacementLabel = await this.writeLabelFor(
          client,
          actor,
          operation.replacement.compartments,
        );
        const replacementId = (
          await this.createMemory(client, actor, scopeId, changeSetId, replacementAt, {
            ...replacementLabel,
            ids: unionLabels(replacementLabel.ids, oldMemory.compartment_ids),
          })
        ).id;
        const oldRevision = oldMemory.revision + 1;
        await client.query(
          `UPDATE memories SET lifecycle = 'superseded', superseded_at = clock_timestamp(),
             valid_to = least(coalesce(valid_to, $4), $4), revision = $5, committed_revision = $5,
             updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
          [actor.userId, scopeId, oldMemory.id, cutover.toISOString(), oldRevision],
        );
        await this.writeVersion(client, actor, scopeId, oldMemory.id, changeSetId, 'inherited');
        await client.query(
          `INSERT INTO relations(user_id, scope_id, from_memory_id, to_memory_id, relation, context, created_by)
           VALUES ($1, $2, $3, $4, 'supersedes', '{}'::jsonb, $5)`,
          [actor.userId, scopeId, replacementId, oldMemory.id, actor.principalId],
        );
        return {
          events: [
            { op: operation.op, memoryId: oldMemory.id, revision: oldRevision, tombstone: false },
            { op: 'CREATE', memoryId: replacementId, revision: 1, tombstone: false },
          ],
          result: {
            op: operation.op,
            memory_ids: [oldMemory.id, replacementId],
            revisions: [oldRevision, 1],
            changed: true,
          },
        };
      }
      case 'CONTEST': {
        const memory = await this.lockMutableMemory(
          client,
          actor,
          scopeId,
          operation.memory_id,
          operation.expected_revision,
        );
        const contestLabels: (readonly string[])[] = [];
        for (const evidence of operation.evidence)
          contestLabels.push(
            (
              await this.attachEvidence(
                client,
                actor,
                scopeId,
                memory.id,
                evidence,
                memory.compartment_ids,
              )
            ).label,
          );
        const reasons = Array.isArray(memory.context['contest_reasons'])
          ? memory.context['contest_reasons']
          : [];
        const context = { ...memory.context, contest_reasons: [...reasons, operation.reason] };
        const nextRevision = memory.revision + 1;
        await client.query(
          `UPDATE memories SET contested = true, context = $4::jsonb, revision = $5,
             committed_revision = $5, updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
          [actor.userId, scopeId, memory.id, JSON.stringify(context), nextRevision],
        );
        await this.writeVersion(
          client,
          actor,
          scopeId,
          memory.id,
          changeSetId,
          'inherited',
          unionLabels(...contestLabels),
        );
        return {
          events: [
            { op: operation.op, memoryId: memory.id, revision: nextRevision, tombstone: false },
          ],
          result: {
            op: operation.op,
            memory_ids: [memory.id],
            revisions: [nextRevision],
            changed: true,
          },
        };
      }
      case 'RELATE': {
        const ids = [operation.from_memory_id, operation.to_memory_id].sort();
        if (ids[0] === ids[1])
          throw new CoreError(400, 'invalid_request', 'A memory cannot be related to itself');
        const rows = await client.query<MutableMemoryRow>(
          `SELECT m.* FROM memories AS m
           WHERE user_id = $1 AND scope_id = $2 AND id = ANY($3::uuid[])
             AND NOT EXISTS (SELECT 1 FROM suppressions AS hidden WHERE hidden.user_id = m.user_id
               AND hidden.scope_id = m.scope_id AND hidden.object_kind = 'memory' AND hidden.object_id = m.id)
             AND NOT EXISTS (
               SELECT 1 FROM memory_evidence me JOIN evidence e
                 ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
               JOIN sources s ON s.user_id = e.user_id AND s.scope_id = e.scope_id AND s.id = e.source_id
               WHERE me.user_id = m.user_id AND me.scope_id = m.scope_id AND me.memory_id = m.id
                 AND (s.rights_status <> 'granted' OR NOT s.consent)
             )
           ORDER BY id FOR UPDATE`,
          [actor.userId, scopeId, ids],
        );
        if (rows.rows.length !== 2)
          throw new CoreError(404, 'not_found', 'Related memory not found');
        const byId = new Map(rows.rows.map((row) => [row.id, row]));
        const from = byId.get(operation.from_memory_id);
        const to = byId.get(operation.to_memory_id);
        if (from === undefined || to === undefined)
          throw new CoreError(404, 'not_found', 'Related memory not found');
        await this.lockMemorySources(client, actor, scopeId, ids);
        if (
          from.revision !== operation.from_expected_revision ||
          to.revision !== operation.to_expected_revision
        ) {
          throw new CoreError(409, 'revision_conflict', 'A related memory revision is stale', true);
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO relations(user_id, scope_id, from_memory_id, to_memory_id, relation, context, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (user_id, scope_id, from_memory_id, to_memory_id, relation) DO NOTHING
           RETURNING id`,
          [
            actor.userId,
            scopeId,
            from.id,
            to.id,
            operation.relation,
            JSON.stringify(operation.context),
            actor.principalId,
          ],
        );
        if (inserted.rowCount === 0) {
          return {
            events: [],
            result: {
              op: operation.op,
              memory_ids: [from.id, to.id],
              revisions: [from.revision, to.revision],
              changed: false,
            },
          };
        }
        const nextFrom = await this.incrementRevision(client, actor, from, changeSetId);
        const nextTo = await this.incrementRevision(client, actor, to, changeSetId);
        return {
          events: [
            { op: operation.op, memoryId: from.id, revision: nextFrom, tombstone: false },
            { op: operation.op, memoryId: to.id, revision: nextTo, tombstone: false },
          ],
          result: {
            op: operation.op,
            memory_ids: [from.id, to.id],
            revisions: [nextFrom, nextTo],
            changed: true,
          },
        };
      }
      case 'RETRACT': {
        if (actor.actorKind !== 'user')
          throw new CoreError(403, 'forbidden', 'Only the User may retract a memory');
        const memory = await this.lockMutableMemory(
          client,
          actor,
          scopeId,
          operation.memory_id,
          operation.expected_revision,
        );
        const revision = memory.revision + 1;
        await client.query(
          `UPDATE memories SET lifecycle = 'retracted', revision = $4, committed_revision = $4, updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
          [actor.userId, scopeId, memory.id, revision],
        );
        await this.writeVersion(client, actor, scopeId, memory.id, changeSetId, 'inherited');
        return {
          events: [{ op: operation.op, memoryId: memory.id, revision, tombstone: true }],
          result: {
            op: operation.op,
            memory_ids: [memory.id],
            revisions: [revision],
            changed: true,
          },
        };
      }
      case 'RECLASSIFY': {
        const memory = await this.lockMutableMemory(
          client,
          actor,
          scopeId,
          operation.memory_id,
          operation.expected_revision,
        );
        const target = await resolveCompartments(client, actor, operation.compartments);
        const current = canonicalLabel(memory.compartment_ids);
        const narrowing = isSubsetLabel(current, target);
        if (narrowing && isSubsetLabel(target, current)) {
          return {
            events: [],
            result: {
              op: operation.op,
              memory_ids: [memory.id],
              revisions: [memory.revision],
              changed: false,
            },
          };
        }
        // Adding a compartment only restricts; removing one widens who receives the memory.
        if (!narrowing && actor.actorKind !== 'user') {
          throw new CoreError(
            403,
            'user_confirmation_required',
            "Removing a compartment from a memory needs the person's approval; request a user decision",
          );
        }
        const nextRevision = memory.revision + 1;
        await client.query(
          `UPDATE memories SET compartment_ids = $4::uuid[], revision = $5, committed_revision = $5,
             updated_at = clock_timestamp()
           WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
          [actor.userId, scopeId, memory.id, target, nextRevision],
        );
        await this.writeVersion(
          client,
          actor,
          scopeId,
          memory.id,
          changeSetId,
          narrowing ? 'reclassified' : 'relaxed',
        );
        return {
          events: [
            {
              op: operation.op,
              memoryId: memory.id,
              revision: nextRevision,
              tombstone: false,
              ...(narrowing ? { previousLabel: current } : {}),
            },
          ],
          result: {
            op: operation.op,
            memory_ids: [memory.id],
            revisions: [nextRevision],
            changed: true,
            compartment_ids: target,
          },
        };
      }
      case 'NO_OP':
        return {
          events: [],
          result: { op: operation.op, memory_ids: [], revisions: [], changed: false },
        };
    }
  }

  /** Resolves a write's requested compartments and applies the connection's labeling rules. */
  private async writeLabelFor(
    client: PoolClient,
    actor: ActorContext,
    refs: readonly string[] | undefined,
  ): Promise<WriteLabel> {
    return resolveWriteLabel(
      actor,
      refs === undefined ? undefined : await resolveCompartments(client, actor, refs),
    );
  }

  /**
   * Creates a memory with its requested label joined with the labels of its evidence. Subjects
   * are attached afterwards under the final label, so a subject never reveals more than its
   * memory.
   */
  private async createMemory(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    changeSetId: string,
    input: MemoryInput,
    label: WriteLabel,
    internalOptions?: InternalCommitOptions,
    operationOrdinal = 0,
  ): Promise<{ readonly id: string; readonly label: string[] }> {
    validateMemoryTime(input);
    const writeActorKind = internalOptions?.writerActorKind ?? actor.actorKind;
    const epistemicStatus = internalOptions?.userStatement ? 'asserted' : input.epistemic_status;
    const authority = deriveAuthority(
      internalOptions?.userStatement ? 'user' : writeActorKind,
      input.kind,
      epistemicStatus,
    );
    const lifecycle =
      internalOptions?.activate === true
        ? 'active'
        : actor.actorKind === 'user' && input.epistemic_status !== 'proposed'
          ? 'active'
          : 'candidate';
    const result = await client.query<{ id: string }>(
      `INSERT INTO memories(user_id, scope_id, kind, statement, context, actor_kind, authority,
        epistemic_status, contested, lifecycle, valid_from, valid_to, created_by, compartment_ids)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid[])
       RETURNING id`,
      [
        actor.userId,
        scopeId,
        input.kind,
        input.statement,
        JSON.stringify(input.context),
        writeActorKind,
        authority,
        epistemicStatus,
        input.contested,
        lifecycle,
        input.valid_from,
        input.valid_to,
        actor.principalId,
        canonicalLabel(label.ids),
      ],
    );
    const memoryId = result.rows[0]?.id;
    if (memoryId === undefined)
      throw new CoreError(500, 'internal_error', 'Memory insert did not return an identifier');
    const anchors = internalOptions?.anchorsByOperation?.[operationOrdinal] ?? [];
    const evidenceLabels: (readonly string[])[] = [];
    for (let evidenceIndex = 0; evidenceIndex < input.evidence.length; evidenceIndex += 1) {
      const evidence = input.evidence[evidenceIndex];
      if (evidence === undefined) continue;
      const anchor = anchors[evidenceIndex];
      evidenceLabels.push(
        (await this.attachEvidence(client, actor, scopeId, memoryId, evidence, label.ids, anchor))
          .label,
      );
    }
    const finalLabel = unionLabels(label.ids, ...evidenceLabels);
    if (finalLabel.length !== label.ids.length) {
      await client.query(
        `UPDATE memories SET compartment_ids = $4::uuid[]
         WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, scopeId, memoryId, finalLabel],
      );
    }
    for (const subject of input.subjects) {
      const subjectId = await this.ensureSubject(
        client,
        actor,
        scopeId,
        subject.name,
        input.valid_from,
        finalLabel,
      );
      await client.query(
        'INSERT INTO memory_subjects(user_id, scope_id, memory_id, subject_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [actor.userId, scopeId, memoryId, subjectId],
      );
      await this.ensureAlias(
        client,
        actor,
        scopeId,
        subjectId,
        subject.name,
        null,
        null,
        finalLabel,
      );
      for (const alias of subject.aliases) {
        await this.ensureAlias(
          client,
          actor,
          scopeId,
          subjectId,
          alias.name,
          alias.valid_from,
          alias.valid_to,
          finalLabel,
        );
      }
    }
    await this.writeVersion(client, actor, scopeId, memoryId, changeSetId, label.origin);
    return { id: memoryId, label: finalLabel };
  }

  private async ensureSubject(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    name: string,
    validAt: string | null,
    label: readonly string[],
  ): Promise<string> {
    // Subjects are keyed by label: the same name under another label is another subject.
    const normalized = normalizeName(name);
    const at = validAt ?? new Date().toISOString();
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM subjects WHERE user_id = $1 AND scope_id = $2 AND normalized_name = $3
         AND compartment_ids = $5::uuid[]
       UNION
       SELECT subject_id AS id FROM subject_aliases
       WHERE user_id = $1 AND scope_id = $2 AND normalized_alias = $3
         AND compartment_ids = $5::uuid[]
         AND valid_from <= $4 AND (valid_to IS NULL OR valid_to > $4)
       LIMIT 1`,
      [actor.userId, scopeId, normalized, at, canonicalLabel(label)],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0].id;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO subjects(user_id, scope_id, canonical_name, normalized_name, compartment_ids)
       VALUES ($1, $2, $3, $4, $5::uuid[])
       ON CONFLICT (user_id, scope_id, compartment_ids, normalized_name) DO NOTHING RETURNING id`,
      [actor.userId, scopeId, name.trim(), normalized, canonicalLabel(label)],
    );
    if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
    const conflict = await client.query<{ id: string }>(
      `SELECT id FROM subjects WHERE user_id = $1 AND scope_id = $2 AND normalized_name = $3
         AND compartment_ids = $4::uuid[]`,
      [actor.userId, scopeId, normalized, canonicalLabel(label)],
    );
    if (conflict.rows[0] !== undefined) return conflict.rows[0].id;
    throw new CoreError(409, 'subject_conflict', 'The subject name overlaps an existing alias');
  }

  private async ensureAlias(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    subjectId: string,
    alias: string,
    validFrom: string | null,
    validTo: string | null,
    label: readonly string[],
  ): Promise<void> {
    if (validFrom !== null && validTo !== null && Date.parse(validTo) <= Date.parse(validFrom)) {
      throw new CoreError(
        400,
        'invalid_request',
        'Subject alias valid_to must be later than valid_from',
      );
    }
    const normalized = normalizeName(alias);
    const from = validFrom ?? '-infinity';
    const existing = await client.query<{ subject_id: string }>(
      `SELECT subject_id FROM subject_aliases
       WHERE user_id = $1 AND scope_id = $2 AND normalized_alias = $3 AND compartment_ids = $6::uuid[]
         AND valid_from = $4::timestamptz AND valid_to IS NOT DISTINCT FROM $5::timestamptz`,
      [actor.userId, scopeId, normalized, from, validTo, canonicalLabel(label)],
    );
    const current = existing.rows[0];
    if (current !== undefined) {
      if (current.subject_id !== subjectId)
        throw new CoreError(
          409,
          'subject_alias_conflict',
          'The alias already belongs to another subject',
        );
      return;
    }
    const overlapping = await client.query<{ subject_id: string }>(
      `SELECT subject_id FROM subject_aliases
       WHERE user_id = $1 AND scope_id = $2 AND normalized_alias = $3 AND compartment_ids = $6::uuid[]
         AND tstzrange(valid_from, coalesce(valid_to, 'infinity'::timestamptz), '[)') &&
             tstzrange($4::timestamptz, coalesce($5::timestamptz, 'infinity'::timestamptz), '[)')
       LIMIT 1`,
      [actor.userId, scopeId, normalized, from, validTo, canonicalLabel(label)],
    );
    if (overlapping.rows[0] !== undefined)
      throw new CoreError(
        409,
        'subject_alias_conflict',
        'The alias overlaps another subject name in time',
      );
    await client.query(
      `INSERT INTO subject_aliases(user_id, scope_id, subject_id, alias, normalized_alias, valid_from, valid_to,
         compartment_ids)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::uuid[])`,
      [
        actor.userId,
        scopeId,
        subjectId,
        alias.trim(),
        normalized,
        from,
        validTo,
        canonicalLabel(label),
      ],
    );
  }

  private async attachEvidence(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    memoryId: string,
    evidence: EvidenceInput,
    newSourceLabel: readonly string[],
    anchor?: CuratedEvidenceAnchor,
  ): Promise<{ readonly id: string; readonly label: string[] }> {
    // Evidence carries its source's label. An explicit remember creates its source under the
    // label of the memory it supports.
    const sourceInput = evidence.source;
    const sourceDigests =
      this.forgetHmacKey === undefined
        ? []
        : [
            sourceIdentityDigest(
              this.forgetHmacKey,
              scopeId,
              sourceInput.kind,
              sourceInput.external_id,
              sourceInput.revision,
            ),
            observationLocatorDigest(
              this.forgetHmacKey,
              scopeId,
              sourceInput.kind,
              sourceInput.external_id,
              sourceInput.revision,
              sourceInput.locator,
            ),
          ];
    const suppression =
      this.forgetHmacKey === undefined
        ? await client.query<{ present: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM suppressions WHERE user_id = $1 AND scope_id = $2
            AND object_kind = 'locator_hmac' AND locator_hmac IS NOT NULL) AS present`,
            [actor.userId, scopeId],
          )
        : await client.query<{ present: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM suppressions WHERE user_id = $1 AND scope_id = $2
            AND object_kind = 'locator_hmac' AND locator_hmac = ANY($3::text[])) AS present`,
            [actor.userId, scopeId, sourceDigests],
          );
    if (suppression.rows[0]?.present === true) {
      throw new CoreError(
        this.forgetHmacKey === undefined ? 503 : 403,
        this.forgetHmacKey === undefined ? 'forget_key_unavailable' : 'source_suppressed',
        this.forgetHmacKey === undefined
          ? 'Source suppression cannot be checked without the configured key'
          : 'This source is no longer available for memory use',
        this.forgetHmacKey === undefined,
      );
    }
    interface SourceRow {
      id: string;
      rights_status: string;
      consent: boolean;
      lineage_root: string | null;
      compartment_ids: string[];
    }
    const sourceByIdentity = () =>
      client.query<SourceRow>(
        `SELECT id, rights_status, consent, lineage_root, compartment_ids::text[] AS compartment_ids
         FROM sources
       WHERE user_id = $1 AND scope_id = $2 AND kind = $3 AND external_id = $4 AND revision = $5`,
        [actor.userId, scopeId, sourceInput.kind, sourceInput.external_id, sourceInput.revision],
      );
    let source = await sourceByIdentity();
    if (source.rows[0] === undefined && sourceInput.kind === 'explicit_remember') {
      await client.query(
        `INSERT INTO sources(user_id, scope_id, kind, external_id, revision, rights_status, consent,
           compartment_ids)
         VALUES ($1, $2, 'explicit_remember', $3, $4, 'granted', true, $5::uuid[])
         ON CONFLICT (user_id, scope_id, kind, external_id, revision) DO NOTHING`,
        [
          actor.userId,
          scopeId,
          sourceInput.external_id,
          sourceInput.revision,
          canonicalLabel(newSourceLabel),
        ],
      );
      source = await sourceByIdentity();
    }
    const identifiedSource = source.rows[0];
    if (identifiedSource !== undefined) {
      await client.query('SELECT app.lock_source_for_share($1::uuid)', [identifiedSource.id]);
      source = await client.query<SourceRow>(
        `SELECT id, rights_status, consent, lineage_root, compartment_ids::text[] AS compartment_ids
         FROM sources
         WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, scopeId, identifiedSource.id],
      );
    }
    const sourceRow = source.rows[0];
    if (sourceRow === undefined)
      throw new CoreError(
        403,
        'source_not_authorized',
        'The source is not registered for this scope',
      );
    if (sourceRow.rights_status !== 'granted' || !sourceRow.consent) {
      throw new CoreError(403, 'source_forbidden', 'The source no longer permits memory use');
    }
    if (anchor !== undefined) {
      const observation = await client.query<{
        source_id: string;
        source_revision: string;
        locator: string;
        content: string;
      }>(
        `SELECT source_id, source_revision, locator, content FROM observations
         WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, scopeId, anchor.observationId],
      );
      const observed = observation.rows[0];
      const anchoredSpan = observed?.content.slice(anchor.spanStart, anchor.spanEnd);
      if (
        observed === undefined ||
        observed.source_id !== sourceRow.id ||
        observed.source_revision !== sourceInput.revision ||
        observed.locator !== sourceInput.locator ||
        anchoredSpan === undefined ||
        anchoredSpan !== evidence.span
      ) {
        throw new CoreError(
          409,
          'invalid_evidence_anchor',
          'Curated evidence no longer matches its immutable source observation',
        );
      }
    }
    const contentHash = sha256(
      stableJson({
        locator: sourceInput.locator,
        span: evidence.span ?? null,
        speaker: evidence.speaker ?? null,
        event_time: evidence.event_time ?? null,
        snippet: evidence.snippet ?? null,
        ...(anchor === undefined
          ? {}
          : {
              observation_id: anchor.observationId,
              span_start: anchor.spanStart,
              span_end: anchor.spanEnd,
            }),
      }),
    );
    const insert = await client.query<{ id: string }>(
      `INSERT INTO evidence(user_id, scope_id, source_id, source_revision, locator, span, speaker,
         captured_at, event_time, lineage_root, snippet, snippet_allowed, content_hash,
         observation_id, span_start, span_end, compartment_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, clock_timestamp()), $9,
         coalesce($10::uuid, $3::uuid), $11, $12, $13, $14, $15, $16, $17::uuid[])
       ON CONFLICT (user_id, scope_id, source_id, source_revision, locator, content_hash) DO NOTHING
       RETURNING id`,
      [
        actor.userId,
        scopeId,
        sourceRow.id,
        sourceInput.revision,
        sourceInput.locator,
        evidence.span ?? null,
        evidence.speaker ?? null,
        evidence.captured_at ?? null,
        evidence.event_time ?? null,
        sourceRow.lineage_root,
        evidence.snippet_allowed ? (evidence.snippet ?? null) : null,
        evidence.snippet_allowed,
        contentHash,
        anchor?.observationId ?? null,
        anchor?.spanStart ?? null,
        anchor?.spanEnd ?? null,
        sourceRow.compartment_ids,
      ],
    );
    let evidenceId = insert.rows[0]?.id;
    let evidenceLabel = sourceRow.compartment_ids;
    if (evidenceId === undefined) {
      const found = await client.query<{
        id: string;
        observation_id: string | null;
        span_start: number | null;
        span_end: number | null;
        compartment_ids: string[];
      }>(
        `SELECT id, observation_id, span_start, span_end, compartment_ids::text[] AS compartment_ids
         FROM evidence WHERE user_id = $1 AND scope_id = $2 AND source_id = $3
           AND source_revision = $4 AND locator = $5 AND content_hash = $6`,
        [
          actor.userId,
          scopeId,
          sourceRow.id,
          sourceInput.revision,
          sourceInput.locator,
          contentHash,
        ],
      );
      const existingEvidence = found.rows[0];
      if (
        anchor !== undefined &&
        (existingEvidence?.observation_id !== anchor.observationId ||
          existingEvidence.span_start !== anchor.spanStart ||
          existingEvidence.span_end !== anchor.spanEnd)
      ) {
        throw new CoreError(
          409,
          'invalid_evidence_anchor',
          'Stored evidence has a different source observation anchor',
        );
      }
      evidenceId = existingEvidence?.id;
      evidenceLabel = existingEvidence?.compartment_ids ?? evidenceLabel;
    }
    if (evidenceId === undefined)
      throw new CoreError(500, 'internal_error', 'Evidence insert did not return an identifier');
    await client.query(
      `INSERT INTO memory_evidence(user_id, scope_id, memory_id, evidence_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [actor.userId, scopeId, memoryId, evidenceId],
    );
    return { id: evidenceId, label: canonicalLabel(evidenceLabel) };
  }

  private async lockMutableMemory(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    memoryId: string,
    expectedRevision: number,
  ): Promise<MutableMemoryRow> {
    const result = await client.query<MutableMemoryRow>(
      `SELECT m.* FROM memories AS m
       WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = $3
         AND NOT EXISTS (SELECT 1 FROM suppressions AS hidden WHERE hidden.user_id = m.user_id
           AND hidden.scope_id = m.scope_id AND hidden.object_kind = 'memory' AND hidden.object_id = m.id)
         AND NOT EXISTS (
           SELECT 1 FROM memory_evidence AS me
           JOIN evidence AS e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
           JOIN sources AS s ON s.user_id = e.user_id AND s.scope_id = e.scope_id AND s.id = e.source_id
           WHERE me.user_id = m.user_id AND me.scope_id = m.scope_id AND me.memory_id = m.id
             AND (s.rights_status <> 'granted' OR NOT s.consent
               OR EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id AND sp.object_id IN (m.id, s.id, e.id)))
         )
       FOR UPDATE`,
      [actor.userId, scopeId, memoryId],
    );
    const memory = result.rows[0];
    if (memory === undefined) throw new CoreError(404, 'not_found', 'Memory not found');
    await this.lockMemorySources(client, actor, scopeId, [memory.id]);
    if (memory.revision !== expectedRevision) {
      throw new CoreError(409, 'revision_conflict', 'The expected memory revision is stale', true, {
        expected: expectedRevision,
        actual: memory.revision,
      });
    }
    if (
      memory.lifecycle === 'forgotten' ||
      memory.lifecycle === 'retracted' ||
      memory.lifecycle === 'superseded'
    ) {
      throw new CoreError(
        409,
        'memory_not_mutable',
        'Superseded, retracted, or forgotten memories cannot be changed',
      );
    }
    return memory;
  }

  private async lockMemorySources(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    memoryIds: readonly string[],
  ): Promise<void> {
    const sourceIds = await client.query<{ source_id: string }>(
      `SELECT DISTINCT src.id AS source_id
       FROM memory_evidence AS me
       JOIN evidence AS e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
       JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
       WHERE me.user_id = $1 AND me.scope_id = $2 AND me.memory_id = ANY($3::uuid[])
       ORDER BY src.id`,
      [actor.userId, scopeId, memoryIds],
    );
    await this.lockSourcesForShare(
      client,
      sourceIds.rows.map((row) => row.source_id),
    );
    const sources = await client.query<{
      rights_status: string;
      consent: boolean;
      suppressed: boolean;
    }>(
      `SELECT src.rights_status, src.consent,
         EXISTS (
           SELECT 1 FROM suppressions AS sp
           WHERE sp.user_id = src.user_id AND sp.scope_id = src.scope_id
             AND sp.object_id IN (me.memory_id, src.id, e.id)
         ) AS suppressed
       FROM memory_evidence AS me
       JOIN evidence AS e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
       JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
       WHERE me.user_id = $1 AND me.scope_id = $2 AND me.memory_id = ANY($3::uuid[])
       ORDER BY src.id, me.memory_id, e.id`,
      [actor.userId, scopeId, memoryIds],
    );
    if (
      sources.rows.some(
        (source) => source.rights_status !== 'granted' || !source.consent || source.suppressed,
      )
    ) {
      throw new CoreError(404, 'not_found', 'Memory not found');
    }
  }

  private async lockSourcesForShare(
    client: PoolClient,
    sourceIds: readonly string[],
  ): Promise<void> {
    for (const sourceId of [...new Set(sourceIds)].sort()) {
      await client.query('SELECT app.lock_source_for_share($1::uuid)', [sourceId]);
    }
  }

  private async incrementRevision(
    client: PoolClient,
    actor: ActorContext,
    memory: MutableMemoryRow,
    changeSetId: string,
    addedLabel: readonly string[] = [],
  ): Promise<number> {
    const revision = memory.revision + 1;
    await client.query(
      `UPDATE memories SET revision = $4, committed_revision = $4, updated_at = clock_timestamp()
       WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
      [actor.userId, memory.scope_id, memory.id, revision],
    );
    await this.writeVersion(
      client,
      actor,
      memory.scope_id,
      memory.id,
      changeSetId,
      'inherited',
      addedLabel,
    );
    return revision;
  }

  private async writeVersion(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    memoryId: string,
    changeSetId: string,
    origin: LabelOrigin,
    addedLabel: readonly string[] = [],
  ): Promise<void> {
    // A version keeps the memory's label joined with the labels of evidence added by this
    // change. Only an approved relaxation lowers a label, by setting it before this call.
    if (addedLabel.length > 0) {
      await client.query(
        `UPDATE memories SET compartment_ids = ARRAY(
           SELECT DISTINCT item FROM unnest(compartment_ids || $4::uuid[]) AS item ORDER BY item)
         WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, scopeId, memoryId, canonicalLabel(addedLabel)],
      );
    }
    await client.query(
      `INSERT INTO memory_versions(user_id, scope_id, memory_id, revision, kind, statement, context,
         actor_kind, authority, epistemic_status, contested, lifecycle, valid_from, valid_to,
         recorded_at, superseded_at, changed_by, change_set_id, compartment_ids, label_origin)
       SELECT user_id, scope_id, id, revision, kind, statement, context, actor_kind, authority,
         epistemic_status, contested, lifecycle, valid_from, valid_to, clock_timestamp(), superseded_at, $4, $5,
         compartment_ids, $6
       FROM memories WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
      [actor.userId, scopeId, memoryId, actor.principalId, changeSetId, origin],
    );
    await client.query(
      `INSERT INTO memory_version_evidence(user_id, scope_id, memory_id, revision, evidence_id)
       SELECT user_id, scope_id, memory_id, revision, evidence_id
       FROM memory_versions v
       JOIN memory_evidence me USING (user_id, scope_id, memory_id)
       WHERE v.user_id = $1 AND v.scope_id = $2 AND v.memory_id = $3
         AND v.revision = (SELECT revision FROM memories WHERE user_id = $1 AND scope_id = $2 AND id = $3)
       ON CONFLICT DO NOTHING`,
      [actor.userId, scopeId, memoryId],
    );
  }

  private async loadMemory(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    memoryId: string,
    query: { readonly valid_at?: string | undefined; readonly known_at?: string | undefined },
  ): Promise<Record<string, unknown> | null> {
    let row: MutableMemoryRow | undefined;
    if (query.known_at === undefined) {
      const result = await client.query<MutableMemoryRow>(
        `SELECT m.id, m.user_id, m.scope_id, m.kind, m.statement, m.context,
           m.actor_kind, m.authority, m.epistemic_status, m.contested, m.lifecycle,
           m.valid_from, m.valid_to, coalesce(v.recorded_at, m.recorded_at) AS recorded_at,
           m.superseded_at, m.revision, m.committed_revision, m.indexed_revision,
           m.compartment_ids::text[] AS compartment_ids
         FROM memories AS m
         LEFT JOIN memory_versions AS v ON v.user_id = m.user_id AND v.scope_id = m.scope_id
           AND v.memory_id = m.id AND v.revision = m.revision
         WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = $3
           AND NOT EXISTS (
             SELECT 1 FROM suppressions AS sp WHERE sp.user_id = m.user_id
               AND sp.scope_id = m.scope_id AND sp.object_kind = 'memory' AND sp.object_id = m.id
           )
           AND ($4::timestamptz IS NULL OR m.valid_from IS NULL OR m.valid_from <= $4)
           AND ($4::timestamptz IS NULL OR m.valid_to IS NULL OR m.valid_to > $4)
           AND NOT EXISTS (
             SELECT 1 FROM memory_evidence AS me
             JOIN evidence AS e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
             JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
             WHERE me.user_id = m.user_id AND me.scope_id = m.scope_id AND me.memory_id = m.id
               AND (src.rights_status <> 'granted' OR NOT src.consent
                 OR EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = src.user_id AND sp.scope_id = src.scope_id AND sp.object_id IN (m.id, src.id, e.id)))
           )`,
        [actor.userId, scopeId, memoryId, query.valid_at ?? null],
      );
      row = result.rows[0];
    } else {
      const result = await client.query<MutableMemoryRow>(
        `WITH latest AS (
           SELECT v.* FROM memory_versions AS v
           WHERE v.user_id = $1 AND v.scope_id = $2 AND v.memory_id = $3 AND v.recorded_at <= $4
           ORDER BY v.revision DESC LIMIT 1
         )
         SELECT m.id, m.user_id, m.scope_id, latest.kind, latest.statement, latest.context,
           latest.actor_kind, latest.authority, latest.epistemic_status, latest.contested,
           latest.lifecycle, latest.valid_from, latest.valid_to, latest.recorded_at,
           latest.superseded_at, latest.revision, latest.revision AS committed_revision,
           0 AS indexed_revision, latest.compartment_ids::text[] AS compartment_ids
         FROM latest JOIN memories AS m
           ON m.user_id = latest.user_id AND m.scope_id = latest.scope_id AND m.id = latest.memory_id
         WHERE ($5::timestamptz IS NULL OR latest.valid_from IS NULL OR latest.valid_from <= $5)
           AND ($5::timestamptz IS NULL OR latest.valid_to IS NULL OR latest.valid_to > $5)
           AND NOT EXISTS (
             SELECT 1 FROM suppressions AS sp WHERE sp.user_id = m.user_id
               AND sp.scope_id = m.scope_id AND sp.object_kind = 'memory' AND sp.object_id = m.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM memory_version_evidence AS mve
             JOIN evidence AS e ON e.user_id = mve.user_id AND e.scope_id = mve.scope_id AND e.id = mve.evidence_id
             JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
             WHERE mve.user_id = latest.user_id AND mve.scope_id = latest.scope_id
               AND mve.memory_id = latest.memory_id AND mve.revision = latest.revision
               AND (src.rights_status <> 'granted' OR NOT src.consent
                 OR EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = src.user_id AND sp.scope_id = src.scope_id AND sp.object_id IN (m.id, src.id, e.id)))
           )`,
        [actor.userId, scopeId, memoryId, query.known_at, query.valid_at ?? null],
      );
      row = result.rows[0];
    }
    return row === undefined ? null : this.hydrateMemory(client, row, query);
  }

  private async hydrateMemory(
    client: PoolClient,
    row: MutableMemoryRow,
    query: { readonly known_at?: string | undefined; readonly valid_at?: string | undefined },
  ): Promise<Record<string, unknown>> {
    const sourceIds = await client.query<{ source_id: string }>(
      `SELECT DISTINCT src.id AS source_id
       FROM memory_version_evidence AS mve
       JOIN evidence AS e ON e.user_id = mve.user_id AND e.scope_id = mve.scope_id AND e.id = mve.evidence_id
       JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
       WHERE mve.user_id = $1 AND mve.scope_id = $2 AND mve.memory_id = $3 AND mve.revision = $4
       ORDER BY src.id`,
      [row.user_id, row.scope_id, row.id, row.revision],
    );
    await this.lockSourcesForShare(
      client,
      sourceIds.rows.map((source) => source.source_id),
    );
    const rights = await client.query<{
      rights_status: string;
      consent: boolean;
      suppressed: boolean;
    }>(
      `SELECT src.rights_status, src.consent,
         EXISTS (
           SELECT 1 FROM suppressions AS sp
           WHERE sp.user_id = src.user_id AND sp.scope_id = src.scope_id
             AND sp.object_id IN (m.id, src.id, e.id)
         ) AS suppressed
       FROM memory_version_evidence AS mve
       JOIN evidence AS e ON e.user_id = mve.user_id AND e.scope_id = mve.scope_id AND e.id = mve.evidence_id
       JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
       JOIN memories AS m ON m.user_id = mve.user_id AND m.scope_id = mve.scope_id AND m.id = mve.memory_id
       WHERE mve.user_id = $1 AND mve.scope_id = $2 AND mve.memory_id = $3 AND mve.revision = $4
       ORDER BY src.id`,
      [row.user_id, row.scope_id, row.id, row.revision],
    );
    if (
      rights.rows.some(
        (source) => source.rights_status !== 'granted' || !source.consent || source.suppressed,
      )
    ) {
      throw new CoreError(404, 'not_found', 'Memory not found');
    }
    // Evidence withheld from this reader still counts: a declassified memory disappears when a
    // source it was derived from is revoked or forgotten.
    const denied = await client.query<{ denied: boolean; withheld: number; names: string[] }>(
      `SELECT app.version_rights_denied($1, $2, $3, $4) AS denied,
         (SELECT count(*)::int FROM memory_version_evidence AS mve
          WHERE mve.user_id = $1 AND mve.scope_id = $2 AND mve.memory_id = $3 AND mve.revision = $4
            AND NOT EXISTS (SELECT 1 FROM evidence AS e WHERE e.user_id = mve.user_id
              AND e.scope_id = mve.scope_id AND e.id = mve.evidence_id)) AS withheld,
         ARRAY(SELECT c.id::text || ':' || c.name FROM compartments AS c
               WHERE c.user_id = $1 AND c.id = ANY($5::uuid[]) ORDER BY c.normalized_name) AS names`,
      [row.user_id, row.scope_id, row.id, row.revision, row.compartment_ids ?? []],
    );
    if (denied.rows[0]?.denied === true) throw new CoreError(404, 'not_found', 'Memory not found');
    const withheldEvidence = denied.rows[0]?.withheld ?? 0;
    const compartments = (denied.rows[0]?.names ?? []).map((entry) => {
      const separator = entry.indexOf(':');
      return { id: entry.slice(0, separator), name: entry.slice(separator + 1) };
    });
    const [subjectRows, evidenceRows] = await Promise.all([
      client.query<{
        id: string;
        canonical_name: string;
        alias: string | null;
        alias_valid_from: Date | string | null;
        alias_valid_to: Date | string | null;
      }>(
        `SELECT sub.id, sub.canonical_name, sa.alias, sa.valid_from AS alias_valid_from, sa.valid_to AS alias_valid_to
         FROM memory_subjects AS ms JOIN subjects AS sub
           ON sub.user_id = ms.user_id AND sub.scope_id = ms.scope_id AND sub.id = ms.subject_id
         LEFT JOIN subject_aliases AS sa
           ON sa.user_id = sub.user_id AND sa.scope_id = sub.scope_id AND sa.subject_id = sub.id
         WHERE ms.user_id = $1 AND ms.scope_id = $2 AND ms.memory_id = $3
           AND ($4::timestamptz IS NULL OR sa.id IS NULL OR sa.valid_from <= $4)
           AND ($4::timestamptz IS NULL OR sa.id IS NULL OR sa.valid_to IS NULL OR sa.valid_to > $4)
         ORDER BY sub.canonical_name, sa.valid_from`,
        [row.user_id, row.scope_id, row.id, query.valid_at ?? null],
      ),
      client.query<EvidenceRow>(
        `SELECT e.id, e.source_id, e.source_revision, e.locator, e.span, e.speaker, e.captured_at,
           e.event_time, coalesce(e.lineage_root, e.source_id) AS lineage_root, e.snippet,
           e.snippet_allowed, e.created_at
         FROM memory_version_evidence AS me JOIN evidence AS e
           ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
         JOIN sources AS src ON src.user_id = e.user_id AND src.scope_id = e.scope_id AND src.id = e.source_id
         WHERE me.user_id = $1 AND me.scope_id = $2 AND me.memory_id = $3 AND me.revision = $5
           AND src.rights_status = 'granted' AND src.consent
           AND ($4::timestamptz IS NULL OR e.created_at <= $4)
         ORDER BY e.created_at, e.id`,
        [row.user_id, row.scope_id, row.id, query.known_at ?? null, row.revision],
      ),
    ]);
    const subjects = new Map<
      string,
      {
        id: string;
        name: string;
        aliases: { name: string; valid_from: string | null; valid_to: string | null }[];
      }
    >();
    for (const subject of subjectRows.rows) {
      let item = subjects.get(subject.id);
      if (item === undefined) {
        item = { id: subject.id, name: subject.canonical_name, aliases: [] };
        subjects.set(subject.id, item);
      }
      if (subject.alias !== null) {
        item.aliases.push({
          name: subject.alias,
          valid_from: timestampOutput(subject.alias_valid_from) ?? null,
          valid_to: timestampOutput(subject.alias_valid_to) ?? null,
        });
      }
    }
    const evidence = evidenceRows.rows.map((item) => ({
      id: item.id,
      source_id: item.source_id,
      source_revision: item.source_revision,
      locator: item.locator,
      span: item.span,
      speaker: item.speaker,
      captured_at: item.captured_at.toISOString(),
      event_time: item.event_time?.toISOString() ?? null,
      lineage_root: item.lineage_root,
      ...(item.snippet_allowed && item.snippet !== null ? { snippet: item.snippet } : {}),
    }));
    return {
      id: row.id,
      scope_id: row.scope_id,
      kind: row.kind,
      statement: row.statement,
      subjects: [...subjects.values()],
      attribution: { actor_kind: row.actor_kind, authority: row.authority },
      context: row.context,
      time: {
        valid_from: row.valid_from?.toISOString() ?? null,
        valid_to: row.valid_to?.toISOString() ?? null,
        recorded_at: row.recorded_at.toISOString(),
        superseded_at: row.superseded_at?.toISOString() ?? null,
      },
      epistemic: { status: row.epistemic_status, contested: row.contested },
      lifecycle: row.lifecycle,
      revision: row.revision,
      compartments,
      evidence_ids: evidence.map((item) => item.id),
      evidence,
      ...(withheldEvidence === 0 ? {} : { withheld_evidence: withheldEvidence }),
      index: { committed_revision: row.committed_revision, indexed_revision: row.indexed_revision },
    };
  }

  private async withActor<T>(
    actor: ActorContext,
    rawScopeIds: readonly string[],
    capability: Capability,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const scopeIds = normalizeScopes(rawScopeIds);
    if (scopeIds.length === 0)
      throw new CoreError(403, 'forbidden', 'An authorized scope is required');
    for (const scopeId of scopeIds) {
      if (!actor.scopeIds.includes(scopeId) || !actor.tokenScopeIds.includes(scopeId)) {
        throw new CoreError(
          403,
          'forbidden',
          'The token does not grant access to every requested scope',
        );
      }
    }
    if (!hasCapability(actor.capabilities, capability)) {
      throw new CoreError(403, 'forbidden', `The token does not grant ${capability} access`);
    }
    const guard = getActorAuthorizationGuard(actor);
    return withTransaction(
      this.pool,
      async (client) => {
        await setDatabaseContext(client, {
          userId: actor.userId,
          principalId: actor.principalId,
          scopeIds,
          compartments: databaseCompartments(actor.compartments),
        });
        const access = await client.query<ScopeAccessRow>(
          `SELECT scope_id AS id, auth_epoch, capabilities
         FROM app.lock_actor_access($1, $2, $3, $4::uuid[])`,
          [actor.userId, actor.principalId, actor.actorKind, scopeIds],
        );
        if (access.rows.length !== scopeIds.length)
          throw new CoreError(
            403,
            'forbidden',
            'Current database grants do not cover every requested scope',
          );
        const requiredGrant = access.rows.every((row) =>
          hasCapability(row.capabilities.filter(isCapability), capability),
        );
        if (!requiredGrant)
          throw new CoreError(
            403,
            'forbidden',
            `Current database grants do not allow ${capability} access`,
          );
        for (const row of access.rows) {
          if (actor.authEpochs[row.id] !== Number(row.auth_epoch)) {
            throw new CoreError(
              403,
              'stale_authorization',
              'Scope authorization changed; retry with a newly verified token',
              true,
            );
          }
        }
        if (capability !== readCapability) {
          for (const scopeId of scopeIds) {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1 || $2 || ':' || $3, 0))",
              [LEGACY_SCOPE_WRITE_LOCK_PREFIX, actor.userId, scopeId],
            );
          }
        }
        return run(client);
      },
      guard === undefined ? {} : { beforeCommit: (client) => guard(client) },
    );
  }

  private async assertCurrentJobLease(
    client: PoolClient,
    actor: ActorContext,
    scopeId: string,
    jobId: string,
    leaseToken: string,
  ): Promise<void> {
    const result = await client.query<{
      state: string;
      lease_token: string | null;
      lease_valid: boolean;
    }>(
      `SELECT state, lease_token, lease_until > clock_timestamp() AS lease_valid
       FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND id = $3 FOR UPDATE`,
      [actor.userId, scopeId, jobId],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.state !== 'processing' ||
      row.lease_token !== leaseToken ||
      row.lease_valid !== true
    ) {
      throw new CoreError(
        409,
        'job_lease_lost',
        'Capture job lease is no longer current; no curation write was committed',
        true,
      );
    }
  }
}

function parseMemory(rawInput: unknown): MemoryInput {
  const parsed = memoryInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new CoreError(
      400,
      'invalid_request',
      'Memory does not match the API contract',
      false,
      parsed.error.issues,
    );
  validateMemoryTime(parsed.data);
  return parsed.data;
}

function validateChangeSetTime(changeSet: ChangeSet): void {
  for (const operation of changeSet.operations) {
    if (operation.op === 'CREATE') validateMemoryTime(operation.memory);
    if (operation.op === 'SUPERSEDE') validateMemoryTime(operation.replacement);
    if (operation.op === 'REFINE') validateRange(operation.valid_from, operation.valid_to);
  }
}

function validateMemoryTime(memory: MemoryInput): void {
  validateRange(memory.valid_from, memory.valid_to);
  for (const subject of memory.subjects) {
    for (const alias of subject.aliases) validateRange(alias.valid_from, alias.valid_to);
  }
}

function validateRange(from: string | null | undefined, to: string | null | undefined): void {
  if (
    from !== undefined &&
    to !== undefined &&
    from !== null &&
    to !== null &&
    Date.parse(to) <= Date.parse(from)
  ) {
    throw new CoreError(400, 'invalid_request', 'valid_to must be later than valid_from');
  }
}

function deriveAuthority(
  actorKind: ActorContext['actorKind'],
  kind: string,
  status: string,
): string {
  if (actorKind !== 'user' || status === 'proposed') return 'ai_proposal';
  if (kind === 'decision') return 'user_decision';
  if (kind === 'preference') return 'user_preference';
  return 'user_assertion';
}

/** The only scope an actor can use, for a write that does not name one. */
function soleWritableScope(actor: ActorContext): string {
  const scopes = normalizeScopes(
    actor.scopeIds.filter((scopeId) => actor.tokenScopeIds.includes(scopeId)),
  );
  if (scopes.length === 1) return scopes[0]!;
  throw new CoreError(
    400,
    'scope_required',
    'Name the scope to write; this connection can use several',
    false,
    { scope_ids: scopes },
  );
}

function normalizeScopes(scopeIds: readonly string[]): string[] {
  const scopes = [...new Set(scopeIds)];
  for (const scopeId of scopes) validateUuid(scopeId, 'scope_id');
  return scopes.sort();
}

function validateUuid(value: string, name: string): void {
  if (!uuidSchema.safeParse(value).success)
    throw new CoreError(400, 'invalid_request', `${name} must be a UUID`);
}

function validateIdempotencyKey(value: string): void {
  if (value.length < 1 || value.length > 256) {
    throw new CoreError(
      400,
      'invalid_request',
      'Idempotency-Key must contain between 1 and 256 characters',
    );
  }
}

function decodeCuratedAnchors(value: unknown): CuratedEvidenceAnchor[][] {
  if (!Array.isArray(value))
    throw new CoreError(
      500,
      'invalid_review_evidence',
      'Review evidence anchors are not stored as an array',
    );
  return value.map((entry) => {
    if (!Array.isArray(entry))
      throw new CoreError(
        500,
        'invalid_review_evidence',
        'Review evidence anchor group is invalid',
      );
    return entry.map((anchor) => {
      if (anchor === null || typeof anchor !== 'object')
        throw new CoreError(500, 'invalid_review_evidence', 'Review evidence anchor is invalid');
      const row = anchor as Record<string, unknown>;
      if (
        typeof row['observationId'] !== 'string' ||
        !Number.isSafeInteger(row['spanStart']) ||
        !Number.isSafeInteger(row['spanEnd'])
      )
        throw new CoreError(
          500,
          'invalid_review_evidence',
          'Review evidence anchor fields are invalid',
        );
      return {
        observationId: row['observationId'],
        spanStart: row['spanStart'] as number,
        spanEnd: row['spanEnd'] as number,
      };
    });
  });
}

function decodeExpectedRevisions(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError(
      500,
      'invalid_review_revisions',
      'Review candidate revisions are not stored as an object',
    );
  const revisions: Record<string, number> = {};
  for (const [memoryId, revision] of Object.entries(value as Record<string, unknown>)) {
    if (
      !uuidSchema.safeParse(memoryId).success ||
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1
    )
      throw new CoreError(
        500,
        'invalid_review_revisions',
        'Review candidate revision entry is invalid',
      );
    revisions[memoryId] = revision as number;
  }
  return revisions;
}

function hasExistingCandidateMatch(summary: Record<string, unknown>): boolean {
  const candidates = summary['candidates'];
  if (!Array.isArray(candidates)) return false;
  return candidates.some((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    const matches = (candidate as Record<string, unknown>)['candidate_matches'];
    return Array.isArray(matches) && matches.length > 0;
  });
}

function normalizeName(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

function stableJson(value: unknown): string {
  return stableJsonRaw(encodeIdentityProvenanceV1(value));
}

function stableJsonRaw(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonRaw).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonRaw(object[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasCapability(actual: readonly Capability[], required: Capability): boolean {
  return actual.includes(required) || actual.includes('admin');
}

function isCapability(value: string): value is Capability {
  return value === 'read' || value === 'write' || value === 'admin';
}

/** The allowance a change cursor is bound to. */
function cursorCompartments(actor: ActorContext): CursorState['compartments'] {
  return actor.compartments.kind === 'all'
    ? 'all'
    : { epoch: actor.compartments.epoch, ids: canonicalLabel(actor.compartments.ids) };
}

function sameCompartmentBinding(
  left: CursorState['compartments'],
  right: CursorState['compartments'],
): boolean {
  if (left === 'all' || right === 'all') return left === right;
  return (
    left.epoch === right.epoch &&
    left.ids.length === right.ids.length &&
    left.ids.every((id, index) => id === right.ids[index])
  );
}

function initialCursor(actor: ActorContext, scopeIds: readonly string[]): CursorState {
  return {
    user: actor.userId,
    principal: actor.principalId,
    scopes: scopeIds,
    offsets: Object.fromEntries(scopeIds.map((scopeId) => [scopeId, '0'])),
    auth_epochs: Object.fromEntries(
      scopeIds.map((scopeId) => [scopeId, actor.authEpochs[scopeId] ?? 0]),
    ),
    compartments: cursorCompartments(actor),
    exp: Number.MAX_SAFE_INTEGER,
  };
}

function estimateTokens(memory: Record<string, unknown>): number {
  return Math.ceil(stableJson(memory).length / 4);
}

function timestampOutput(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
