import { randomUUID } from 'node:crypto';
import {
  allCompartments,
  CoreError,
  reviewDecisionSchema,
  reviewListQuerySchema,
  uuidSchema,
  type ActorContext,
  type EvidenceInput,
  type MemoryInput,
} from '@memory/contracts';
import { setDatabaseContext, withTransaction, type Database } from '@memory/db';
import { CoreService, withAuthorizedActor } from '@memory/domain';
import {
  parseCuratorResult,
  validateProposalEvidence,
  type CuratorObservation,
  type CuratorProvider,
  type CuratorProposal,
} from '@memory/curator';
import { RecallService } from '@memory/recall';
import type { PoolClient } from 'pg';

interface ClaimedJob {
  readonly job_id: string;
  readonly user_id: string;
  readonly scope_id: string;
  readonly source_id: string;
  readonly principal_id: string;
  readonly actor_kind: ActorContext['actorKind'];
  readonly attempt: number;
  readonly state: string;
  readonly lease_token: string;
}

interface JobRuntime extends ClaimedJob {
  readonly prompt_generation: string;
  readonly model_id: string;
  readonly max_attempts: number;
  readonly authorized_capabilities: readonly string[];
  readonly token_scope_ids: readonly string[];
  readonly auth_epochs: Record<string, number>;
  readonly checkpoint: Record<string, unknown>;
  readonly observations: readonly CuratorObservation[];
  readonly source_kind: 'chat' | 'document' | 'tool_result' | 'episode';
  readonly source_external_id: string;
  readonly source_revision: string;
}

interface WorkCandidate {
  readonly memory: MemoryInput;
  readonly anchors: readonly { observationId: string; spanStart: number; spanEnd: number }[];
  readonly proposal: CuratorProposal;
  readonly matched: readonly Record<string, unknown>[];
  readonly safe: boolean;
  readonly duplicate: Record<string, unknown> | null;
  readonly reasonCodes: readonly string[];
}

export type CaptureJobResult =
  | { readonly status: 'accepted' | 'processing'; readonly job_id: string }
  | {
      readonly status: 'committed' | 'held' | 'failed';
      readonly job_id: string;
      readonly review_id?: string;
      readonly duplicate?: boolean;
    };

export interface CaptureProcessorOptions {
  readonly leaseSeconds?: number;
  readonly maxProviderMs?: number;
  readonly retryBaseSeconds?: number;
}

export class CaptureJobProcessor {
  private readonly leaseSeconds: number;
  private readonly maxProviderMs: number;
  private readonly retryBaseSeconds: number;

  constructor(
    private readonly workerPool: Database,
    private readonly core: CoreService,
    private readonly recall: RecallService,
    private readonly provider: CuratorProvider,
    options: CaptureProcessorOptions = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 120;
    this.maxProviderMs = options.maxProviderMs ?? 30_000;
    this.retryBaseSeconds = options.retryBaseSeconds ?? 2;
  }

