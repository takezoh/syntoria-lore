import { encodeIdentityProvenanceV1 } from '@memory/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  CoreError,
  forgetRequestSchema,
  grantMutationSchema,
  memoryFeedbackSchema,
  retentionPolicySchema,
  sourceRightsSchema,
  LEGACY_SCOPE_WRITE_LOCK_PREFIX,
  type ActorContext,
} from '@memory/contracts';
import { type Database, withTransaction } from '@memory/db';
import {
  observationLocatorDigest,
  sourceIdentityDigest,
  withAuthorizedActor,
} from '@memory/domain';
import type { PoolClient } from 'pg';
import {
  type DeletionLedger,
  type DeletionLedgerEntry,
  type DeletionLedgerReceipt,
} from './deletion-ledger.js';

interface ForgetRow {
  readonly id: string;
  readonly status: string;
  readonly request_hash: string | null;
  readonly created_at: Date;
}

interface SourceIdentity {
  readonly id: string;
  readonly kind: string;
  readonly external_id: string;
  readonly revision: string;
}

interface PendingDeletion {
  readonly request_id: string;
  readonly user_id: string;
  readonly scope_id: string;
  readonly principal_id: string;
  readonly blocked_at: Date | string;
  readonly memory_ids: string[];
  readonly source_ids: string[];
  readonly subject_ids: string[];
  readonly source_locator_hmacs: string[];
  readonly status: string;
}

interface RetentionCandidate {
  readonly user_id: string;
  readonly scope_id: string;
  readonly principal_id: string;
  readonly target_kind: 'memory' | 'source';
  readonly target_id: string;
  readonly source_kind: string | null;
  readonly external_id: string | null;
  readonly revision: string | null;
  readonly locators: string[];
  readonly source_material: Array<{
    readonly kind: string;
    readonly external_id: string;
    readonly revision: string;
    readonly locator: string;
  }>;
}

interface IndexMaintenanceActor {
  readonly user_id: string;
  readonly scope_id: string;
  readonly principal_id: string;
  readonly auth_epoch: string | number;
  readonly capabilities: string[];
}

const admin = 'admin' as const;
const write = 'write' as const;
const read = 'read' as const;

export interface ForgetServiceOptions {
  readonly hmacKey?: string;
}

export interface GovernanceMaintenanceResult {
  readonly retention_queued: number;
  readonly retention_pending: number;
  readonly feedback_held: number;
  readonly reindexed: number;
  readonly indexing_pending: number;
}

export interface GovernanceMaintenanceLimits {
  readonly reindexActorLimit?: number;
  readonly reindexItemLimit?: number;
}

export class ForgetService {
  private readonly hmacKey: string;

  constructor(
    private readonly pool: Database,
    private readonly ledger: DeletionLedger,
    options: ForgetServiceOptions = {},
  ) {
    this.hmacKey = options.hmacKey ?? process.env['FORGET_HMAC_KEY'] ?? '';
    if (Buffer.byteLength(this.hmacKey) < 32) {
      throw new Error('FORGET_HMAC_KEY must contain at least 32 bytes');
    }
  }

  async forget(
    actor: ActorContext,
    rawRequest: unknown,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const parsed = forgetRequestSchema.safeParse(rawRequest);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Forget request is invalid',
        false,
        parsed.error.issues,
      );
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may forget scoped memories');
    if (idempotencyKey.length < 1 || idempotencyKey.length > 256)
      throw new CoreError(
        400,
        'invalid_request',
        'Idempotency-Key must contain 1 to 256 characters',
      );

