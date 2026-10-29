import { encodePortableBundleV1, decodePortableBundleV1 } from './user-identity-v1.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CoreError,
  exportRequestSchema,
  importRequestSchema,
  type ActorContext,
} from '@memory/contracts';
import {
  LEGACY_PORTABILITY_PAYLOAD_FORMAT,
  LEGACY_SCOPE_WRITE_LOCK_PREFIX,
} from '@memory/contracts';
import { type Database, withTransaction } from '@memory/db';
import {
  observationLocatorDigest,
  sourceIdentityDigest,
  withAuthorizedActor,
} from '@memory/domain';
import type { PoolClient } from 'pg';
import { type PortabilityStore, portabilityPayloadHash } from './portability-store.js';

const read = 'read' as const;
const admin = 'admin' as const;
const bundleSchema = z.strictObject({
  format: z.literal(LEGACY_PORTABILITY_PAYLOAD_FORMAT),
  schema_version: z.literal(1),
  origin: z.strictObject({
    user_id: z.uuid(),
    scope_id: z.uuid(),
    export_id: z.uuid(),
    created_at: z.iso.datetime({ offset: true }),
  }),
  tables: z.strictObject({
    sources: z.array(z.record(z.string(), z.unknown())).max(100_000),
    observations: z.array(z.record(z.string(), z.unknown())).max(500_000),
    episodes: z.array(z.record(z.string(), z.unknown())).max(100_000),
    evidence: z.array(z.record(z.string(), z.unknown())).max(500_000),
    subjects: z.array(z.record(z.string(), z.unknown())).max(200_000),
    subject_aliases: z.array(z.record(z.string(), z.unknown())).max(500_000),
    memories: z.array(z.record(z.string(), z.unknown())).max(500_000),
    memory_versions: z.array(z.record(z.string(), z.unknown())).max(1_000_000),
    memory_subjects: z.array(z.record(z.string(), z.unknown())).max(1_000_000),
    memory_evidence: z.array(z.record(z.string(), z.unknown())).max(2_000_000),
    memory_version_evidence: z.array(z.record(z.string(), z.unknown())).max(5_000_000),
    relations: z.array(z.record(z.string(), z.unknown())).max(1_000_000),
  }),
});

type PortableRow = Record<string, unknown>;
type BundleTables = z.infer<typeof bundleSchema>['tables'];
interface ExportJob {
  readonly export_id: string;
  readonly user_id: string;
  readonly scope_id: string;
  readonly principal_id: string;
  readonly deletion_epoch: string | number;
  readonly claim_token: string;
}
interface ExportStatus {
  readonly id: string;
  readonly state: string;
  readonly created_at: Date;
  readonly expires_at: Date | null;
  readonly deletion_epoch: string | number;
  readonly ready_auth_epoch: string | number | null;
  readonly current_deletion_epoch: string | number;
  readonly current_auth_epoch: string | number;
}
interface ImportStatus {
  readonly id: string;
  readonly state: string;
  readonly bundle_hash: string;
  readonly request_hash: string | null;
  readonly response: Record<string, unknown> | null;
  readonly id_map: Record<string, string>;
}

interface ImportedMemory {
  readonly id: string;
  readonly revision: number;
}

const tableOrder = [
  'sources',
  'observations',
  'episodes',
  'evidence',
  'subjects',
  'subject_aliases',
  'memories',
  'memory_versions',
  'memory_subjects',
  'memory_evidence',
  'memory_version_evidence',
  'relations',
] as const;
type TableName = (typeof tableOrder)[number];
const columns: Readonly<Record<TableName, readonly string[]>> = {
  sources: [
    'id',
    'user_id',
    'scope_id',
    'kind',
    'external_id',
    'revision',
    'rights_status',
    'consent',
    'metadata',
    'created_at',
    'lineage_root',
    'origin_lineage_root',
  ],
  observations: [
    'id',
    'user_id',
    'scope_id',
    'source_id',
    'source_revision',
    'speaker',
    'event_time',
    'captured_at',
    'locator',
    'content',
    'content_hash',
    'lineage_root',
    'created_at',
    'canonical_locator',
    'source_kind',
    'prompt_generation',
    'origin_lineage_root',
  ],
  episodes: [
    'id',
    'user_id',
    'scope_id',
    'source_id',
    'title',
    'content',
    'occurred_at',
    'recorded_at',
    'status',
  ],
  evidence: [
    'id',
    'user_id',
    'scope_id',
    'source_id',
    'source_revision',
    'locator',
    'span',
    'speaker',
    'captured_at',
    'event_time',
    'lineage_root',
    'snippet',
    'snippet_allowed',
    'content_hash',
    'created_at',
    'observation_id',
    'span_start',
    'span_end',
    'origin_lineage_root',
  ],
  subjects: ['id', 'user_id', 'scope_id', 'canonical_name', 'normalized_name', 'created_at'],
  subject_aliases: [
    'id',
    'user_id',
    'scope_id',
    'subject_id',
    'alias',
    'normalized_alias',
    'valid_from',
    'valid_to',
    'created_at',
  ],
  memories: [
    'id',
    'user_id',
    'scope_id',
    'kind',
    'statement',
    'context',
    'actor_kind',
    'authority',
    'epistemic_status',
    'contested',
    'lifecycle',
    'valid_from',
    'valid_to',
    'recorded_at',
    'superseded_at',
    'revision',
    'committed_revision',
    'indexed_revision',
    'created_by',
    'updated_at',
    'import_provenance',
  ],
  memory_versions: [
    'id',
    'user_id',
    'scope_id',
    'memory_id',
    'revision',
    'kind',
    'statement',
    'context',
    'actor_kind',
    'authority',
    'epistemic_status',
    'contested',
    'lifecycle',
    'valid_from',
    'valid_to',
    'recorded_at',
    'superseded_at',
    'changed_by',
    'change_set_id',
    'created_at',
    'origin_provenance',
  ],
  memory_subjects: ['user_id', 'scope_id', 'memory_id', 'subject_id'],
  memory_evidence: ['user_id', 'scope_id', 'memory_id', 'evidence_id'],
  memory_version_evidence: [
    'user_id',
    'scope_id',
    'memory_id',
    'revision',
    'evidence_id',
    'support_role',
    'created_at',
  ],
  relations: [
    'id',
    'user_id',
    'scope_id',
    'from_memory_id',
    'to_memory_id',
    'relation',
    'context',
    'created_by',
    'created_at',
  ],
};