  async process(jobId: string): Promise<CaptureJobResult> {
    if (!uuidSchema.safeParse(jobId).success)
      throw new CoreError(400, 'invalid_request', 'job_id must be a UUID');
    const leaseToken = randomUUID();
    const claimed = await withTransaction(this.workerPool, async (client) => {
      const result = await client.query<ClaimedJob>(
        'SELECT * FROM app.claim_capture_job($1::uuid, $2::uuid, $3::integer)',
        [jobId, leaseToken, this.leaseSeconds],
      );
      return result.rows[0];
    });
    if (claimed === undefined) return this.currentState(jobId);
    const skeleton = { ...claimed, lease_token: leaseToken };
    let runtime: JobRuntime | undefined;
    try {
      runtime = await this.loadAuthorizedJob(skeleton);
      const actor = actorFromJob(runtime);
      const readAllowed = actor.capabilities.includes('read');
      const initialCandidates = readAllowed
        ? await this.matchingCandidates(actor, runtime.observations)
        : [];
      const savedResult = runtime.checkpoint['curator_result'];
      let result: Awaited<ReturnType<CuratorProvider['extract']>>;
      if (savedResult !== undefined) {
        result = parseCuratorResult(savedResult);
      } else {
        const controller = new AbortController();
        result = await runWithDeadline(
          this.provider.extract({
            observations: runtime.observations,
            candidates: initialCandidates,
            promptVersion: runtime.prompt_generation,
            modelId: runtime.model_id,
            signal: controller.signal,
            tokenBudget: 8_000,
          }),
          controller,
          this.maxProviderMs,
        );
        await this.saveCuratorResult(actor, runtime.scope_id, skeleton, result);
      }
      const unique = new Set<string>();
      const candidates: WorkCandidate[] = [];
      let invalidProposalCount = 0;
      let invalidEpisodeProposal = false;
      for (const proposal of result.proposals) {
        let verifiedAnchors: ReturnType<typeof validateProposalEvidence>;
        let memory: MemoryInput;
        try {
          verifiedAnchors = validateProposalEvidence(proposal, runtime.observations);
          if (
            runtime.source_kind === 'episode' &&
            !isCompleteEpisodeProposal(proposal, verifiedAnchors)
          ) {
            invalidProposalCount += 1;
            invalidEpisodeProposal = true;
            continue;
          }
          if (verifiedAnchors.some((anchor) => anchor.end - anchor.start > 8_192)) {
            invalidProposalCount += 1;
            continue;
          }
          memory = toMemoryInput(proposal, verifiedAnchors, runtime);
        } catch {
          // Invalid provider anchors are isolated and never reach a ChangeSet or Memory write.
          invalidProposalCount += 1;
          continue;
        }
        const signature = `${proposal.kind}:${normalizeClaim(proposal.statement)}`;
        if (unique.has(signature)) continue;
        unique.add(signature);
        const matched = readAllowed
          ? await this.recall.searchCandidates(
              actor,
              runtime.scope_id,
              proposal.statement.slice(0, 2_000),
              8,
            )
          : [];
        const exactDuplicates = matched.filter(
          (match) =>
            match['kind'] === proposal.kind &&
            normalizeClaim(String(match['statement'] ?? '')) ===
              normalizeClaim(proposal.statement) &&
            match['lifecycle'] === 'active' &&
            match['contested'] !== true,
        );
        const duplicate =
          exactDuplicates.length === 1 && matched.length === 1 ? exactDuplicates[0]! : null;
        const reasonCodes: string[] = [];
        if (!readAllowed) reasonCodes.push('read_capability_required_for_reconciliation');
        if (proposal.kind !== 'fact') reasonCodes.push('non_fact_requires_user_review');
        if (proposal.contested) reasonCodes.push('contested_proposal');
        if (!['observed', 'inferred'].includes(proposal.epistemic_status))
          reasonCodes.push('uncertain_epistemic_status');
        if (matched.length > 0 && (duplicate === null || proposal.kind !== 'fact'))
          reasonCodes.push('existing_memory_requires_reconciliation');
        const safe =
          readAllowed &&
          proposal.kind === 'fact' &&
          !proposal.contested &&
          ['observed', 'inferred'].includes(proposal.epistemic_status) &&
          (matched.length === 0 || duplicate !== null) &&
          proposal.statement.length <= 8_192 &&
          verifiedAnchors.every((anchor) => anchor.end - anchor.start <= 8_192);
        candidates.push({
          memory,
          anchors: verifiedAnchors.map((anchor) => ({
            observationId: anchor.observation.id,
            spanStart: anchor.start,
            spanEnd: anchor.end,
          })),
          proposal,
          matched,
          safe,
          duplicate,
          reasonCodes: reasonCodes.length === 0 ? ['user_review_required'] : reasonCodes,
        });
      }
      if (invalidEpisodeProposal) {
        await this.finish(skeleton, 'held', 'invalid_episode_structure', {
          invalid_provider_output: true,
          invalid_proposal_count: invalidProposalCount,
          model_version: result.modelVersion,
          prompt_version: result.promptVersion,
          usage: result.usage,
        });
        return { status: 'held', job_id: jobId };
      }
      if (result.proposals.length > 0 && candidates.length === 0) {
        await this.finish(skeleton, 'held', 'invalid_provider_evidence', {
          invalid_provider_output: true,
        });
        return { status: 'held', job_id: jobId };
      }
      if (candidates.length === 0) {
        await this.finish(skeleton, 'committed', null, {
          proposal_count: result.proposals.length,
          invalid_proposal_count: invalidProposalCount,
          model_version: result.modelVersion,
          prompt_version: result.promptVersion,
          usage: result.usage,
        });
        return { status: 'committed', job_id: jobId };
      }

      const held: WorkCandidate[] = [];
      let anyCommitted = false;
      const committedMemoryIds: string[] = [];
      for (const [index, candidate] of candidates.entries()) {
        if (!candidate.safe) {
          held.push(candidate);
          continue;
        }
        const idempotencyKey = `capture:${jobId}:candidate:${index}`;
        if (candidate.duplicate !== null) {
          const committed = await this.core.corroborateCuratedMemory(
            actor,
            runtime.scope_id,
            String(candidate.duplicate['id']),
            Number(candidate.duplicate['revision']),
            candidate.memory.evidence,
            candidate.anchors,
            randomUUID(),
            idempotencyKey,
            { jobId: skeleton.job_id, leaseToken },
          );
          committedMemoryIds.push(...extractMemoryIds(committed));
        } else {
          const committed = await this.core.commitCuratedFacts(
            actor,
            runtime.scope_id,
            [{ memory: candidate.memory, anchors: candidate.anchors }],
            randomUUID(),
            idempotencyKey,
            { jobId: skeleton.job_id, leaseToken },
          );
          committedMemoryIds.push(...extractMemoryIds(committed));
        }
        anyCommitted = true;
      }
      if (anyCommitted && committedMemoryIds.length > 0)
        await this.recall.indexCommittedMemories(actor, committedMemoryIds);
      if (held.length > 0) {
        const review = await this.createReview(actor, runtime, skeleton, held, result);
        return { status: 'held', job_id: jobId, review_id: review.reviewId };
      }
      await this.finish(skeleton, 'committed', null, {
        proposal_count: result.proposals.length,
        committed_count: candidates.length,
        model_version: result.modelVersion,
        prompt_version: result.promptVersion,
        usage: result.usage,
      });
      return {
        status: 'committed',
        job_id: jobId,
        duplicate: candidates.some((candidate) => candidate.duplicate !== null),
      };
    } catch (error) {
      const detail = error instanceof CoreError ? error.code : 'provider_or_worker_error';
      const retryable =
        !(error instanceof CoreError) || (error.retryable && error.code !== 'stale_authorization');
      const attempt = runtime?.attempt ?? claimed.attempt;
      const maxAttempts = runtime?.max_attempts ?? 5;
      if (retryable && attempt < maxAttempts) {
        const delay = Math.min(3_600, this.retryBaseSeconds * 2 ** Math.max(0, attempt - 1));
        await this.finish(skeleton, 'failed', detail, { retry_after_seconds: delay }, delay);
        return { status: 'failed', job_id: jobId };
      }
      await this.finish(skeleton, 'held', detail, { terminal_error: true });
      return { status: 'held', job_id: jobId };
    }
  }