    const request = parsed.data;
    const requestHash = digest(stableJson(request));
    const created = await withAuthorizedActor(
      this.pool,
      actor,
      [request.scope_id],
      admin,
      async (client) => {
        await lockScopeWrites(client, actor.userId, request.scope_id);
        const memoryIds = await resolveTargets(
          client,
          actor.userId,
          request.scope_id,
          request.selector,
        );
        const sourceIds = sorted(request.selector.source_ids ?? []);
        const subjectIds = sorted(request.selector.subject_ids ?? []);
        await assertSelectorIdsExist(client, actor.userId, request.scope_id, request.selector);
        const previous = await client.query<ForgetRow>(
          `SELECT id, status, request_hash, created_at FROM deletion_requests
           WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
          [actor.userId, request.scope_id, actor.principalId, idempotencyKey],
        );
        const row = previous.rows[0];
        if (row !== undefined) {
          if (row.request_hash !== requestHash)
            throw new CoreError(
              409,
              'idempotency_conflict',
              'Idempotency-Key was used for another Forget request',
            );
          return {
            requestId: row.id,
            entry: await loadLedgerEntry(client, actor, request.scope_id, row),
          };
        }

        const sources = await loadSourcesForTargets(
          client,
          actor.userId,
          request.scope_id,
          memoryIds,
          sourceIds,
        );
        const locators = await loadLocatorsForTargets(
          client,
          actor.userId,
          request.scope_id,
          memoryIds,
          sourceIds,
        );
        const hmacs = new Set<string>();
        for (const source of sources) {
          if (sourceIds.includes(source.id)) {
            hmacs.add(
              sourceIdentityDigest(
                this.hmacKey,
                request.scope_id,
                source.kind,
                source.external_id,
                source.revision,
              ),
            );
          }
        }
        for (const locator of locators) {
          hmacs.add(
            observationLocatorDigest(
              this.hmacKey,
              request.scope_id,
              locator.kind,
              locator.external_id,
              locator.revision,
              locator.locator,
            ),
          );
        }
        const requestId = randomUUID();
        const blockedAt = new Date().toISOString();
        await client.query(
          `INSERT INTO deletion_requests(id, user_id, scope_id, principal_id, selector,
             reason_code, status, created_at, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'ledger_pending', $7, $8, $9)`,
          [
            requestId,
            actor.userId,
            request.scope_id,
            actor.principalId,
            JSON.stringify(request.selector),
            request.reason_code,
            blockedAt,
            idempotencyKey,
            requestHash,
          ],
        );
        await insertTargets(
          client,
          actor.userId,
          request.scope_id,
          requestId,
          memoryIds,
          sourceIds,
          subjectIds,
        );
        await insertSuppressions(
          client,
          actor.userId,
          request.scope_id,
          requestId,
          memoryIds,
          sourceIds,
          [...hmacs],
        );
        await recordForgottenMemories(client, actor, request.scope_id, requestId, memoryIds);
        await client.query('SELECT app.advance_scope_deletion_epoch($1, $2, $3, $4)', [
          actor.userId,
          request.scope_id,
          actor.principalId,
          actor.actorKind,
        ]);
        await client.query(
          `INSERT INTO audit_events(user_id, scope_id, principal_id, event_type, request_id, object_id, metadata)
           VALUES ($1, $2, $3, 'memory.forget_requested', $4, $4, jsonb_build_object('status', 'ledger_pending'))`,
          [actor.userId, request.scope_id, actor.principalId, requestId],
        );
        await client.query(
          `INSERT INTO outbox(user_id, scope_id, event_type, aggregate_id, payload)
           VALUES ($1, $2, 'forget.accepted', $3, '{}'::jsonb) ON CONFLICT DO NOTHING`,
          [actor.userId, request.scope_id, requestId],
        );
        const entry: DeletionLedgerEntry = {
          request_id: requestId,
          user_id: actor.userId,
          scope_id: request.scope_id,
          principal_id: actor.principalId,
          actor_kind: 'user',
          target_memory_ids: sorted(memoryIds),
          target_source_ids: sourceIds,
          target_subject_ids: subjectIds,
          source_locator_hmacs: [...hmacs].sort(),
          blocked_at: blockedAt,
        };
        return { requestId, entry };
      },
    );

    let ledgerDurable = false;
    try {
      const receipt = await this.ledger.append(created.entry);
      await withTransaction(this.pool, async (client) => {
        await setActorContext(client, actor, [created.entry.scope_id]);
        await recordVisibilityItem(client, created.entry, receipt);
      });
      ledgerDurable = true;
    } catch {
      // The committed suppression stays in place and the worker retries the independent ledger append.
    }
    return {
      forget_request_id: created.requestId,
      status: 'ledger_pending',
      ledger_durable: ledgerDurable,
      content_available: false,
    };
  }

  async status(
    actor: ActorContext,
    scopeId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    return withAuthorizedActor(this.pool, actor, [scopeId], read, async (client) => {
      const result = await client.query<{
        status: string;
        created_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT status, created_at, completed_at FROM deletion_requests
         WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
        [actor.userId, scopeId, requestId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new CoreError(404, 'not_found', 'Forget request was not found');
      return {
        forget_request_id: requestId,
        status: row.status,
        requested_at: row.created_at,
        ...(row.completed_at === null ? {} : { completed_at: row.completed_at }),
        content_available: false,
      };
    });
  }

  async verifyLedgerReadiness(): Promise<void> {
    const snapshot = await this.ledger.readSnapshot();
    const result = await this.pool.query<{
      visible_sequence: string | number;
      visible_entry_hash: string;
      visible_head_generation: string;
    }>('SELECT * FROM app.deletion_ledger_checkpoint()');
    const checkpoint = result.rows[0];
    if (
      checkpoint === undefined ||
      Number(checkpoint.visible_sequence) !== snapshot.head.sequence ||
      checkpoint.visible_entry_hash !== snapshot.head.entry_hash ||
      checkpoint.visible_head_generation !== snapshot.head.head_generation
    ) {
      throw new Error(
        'Restore readiness blocked: the verified deletion ledger suppressions are not applied',
      );
    }
    const fresh = await this.ledger.currentHead();
    if (
      fresh.sequence !== snapshot.head.sequence ||
      fresh.entry_hash !== snapshot.head.entry_hash ||
      fresh.head_generation !== snapshot.head.head_generation
    ) {
      throw new Error(
        'Restore readiness blocked: the verified deletion ledger changed during readiness check',
      );
    }
  }

  async updateSourceRights(
    actor: ActorContext,
    sourceId: string,
    rawRequest: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = sourceRightsSchema.safeParse(rawRequest);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Source rights update is invalid',
        false,
        parsed.error.issues,
      );
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may change source rights');
    const scopeId = parsed.data.scope_id;
    return withAuthorizedActor(this.pool, actor, [scopeId], admin, async (client) => {
      await lockScopeWrites(client, actor.userId, scopeId);
      const locked = await client.query<{ present: boolean }>(
        'SELECT app.lock_source_for_share($1::uuid) AS present',
        [sourceId],
      );
      if (!locked.rows[0]?.present) throw new CoreError(404, 'not_found', 'Source was not found');
      const result = await client.query<{ rights_status: string; consent: boolean }>(
        `UPDATE sources SET rights_status = $4, consent = $5
         WHERE user_id = $1 AND scope_id = $2 AND id = $3
         RETURNING rights_status, consent`,
        [actor.userId, scopeId, sourceId, parsed.data.rights_status, parsed.data.consent],
      );
      const row = result.rows[0];
      if (row === undefined) throw new CoreError(404, 'not_found', 'Source was not found');
      return { scope_id: scopeId, source_id: sourceId, ...row };
    });
  }

  async mutateGrant(
    actor: ActorContext,
    scopeId: string,
    rawRequest: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = grantMutationSchema.safeParse(rawRequest);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Grant mutation is invalid',
        false,
        parsed.error.issues,
      );
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may change grants');
    await withAuthorizedActor(this.pool, actor, [scopeId], admin, async (client) => {
      await client.query('SELECT app.manage_scope_grant($1, $2, $3, $4, $5::text[], $6, $7)', [
        actor.userId,
        scopeId,
        actor.principalId,
        parsed.data.principal_id,
        parsed.data.capabilities ?? [],
        parsed.data.expires_at ?? null,
        parsed.data.revoke,
      ]);
    });
    return {
      scope_id: scopeId,
      principal_id: parsed.data.principal_id,
      state: parsed.data.revoke ? 'revoked' : 'granted',
    };
  }

  async submitFeedback(actor: ActorContext, rawRequest: unknown): Promise<Record<string, unknown>> {
    const parsed = memoryFeedbackSchema.safeParse(rawRequest);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Memory feedback is invalid',
        false,
        parsed.error.issues,
      );
    return withAuthorizedActor(this.pool, actor, [parsed.data.scope_id], write, async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO feedback(user_id, scope_id, principal_id, memory_id, feedback_type, metadata)
         SELECT $1, $2, $3, m.id, $5, $6::jsonb FROM memories m
         WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = $4
           AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = m.user_id
             AND sp.scope_id = m.scope_id AND sp.object_kind = 'memory' AND sp.object_id = m.id)
         RETURNING id`,
        [
          actor.userId,
          parsed.data.scope_id,
          actor.principalId,
          parsed.data.memory_id,
          parsed.data.feedback_type,
          JSON.stringify(parsed.data.metadata),
        ],
      );
      const feedbackId = row.rows[0]?.id;
      if (feedbackId === undefined) throw new CoreError(404, 'not_found', 'Memory was not found');
      await client.query(
        `INSERT INTO feedback_reassessments(user_id, scope_id, memory_id, feedback_id, state)
         VALUES ($1, $2, $3, $4, 'queued') ON CONFLICT (user_id, scope_id, feedback_id) DO NOTHING`,
        [actor.userId, parsed.data.scope_id, parsed.data.memory_id, feedbackId],
      );
      return { feedback_id: feedbackId, reassessment: 'queued' };
    });
  }

  async updateRetention(
    actor: ActorContext,
    scopeId: string,
    rawRequest: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = retentionPolicySchema.safeParse(rawRequest);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Retention policy is invalid',
        false,
        parsed.error.issues,
      );
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may set retention');
    return withAuthorizedActor(this.pool, actor, [scopeId], admin, async (client) => {
      await client.query(
        `INSERT INTO scope_retention_policies(user_id, scope_id, observation_days, memory_days, updated_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, scope_id) DO UPDATE
           SET observation_days = EXCLUDED.observation_days, memory_days = EXCLUDED.memory_days,
               updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()`,
        [
          actor.userId,
          scopeId,
          parsed.data.observation_days,
          parsed.data.memory_days ?? null,
          actor.principalId,
        ],
      );
      return { scope_id: scopeId, ...parsed.data };
    });
  }

  async processPendingWorker(
    workerPool: Database,
    limit = 100,
  ): Promise<{ purged: number; pending: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Pending deletion limit must be between 1 and 100');
    const pending = await workerPool.query<PendingDeletion>(
      'SELECT * FROM app.list_pending_deletions($1::integer)',
      [limit],
    );
    let purged = 0;
    let waiting = 0;
    for (const raw of pending.rows) {
      const entry: DeletionLedgerEntry = {
        request_id: raw.request_id,
        user_id: raw.user_id,
        scope_id: raw.scope_id,
        principal_id: raw.principal_id,
        actor_kind: 'user',
        target_memory_ids: sorted(raw.memory_ids),
        target_source_ids: sorted(raw.source_ids),
        target_subject_ids: sorted(raw.subject_ids),
        source_locator_hmacs: sorted(raw.source_locator_hmacs),
        blocked_at: new Date(raw.blocked_at).toISOString(),
      };
      try {
        const receipt = await this.ledger.append(entry);
        await withTransaction(workerPool, async (client) => {
          await setActorContextForWorker(client, raw.user_id, raw.scope_id, raw.principal_id);
          await client.query('SELECT app.ack_deletion_ledger($1, $2, $3, $4, $5, $6, $7)', [
            raw.user_id,
            raw.scope_id,
            raw.request_id,
            raw.principal_id,
            receipt.sequence,
            receipt.entry_hash,
            receipt.head_generation,
          ]);
          await recordVisibilityItem(client, entry, receipt);
        });
        const result = await withTransaction(workerPool, async (client) => {
          await setActorContextForWorker(client, raw.user_id, raw.scope_id, raw.principal_id);
          return client.query<{ removed: number }>(
            `SELECT app.purge_replayed_forgotten_request($1, $2, $3, $4, $5, $6, $7) AS removed`,
            [
              raw.user_id,
              raw.scope_id,
              raw.request_id,
              raw.principal_id,
              receipt.sequence,
              receipt.entry_hash,
              receipt.head_generation,
            ],
          );
        });
        if (result.rows[0] !== undefined) purged += 1;
      } catch {
        waiting += 1;
        try {
          await workerPool.query('SELECT app.defer_pending_deletion($1::uuid)', [raw.request_id]);
        } catch {
          waiting += 1;
        }
      }
    }
    if (waiting === 0) {
      try {
        const backlog = await workerPool.query<{ has_pending_deletions: boolean }>(
          'SELECT app.has_pending_deletions() AS has_pending_deletions',
        );
        if (backlog.rows[0]?.has_pending_deletions === true) waiting += 1;
      } catch {
        waiting += 1;
      }
    }
    if (waiting === 0) {
      try {
        const snapshot = await this.ledger.readSnapshot();
        if (snapshot.head.sequence === 0) {
          await withTransaction(workerPool, async (client) => {
            await client.query('SELECT app.record_empty_deletion_ledger_visibility_head($1)', [
              snapshot.head.head_generation,
            ]);
          });
        }
        const state = await workerPool.query<{
          pending_count: string | number;
          visible_sequence: string | number;
          visible_entry_hash: string;
          visible_head_generation: string;
        }>('SELECT * FROM app.deletion_ledger_checkpoint()');
        const checkpoint = state.rows[0];
        if (
          Number(checkpoint?.pending_count ?? -1) !== 0 ||
          Number(checkpoint?.visible_sequence ?? -1) !== snapshot.head.sequence ||
          checkpoint?.visible_entry_hash !== snapshot.head.entry_hash ||
          checkpoint.visible_head_generation !== snapshot.head.head_generation
        ) {
          waiting += 1;
        } else {
          await withTransaction(workerPool, async (client) => {
            await client.query('SELECT app.record_deletion_ledger_checkpoint($1, $2, $3)', [
              snapshot.head.sequence,
              snapshot.head.entry_hash,
              snapshot.head.head_generation,
            ]);
          });
          const fresh = await this.ledger.currentHead();
          if (
            fresh.sequence !== snapshot.head.sequence ||
            fresh.entry_hash !== snapshot.head.entry_hash ||
            fresh.head_generation !== snapshot.head.head_generation
          )
            waiting += 1;
        }
      } catch {
        waiting += 1;
      }
    }
    return { purged, pending: waiting === 0 ? 0 : 1 };
  }

  async processMaintenanceWorker(
    workerPool: Database,
    reindex?: (
      actor: ActorContext,
      scopeId: string,
      limit: number,
    ) => Promise<{ indexed: number; skipped: number }>,
    limits: GovernanceMaintenanceLimits = {},
  ): Promise<GovernanceMaintenanceResult> {
    const reindexActorLimit = limits.reindexActorLimit ?? 25;
    const reindexItemLimit = limits.reindexItemLimit ?? 25;
    if (
      !Number.isSafeInteger(reindexActorLimit) ||
      reindexActorLimit < 1 ||
      reindexActorLimit > 100 ||
      !Number.isSafeInteger(reindexItemLimit) ||
      reindexItemLimit < 1 ||
      reindexItemLimit > 100
    )
      throw new Error('Governance reindex limits must be between 1 and 100');
    const candidates = await workerPool.query<RetentionCandidate>(
      'SELECT * FROM app.list_due_retention_candidates($1)',
      [100],
    );
    let retentionQueued = 0;
    let retentionPending = 0;
    for (const candidate of candidates.rows) {
      const locatorHmacs = new Set<string>();
      const sourceMaterials = candidate.source_material ?? [];
      for (const source of sourceMaterials) {
        locatorHmacs.add(
          sourceIdentityDigest(
            this.hmacKey,
            candidate.scope_id,
            source.kind,
            source.external_id,
            source.revision,
          ),
        );
        locatorHmacs.add(
          observationLocatorDigest(
            this.hmacKey,
            candidate.scope_id,
            source.kind,
            source.external_id,
            source.revision,
            source.locator,
          ),
        );
      }
      if (
        candidate.target_kind === 'source' &&
        candidate.source_kind !== null &&
        candidate.external_id !== null &&
        candidate.revision !== null
      ) {
        locatorHmacs.add(
          sourceIdentityDigest(
            this.hmacKey,
            candidate.scope_id,
            candidate.source_kind,
            candidate.external_id,
            candidate.revision,
          ),
        );
        for (const locator of candidate.locators) {
          locatorHmacs.add(
            observationLocatorDigest(
              this.hmacKey,
              candidate.scope_id,
              candidate.source_kind,
              candidate.external_id,
              candidate.revision,
              locator,
            ),
          );
        }
      }
      try {
        const created = await workerPool.query<{ enqueue_retention_deletion: boolean }>(
          `SELECT app.enqueue_retention_deletion($1, $2, $3, $4, $5, $6, $7::text[], ARRAY[]::text[])
             AS enqueue_retention_deletion`,
          [
            randomUUID(),
            candidate.user_id,
            candidate.scope_id,
            candidate.principal_id,
            candidate.target_kind,
            candidate.target_id,
            [...locatorHmacs].sort(),
          ],
        );
        if (created.rows[0]?.enqueue_retention_deletion === true) retentionQueued += 1;
      } catch {
        retentionPending += 1;
      }
    }

    const feedback = await workerPool.query<{ held: number }>(
      'SELECT app.hold_queued_feedback_reassessments($1) AS held',
      [100],
    );
    let reindexed = 0;
    let indexingPending = 0;
    if (reindex !== undefined) {
      const actors = await workerPool.query<IndexMaintenanceActor>(
        'SELECT * FROM app.list_index_maintenance_actors($1)',
        [reindexActorLimit],
      );
      for (const row of actors.rows) {
        const actor: ActorContext = {
          userId: row.user_id,
          principalId: row.principal_id,
          actorKind: 'user',
          scopeIds: [row.scope_id],
          tokenScopeIds: [row.scope_id],
          capabilities: ['read', 'write', 'admin'],
          authEpochs: { [row.scope_id]: Number(row.auth_epoch) },
        };
        try {
          const indexed = await reindex(actor, row.scope_id, reindexItemLimit);
          reindexed += indexed.indexed;
        } catch {
          indexingPending += 1;
        }
      }
    }
    return {
      retention_queued: retentionQueued,
      retention_pending: retentionPending,
      feedback_held: feedback.rows[0]?.held ?? 0,
      reindexed,
      indexing_pending: indexingPending,
    };
  }

  async applyLedgerForRestore(workerPool: Database): Promise<{ replayed: number; purged: number }> {
    let replayed = 0;
    let purged = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      const snapshot = await this.ledger.readSnapshot();
      for (const stored of snapshot.entries) {
        const entry = stored.entry;
        const replay = await withTransaction(workerPool, async (client) => {
          const result = await client.query<{ replay_deletion_ledger_entry: boolean }>(
            `SELECT app.replay_deletion_ledger_entry($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[],
               $8::uuid[], $9::text[], $10, $11, $12)`,
            [
              entry.request_id,
              entry.user_id,
              entry.scope_id,
              entry.principal_id,
              entry.blocked_at,
              entry.target_memory_ids,
              entry.target_source_ids,
              entry.target_subject_ids,
              entry.source_locator_hmacs,
              stored.sequence,
              stored.entry_hash,
              stored.entry_hash,
            ],
          );
          await recordVisibilityItem(client, entry, {
            sequence: stored.sequence,
            entry_hash: stored.entry_hash,
            head_generation: stored.entry_hash,
          });
          return result.rows[0]?.replay_deletion_ledger_entry ?? false;
        });
        if (replay) replayed += 1;
      }
      const drained = await this.processPendingWorker(workerPool);
      purged += drained.purged;
      const fresh = await this.ledger.readSnapshot();
      if (
        fresh.head.sequence !== snapshot.head.sequence ||
        fresh.head.entry_hash !== snapshot.head.entry_hash ||
        fresh.head.head_generation !== snapshot.head.head_generation
      )
        continue;
      if (drained.pending !== 0) continue;
      await this.verifyLedgerReadiness();
      return { replayed, purged };
    }
    throw new Error(
      'Restore readiness blocked: the external deletion ledger changed during replay',
    );
  }
}