export interface PortabilityServiceOptions {
  readonly hmacKey: string;
  readonly jobTtlMs?: number;
}

export class PortabilityService {
  private readonly hmacKey: string;
  private readonly jobTtlMs: number;

  constructor(
    private readonly pool: Database,
    private readonly store: PortabilityStore,
    options: PortabilityServiceOptions,
  ) {
    if (Buffer.byteLength(options.hmacKey) < 32)
      throw new Error('FORGET_HMAC_KEY must contain at least 32 bytes');
    this.hmacKey = options.hmacKey;
    this.jobTtlMs = options.jobTtlMs ?? 15 * 60 * 1000;
  }

  async requestExport(
    actor: ActorContext,
    raw: unknown,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const parsed = exportRequestSchema.safeParse(raw);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Export request is invalid',
        false,
        parsed.error.issues,
      );
    assertIdempotencyKey(idempotencyKey);
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may export a scope');
    const requestHash = portabilityPayloadHash(parsed.data);
    return withAuthorizedActor(this.pool, actor, [parsed.data.scope_id], admin, async (client) => {
      await lockScopeWrites(client, actor.userId, parsed.data.scope_id);
      const prior = await client.query<ExportStatus & { request_hash: string | null }>(
        `SELECT id, state, created_at, expires_at, deletion_epoch, request_hash FROM export_jobs
         WHERE user_id=$1 AND scope_id=$2 AND principal_id=$3 AND idempotency_key=$4`,
        [actor.userId, parsed.data.scope_id, actor.principalId, idempotencyKey],
      );
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new CoreError(
            409,
            'idempotency_conflict',
            'Idempotency-Key was used for another export',
          );
        return { export_id: prior.rows[0].id, state: prior.rows[0].state };
      }
      const scope = await client.query<{ deletion_epoch: string | number }>(
        'SELECT deletion_epoch FROM scopes WHERE user_id=$1 AND id=$2',
        [actor.userId, parsed.data.scope_id],
      );
      const epoch = scope.rows[0]?.deletion_epoch;
      if (epoch === undefined) throw new CoreError(404, 'not_found', 'Scope was not found');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO export_jobs(user_id, scope_id, principal_id, state, deletion_epoch, idempotency_key, request_hash)
         VALUES ($1, $2, $3, 'accepted', $4, $5, $6) RETURNING id`,
        [actor.userId, parsed.data.scope_id, actor.principalId, epoch, idempotencyKey, requestHash],
      );
      return { export_id: inserted.rows[0]!.id, state: 'accepted', content_available: false };
    });
  }

  async exportStatus(
    actor: ActorContext,
    scopeId: string,
    exportId: string,
  ): Promise<Record<string, unknown>> {
    return withAuthorizedActor(this.pool, actor, [scopeId], read, async (client) => {
      const result = await client.query<ExportStatus>(
        `SELECT ej.id, ej.state, ej.created_at, ej.expires_at, ej.deletion_epoch,
           ej.ready_auth_epoch, s.deletion_epoch AS current_deletion_epoch,
           s.auth_epoch AS current_auth_epoch
         FROM export_jobs ej JOIN scopes s ON s.user_id=ej.user_id AND s.id=ej.scope_id
         WHERE ej.user_id=$1 AND ej.scope_id=$2 AND ej.id=$3`,
        [actor.userId, scopeId, exportId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new CoreError(404, 'not_found', 'Export job was not found');
      if (
        row.state === 'ready' &&
        (Number(row.deletion_epoch) !== Number(row.current_deletion_epoch) ||
          row.ready_auth_epoch === null ||
          Number(row.ready_auth_epoch) !== Number(row.current_auth_epoch))
      ) {
        throw new CoreError(404, 'export_unavailable', 'Export is unavailable or expired');
      }
      return {
        export_id: row.id,
        state: row.state,
        created_at: row.created_at,
        expires_at: row.expires_at,
        content_available:
          row.state === 'ready' && row.expires_at !== null && row.expires_at > new Date(),
      };
    });
  }

  async download(
    actor: ActorContext,
    scopeId: string,
    exportId: string,
  ): Promise<{ readonly bundle: string; readonly filename: string }> {
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may download an export');
    return withAuthorizedActor(this.pool, actor, [scopeId], admin, async (client) => {
      const result = await client.query<
        ExportStatus & { artifact_key: string | null; user_id: string }
      >(
        `SELECT ej.id, ej.user_id, ej.state, ej.created_at, ej.expires_at, ej.deletion_epoch,
           ej.ready_auth_epoch, s.deletion_epoch AS current_deletion_epoch,
           s.auth_epoch AS current_auth_epoch, ej.artifact_key
         FROM export_jobs ej JOIN scopes s ON s.user_id=ej.user_id AND s.id=ej.scope_id
         WHERE ej.user_id=$1 AND ej.scope_id=$2 AND ej.id=$3 AND s.deletion_epoch=ej.deletion_epoch
           AND s.auth_epoch=ej.ready_auth_epoch AND ej.state='ready'
           AND ej.expires_at > clock_timestamp()`,
        [actor.userId, scopeId, exportId],
      );
      const row = result.rows[0];
      if (row === undefined || row.artifact_key === null)
        throw new CoreError(404, 'export_unavailable', 'Export is unavailable or expired');
      const bundle = await this.store.read(row.artifact_key);
      // Verify the encrypted artifact on every read and never publish a reusable URL.
      this.store.open(bundle);
      // withAuthorizedActor revalidates the Gate credential immediately before this
      // transaction commits, after the storage read and before these bytes can be returned.
      return { bundle, filename: row.artifact_key };
    });
  }

  async importBundle(
    actor: ActorContext,
    raw: unknown,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const parsed = importRequestSchema.safeParse(raw);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Import request is invalid',
        false,
        parsed.error.issues,
      );
    assertIdempotencyKey(idempotencyKey);
    if (actor.actorKind !== 'user')
      throw new CoreError(403, 'user_required', 'Only the User may import a scope');
    let opened: unknown;
    try {
      opened = this.store.open(parsed.data.encrypted_bundle);
    } catch {
      throw new CoreError(400, 'untrusted_bundle', 'Portable bundle authentication failed');
    }
    const payload = bundleSchema.safeParse(decodePortableBundleV1(opened));
    if (!payload.success)
      throw new CoreError(400, 'invalid_bundle', 'Portable bundle data is invalid');
    const bundleHash = portabilityPayloadHash(opened);
    const requestHash = portabilityPayloadHash({ bundle_hash: bundleHash, ...parsed.data });
    return withAuthorizedActor(this.pool, actor, [parsed.data.scope_id], admin, async (client) => {
      await lockScopeWrites(client, actor.userId, parsed.data.scope_id);
      const prior = await client.query<ImportStatus>(
        `SELECT id, state, bundle_hash, request_hash, response, id_map FROM portability_imports
         WHERE user_id=$1 AND scope_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`,
        [actor.userId, parsed.data.scope_id, actor.principalId, idempotencyKey],
      );
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new CoreError(
            409,
            'idempotency_conflict',
            'Idempotency-Key was used for another import',
          );
        return (
          prior.rows[0].response ?? {
            import_id: prior.rows[0].id,
            state: prior.rows[0].state,
            id_map: prior.rows[0].id_map,
          }
        );
      }
      const importId = randomUUID();
      const receipt = await client.query<{ id: string }>(
        `INSERT INTO portability_imports(id, user_id, scope_id, principal_id, idempotency_key, bundle_hash, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          importId,
          actor.userId,
          parsed.data.scope_id,
          actor.principalId,
          idempotencyKey,
          bundleHash,
          requestHash,
        ],
      );
      const tableData = payload.data.tables;
      const suppressed = await hasSuppressedPortableSource(
        client,
        actor,
        parsed.data.scope_id,
        tableData,
        this.hmacKey,
      );
      if (suppressed) {
        const response = {
          import_id: receipt.rows[0]!.id,
          state: 'held',
          reason: 'source_suppressed',
        };
        await client.query(
          "UPDATE portability_imports SET state='held', response=$2::jsonb WHERE id=$1",
          [importId, JSON.stringify(response)],
        );
        return response;
      }
      const existingSource = await hasConflictingSource(
        client,
        actor.userId,
        parsed.data.scope_id,
        tableData.sources,
      );
      if (existingSource) {
        const response = {
          import_id: receipt.rows[0]!.id,
          state: 'held',
          reason: 'source_conflict',
        };
        await client.query(
          "UPDATE portability_imports SET state='held', response=$2::jsonb WHERE id=$1",
          [importId, JSON.stringify(response)],
        );
        return response;
      }
      const idMap = buildIdMap(tableData);
      await client.query('SAVEPOINT portable_import');
      try {
        const importedMemories = await insertPortableTables(
          client,
          actor,
          parsed.data.scope_id,
          payload.data.origin,
          importId,
          tableData,
          idMap,
          parsed.data.grant_imported_sources,
        );
        const feed = await recordPortableImportChanges(
          client,
          actor,
          parsed.data.scope_id,
          importId,
          importedMemories,
        );
        await client.query('RELEASE SAVEPOINT portable_import');
        const response = {
          import_id: importId,
          state: 'complete',
          imported_memories: importedMemories.length,
          grant_imported_sources: parsed.data.grant_imported_sources,
          id_map: idMap,
          ...(feed === null ? {} : feed),
        };
        await client.query(
          `UPDATE portability_imports SET state='complete', id_map=$2::jsonb, response=$3::jsonb,
          completed_at=clock_timestamp() WHERE id=$1`,
          [importId, JSON.stringify(idMap), JSON.stringify(response)],
        );
        return response;
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT portable_import');
        await client.query('RELEASE SAVEPOINT portable_import');
        const response = {
          import_id: importId,
          state: 'held',
          reason: 'conflict_or_invalid_history',
        };
        await client.query(
          "UPDATE portability_imports SET state='held', response=$2::jsonb WHERE id=$1",
          [importId, JSON.stringify(response)],
        );
        return response;
      }
    });
  }

  async processPendingWorker(workerPool: Database): Promise<{ exports: number; failed: number }> {
    const pending = await workerPool.query<ExportJob>(
      'SELECT * FROM app.list_pending_export_jobs()',
    );
    let exports = 0;
    let failed = 0;
    for (const job of pending.rows) {
      let artifactKey: string | null = null;
      try {
        const actor = await loadWorkerActor(workerPool, job);
        if (actor === null) {
          await finishExport(workerPool, job, null, false, 0, null);
          failed += 1;
          continue;
        }
        const artifact = await withAuthorizedActor(
          workerPool,
          actor,
          [job.scope_id],
          admin,
          async (client) => {
            await lockScopeWrites(client, job.user_id, job.scope_id);
            const current = await client.query<{
              deletion_epoch: string | number;
              auth_epoch: string | number;
            }>(`SELECT deletion_epoch, auth_epoch FROM scopes WHERE user_id=$1 AND id=$2`, [
              job.user_id,
              job.scope_id,
            ]);
            if (Number(current.rows[0]?.deletion_epoch ?? -1) !== Number(job.deletion_epoch))
              throw new Error('The scope changed after this export was requested');
            const payload = await this.createPayload(client, job);
            const encrypted = this.store.seal(payload);
            return { encrypted, auth_epoch: Number(current.rows[0]!.auth_epoch) };
          },
        );
        artifactKey = this.store.keyForClaim(job.export_id, job.claim_token);
        const finished = await finishExport(
          workerPool,
          job,
          artifactKey,
          true,
          this.jobTtlMs,
          artifact.auth_epoch,
          async () => {
            const storedKey = await this.store.write(
              job.export_id,
              artifact.encrypted,
              job.claim_token,
            );
            if (storedKey !== artifactKey) throw new Error('Export artifact key changed');
          },
        );
        if (!finished) {
          await this.store.remove(artifactKey);
          failed += 1;
        } else exports += 1;
      } catch (error) {
        console.error('Portable export attempt failed', {
          event: 'portability.export.failed',
          trace_id: job.export_id,
          error_code:
            typeof error === 'object' && error !== null && 'code' in error
              ? safeErrorCode(String(error.code))
              : error instanceof Error
                ? error.name
                : 'unknown',
        });
        if (artifactKey !== null) {
          let shouldRemove = false;
          try {
            const persisted = await withTransaction(workerPool, async (client) => {
              const result = await client.query<{ state: string; artifact_key: string | null }>(
                'SELECT state, artifact_key FROM export_jobs WHERE id=$1 FOR UPDATE',
                [job.export_id],
              );
              return (
                result.rows[0]?.state === 'ready' && result.rows[0]?.artifact_key === artifactKey
              );
            });
            shouldRemove = !persisted;
          } catch {
            // If commit visibility is uncertain, leave the file for durable job cleanup.
          }
          if (shouldRemove) await this.store.remove(artifactKey);
        }
        try {
          await finishExport(workerPool, job, null, false, 0, null);
        } catch {
          /* A stale job remains unavailable. */
        }
        failed += 1;
      }
    }
    return { exports, failed };
  }

  async expireArtifacts(workerPool: Database): Promise<number> {
    const expired = await workerPool.query<{ artifact_key: string | null }>(
      'SELECT artifact_key FROM app.expire_export_jobs()',
    );
    return expired.rowCount ?? 0;
  }

  async processPendingFileDeletions(
    workerPool: Database,
  ): Promise<{ deleted: number; pending: number }> {
    const claimed = await workerPool.query<{
      id: string;
      user_id: string;
      scope_id: string;
      artifact_key: string;
    }>('SELECT * FROM app.claim_governance_file_deletions()');
    let deleted = 0;
    let pending = 0;
    for (const row of claimed.rows) {
      try {
        await this.store.remove(row.artifact_key);
        const result = await workerPool.query<{ ack_governance_file_deletion: boolean }>(
          'SELECT app.ack_governance_file_deletion($1, $2)',
          [row.id, row.artifact_key],
        );
        if (result.rows[0]?.ack_governance_file_deletion) deleted += 1;
        else pending += 1;
      } catch {
        // The durable queue retains the artifact key; an expired lease makes it retryable.
        pending += 1;
      }
    }
    return { deleted, pending };
  }

  private async createPayload(client: PoolClient, job: ExportJob): Promise<unknown> {
    const tables = {} as Record<TableName, PortableRow[]>;
    for (const table of tableOrder)
      tables[table] = await readTable(client, table, job.user_id, job.scope_id);
    const suppressions = await client.query<{
      object_kind: string;
      object_id: string | null;
      locator_hmac: string | null;
    }>(
      `SELECT object_kind, object_id, locator_hmac FROM suppressions WHERE user_id=$1 AND scope_id=$2`,
      [job.user_id, job.scope_id],
    );
    const blockedMemory = new Set(
      suppressions.rows
        .filter((row) => row.object_kind === 'memory' && row.object_id !== null)
        .map((row) => row.object_id!),
    );
    const blockedSource = new Set(
      suppressions.rows
        .filter((row) => row.object_kind === 'source' && row.object_id !== null)
        .map((row) => row.object_id!),
    );
    const blockedHashes = new Set(
      suppressions.rows.filter((row) => row.locator_hmac !== null).map((row) => row.locator_hmac!),
    );
    const sources = new Map(tables.sources.map((source) => [stringValue(source['id']), source]));
    const allowedSourceIds = new Set<string>();
    for (const source of tables.sources) {
      const id = stringValue(source['id']);
      const kind = stringValue(source['kind']);
      const externalId = stringValue(source['external_id']);
      const revision = stringValue(source['revision']);
      if (
        source['rights_status'] === 'granted' &&
        source['consent'] === true &&
        !blockedSource.has(id) &&
        !blockedHashes.has(
          sourceIdentityDigest(this.hmacKey, job.scope_id, kind, externalId, revision),
        )
      ) {
        allowedSourceIds.add(id);
      }
    }
    const allowedEvidenceIds = new Set<string>();
    for (const evidence of tables.evidence) {
      const source = sources.get(stringValue(evidence['source_id']));
      if (source === undefined || !allowedSourceIds.has(stringValue(source['id']))) continue;
      const digest = observationLocatorDigest(
        this.hmacKey,
        job.scope_id,
        stringValue(source['kind']),
        stringValue(source['external_id']),
        stringValue(source['revision']),
        stringValue(evidence['locator']),
      );
      if (!blockedHashes.has(digest)) allowedEvidenceIds.add(stringValue(evidence['id']));
    }
    const allowedMemoryIds = new Set<string>();
    for (const memory of tables.memories) {
      const id = stringValue(memory['id']);
      if (blockedMemory.has(id)) continue;
      const evidenceIds = new Set([
        ...tables.memory_evidence
          .filter((row) => row['memory_id'] === id)
          .map((row) => stringValue(row['evidence_id'])),
        ...tables.memory_version_evidence
          .filter((row) => row['memory_id'] === id)
          .map((row) => stringValue(row['evidence_id'])),
      ]);
      if ([...evidenceIds].some((evidenceId) => !allowedEvidenceIds.has(evidenceId))) continue;
      allowedMemoryIds.add(id);
    }
    const includedSources = tables.sources.filter((row) =>
      allowedSourceIds.has(stringValue(row['id'])),
    );
    const includedObservations = tables.observations.filter((row) => {
      const source = sources.get(stringValue(row['source_id']));
      if (source === undefined || !allowedSourceIds.has(stringValue(source['id']))) return false;
      return !blockedHashes.has(
        observationLocatorDigest(
          this.hmacKey,
          job.scope_id,
          stringValue(source['kind']),
          stringValue(source['external_id']),
          stringValue(source['revision']),
          stringValue(row['canonical_locator'] ?? row['locator']),
        ),
      );
    });
    const includedEpisodes = tables.episodes.filter((row) =>
      allowedSourceIds.has(stringValue(row['source_id'])),
    );
    const includedEvidence = tables.evidence.filter((row) =>
      allowedEvidenceIds.has(stringValue(row['id'])),
    );
    const includedMemories = tables.memories.filter((row) =>
      allowedMemoryIds.has(stringValue(row['id'])),
    );
    const includedSubjects = tables.subjects.filter((row) =>
      tables.memory_subjects.some(
        (link) =>
          allowedMemoryIds.has(stringValue(link['memory_id'])) && link['subject_id'] === row['id'],
      ),
    );
    const includedSubjectIds = new Set(includedSubjects.map((row) => stringValue(row['id'])));
    return encodePortableBundleV1({
      format: LEGACY_PORTABILITY_PAYLOAD_FORMAT,
      schema_version: 1,
      origin: {
        user_id: job.user_id,
        scope_id: job.scope_id,
        export_id: job.export_id,
        created_at: new Date().toISOString(),
      },
      tables: {
        sources: includedSources,
        observations: includedObservations,
        episodes: includedEpisodes,
        evidence: includedEvidence,
        subjects: includedSubjects,
        subject_aliases: tables.subject_aliases.filter((row) =>
          includedSubjectIds.has(stringValue(row['subject_id'])),
        ),
        memories: includedMemories,
        memory_versions: tables.memory_versions.filter((row) =>
          allowedMemoryIds.has(stringValue(row['memory_id'])),
        ),
        memory_subjects: tables.memory_subjects.filter(
          (row) =>
            allowedMemoryIds.has(stringValue(row['memory_id'])) &&
            includedSubjectIds.has(stringValue(row['subject_id'])),
        ),
        memory_evidence: tables.memory_evidence.filter(
          (row) =>
            allowedMemoryIds.has(stringValue(row['memory_id'])) &&
            allowedEvidenceIds.has(stringValue(row['evidence_id'])),
        ),
        memory_version_evidence: tables.memory_version_evidence.filter(
          (row) =>
            allowedMemoryIds.has(stringValue(row['memory_id'])) &&
            allowedEvidenceIds.has(stringValue(row['evidence_id'])),
        ),
        relations: tables.relations.filter(
          (row) =>
            allowedMemoryIds.has(stringValue(row['from_memory_id'])) &&
            allowedMemoryIds.has(stringValue(row['to_memory_id'])),
        ),
      },
    });
  }
}