  private async loadAuthorizedJob(claim: ClaimedJob): Promise<JobRuntime> {
    const preliminary = await withTransaction(this.workerPool, async (client) => {
      await setJobTenant(client, claim.user_id, claim.scope_id);
      const result = await client.query<{
        prompt_generation: string;
        model_id: string;
        max_attempts: number;
        attempt: number;
        authorized_capabilities: string[];
        token_scope_ids: string[];
        auth_epochs: Record<string, number>;
        checkpoint: Record<string, unknown>;
      }>(
        `SELECT prompt_generation, model_id, max_attempts, attempt, authorized_capabilities, token_scope_ids, auth_epochs, checkpoint
         FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND lease_token = $4`,
        [claim.user_id, claim.scope_id, claim.job_id, claim.lease_token],
      );
      return result.rows[0];
    });
    if (preliminary === undefined)
      throw new CoreError(409, 'job_lease_lost', 'Capture job lease is no longer current', true);
    const capabilities = normalizeCapabilities(preliminary.authorized_capabilities);
    const actor: ActorContext = {
      userId: claim.user_id,
      principalId: claim.principal_id,
      actorKind: claim.actor_kind,
      scopeIds: [claim.scope_id],
      tokenScopeIds: preliminary.token_scope_ids.includes(claim.scope_id) ? [claim.scope_id] : [],
      capabilities,
      authEpochs: { [claim.scope_id]: Number(preliminary.auth_epochs[claim.scope_id]) },
      compartments: allCompartments,
    };
    const data = await withAuthorizedActor(
      this.workerPool,
      actor,
      [claim.scope_id],
      'write',
      async (client) => {
        const source = await client.query<{
          source_kind: JobRuntime['source_kind'];
          source_external_id: string;
          source_revision: string;
          rights_status: string;
          consent: boolean;
          enabled: boolean;
          connector_consent: boolean;
        }>(
          `SELECT s.kind AS source_kind, s.external_id AS source_external_id, s.revision AS source_revision,
            s.rights_status, s.consent, ca.enabled, ca.consent AS connector_consent
         FROM capture_jobs j JOIN sources s ON s.user_id = j.user_id AND s.scope_id = j.scope_id AND s.id = j.source_id
         JOIN connector_authorizations ca ON ca.user_id = s.user_id AND ca.scope_id = s.scope_id
           AND ca.source_kind = s.kind AND ca.external_id = s.external_id
         WHERE j.user_id = $1 AND j.scope_id = $2 AND j.id = $3 AND j.lease_token = $4
         FOR SHARE OF j`,
          [claim.user_id, claim.scope_id, claim.job_id, claim.lease_token],
        );
        const sourceRow = source.rows[0];
        if (
          sourceRow === undefined ||
          sourceRow.rights_status !== 'granted' ||
          !sourceRow.consent ||
          !sourceRow.enabled ||
          !sourceRow.connector_consent
        )
          throw new CoreError(
            403,
            'source_forbidden',
            'Capture source consent or rights were revoked',
          );
        const observations = await client.query<CuratorObservation>(
          `SELECT o.id, o.source_id, o.source_kind, o.source_revision, o.locator, o.content, o.speaker,
           to_char(o.event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS event_time,
           o.lineage_root::text AS lineage_root
         FROM capture_job_observations jo JOIN observations o ON o.user_id = jo.user_id AND o.scope_id = jo.scope_id AND o.id = jo.observation_id
         WHERE jo.user_id = $1 AND jo.scope_id = $2 AND jo.job_id = $3 ORDER BY jo.ordinal`,
          [claim.user_id, claim.scope_id, claim.job_id],
        );
        if (observations.rows.length === 0)
          throw new CoreError(
            409,
            'capture_observations_missing',
            'Capture job has no source observations',
          );
        return { source: sourceRow, observations: observations.rows };
      },
    );
    return {
      ...claim,
      ...preliminary,
      observations: data.observations,
      source_kind: data.source.source_kind,
      source_external_id: data.source.source_external_id,
      source_revision: data.source.source_revision,
    };
  }