async function resolveTargets(
  client: PoolClient,
  userId: string,
  scopeId: string,
  selector: {
    memory_ids?: string[] | undefined;
    source_ids?: string[] | undefined;
    subject_ids?: string[] | undefined;
  },
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT DISTINCT selected.id FROM (
       SELECT m.id FROM memories m WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = ANY($3::uuid[])
       UNION
       SELECT me.memory_id FROM memory_evidence me JOIN evidence e ON e.user_id = me.user_id
         AND e.scope_id = me.scope_id AND e.id = me.evidence_id
         WHERE me.user_id = $1 AND me.scope_id = $2 AND e.source_id = ANY($4::uuid[])
       UNION
       SELECT mve.memory_id FROM memory_version_evidence mve JOIN evidence e ON e.user_id = mve.user_id
         AND e.scope_id = mve.scope_id AND e.id = mve.evidence_id
         WHERE mve.user_id = $1 AND mve.scope_id = $2 AND e.source_id = ANY($4::uuid[])
       UNION
       SELECT ms.memory_id FROM memory_subjects ms
         WHERE ms.user_id = $1 AND ms.scope_id = $2 AND ms.subject_id = ANY($5::uuid[])
     ) AS selected ORDER BY selected.id`,
    [
      userId,
      scopeId,
      selector.memory_ids ?? [],
      selector.source_ids ?? [],
      selector.subject_ids ?? [],
    ],
  );
  return result.rows.map((row) => row.id);
}

async function assertSelectorIdsExist(
  client: PoolClient,
  userId: string,
  scopeId: string,
  selector: {
    memory_ids?: string[] | undefined;
    source_ids?: string[] | undefined;
    subject_ids?: string[] | undefined;
  },
): Promise<void> {
  const result = await client.query<{ kind: string; id: string }>(
    `SELECT 'memory'::text AS kind, id FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=ANY($3::uuid[])
     UNION ALL SELECT 'source', id FROM sources WHERE user_id=$1 AND scope_id=$2 AND id=ANY($4::uuid[])
     UNION ALL SELECT 'subject', id FROM subjects WHERE user_id=$1 AND scope_id=$2 AND id=ANY($5::uuid[])`,
    [
      userId,
      scopeId,
      selector.memory_ids ?? [],
      selector.source_ids ?? [],
      selector.subject_ids ?? [],
    ],
  );
  for (const [kind, requested] of Object.entries({
    memory: sorted(selector.memory_ids ?? []),
    source: sorted(selector.source_ids ?? []),
    subject: sorted(selector.subject_ids ?? []),
  })) {
    if (result.rows.filter((row) => row.kind === kind).length !== requested.length)
      throw new CoreError(404, 'not_found', 'One or more Forget targets were not found');
  }
}

async function loadSourcesForTargets(
  client: PoolClient,
  userId: string,
  scopeId: string,
  memoryIds: readonly string[],
  sourceIds: readonly string[],
): Promise<SourceIdentity[]> {
  const result = await client.query<SourceIdentity>(
    `SELECT DISTINCT s.id, s.kind, s.external_id, s.revision FROM sources s
     WHERE s.user_id=$1 AND s.scope_id=$2 AND (
       s.id=ANY($4::uuid[]) OR EXISTS (SELECT 1 FROM evidence e JOIN memory_evidence me
         ON me.user_id=e.user_id AND me.scope_id=e.scope_id AND me.evidence_id=e.id
         WHERE e.user_id=s.user_id AND e.scope_id=s.scope_id AND e.source_id=s.id AND me.memory_id=ANY($3::uuid[]))
       OR EXISTS (SELECT 1 FROM observations o WHERE o.user_id=s.user_id AND o.scope_id=s.scope_id
         AND o.source_id=s.id AND s.id=ANY($4::uuid[]))) ORDER BY s.id`,
    [userId, scopeId, memoryIds, sourceIds],
  );
  return result.rows;
}

async function loadLocatorsForTargets(
  client: PoolClient,
  userId: string,
  scopeId: string,
  memoryIds: readonly string[],
  sourceIds: readonly string[],
): Promise<Array<SourceIdentity & { locator: string }>> {
  const result = await client.query<SourceIdentity & { locator: string }>(
    `SELECT DISTINCT s.kind, s.external_id, s.revision, COALESCE(e.locator, o.locator) AS locator
     FROM sources s LEFT JOIN evidence e ON e.user_id=s.user_id AND e.scope_id=s.scope_id
       AND e.source_id=s.id LEFT JOIN memory_evidence me ON me.user_id=e.user_id
       AND me.scope_id=e.scope_id AND me.evidence_id=e.id
     LEFT JOIN observations o ON o.user_id=s.user_id AND o.scope_id=s.scope_id AND o.source_id=s.id
       AND o.source_revision=s.revision AND o.locator=COALESCE(e.locator, o.locator)
     WHERE s.user_id=$1 AND s.scope_id=$2 AND COALESCE(e.locator,o.locator) IS NOT NULL AND (
       s.id=ANY($4::uuid[]) OR me.memory_id=ANY($3::uuid[])
       OR EXISTS (SELECT 1 FROM memory_version_evidence mve WHERE mve.user_id=e.user_id
         AND mve.scope_id=e.scope_id AND mve.evidence_id=e.id AND mve.memory_id=ANY($3::uuid[])))`,
    [userId, scopeId, memoryIds, sourceIds],
  );
  return result.rows;
}

async function loadLedgerEntry(
  client: PoolClient,
  actor: ActorContext,
  scopeId: string,
  request: ForgetRow,
): Promise<DeletionLedgerEntry> {
  const [targets, hashes] = await Promise.all([
    client.query<{ target_kind: string; target_id: string }>(
      `SELECT target_kind, target_id FROM deletion_targets WHERE user_id=$1 AND scope_id=$2
       AND deletion_request_id=$3 ORDER BY target_kind, target_id`,
      [actor.userId, scopeId, request.id],
    ),
    client.query<{ locator_hmac: string }>(
      `SELECT locator_hmac FROM suppressions WHERE user_id=$1 AND scope_id=$2 AND deletion_request_id=$3
       AND object_kind='locator_hmac' AND locator_hmac IS NOT NULL ORDER BY locator_hmac`,
      [actor.userId, scopeId, request.id],
    ),
  ]);
  const byKind = (kind: string) =>
    sorted(targets.rows.filter((row) => row.target_kind === kind).map((row) => row.target_id));
  return {
    request_id: request.id,
    user_id: actor.userId,
    scope_id: scopeId,
    principal_id: actor.principalId,
    actor_kind: 'user',
    target_memory_ids: byKind('memory'),
    target_source_ids: byKind('source'),
    target_subject_ids: byKind('subject'),
    source_locator_hmacs: hashes.rows.map((row) => row.locator_hmac),
    blocked_at: new Date(request.created_at).toISOString(),
  };
}

async function insertTargets(
  client: PoolClient,
  userId: string,
  scopeId: string,
  requestId: string,
  memoryIds: readonly string[],
  sourceIds: readonly string[],
  subjectIds: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO deletion_targets(user_id, scope_id, deletion_request_id, target_kind, target_id)
     SELECT $1, $2, $3, target_kind, target_id FROM (
       SELECT 'memory'::text AS target_kind, unnest($4::uuid[]) AS target_id
       UNION ALL SELECT 'source', unnest($5::uuid[])
       UNION ALL SELECT 'subject', unnest($6::uuid[])
     ) targets ON CONFLICT DO NOTHING`,
    [userId, scopeId, requestId, memoryIds, sourceIds, subjectIds],
  );
}