async function readTable(
  client: PoolClient,
  table: TableName,
  userId: string,
  scopeId: string,
): Promise<PortableRow[]> {
  const result = await client.query<{ rows: PortableRow[] }>(
    `SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) AS rows
     FROM (SELECT * FROM public.${table} WHERE user_id=$1 AND scope_id=$2) r`,
    [userId, scopeId],
  );
  return result.rows[0]?.rows ?? [];
}

async function hasSuppressedPortableSource(
  client: PoolClient,
  actor: ActorContext,
  scopeId: string,
  tables: BundleTables,
  hmacKey: string,
): Promise<boolean> {
  const digests: string[] = [];
  for (const source of tables.sources) {
    const kind = stringValue(source['kind']);
    const externalId = stringValue(source['external_id']);
    const revision = stringValue(source['revision']);
    digests.push(sourceIdentityDigest(hmacKey, scopeId, kind, externalId, revision));
  }
  const sourceById = new Map(tables.sources.map((source) => [stringValue(source['id']), source]));
  for (const record of [...tables.observations, ...tables.evidence]) {
    const source = sourceById.get(stringValue(record['source_id']));
    if (source === undefined) return true;
    digests.push(
      observationLocatorDigest(
        hmacKey,
        scopeId,
        stringValue(source['kind']),
        stringValue(source['external_id']),
        stringValue(source['revision']),
        stringValue(record['canonical_locator'] ?? record['locator']),
      ),
    );
  }
  if (digests.length === 0) return false;
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM suppressions WHERE user_id=$1 AND scope_id=$2
      AND object_kind='locator_hmac' AND locator_hmac=ANY($3::text[])) AS present`,
    [actor.userId, scopeId, [...new Set(digests)]],
  );
  return result.rows[0]?.present ?? true;
}

async function hasConflictingSource(
  client: PoolClient,
  userId: string,
  scopeId: string,
  sources: readonly PortableRow[],
): Promise<boolean> {
  for (const source of sources) {
    const exists = await client.query(
      `SELECT 1 FROM sources WHERE user_id=$1 AND scope_id=$2 AND kind=$3 AND external_id=$4 AND revision=$5 LIMIT 1`,
      [userId, scopeId, source['kind'], source['external_id'], source['revision']],
    );
    if (exists.rowCount !== 0) return true;
  }
  return false;
}

function buildIdMap(tables: BundleTables): Record<string, string> {
  const map: Record<string, string> = {};
  for (const table of tableOrder) {
    for (const row of tables[table]) {
      const id = row['id'];
      if (id === undefined) continue;
      if (typeof id !== 'string' || !z.uuid().safeParse(id).success)
        throw new CoreError(400, 'invalid_bundle', `Portable ${table} identifiers are invalid`);
      map[`${table}:${id}`] = randomUUID();
    }
  }
  for (const table of ['sources', 'observations', 'evidence'] as const) {
    for (const row of tables[table]) {
      const root = row['lineage_root'];
      if (root === null || root === undefined) continue;
      if (typeof root !== 'string' || !z.uuid().safeParse(root).success)
        throw new CoreError(
          400,
          'invalid_bundle',
          `Portable ${table} lineage identifiers are invalid`,
        );
      if (map[`lineage:${root}`] === undefined) {
        map[`lineage:${root}`] =
          map[`sources:${root}`] ?? map[`observations:${root}`] ?? randomUUID();
      }
    }
  }
  return map;
}

async function insertPortableTables(
  client: PoolClient,
  actor: ActorContext,
  scopeId: string,
  origin: { user_id: string; scope_id: string; export_id: string; created_at: string },
  importId: string,
  tables: BundleTables,
  idMap: Record<string, string>,
  grantSources: boolean,
): Promise<ImportedMemory[]> {
  const mapId = (table: TableName, value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('Portable reference is invalid');
    const mapped = idMap[`${table}:${value}`];
    if (mapped === undefined) throw new Error('Portable reference is missing');
    return mapped;
  };
  const mapLineage = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('Portable lineage is invalid');
    const mapped = idMap[`lineage:${value}`];
    if (mapped === undefined) throw new Error('Portable lineage mapping is missing');
    return mapped;
  };
  const originalLineage = (row: PortableRow): string | null => {
    const value = row['origin_lineage_root'] ?? row['lineage_root'];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !z.uuid().safeParse(value).success)
      throw new Error('Portable origin lineage is invalid');
    return value;
  };
  const base = (row: PortableRow, table: TableName): PortableRow => ({
    ...row,
    id: row['id'] === undefined ? undefined : mapId(table, row['id']),
    user_id: actor.userId,
    scope_id: scopeId,
  });
  const insert = async (
    table: TableName,
    row: PortableRow,
    overrides: PortableRow = {},
  ): Promise<void> => {
    const values = { ...base(row, table), ...overrides };
    const names = columns[table];
    const args = names.map((name) => values[name] ?? null);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
      `INSERT INTO public.${table} (${names.join(', ')}) VALUES (${placeholders})`,
      args,
    );
  };

  for (const row of tables.sources) {
    await insert('sources', row, {
      rights_status: grantSources ? 'granted' : 'revoked',
      consent: grantSources,
      lineage_root: mapLineage(row['lineage_root']),
      origin_lineage_root: originalLineage(row),
    });
  }
  for (const row of tables.observations) {
    await insert('observations', row, {
      source_id: mapId('sources', row['source_id']),
      lineage_root: mapLineage(row['lineage_root']),
      origin_lineage_root: originalLineage(row),
    });
  }
  for (const row of tables.episodes)
    await insert('episodes', row, { source_id: mapId('sources', row['source_id']) });
  for (const row of tables.evidence) {
    await insert('evidence', row, {
      source_id: mapId('sources', row['source_id']),
      observation_id: mapId('observations', row['observation_id']),
      lineage_root: mapLineage(row['lineage_root']),
      origin_lineage_root: originalLineage(row),
    });
  }
  for (const row of tables.subjects) await insert('subjects', row);
  for (const row of tables.subject_aliases)
    await insert('subject_aliases', row, { subject_id: mapId('subjects', row['subject_id']) });
  const importedMemories: ImportedMemory[] = [];
  for (const row of tables.memories) {
    const memoryId = mapId('memories', row['id']);
    const revision = row['revision'];
    if (memoryId === null || typeof revision !== 'number' || !Number.isInteger(revision))
      throw new Error('Portable memory identity is invalid');
    await insert('memories', row, {
      created_by: actor.principalId,
      actor_kind: 'connector',
      authority: 'third_party_claim',
      indexed_revision: 0,
      import_provenance: {
        origin_user_id: origin.user_id,
        origin_scope_id: origin.scope_id,
        origin_export_id: origin.export_id,
        origin_memory_id: row['id'],
        origin_created_by: row['created_by'],
        origin_authority: row['authority'],
        origin_actor_kind: row['actor_kind'],
        import_id: importId,
      },
    });
    importedMemories.push({ id: memoryId, revision });
  }
  for (const row of tables.memory_versions) {
    await insert('memory_versions', row, {
      memory_id: mapId('memories', row['memory_id']),
      actor_kind: 'connector',
      authority: 'third_party_claim',
      changed_by: actor.principalId,
      change_set_id: null,
      origin_provenance: {
        origin_user_id: origin.user_id,
        origin_scope_id: origin.scope_id,
        origin_memory_version_id: row['id'],
        origin_changed_by: row['changed_by'],
        origin_change_set_id: row['change_set_id'],
        origin_authority: row['authority'],
        origin_actor_kind: row['actor_kind'],
        import_id: importId,
      },
    });
  }
  for (const row of tables.memory_subjects) {
    await insert('memory_subjects', row, {
      memory_id: mapId('memories', row['memory_id']),
      subject_id: mapId('subjects', row['subject_id']),
    });
  }
  for (const row of tables.memory_evidence) {
    await insert('memory_evidence', row, {
      memory_id: mapId('memories', row['memory_id']),
      evidence_id: mapId('evidence', row['evidence_id']),
    });
  }
  for (const row of tables.memory_version_evidence) {
    await insert('memory_version_evidence', row, {
      memory_id: mapId('memories', row['memory_id']),
      evidence_id: mapId('evidence', row['evidence_id']),
    });
  }
  for (const row of tables.relations) {
    await insert('relations', row, {
      from_memory_id: mapId('memories', row['from_memory_id']),
      to_memory_id: mapId('memories', row['to_memory_id']),
      created_by: actor.principalId,
    });
  }
  return importedMemories;
}

async function recordPortableImportChanges(
  client: PoolClient,
  actor: ActorContext,
  scopeId: string,
  importId: string,
  memories: readonly ImportedMemory[],
): Promise<{ change_set_id: string; sequence_from: string; sequence_to: string } | null> {
  if (memories.length === 0) return null;
  await client.query(
    'INSERT INTO scope_offsets(user_id, scope_id) VALUES ($1, $2) ON CONFLICT (user_id, scope_id) DO NOTHING',
    [actor.userId, scopeId],
  );
  await client.query(
    'SELECT last_seq FROM scope_offsets WHERE user_id = $1 AND scope_id = $2 FOR UPDATE',
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
      importId,
      memories.length,
      JSON.stringify({ change_set_id: changeSetId, source: 'portable_import' }),
      actor.clientId ?? null,
    ],
  );
  const result = await client.query<{ last_seq: string }>(
    `UPDATE scope_offsets SET last_seq = last_seq + $3, updated_at = clock_timestamp()
     WHERE user_id = $1 AND scope_id = $2 RETURNING last_seq`,
    [actor.userId, scopeId, memories.length],
  );
  const last = BigInt(result.rows[0]?.last_seq ?? '0');
  const first = last - BigInt(memories.length) + 1n;
  for (let index = 0; index < memories.length; index += 1) {
    const memory = memories[index];
    if (memory === undefined) continue;
    const seq = (first + BigInt(index)).toString();
    const changeId = randomUUID();
    await client.query(
      `INSERT INTO change_ops(user_id, scope_id, change_set_id, ordinal, op, memory_id,
         memory_revision, metadata)
       VALUES ($1, $2, $3, $4, 'IMPORT', $5, $6, $7::jsonb)`,
      [
        actor.userId,
        scopeId,
        changeSetId,
        index,
        memory.id,
        memory.revision,
        JSON.stringify({ import_id: importId }),
      ],
    );
    await client.query(
      `INSERT INTO change_log(user_id, scope_id, id, seq, change_set_id, op, memory_id,
         memory_revision, tombstone)
       VALUES ($1, $2, $3, $4, $5, 'IMPORT', $6, $7, false)`,
      [actor.userId, scopeId, changeId, seq, changeSetId, memory.id, memory.revision],
    );
    await client.query(
      `INSERT INTO outbox(user_id, scope_id, id, event_type, aggregate_id, payload)
       VALUES ($1, $2, $3, 'memory.change', $4, $5::jsonb)`,
      [
        actor.userId,
        scopeId,
        randomUUID(),
        changeSetId,
        JSON.stringify({ change_id: changeId, seq, op: 'IMPORT' }),
      ],
    );
  }
  return {
    change_set_id: changeSetId,
    sequence_from: first.toString(),
    sequence_to: last.toString(),
  };
}

async function loadWorkerActor(pool: Database, job: ExportJob): Promise<ActorContext | null> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [job.user_id]);
    await client.query("SELECT set_config('app.scope_ids',$1,true)", [`{${job.scope_id}}`]);
    await client.query("SELECT set_config('app.principal_id',$1,true)", [job.principal_id]);
    const access = await client.query<{ auth_epoch: string | number; capabilities: string[] }>(
      `SELECT auth_epoch, capabilities FROM app.lock_actor_access($1,$2,'user',ARRAY[$3::uuid])`,
      [job.user_id, job.principal_id, job.scope_id],
    );
    const current = access.rows[0];
    if (current === undefined || !current.capabilities.includes('admin')) return null;
    return {
      userId: job.user_id,
      principalId: job.principal_id,
      actorKind: 'user',
      scopeIds: [job.scope_id],
      tokenScopeIds: [job.scope_id],
      capabilities: ['admin'],
      authEpochs: { [job.scope_id]: Number(current.auth_epoch) },
    };
  });
}

async function finishExport(
  pool: Database,
  job: ExportJob,
  artifactKey: string | null,
  succeeded: boolean,
  ttlMs = 0,
  expectedAuthEpoch: number | null = null,
  writeBeforeCommit?: () => Promise<void>,
): Promise<boolean> {
  const expiresAt = succeeded ? new Date(Date.now() + ttlMs).toISOString() : null;
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ finish_export_job: boolean }>(
      `SELECT app.finish_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        job.export_id,
        job.user_id,
        job.scope_id,
        job.principal_id,
        job.deletion_epoch,
        expectedAuthEpoch,
        artifactKey,
        expiresAt,
        succeeded,
        job.claim_token,
      ],
    );
    const finished = result.rows[0]?.finish_export_job ?? false;
    if (finished && writeBeforeCommit !== undefined) await writeBeforeCommit();
    return finished;
  });
}

function lockScopeWrites(client: PoolClient, userId: string, scopeId: string): Promise<unknown> {
  return client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || $2 || ':' || $3, 0))", [
    LEGACY_SCOPE_WRITE_LOCK_PREFIX,
    userId,
    scopeId,
  ]);
}

function assertIdempotencyKey(value: string): void {
  if (value.length < 1 || value.length > 256)
    throw new CoreError(400, 'invalid_request', 'Idempotency-Key must contain 1 to 256 characters');
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Portable string field is invalid');
  return value;
}

function safeErrorCode(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : 'provider_error';
}