  private async matchingCandidates(
    actor: ActorContext,
    observations: readonly CuratorObservation[],
  ): Promise<readonly Record<string, unknown>[]> {
    const found = new Map<string, Record<string, unknown>>();
    for (const observation of observations.slice(0, 16)) {
      const query = observation.content.slice(0, 2_000).trim();
      if (query.length < 2) continue;
      const matches = await this.recall.searchCandidates(actor, actor.scopeIds[0]!, query, 8);
      for (const match of matches) {
        const id = String(match['id'] ?? '');
        if (id !== '') found.set(id, match);
      }
      if (found.size >= 50) break;
    }
    return [...found.values()].slice(0, 50);
  }

  private async saveCuratorResult(
    actor: ActorContext,
    scopeId: string,
    claim: ClaimedJob,
    result: Awaited<ReturnType<CuratorProvider['extract']>>,
  ): Promise<void> {
    await withAuthorizedActor(this.workerPool, actor, [scopeId], 'write', async (client) => {
      const saved = await client.query(
        `UPDATE capture_jobs SET checkpoint = checkpoint || $5::jsonb, updated_at = clock_timestamp()
         WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND lease_token = $4
           AND state = 'processing' AND lease_until > clock_timestamp()`,
        [
          claim.user_id,
          scopeId,
          claim.job_id,
          claim.lease_token,
          JSON.stringify({ curator_result: result }),
        ],
      );
      if (saved.rowCount !== 1)
        throw new CoreError(
          409,
          'job_lease_lost',
          'Capture job lease was lost while saving provider output',
          true,
        );
    });
  }

  private async createReview(
    actor: ActorContext,
    runtime: JobRuntime,
    claim: ClaimedJob,
    candidates: readonly WorkCandidate[],
    result: Awaited<ReturnType<CuratorProvider['extract']>>,
  ): Promise<{ reviewId: string }> {
    const changeSet = {
      scope_id: runtime.scope_id,
      operations: candidates.map((candidate) => ({
        op: 'CREATE' as const,
        memory: candidate.memory,
      })),
    };
    const reasonCodes = [...new Set(candidates.flatMap((candidate) => candidate.reasonCodes))];
    const review = await this.core.createCurationReview(
      actor,
      changeSet,
      randomUUID(),
      `capture-review:${claim.job_id}`,
      { jobId: claim.job_id, leaseToken: claim.lease_token },
      {
        reasonCodes,
        rationale: candidates
          .map((candidate) => candidate.proposal.rationale)
          .filter(Boolean)
          .join('\n')
          .slice(0, 4_000),
        candidateSummary: {
          candidates: candidates.map((candidate) => ({
            kind: candidate.memory.kind,
            statement: candidate.memory.statement,
            candidate_matches: candidate.matched.map((match) => ({
              id: match['id'],
              revision: match['revision'],
              kind: match['kind'],
              statement: match['statement'],
            })),
          })),
          model_version: result.modelVersion,
          prompt_version: result.promptVersion,
          usage: result.usage,
        },
        evidenceAnchors: candidates.map((candidate) => candidate.anchors),
        expectedRevisions: Object.fromEntries(
          candidates.flatMap((candidate) =>
            candidate.matched.map((match) => [String(match['id']), Number(match['revision'])]),
          ),
        ),
        checkpoint: {
          model_version: result.modelVersion,
          prompt_version: result.promptVersion,
          usage: result.usage,
          reason_codes: reasonCodes,
        },
      },
    );
    return { reviewId: review.review_id };
  }