async function insertSuppressions(
  client: PoolClient,
  userId: string,
  scopeId: string,
  requestId: string,
  memoryIds: readonly string[],
  sourceIds: readonly string[],
  hashes: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO suppressions(user_id, scope_id, deletion_request_id, object_kind, object_id, locator_hmac)
     SELECT $1, $2, $3, kind, id, NULL FROM (
       SELECT 'memory'::text AS kind, unnest($4::uuid[]) AS id
       UNION ALL SELECT 'source', unnest($5::uuid[])
     ) items ON CONFLICT DO NOTHING`,
    [userId, scopeId, requestId, memoryIds, sourceIds],
  );
  await client.query(
    `INSERT INTO suppressions(user_id, scope_id, deletion_request_id, object_kind, locator_hmac)
     SELECT $1, $2, $3, 'locator_hmac', unnest($4::text[]) ON CONFLICT DO NOTHING`,
    [userId, scopeId, requestId, hashes],
  );
}

async function recordForgottenMemories(
  client: PoolClient,
  actor: ActorContext,
  scopeId: string,
  requestId: string,
  memoryIds: readonly string[],
): Promise<void> {
  if (memoryIds.length === 0) return;
  const memories = await client.query<{ id: string; revision: number }>(
    `SELECT id, coalesce(nullif(committed_revision, 0), revision) AS revision
     FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=ANY($3::uuid[]) ORDER BY id`,
    [actor.userId, scopeId, memoryIds],
  );
  if (memories.rows.length === 0) return;
  await client.query(
    'INSERT INTO scope_offsets(user_id, scope_id) VALUES ($1, $2) ON CONFLICT (user_id, scope_id) DO NOTHING',
    [actor.userId, scopeId],
  );
  await client.query(
    'SELECT last_seq FROM scope_offsets WHERE user_id=$1 AND scope_id=$2 FOR UPDATE',
    [actor.userId, scopeId],
  );
  const changeSetId = randomUUID();
  await client.query(
    `INSERT INTO changesets(user_id, scope_id, id, principal_id, request_id, operation_count,
       response, status, committed_at, client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'committed', clock_timestamp(), $8)`,
    [
      actor.userId,
      scopeId,
      changeSetId,
      actor.principalId,
      requestId,
      memories.rows.length,
      JSON.stringify({ change_set_id: changeSetId, source: 'forget' }),
      actor.clientId ?? null,
    ],
  );
  const result = await client.query<{ last_seq: string }>(
    `UPDATE scope_offsets SET last_seq=last_seq+$3, updated_at=clock_timestamp()
     WHERE user_id=$1 AND scope_id=$2 RETURNING last_seq`,
    [actor.userId, scopeId, memories.rows.length],
  );
  const last = BigInt(result.rows[0]?.last_seq ?? '0');
  const first = last - BigInt(memories.rows.length) + 1n;
  for (let index = 0; index < memories.rows.length; index += 1) {
    const memory = memories.rows[index];
    if (memory === undefined) continue;
    const sequence = (first + BigInt(index)).toString();
    const changeId = randomUUID();
    await client.query(
      `INSERT INTO change_ops(user_id, scope_id, change_set_id, ordinal, op, memory_id,
         memory_revision, metadata)
       VALUES ($1, $2, $3, $4, 'RETRACT', $5, $6, $7::jsonb)`,
      [
        actor.userId,
        scopeId,
        changeSetId,
        index,
        memory.id,
        memory.revision,
        JSON.stringify({ forget_request_id: requestId }),
      ],
    );
    await client.query(
      `INSERT INTO change_log(user_id, scope_id, id, seq, change_set_id, op, memory_id,
         memory_revision, tombstone)
       VALUES ($1, $2, $3, $4, $5, 'RETRACT', $6, $7, true)`,
      [actor.userId, scopeId, changeId, sequence, changeSetId, memory.id, memory.revision],
    );
    await client.query(
      `INSERT INTO outbox(user_id, scope_id, id, event_type, aggregate_id, payload)
       VALUES ($1, $2, $3, 'memory.change', $4, $5::jsonb)`,
      [
        actor.userId,
        scopeId,
        randomUUID(),
        changeSetId,
        JSON.stringify({ change_id: changeId, seq: sequence, op: 'RETRACT', tombstone: true }),
      ],
    );
  }
}

async function lockScopeWrites(client: PoolClient, userId: string, scopeId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || $2 || ':' || $3, 0))", [
    LEGACY_SCOPE_WRITE_LOCK_PREFIX,
    userId,
    scopeId,
  ]);
}

async function setActorContext(
  client: PoolClient,
  actor: ActorContext,
  scopeIds: readonly string[],
): Promise<void> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [actor.userId]);
  await client.query("SELECT set_config('app.scope_ids', $1, true)", [`{${scopeIds.join(',')}}`]);
  await client.query("SELECT set_config('app.principal_id', $1, true)", [actor.principalId]);
}

async function recordVisibilityItem(
  client: PoolClient,
  entry: DeletionLedgerEntry,
  receipt: DeletionLedgerReceipt,
): Promise<void> {
  await client.query(
    `SELECT app.record_deletion_ledger_visibility_item($1, $2, $3, $4, $5, $6, $7,
       $8::uuid[], $9::uuid[], $10::uuid[], $11::text[])`,
    [
      entry.request_id,
      entry.user_id,
      entry.scope_id,
      entry.principal_id,
      receipt.sequence,
      receipt.entry_hash,
      receipt.head_generation,
      entry.target_memory_ids,
      entry.target_source_ids,
      entry.target_subject_ids,
      entry.source_locator_hmacs,
    ],
  );
}

async function setActorContextForWorker(
  client: PoolClient,
  userId: string,
  scopeId: string,
  principalId: string,
): Promise<void> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  await client.query("SELECT set_config('app.scope_ids', $1, true)", [`{${scopeId}}`]);
  await client.query("SELECT set_config('app.principal_id', $1, true)", [principalId]);
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  return stableJsonRaw(encodeIdentityProvenanceV1(value));
}

function stableJsonRaw(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonRaw).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonRaw(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
