import { encodeIdentityProvenanceV1 } from '@memory/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  CoreError,
  LEGACY_SCOPE_WRITE_LOCK_PREFIX,
  captureRequestSchema,
  connectorAuthorizationSchema,
  type ActorContext,
} from '@memory/contracts';
import type { Database } from '@memory/db';
import {
  observationLocatorDigest,
  sourceIdentityDigest,
  withAuthorizedActor,
} from '@memory/domain';

const write = 'write' as const;

interface ConnectorRow {
  readonly rights_status: 'granted' | 'revoked';
  readonly enabled: boolean;
  readonly consent: boolean;
  readonly metadata: Record<string, unknown>;
}

export interface ConnectorServiceOptions {
  readonly promptGeneration?: string;
  readonly modelId?: string;
  readonly forgetHmacKey?: string;
}

export class ConnectorService {
  private readonly promptGeneration: string;
  private readonly modelId: string;
  private readonly forgetHmacKey: string | undefined;

  constructor(
    private readonly pool: Database,
    options: ConnectorServiceOptions = {},
  ) {
    this.promptGeneration = options.promptGeneration ?? 'curator-v1';
    this.modelId = options.modelId ?? 'local-fake-v1';
    this.forgetHmacKey = options.forgetHmacKey ?? process.env['FORGET_HMAC_KEY'];
  }