  private async finish(
    claim: ClaimedJob,
    state: 'committed' | 'held' | 'failed',
    errorCode: string | null,
    checkpoint: Record<string, unknown>,
    retryAfterSeconds?: number,
  ): Promise<void> {
    await withTransaction(this.workerPool, async (client) => {
      await setJobTenant(client, claim.user_id, claim.scope_id);
      const result = await client.query(
        `UPDATE capture_jobs SET state = $5, last_error_code = $6,
           next_retry_at = CASE WHEN $7::integer IS NULL THEN NULL ELSE clock_timestamp() + make_interval(secs => $7) END,
           checkpoint = checkpoint || $8::jsonb, lease_until = NULL, lease_token = NULL,
           updated_at = clock_timestamp()
         WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND lease_token = $4
           AND state = 'processing' AND lease_until > clock_timestamp()`,
        [
          claim.user_id,
          claim.scope_id,
          claim.job_id,
          claim.lease_token,
          state,
          errorCode,
          retryAfterSeconds ?? null,
          JSON.stringify(checkpoint),
        ],
      );
      if (result.rowCount !== 1)
        throw new CoreError(
          409,
          'job_lease_lost',
          'Capture job lease was lost before completion',
          true,
        );
    });
  }

  private async currentState(jobId: string): Promise<CaptureJobResult> {
    const result = await this.workerPool.query<{ state: string; review_id: string | null }>(
      'SELECT * FROM app.capture_job_status($1::uuid)',
      [jobId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new CoreError(404, 'not_found', 'Capture job not found');
    if (row.state === 'processing') return { status: 'processing', job_id: jobId };
    if (row.state === 'held' || row.state === 'committed' || row.state === 'failed') {
      return {
        status: row.state,
        job_id: jobId,
        ...(row.review_id === null ? {} : { review_id: row.review_id }),
      };
    }
    return { status: 'accepted', job_id: jobId };
  }
}

export class CurationReviewService {
  constructor(
    private readonly pool: Database,
    private readonly core: CoreService,
  ) {}

  async list(actor: ActorContext, rawQuery: unknown): Promise<Record<string, unknown>> {
    if (actor.actorKind !== 'user' && actor.actsForUser !== true)
      throw new CoreError(403, 'user_required', 'Only the User may read the curation queue');
    const parsed = reviewListQuerySchema.safeParse(rawQuery);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Review list query is invalid',
        false,
        parsed.error.issues,
      );
    const query = parsed.data;
    const rows = await withAuthorizedActor(
      this.pool,
      actor,
      [query.scope_id],
      'read',
      async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `WITH visible AS (
           SELECT r.*, c.proposal,
             (s.rights_status = 'granted' AND s.consent AND ca.enabled AND ca.consent
               AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id AND sp.object_id = s.id)) AS source_visible
           FROM curation_reviews r JOIN capture_jobs j ON j.user_id = r.user_id AND j.scope_id = r.scope_id AND j.id = r.job_id
           JOIN sources s ON s.user_id = j.user_id AND s.scope_id = j.scope_id AND s.id = j.source_id
           JOIN connector_authorizations ca ON ca.user_id = s.user_id AND ca.scope_id = s.scope_id AND ca.source_kind = s.kind AND ca.external_id = s.external_id
           JOIN changesets c ON c.user_id = r.user_id AND c.scope_id = r.scope_id AND c.id = r.change_set_id
           WHERE r.user_id = $1 AND r.scope_id = $2
         )
         SELECT id, scope_id, CASE WHEN source_visible THEN status ELSE 'stale' END AS status,
           revision, reason_codes, CASE WHEN source_visible THEN rationale ELSE NULL END AS rationale,
           CASE WHEN source_visible THEN candidate_summary ELSE NULL END AS candidate_summary,
           created_at, updated_at, decision_reason,
           CASE WHEN source_visible THEN proposal ELSE NULL END AS proposal
         FROM visible
         WHERE (($3 = 'stale' AND NOT source_visible) OR ($3 <> 'stale' AND source_visible AND status = $3))
           AND ($4::timestamptz IS NULL OR created_at < $4)
         ORDER BY created_at DESC, id DESC LIMIT $5`,
          [actor.userId, query.scope_id, query.status, query.before ?? null, query.limit],
        );
        return result.rows;
      },
    );
    return { reviews: rows };
  }

  async get(actor: ActorContext, reviewId: string): Promise<Record<string, unknown>> {
    if (actor.actorKind !== 'user' && actor.actsForUser !== true)
      throw new CoreError(403, 'user_required', 'Only the User may read a curation review');
    if (!uuidSchema.safeParse(reviewId).success)
      throw new CoreError(400, 'invalid_request', 'review_id must be a UUID');
    const scopes = actor.scopeIds.filter((scope) => actor.tokenScopeIds.includes(scope));
    if (scopes.length === 0)
      throw new CoreError(403, 'forbidden', 'An authorized scope is required');
    const row = await withAuthorizedActor(this.pool, actor, scopes, 'read', async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT r.id, r.scope_id,
           CASE WHEN s.rights_status = 'granted' AND s.consent AND ca.enabled AND ca.consent
             AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id AND sp.object_id = s.id)
             THEN r.status ELSE 'stale' END AS status,
           r.revision, r.reason_codes,
           CASE WHEN s.rights_status = 'granted' AND s.consent AND ca.enabled AND ca.consent
             AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id AND sp.object_id = s.id)
             THEN r.rationale ELSE NULL END AS rationale,
           CASE WHEN s.rights_status = 'granted' AND s.consent AND ca.enabled AND ca.consent
             AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id AND sp.object_id = s.id)
             THEN r.candidate_summary ELSE NULL END AS candidate_summary,
           r.created_at, r.updated_at, r.decision_reason,
           CASE WHEN s.rights_status = 'granted' AND s.consent AND ca.enabled AND ca.consent
             AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id AND sp.object_id = s.id)
             THEN c.proposal ELSE NULL END AS proposal
         FROM curation_reviews r JOIN capture_jobs j ON j.user_id = r.user_id AND j.scope_id = r.scope_id AND j.id = r.job_id
         JOIN sources s ON s.user_id = j.user_id AND s.scope_id = j.scope_id AND s.id = j.source_id
         JOIN connector_authorizations ca ON ca.user_id = s.user_id AND ca.scope_id = s.scope_id AND ca.source_kind = s.kind AND ca.external_id = s.external_id
         JOIN changesets c ON c.user_id = r.user_id AND c.scope_id = r.scope_id AND c.id = r.change_set_id
         WHERE r.user_id = $1 AND r.id = $2 AND r.scope_id = ANY($3::uuid[])`,
        [actor.userId, reviewId, scopes],
      );
      return result.rows[0];
    });
    if (row === undefined) throw new CoreError(404, 'not_found', 'Curation review not found');
    return row;
  }

  async decide(
    actor: ActorContext,
    reviewId: string,
    rawDecision: unknown,
    requestId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const parsed = reviewDecisionSchema.safeParse(rawDecision);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Review decision is invalid',
        false,
        parsed.error.issues,
      );
    return this.core.decideCurationReview(
      actor,
      reviewId,
      parsed.data.expected_revision,
      parsed.data.decision,
      parsed.data.confirmation,
      parsed.data.reason ?? null,
      requestId,
      idempotencyKey,
    );
  }

  async jobStatus(actor: ActorContext, jobId: string): Promise<Record<string, unknown>> {
    if (!uuidSchema.safeParse(jobId).success)
      throw new CoreError(400, 'invalid_request', 'job_id must be a UUID');
    const scopes = actor.scopeIds.filter((scope) => actor.tokenScopeIds.includes(scope));
    if (scopes.length === 0)
      throw new CoreError(403, 'forbidden', 'An authorized scope is required');
    const row = await withAuthorizedActor(this.pool, actor, scopes, 'read', async (client) => {
      const result = await client.query<{
        id: string;
        scope_id: string;
        state: string;
        review_id: string | null;
        attempt: number;
        updated_at: Date;
      }>(
        `SELECT id, scope_id, state, review_id, attempt, updated_at
         FROM capture_jobs WHERE user_id = $1 AND scope_id = ANY($2::uuid[]) AND id = $3`,
        [actor.userId, scopes, jobId],
      );
      return result.rows[0];
    });
    if (row === undefined) throw new CoreError(404, 'not_found', 'Capture job not found');
    return {
      job_id: row.id,
      scope_id: row.scope_id,
      status: row.state,
      attempt: row.attempt,
      ...(row.review_id === null ? {} : { review_id: row.review_id }),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export interface TaskDispatcher {
  dispatch(jobId: string, traceId?: string): Promise<void>;
}

export class HttpTaskDispatcher implements TaskDispatcher {
  constructor(
    private readonly workerUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
    allowInsecureLocalFixture = false,
  ) {
    if (token.length < 32) throw new Error('WORKER_TASK_TOKEN must contain at least 32 characters');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000)
      throw new Error('Worker task timeout must be between 1 second and 15 minutes');
    const url = new URL(workerUrl);
    if (
      url.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) &&
      !(allowInsecureLocalFixture && url.href === 'http://tasks:9091/')
    )
      throw new Error('Worker task endpoint must use HTTPS outside localhost');
  }

  async dispatch(jobId: string, traceId = randomUUID()): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Worker dispatch timed out')),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(new URL('/internal/jobs/run', this.workerUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'x-request-id': traceId,
        },
        body: JSON.stringify({ job_id: jobId }),
      });
      if (!response.ok) throw new Error(`Worker task endpoint returned HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface CloudTasksConfiguration {
  readonly projectId: string;
  readonly location: string;
  readonly queue: string;
  readonly workerUrl: string;
  readonly taskInvokerServiceAccount: string;
}

export type CloudAccessTokenProvider = () => Promise<string>;

export class CloudTasksTaskDispatcher implements TaskDispatcher {
  private readonly taskParentUrl: URL;
  private readonly taskParentName: string;
  private readonly taskUrl: URL;
  private readonly audience: string;
  private readonly taskInvokerServiceAccount: string;

  constructor(
    configuration: CloudTasksConfiguration,
    private readonly accessToken: CloudAccessTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(configuration.projectId))
      throw new Error('CLOUD_TASKS_PROJECT_ID is invalid');
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(configuration.location))
      throw new Error('CLOUD_TASKS_LOCATION is invalid');
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(configuration.queue))
      throw new Error('CLOUD_TASKS_QUEUE is invalid');
    if (
      !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(
        configuration.taskInvokerServiceAccount,
      )
    )
      throw new Error('TASK_INVOKER_SERVICE_ACCOUNT is invalid');
    const workerUrl = new URL(configuration.workerUrl);
    if (
      workerUrl.protocol !== 'https:' ||
      workerUrl.username !== '' ||
      workerUrl.password !== '' ||
      workerUrl.pathname !== '/' ||
      workerUrl.search !== '' ||
      workerUrl.hash !== ''
    )
      throw new Error('WORKER_TASK_URL must be an HTTPS origin');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000)
      throw new Error('Cloud Tasks API timeout must be between 1 and 60 seconds');

    this.taskParentName = `projects/${configuration.projectId}/locations/${configuration.location}/queues/${configuration.queue}/tasks`;
    this.taskParentUrl = new URL(`https://cloudtasks.googleapis.com/v2/${this.taskParentName}`);
    this.audience = workerUrl.origin;
    this.taskUrl = new URL('/internal/jobs/run', workerUrl);
    this.taskInvokerServiceAccount = configuration.taskInvokerServiceAccount;
  }

  async dispatch(jobId: string, _traceId?: string): Promise<void> {
    void _traceId;
    if (!uuidSchema.safeParse(jobId).success) throw new Error('Cloud Task job_id must be a UUID');
    const token = await this.accessToken();
    if (token.length === 0) throw new Error('Google Cloud access token is unavailable');
    const taskName = `${this.taskParentName}/${randomUUID()}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Cloud Tasks API timed out')),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(this.taskParentUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          task: {
            name: taskName,
            dispatchDeadline: '600s',
            httpRequest: {
              httpMethod: 'POST',
              url: this.taskUrl.href,
              headers: { 'Content-Type': 'application/json' },
              body: Buffer.from(JSON.stringify({ job_id: jobId })).toString('base64'),
              oidcToken: {
                serviceAccountEmail: this.taskInvokerServiceAccount,
                audience: this.audience,
              },
            },
          },
        }),
      });
      if (!response.ok) throw new Error(`Cloud Tasks create returned HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OutboxDispatcher {
  constructor(
    private readonly workerPool: Database,
    private readonly tasks: TaskDispatcher,
  ) {}

  async dispatchPending(limit = 50): Promise<{ dispatched: number; retrying: number }> {
    const leaseToken = randomUUID();
    const events = await withTransaction(this.workerPool, async (client) => {
      const result = await client.query<{ event_id: string; payload: Record<string, unknown> }>(
        'SELECT event_id, payload FROM app.claim_outbox_events($1::uuid, $2::integer, 120)',
        [leaseToken, limit],
      );
      return result.rows;
    });
    let dispatched = 0;
    let retrying = 0;
    for (const event of events) {
      const jobId = event.payload['job_id'];
      if (
        typeof jobId !== 'string' ||
        !uuidSchema.safeParse(jobId).success ||
        Object.keys(event.payload).some((key) => key !== 'job_id')
      ) {
        await this.retry(event.event_id, leaseToken, 3_600);
        retrying += 1;
        continue;
      }
      try {
        await this.tasks.dispatch(jobId, event.event_id);
        await this.workerPool.query('SELECT app.complete_outbox_event($1::uuid, $2::uuid)', [
          event.event_id,
          leaseToken,
        ]);
        dispatched += 1;
      } catch {
        const delay = Math.min(86_400, 2 ** Math.min(16, dispatched + retrying + 1));
        await this.retry(event.event_id, leaseToken, delay);
        retrying += 1;
      }
    }
    return { dispatched, retrying };
  }

  async sweepDueJobs(limit = 100): Promise<number> {
    const due = await this.workerPool.query<{ job_id: string }>(
      'SELECT job_id FROM app.due_capture_job_ids($1::integer)',
      [limit],
    );
    let dispatched = 0;
    for (const row of due.rows) {
      try {
        await this.tasks.dispatch(row.job_id, randomUUID());
        dispatched += 1;
      } catch {
        /* The durable outbox/next sweep will retry. */
      }
    }
    return dispatched;
  }

  private async retry(eventId: string, leaseToken: string, seconds: number): Promise<void> {
    await this.workerPool.query('SELECT app.retry_outbox_event($1::uuid, $2::uuid, $3::integer)', [
      eventId,
      leaseToken,
      seconds,
    ]);
  }
}

function actorFromJob(job: JobRuntime): ActorContext {
  return {
    userId: job.user_id,
    principalId: job.principal_id,
    actorKind: job.actor_kind,
    scopeIds: [job.scope_id],
    tokenScopeIds: job.token_scope_ids.includes(job.scope_id) ? [job.scope_id] : [],
    capabilities: normalizeCapabilities(job.authorized_capabilities),
    authEpochs: { [job.scope_id]: Number(job.auth_epochs[job.scope_id]) },
    compartments: allCompartments,
  };
}

function normalizeCapabilities(raw: readonly string[]): ActorContext['capabilities'] {
  const values = new Set(
    raw.filter(
      (value): value is 'read' | 'write' | 'admin' =>
        value === 'read' || value === 'write' || value === 'admin',
    ),
  );
  if (values.has('admin')) {
    values.add('read');
    values.add('write');
  }
  return [...values];
}

function toMemoryInput(
  proposal: CuratorProposal,
  verified: readonly {
    observation: CuratorObservation;
    start: number;
    end: number;
    span: string;
  }[],
  runtime: JobRuntime,
): MemoryInput {
  const evidence: EvidenceInput[] = verified.map((anchor) => ({
    source: {
      kind: runtime.source_kind,
      external_id: runtime.source_external_id,
      revision: anchor.observation.source_revision,
      locator: anchor.observation.locator,
    },
    span: anchor.span,
    ...(anchor.observation.speaker === null ? {} : { speaker: anchor.observation.speaker }),
    ...(anchor.observation.event_time === null
      ? {}
      : { event_time: anchor.observation.event_time }),
    snippet: anchor.span,
    snippet_allowed: true,
  }));
  return {
    kind: proposal.kind,
    statement: proposal.statement,
    context: proposal.context,
    subjects: proposal.subjects,
    valid_from: proposal.valid_from,
    valid_to: proposal.valid_to,
    epistemic_status: proposal.epistemic_status,
    contested: proposal.contested,
    evidence,
  };
}

function normalizeClaim(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isCompleteEpisodeProposal(
  proposal: CuratorProposal,
  verified: ReturnType<typeof validateProposalEvidence>,
): boolean {
  if (proposal.kind !== 'experience' || verified.length !== 1 || proposal.anchors.length !== 1)
    return false;
  const anchor = verified[0];
  if (
    anchor === undefined ||
    anchor.observation.source_kind !== 'episode' ||
    anchor.start !== 0 ||
    anchor.end !== anchor.observation.content.length ||
    anchor.span !== anchor.observation.content ||
    proposal.statement !== anchor.observation.content.trim()
  )
    return false;

  let sourceContext: unknown;
  try {
    sourceContext = JSON.parse(anchor.observation.content) as unknown;
  } catch {
    sourceContext = undefined;
  }
  const episodeContext = proposal.context['episode'];
  if (
    sourceContext !== null &&
    typeof sourceContext === 'object' &&
    !Array.isArray(sourceContext)
  ) {
    const episode = sourceContext as Record<string, unknown>;
    return (
      hasStructuredValue(episode['condition']) &&
      hasStructuredValue(episode['action']) &&
      hasStructuredValue(episode['outcome']) &&
      canonicalJson(episodeContext) === canonicalJson(sourceContext)
    );
  }
  return (
    episodeContext !== null &&
    typeof episodeContext === 'object' &&
    !Array.isArray(episodeContext) &&
    canonicalJson(episodeContext) ===
      canonicalJson({ description: anchor.observation.content.trim() })
  );
}

function hasStructuredValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function extractMemoryIds(result: Record<string, unknown>): string[] {
  const operations = result['operations'];
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((operation) => {
    if (operation === null || typeof operation !== 'object') return [];
    const ids = (operation as Record<string, unknown>)['memory_ids'];
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string' && uuidSchema.safeParse(id).success)
      : [];
  });
}

async function runWithDeadline<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('Curator request timed out'));
      reject(new CoreError(503, 'curator_timeout', 'Curator provider timed out', true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function setJobTenant(client: PoolClient, userId: string, scopeId: string): Promise<void> {
  await setDatabaseContext(client, { userId, scopeIds: [scopeId], compartments: 'all' });
}