  async configure(actor: ActorContext, rawRequest: unknown): Promise<Record<string, unknown>> {
    const parsed = connectorAuthorizationSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new CoreError(
        400,
        'invalid_request',
        'Connector authorization is invalid',
        false,
        parsed.error.issues,
      );
    }
    if (actor.actorKind !== 'user') {
      throw new CoreError(403, 'user_required', 'Only the User may enable a source connector');
    }
    const value = parsed.data;
    const rightsStatus = value.enabled && value.consent ? 'granted' : 'revoked';
    return withAuthorizedActor(this.pool, actor, [value.scope_id], write, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || $2 || ':' || $3, 0))",
        [LEGACY_SCOPE_WRITE_LOCK_PREFIX, actor.userId, value.scope_id],
      );
      const result = await client.query<{ id: string; enabled: boolean; consent: boolean }>(
        `INSERT INTO connector_authorizations(user_id, scope_id, source_kind, external_id,
           enabled, consent, rights_status, metadata, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, clock_timestamp())
         ON CONFLICT (user_id, scope_id, source_kind, external_id) DO UPDATE
           SET enabled = EXCLUDED.enabled, consent = EXCLUDED.consent,
               rights_status = EXCLUDED.rights_status, metadata = EXCLUDED.metadata,
               updated_at = clock_timestamp()
         RETURNING id, enabled, consent`,
        [
          actor.userId,
          value.scope_id,
          value.source_kind,
          value.external_id,
          value.enabled,
          value.consent,
          rightsStatus,
          JSON.stringify(value.metadata),
          actor.principalId,
        ],
      );
      await client.query(
        `UPDATE sources SET rights_status = $5, consent = $6, metadata = $7::jsonb
         WHERE user_id = $1 AND scope_id = $2 AND kind = $3 AND external_id = $4
           AND (rights_status IS DISTINCT FROM $5 OR consent IS DISTINCT FROM $6)`,
        [
          actor.userId,
          value.scope_id,
          value.source_kind,
          value.external_id,
          rightsStatus,
          value.enabled && value.consent,
          JSON.stringify(value.metadata),
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new CoreError(500, 'internal_error', 'Connector authorization was not stored', true);
      return {
        connector_id: row.id,
        scope_id: value.scope_id,
        source_kind: value.source_kind,
        external_id: value.external_id,
        enabled: row.enabled,
        consent: row.consent,
        rights_status: rightsStatus,
      };
    });
  }

  async capture(
    actor: ActorContext,
    rawRequest: unknown,
    idempotencyKey: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const parsed = captureRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new CoreError(
        400,
        'invalid_request',
        'Capture request is invalid',
        false,
        parsed.error.issues,
      );
    }
    if (idempotencyKey.length < 1 || idempotencyKey.length > 256) {
      throw new CoreError(
        400,
        'invalid_request',
        'Idempotency-Key must contain 1 to 256 characters',
      );
    }
    const capture = parsed.data;
    const payloadHash = hash(
      stableJson({
        scope_id: capture.scope_id,
        source: capture.source,
        observations: capture.observations,
      }),
    );

    return withAuthorizedActor(this.pool, actor, [capture.scope_id], write, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || $2 || ':' || $3, 0))",
        [LEGACY_SCOPE_WRITE_LOCK_PREFIX, actor.userId, capture.scope_id],
      );
      const sourceDigests =
        this.forgetHmacKey === undefined
          ? []
          : [
              sourceIdentityDigest(
                this.forgetHmacKey,
                capture.scope_id,
                capture.source.kind,
                capture.source.external_id,
                capture.source.revision,
              ),
              ...capture.observations.map((observation) =>
                observationLocatorDigest(
                  this.forgetHmacKey!,
                  capture.scope_id,
                  capture.source.kind,
                  capture.source.external_id,
                  capture.source.revision,
                  observation.locator,
                ),
              ),
            ];
      const suppressed =
        this.forgetHmacKey === undefined
          ? await client.query<{ present: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM suppressions WHERE user_id = $1 AND scope_id = $2
              AND object_kind = 'locator_hmac' AND locator_hmac IS NOT NULL) AS present`,
              [actor.userId, capture.scope_id],
            )
          : await client.query<{ present: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM suppressions WHERE user_id = $1 AND scope_id = $2
              AND object_kind = 'locator_hmac' AND locator_hmac = ANY($3::text[])) AS present`,
              [actor.userId, capture.scope_id, sourceDigests],
            );
      if (suppressed.rows[0]?.present === true) {
        throw new CoreError(
          this.forgetHmacKey === undefined ? 503 : 403,
          this.forgetHmacKey === undefined ? 'forget_key_unavailable' : 'source_suppressed',
          this.forgetHmacKey === undefined
            ? 'Source suppression cannot be checked without the configured key'
            : 'This source is no longer available for capture',
          this.forgetHmacKey === undefined,
        );
      }
      const locks = [
        `capture-operation:${actor.userId}:${capture.scope_id}:${actor.principalId}:${capture.operation_id}`,
        `capture-idempotency:${actor.userId}:${capture.scope_id}:${actor.principalId}:${idempotencyKey}`,
      ].sort();
      for (const lock of locks)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
      const prior = await client.query<{ payload_hash: string; job_id: string }>(
        `SELECT payload_hash, job_id FROM capture_requests
         WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3
           AND (operation_id = $4 OR idempotency_key = $5)
         FOR UPDATE`,
        [actor.userId, capture.scope_id, actor.principalId, capture.operation_id, idempotencyKey],
      );
      const priorRows = [...new Map(prior.rows.map((row) => [row.job_id, row])).values()];
      if (priorRows.length > 0) {
        if (priorRows.some((row) => row.payload_hash !== payloadHash) || priorRows.length > 1) {
          throw new CoreError(
            409,
            'idempotency_conflict',
            'Capture operation ID or Idempotency-Key was reused with different input',
          );
        }
        return { status: 'accepted', job_id: priorRows[0]!.job_id, replayed: true };
      }

      const connector = await client.query<ConnectorRow>(
        `SELECT enabled, consent, rights_status, metadata
         FROM connector_authorizations
         WHERE user_id = $1 AND scope_id = $2 AND source_kind = $3 AND external_id = $4
         FOR UPDATE`,
        [actor.userId, capture.scope_id, capture.source.kind, capture.source.external_id],
      );
      const authorization = connector.rows[0];
      if (
        authorization === undefined ||
        !authorization.enabled ||
        !authorization.consent ||
        authorization.rights_status !== 'granted'
      ) {
        throw new CoreError(
          403,
          'source_forbidden',
          'The User has not enabled this source with consent',
        );
      }

      const sourceResult = await client.query<{ id: string }>(
        `INSERT INTO sources(user_id, scope_id, kind, external_id, revision, rights_status, consent, metadata)
         VALUES ($1, $2, $3, $4, $5, 'granted', true, $6::jsonb)
         ON CONFLICT (user_id, scope_id, kind, external_id, revision) DO UPDATE
           SET rights_status = CASE WHEN sources.rights_status = 'granted' AND sources.consent THEN 'granted' ELSE 'revoked' END
         RETURNING id`,
        [
          actor.userId,
          capture.scope_id,
          capture.source.kind,
          capture.source.external_id,
          capture.source.revision,
          JSON.stringify(authorization.metadata),
        ],
      );
      const sourceId = sourceResult.rows[0]?.id;
      if (sourceId === undefined)
        throw new CoreError(500, 'internal_error', 'Capture source was not stored', true);
      const sourceRights = await client.query<{ rights_status: string; consent: boolean }>(
        'SELECT rights_status, consent FROM sources WHERE user_id = $1 AND scope_id = $2 AND id = $3 FOR SHARE',
        [actor.userId, capture.scope_id, sourceId],
      );
      if (sourceRights.rows[0]?.rights_status !== 'granted' || !sourceRights.rows[0]?.consent) {
        throw new CoreError(403, 'source_forbidden', 'Source rights were revoked');
      }

      const observationIds: string[] = [];
      for (const observation of capture.observations) {
        const canonicalLocator = canonicalizeLocator(observation.locator);
        const contentHash = hash(observation.content.normalize('NFKC'));
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO observations(user_id, scope_id, source_id, source_revision, speaker,
             event_time, locator, canonical_locator, source_kind, content, content_hash, lineage_root)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12::uuid)
           ON CONFLICT (user_id, scope_id, source_id, source_revision, canonical_locator, content_hash)
           DO NOTHING RETURNING id`,
          [
            actor.userId,
            capture.scope_id,
            sourceId,
            capture.source.revision,
            observation.speaker ?? null,
            observation.event_time ?? null,
            observation.locator,
            canonicalLocator,
            capture.source.kind,
            observation.content,
            contentHash,
            observation.lineage_root ?? null,
          ],
        );
        let observationId = inserted.rows[0]?.id;
        if (observationId === undefined) {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM observations WHERE user_id = $1 AND scope_id = $2 AND source_id = $3
               AND source_revision = $4 AND canonical_locator = $5 AND content_hash = $6`,
            [
              actor.userId,
              capture.scope_id,
              sourceId,
              capture.source.revision,
              canonicalLocator,
              contentHash,
            ],
          );
          observationId = existing.rows[0]?.id;
        }
        if (observationId === undefined)
          throw new CoreError(500, 'internal_error', 'Capture observation was not stored', true);
        observationIds.push(observationId);
      }

      const requestHash = hash(
        stableJson({
          source_id: sourceId,
          observation_ids: observationIds,
          principal_id: actor.principalId,
          actor_kind: actor.actorKind,
          auth_epochs: actor.authEpochs,
          token_scope_ids: actor.tokenScopeIds,
          capabilities: actor.capabilities,
          prompt_generation: this.promptGeneration,
          model_id: this.modelId,
        }),
      );
      const newJob = await client.query<{ id: string }>(
        `INSERT INTO capture_jobs(user_id, scope_id, source_id, state, principal_id, actor_kind,
           request_hash, prompt_generation, model_id, auth_epochs, token_scope_ids, authorized_capabilities)
         VALUES ($1, $2, $3, 'accepted', $4, $5, $6, $7, $8, $9::jsonb, $10::uuid[], $11::text[])
         ON CONFLICT (user_id, scope_id, source_id, request_hash) WHERE request_hash IS NOT NULL
         DO NOTHING RETURNING id`,
        [
          actor.userId,
          capture.scope_id,
          sourceId,
          actor.principalId,
          actor.actorKind,
          requestHash,
          this.promptGeneration,
          this.modelId,
          JSON.stringify(actor.authEpochs),
          actor.tokenScopeIds,
          actor.capabilities,
        ],
      );
      const isNewJob = newJob.rows[0] !== undefined;
      let jobId = newJob.rows[0]?.id;
      if (jobId === undefined) {
        const existingJob = await client.query<{ id: string }>(
          `SELECT id FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND source_id = $3 AND request_hash = $4`,
          [actor.userId, capture.scope_id, sourceId, requestHash],
        );
        jobId = existingJob.rows[0]?.id;
      }
      if (jobId === undefined)
        throw new CoreError(500, 'internal_error', 'Capture job was not stored', true);
      for (const [ordinal, observationId] of observationIds.entries()) {
        await client.query(
          `INSERT INTO capture_job_observations(user_id, scope_id, job_id, observation_id, ordinal)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [actor.userId, capture.scope_id, jobId, observationId, ordinal],
        );
      }
      await client.query(
        `INSERT INTO capture_requests(user_id, scope_id, principal_id, operation_id,
           idempotency_key, payload_hash, job_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          actor.userId,
          capture.scope_id,
          actor.principalId,
          capture.operation_id,
          idempotencyKey,
          payloadHash,
          jobId,
        ],
      );
      if (isNewJob) {
        await client.query(
          `INSERT INTO outbox(user_id, scope_id, id, event_type, aggregate_id, payload)
           VALUES ($1, $2, $3, 'capture.accepted', $4, $5::jsonb)
           ON CONFLICT DO NOTHING`,
          [actor.userId, capture.scope_id, randomUUID(), jobId, JSON.stringify({ job_id: jobId })],
        );
      }
      await client.query(
        `INSERT INTO audit_events(user_id, scope_id, principal_id, event_type, request_id, object_id, metadata)
         VALUES ($1, $2, $3, 'capture.accepted', $4::uuid, $5, $6::jsonb)`,
        [
          actor.userId,
          capture.scope_id,
          actor.principalId,
          requestId,
          jobId,
          JSON.stringify({ observations: observationIds.length, source_kind: capture.source.kind }),
        ],
      );
      return {
        status: 'accepted',
        job_id: jobId,
        replayed: false,
        observations: observationIds.length,
      };
    });
  }
}

export function canonicalizeLocator(locator: string): string {
  const normalized = locator.normalize('NFKC').trim().replace(/\\/g, '/');
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(normalized);
  if (scheme?.[1] !== undefined && scheme[2] !== undefined) {
    return `${scheme[1].toLowerCase()}${scheme[2].replace(/\/{2,}/g, '/')}`;
  }
  return normalized.replace(/\/{2,}/g, '/');
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown): string {
  return stableJsonRaw(encodeIdentityProvenanceV1(value));
}

function stableJsonRaw(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonRaw).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJsonRaw(item)}`).join(',')}}`;
}
