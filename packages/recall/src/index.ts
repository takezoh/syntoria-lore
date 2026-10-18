import { CoreError, recallQuerySchema, type ActorContext } from '@memory/contracts';
import type { Database } from '@memory/db';
import { CoreService, withAuthorizedActor } from '@memory/domain';
import type { EmbeddingProvider } from '@memory/curator';
import type { PoolClient } from 'pg';

interface CandidateRow {
  readonly id: string;
  readonly scope_id: string;
  readonly revision: number;
  readonly lifecycle: string;
  readonly contested: boolean;
  readonly recorded_at: Date;
  readonly score: number;
  readonly indexed_revision: number;
  readonly committed_revision: number;
  readonly lexical_similarity?: number;
  readonly semantic_similarity?: number;
  readonly structured_match?: boolean;
  readonly relation_match?: boolean;
}

interface RecallOptions {
  readonly defaultLimit?: number;
  readonly maxCandidates?: number;
  readonly semanticMinSimilarity?: number;
}

const read = 'read' as const;

export class RecallService {
  private readonly maxCandidates: number;
  private readonly semanticMinSimilarity: number;

  constructor(
    private readonly pool: Database,
    private readonly core: CoreService,
    private readonly embeddings?: EmbeddingProvider,
    options: RecallOptions = {},
  ) {
    this.maxCandidates = options.maxCandidates ?? 200;
    this.semanticMinSimilarity = options.semanticMinSimilarity ?? 0.18;
    if (
      !Number.isFinite(this.semanticMinSimilarity) ||
      this.semanticMinSimilarity < 0 ||
      this.semanticMinSimilarity > 1
    ) {
      throw new Error('semanticMinSimilarity must be between 0 and 1');
    }
  }

  async recall(actor: ActorContext, rawQuery: unknown): Promise<Record<string, unknown>> {
    const parsed = recallQuerySchema.safeParse(rawQuery);
    if (!parsed.success)
      throw new CoreError(
        400,
        'invalid_request',
        'Recall query is invalid',
        false,
        parsed.error.issues,
      );
    const query = parsed.data;
    const requestedScopes = [
      ...new Set(query.scope_ids.length === 0 ? actor.scopeIds : query.scope_ids),
    ].sort();
    await withAuthorizedActor(this.pool, actor, requestedScopes, read, async () => undefined);

    let queryVector: readonly number[] | undefined;
    let semanticUnavailable =
      query.mode !== 'changes' && query.mode !== 'precise' && this.embeddings === undefined;
    if (this.embeddings !== undefined && query.mode !== 'changes' && query.mode !== 'precise') {
      try {
        queryVector = (await embeddingWithDeadline(this.embeddings, [query.query], 20_000))[0];
        if (
          queryVector === undefined ||
          queryVector.length !== this.embeddings.dimension ||
          queryVector.some((value) => !Number.isFinite(value))
        ) {
          queryVector = undefined;
          semanticUnavailable = true;
        } else {
          semanticUnavailable = false;
        }
      } catch {
        semanticUnavailable = true;
      }
    }

    const rankedResult = await withAuthorizedActor(
      this.pool,
      actor,
      requestedScopes,
      read,
      async (client) => {
        const limit = Math.min(this.maxCandidates, query.limit * 8);
        const exact =
          query.mode === 'changes'
            ? []
            : await this.exactCandidates(client, actor, requestedScopes, query, limit);
        const lexical =
          query.mode === 'changes'
            ? await this.changeCandidates(client, actor, requestedScopes, query, limit)
            : query.mode === 'precise'
              ? []
              : await this.lexicalCandidates(client, actor, requestedScopes, query, limit);
        const semantic =
          queryVector === undefined || query.mode === 'precise' || query.mode === 'changes'
            ? []
            : await this.semanticCandidates(
                client,
                actor,
                requestedScopes,
                query,
                queryVector,
                limit,
                this.semanticMinSimilarity,
              );
        const exactKeys = new Set(exact.map((row) => `${row.scope_id}:${row.id}`));
        const supportedRoots = [...exact, ...lexical, ...semantic].filter((row) =>
          hasRetrievalSupport(row, exactKeys, this.semanticMinSimilarity),
        );
        const relation =
          query.mode === 'precise' || query.mode === 'changes'
            ? []
            : await this.relatedCandidates(
                client,
                actor,
                requestedScopes,
                query,
                supportedRoots,
                limit,
              );
        const lag = await this.indexLag(client, actor, requestedScopes, query);
        return {
          rows: mergeRanks(
            query.mode,
            [
              [exact, 4],
              [lexical, 1.5],
              [semantic, 1.5],
              [relation, 0.45],
            ],
            query.limit * 8,
          ).map((row) => ({ ...row, index_lag: lag })),
          exactKeys,
          indexLag: lag,
        };
      },
    );

    const items: Record<string, unknown>[] = [];
    const insufficiencies: string[] = [];
    if (semanticUnavailable && query.mode !== 'changes' && query.mode !== 'precise')
      insufficiencies.push('semantic_index_unavailable');
    for (const candidate of rankedResult.rows) {
      const isExact = rankedResult.exactKeys.has(`${candidate.scope_id}:${candidate.id}`);
      if (!hasRetrievalSupport(candidate, rankedResult.exactKeys, this.semanticMinSimilarity)) {
        continue;
      }
      let memory: Record<string, unknown>;
      try {
        memory = await this.core.getMemory(actor, candidate.scope_id, candidate.id, {
          ...(query.valid_at === undefined ? {} : { valid_at: query.valid_at }),
          ...(query.known_at === undefined ? {} : { known_at: query.known_at }),
        });
      } catch (error) {
        if (
          error instanceof CoreError &&
          (error.status === 404 || error.code === 'source_forbidden')
        )
          continue;
        throw error;
      }
      if (query.mode !== 'exploratory' && memory['lifecycle'] === 'candidate') continue;
      const uncertainty = uncertaintyFor(memory);
      const item = {
        memory,
        score: Number(candidate.score.toFixed(6)),
        exact_match: isExact,
        lexical_similarity: candidate.lexical_similarity ?? 0,
        semantic_similarity: candidate.semantic_similarity ?? 0,
        structured_match: candidate.structured_match ?? false,
        relation_match: candidate.relation_match ?? false,
        uncertainty,
        indexed_revision: candidate.indexed_revision,
        committed_revision: candidate.committed_revision,
      };
      const proposedPack = buildContextPack(
        query.mode,
        [...items, item],
        insufficiencies,
        requestedScopes,
        !semanticUnavailable && !candidate.index_lag,
      );
      const tokens = estimatePackTokens(proposedPack);
      if (tokens > query.token_budget) {
        insufficiencies.push('token_budget_exhausted');
        continue;
      }
      items.push(item);
      if (items.length >= query.limit) break;
    }
    const visibleKeys = await withAuthorizedActor(
      this.pool,
      actor,
      requestedScopes,
      'read',
      async (client) => {
        const rows = await client.query<{ id: string; scope_id: string }>(
          `WITH requested AS (
           SELECT id, scope_id, revision
           FROM jsonb_to_recordset($3::jsonb) AS item(id uuid, scope_id uuid, revision integer)
         )
         SELECT requested.id, requested.scope_id FROM requested
         WHERE requested.scope_id = ANY($2::uuid[]) AND EXISTS (
           SELECT 1 FROM memory_versions v WHERE v.user_id = $1 AND v.scope_id = requested.scope_id
             AND v.memory_id = requested.id AND v.revision = requested.revision
         )
         AND NOT EXISTS (
           SELECT 1 FROM memory_version_evidence mve
           JOIN evidence e ON e.user_id = mve.user_id AND e.scope_id = mve.scope_id AND e.id = mve.evidence_id
           JOIN sources s ON s.user_id = e.user_id AND s.scope_id = e.scope_id AND s.id = e.source_id
           WHERE mve.user_id = $1 AND mve.scope_id = requested.scope_id
             AND mve.memory_id = requested.id AND mve.revision = requested.revision
             AND (s.rights_status <> 'granted' OR NOT s.consent
               OR EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id
                 AND sp.object_id IN (requested.id, s.id, e.id)))
         )`,
          [
            actor.userId,
            requestedScopes,
            JSON.stringify(
              items.map((item) => {
                const memory = item['memory'] as Record<string, unknown>;
                return {
                  id: memory['id'],
                  scope_id: memory['scope_id'],
                  revision: memory['revision'],
                };
              }),
            ),
          ],
        );
        return new Set(rows.rows.map((row) => `${row.scope_id}:${row.id}`));
      },
    );
    const beforeVisibilityFilter = items.length;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const memory = items[index]?.['memory'] as Record<string, unknown> | undefined;
      if (memory === undefined || !visibleKeys.has(`${memory['scope_id']}:${memory['id']}`))
        items.splice(index, 1);
    }
    if (items.length < beforeVisibilityFilter)
      insufficiencies.push('source_rights_changed_during_recall');
    if (items.length === 0) insufficiencies.push('no_supported_match');
    const indexLag = rankedResult.indexLag;
    if (indexLag) insufficiencies.push('embedding_index_lag_fallback');
    let contextPack = buildContextPack(
      query.mode,
      items,
      [...new Set(insufficiencies)],
      requestedScopes,
      !semanticUnavailable && !indexLag,
    );
    let estimatedTokens = estimatePackTokens(contextPack);
    while (estimatedTokens > query.token_budget && items.length > 0) {
      items.pop();
      insufficiencies.push('token_budget_exhausted');
      contextPack = buildContextPack(
        query.mode,
        items,
        [...new Set(insufficiencies)],
        requestedScopes,
        !semanticUnavailable && !indexLag,
      );
      estimatedTokens = estimatePackTokens(contextPack);
    }
    if (estimatedTokens > query.token_budget) {
      throw new CoreError(
        400,
        'token_budget_too_small',
        'Token budget cannot fit the required recall status and coverage',
      );
    }
    return {
      query: query.query,
      context_pack: contextPack,
      matches: items.map((item) => item['memory']),
      unknown: items.length === 0,
      exact: items.some((item) => item['exact_match'] === true),
      mode: query.mode,
      insufficiencies: [...new Set(insufficiencies)],
      coverage: contextPack['coverage'],
      token_budget: query.token_budget,
      estimated_tokens: estimatedTokens,
    };
  }

  async searchCandidates(
    actor: ActorContext,
    scopeId: string,
    query: string,
    limit = 20,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await this.recall(actor, {
      query,
      scope_ids: [scopeId],
      mode: 'contextual',
      limit,
      token_budget: 8_000,
    });
    const pack = result['context_pack'] as { matches?: unknown; items?: unknown } | undefined;
    if (!Array.isArray(pack?.matches) || !Array.isArray(pack.items)) return [];
    const itemById = new Map(
      pack.items.map((item) => {
        const entry = item as Record<string, unknown>;
        return [String(entry['memory_id']), entry] as const;
      }),
    );
    const filtered: Record<string, unknown>[] = (pack.matches as Record<string, unknown>[]).flatMap(
      (memory) => {
        const metadata = itemById.get(String(memory['id']));
        if (metadata === undefined) return [];
        return [
          {
            ...memory,
            retrieval_exact: metadata['exact_match'] === true,
            lexical_similarity: metadata['lexical_similarity'],
            semantic_similarity: metadata['semantic_similarity'],
          },
        ];
      },
    );
    return filtered;
  }

  async indexCommittedMemories(
    actor: ActorContext,
    memoryIds: readonly string[],
  ): Promise<{ indexed: number; skipped: number }> {
    if (this.embeddings === undefined || memoryIds.length === 0)
      return { indexed: 0, skipped: memoryIds.length };
    const memories: { scopeId: string; id: string; revision: number; statement: string }[] = [];
    for (const memoryId of [...new Set(memoryIds)].slice(0, 128)) {
      for (const scopeId of actor.scopeIds) {
        try {
          const memory = await this.core.getMemory(actor, scopeId, memoryId, {});
          const revision = Number(memory['revision']);
          const statement = typeof memory['statement'] === 'string' ? memory['statement'] : '';
          if (revision > 0 && statement.length > 0)
            memories.push({ scopeId, id: memoryId, revision, statement });
          break;
        } catch (error) {
          if (!(error instanceof CoreError && error.status === 404)) throw error;
        }
      }
    }
    if (memories.length === 0) return { indexed: 0, skipped: memoryIds.length };
    const vectors = await embeddingWithDeadline(
      this.embeddings,
      memories.map((row) => row.statement),
      20_000,
    );
    if (
      vectors.length !== memories.length ||
      vectors.some(
        (vector) =>
          vector.length !== this.embeddings!.dimension ||
          vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new CoreError(
        503,
        'embedding_unavailable',
        'Embedding provider returned an invalid vector',
        true,
      );
    }
    const grouped = new Map<string, typeof memories>();
    for (const memory of memories)
      grouped.set(memory.scopeId, [...(grouped.get(memory.scopeId) ?? []), memory]);
    let indexed = 0;
    for (const [scopeId, group] of grouped) {
      const allowed = await withAuthorizedActor(
        this.pool,
        actor,
        [scopeId],
        'write',
        async (client) => {
          for (const memory of group) {
            const row = await client.query<{ allowed: boolean }>(
              `SELECT NOT EXISTS (
               SELECT 1 FROM memory_version_evidence me
               JOIN evidence e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
               JOIN sources s ON s.user_id = e.user_id AND s.scope_id = e.scope_id AND s.id = e.source_id
               WHERE me.user_id = $1 AND me.scope_id = $2 AND me.memory_id = $3 AND me.revision = $4
                 AND (s.rights_status <> 'granted' OR NOT s.consent
                   OR EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id AND sp.object_id IN (s.id,e.id,$3)))
             ) AS allowed`,
              [actor.userId, scopeId, memory.id, memory.revision],
            );
            if (row.rows[0]?.allowed !== true) continue;
            const vector = vectors[memories.indexOf(memory)];
            if (vector === undefined) continue;
            const pgVector = `[${vector.join(',')}]`;
            await client.query(
              `INSERT INTO memory_embeddings(user_id, scope_id, memory_id, revision, model, dimension, generation, embedding)
             SELECT $1, $2, m.id, $4, $5, $6, 1, $7::vector
             FROM memories m WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = $3 AND m.committed_revision = $4
             ON CONFLICT (user_id, scope_id, memory_id, revision, model, dimension)
             DO UPDATE SET generation = memory_embeddings.generation + 1, embedding = EXCLUDED.embedding, created_at = clock_timestamp()
             WHERE memory_embeddings.generation < EXCLUDED.generation`,
              [
                actor.userId,
                scopeId,
                memory.id,
                memory.revision,
                this.embeddings!.modelId,
                this.embeddings!.dimension,
                pgVector,
              ],
            );
            await client.query(
              `UPDATE memories SET indexed_revision = greatest(indexed_revision, $4)
             WHERE user_id = $1 AND scope_id = $2 AND id = $3 AND committed_revision = $4`,
              [actor.userId, scopeId, memory.id, memory.revision],
            );
            indexed += 1;
          }
          return true;
        },
      );
      void allowed;
    }
    return { indexed, skipped: Math.max(0, memoryIds.length - indexed) };
  }

  async indexStaleMemories(
    actor: ActorContext,
    scopeId: string,
    limit = 25,
  ): Promise<{ indexed: number; skipped: number }> {
    if (this.embeddings === undefined) return { indexed: 0, skipped: 0 };
    const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const memoryIds = await withAuthorizedActor(
      this.pool,
      actor,
      [scopeId],
      'write',
      async (client) => {
        const result = await client.query<{ id: string }>(
          `SELECT m.id FROM memories m
         WHERE m.user_id=$1 AND m.scope_id=$2 AND m.lifecycle IN ('active', 'candidate')
           AND m.committed_revision > 0
           AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.user_id=m.user_id
             AND e.scope_id=m.scope_id AND e.memory_id=m.id AND e.revision=m.committed_revision
             AND e.model=$3 AND e.dimension=$4)
           AND NOT EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id=m.user_id
             AND sp.scope_id=m.scope_id AND sp.object_kind='memory' AND sp.object_id=m.id)
           AND NOT EXISTS (SELECT 1 FROM memory_version_evidence mve
             JOIN evidence ev ON ev.user_id=mve.user_id AND ev.scope_id=mve.scope_id AND ev.id=mve.evidence_id
             JOIN sources s ON s.user_id=ev.user_id AND s.scope_id=ev.scope_id AND s.id=ev.source_id
             WHERE mve.user_id=m.user_id AND mve.scope_id=m.scope_id AND mve.memory_id=m.id
               AND mve.revision=m.committed_revision AND (s.rights_status <> 'granted' OR NOT s.consent
                 OR EXISTS (SELECT 1 FROM suppressions ss WHERE ss.user_id=s.user_id AND ss.scope_id=s.scope_id
                 AND ss.object_kind IN ('source', 'evidence')
                   AND ss.object_id IN (s.id, ev.id))))
         ORDER BY m.recorded_at, m.id LIMIT $5`,
          [
            actor.userId,
            scopeId,
            this.embeddings!.modelId,
            this.embeddings!.dimension,
            boundedLimit,
          ],
        );
        return result.rows.map((row) => row.id);
      },
    );
    return this.indexCommittedMemories(actor, memoryIds);
  }

  private exactCandidates(
    client: PoolClient,
    actor: ActorContext,
    scopeIds: readonly string[],
    query: ReturnType<typeof recallQuerySchema.parse>,
    limit: number,
  ): Promise<CandidateRow[]> {
    return this.candidateQuery(
      client,
      `AND (lower(btrim(r.statement)) = lower(btrim($3))
        OR EXISTS (
          SELECT 1 FROM memory_subjects ms JOIN subjects s ON s.user_id = ms.user_id AND s.scope_id = ms.scope_id AND s.id = ms.subject_id
          WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id AND ms.memory_id = r.id AND s.normalized_name = $4)
        OR EXISTS (
          SELECT 1 FROM memory_subjects ms JOIN subject_aliases a ON a.user_id = ms.user_id AND a.scope_id = ms.scope_id AND a.subject_id = ms.subject_id
          WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id AND ms.memory_id = r.id AND a.normalized_alias = $4
            AND ($5::timestamptz IS NULL OR (a.valid_from <= $5 AND (a.valid_to IS NULL OR a.valid_to > $5)))))`,
      [
        actor.userId,
        scopeIds,
        query.query,
        normalizeName(query.query),
        query.valid_at ?? null,
        query.known_at ?? null,
        query.mode,
        query.memory_ids ?? [],
        query.subject_ids ?? [],
        limit,
      ],
      `4::float8`,
      `r.recorded_at DESC`,
    );
  }

  private lexicalCandidates(
    client: PoolClient,
    actor: ActorContext,
    scopeIds: readonly string[],
    query: ReturnType<typeof recallQuerySchema.parse>,
    limit: number,
  ): Promise<CandidateRow[]> {
    return this.candidateQuery(
      client,
      `AND (r.statement ILIKE $10 ESCAPE '\\' OR r.context::text ILIKE $10 ESCAPE '\\'
        OR similarity(r.statement, $3) > 0.08 OR similarity(r.context::text, $3) > 0.08
      OR EXISTS (SELECT 1 FROM memory_subjects ms JOIN subjects s ON s.user_id = ms.user_id AND s.scope_id = ms.scope_id AND s.id = ms.subject_id
          WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id AND ms.memory_id = r.id
            AND (s.normalized_name = $4 OR s.normalized_name ILIKE $10 ESCAPE '\\'))
        OR EXISTS (SELECT 1 FROM memory_subjects ms JOIN subject_aliases a ON a.user_id = ms.user_id AND a.scope_id = ms.scope_id AND a.subject_id = ms.subject_id
          WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id AND ms.memory_id = r.id
            AND (a.normalized_alias = $4 OR a.normalized_alias ILIKE $10 ESCAPE '\\')
            AND ($5::timestamptz IS NULL OR (a.valid_from <= $5 AND (a.valid_to IS NULL OR a.valid_to > $5)))))`,
      [
        actor.userId,
        scopeIds,
        query.query,
        normalizeName(query.query),
        query.valid_at ?? null,
        query.known_at ?? null,
        query.mode,
        query.memory_ids ?? [],
        query.subject_ids ?? [],
        `%${escapeLike(query.query)}%`,
        limit,
      ],
      `greatest(
        similarity(${lexicalTextWithoutOpaqueIds('r.statement')}, ${lexicalTextWithoutOpaqueIds('$3')}),
        similarity(${lexicalTextWithoutOpaqueIds('r.context::text')}, ${lexicalTextWithoutOpaqueIds('$3')}),
        CASE WHEN r.statement ILIKE $10 ESCAPE '\\' THEN 1 ELSE 0 END
      )::float8`,
      `score DESC, r.recorded_at DESC`,
    ).then((rows) => rows.map((row) => ({ ...row, lexical_similarity: row.score })));
  }

  private async semanticCandidates(
    client: PoolClient,
    actor: ActorContext,
    scopeIds: readonly string[],
    query: ReturnType<typeof recallQuerySchema.parse>,
    vector: readonly number[],
    limit: number,
    minSimilarity: number,
  ): Promise<CandidateRow[]> {
    if (this.embeddings === undefined) return [];
    const pgVector = `[${vector.join(',')}]`;
    const distance =
      this.embeddings.dimension === 1536
        ? `(e.embedding::vector(1536) <=> $10::vector(1536))`
        : `(e.embedding <=> $10::vector)`;
    const rows = await this.candidateQuery(
      client,
      `AND EXISTS (SELECT 1 FROM memory_embeddings e
        WHERE e.user_id = r.user_id AND e.scope_id = r.scope_id AND e.memory_id = r.id
          AND e.revision = r.revision AND e.model = $11 AND e.dimension = $12)
        AND 1 - (SELECT ${distance} FROM memory_embeddings e
          WHERE e.user_id = r.user_id AND e.scope_id = r.scope_id AND e.memory_id = r.id
            AND e.revision = r.revision AND e.model = $11 AND e.dimension = $12 LIMIT 1) >= $13::float8`,
      [
        actor.userId,
        scopeIds,
        query.query,
        normalizeName(query.query),
        query.valid_at ?? null,
        query.known_at ?? null,
        query.mode,
        query.memory_ids ?? [],
        query.subject_ids ?? [],
        pgVector,
        this.embeddings.modelId,
        this.embeddings.dimension,
        minSimilarity,
        limit,
      ],
      `1 - (SELECT ${distance} FROM memory_embeddings e
        WHERE e.user_id = r.user_id AND e.scope_id = r.scope_id AND e.memory_id = r.id
          AND e.revision = r.revision AND e.model = $11 AND e.dimension = $12 LIMIT 1)
       + greatest(similarity(r.statement, $3), similarity(r.context::text, $3)) * 0.001
       + CASE WHEN EXISTS (SELECT 1 FROM memory_subjects ms JOIN subjects s
           ON s.user_id = ms.user_id AND s.scope_id = ms.scope_id AND s.id = ms.subject_id
           WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id AND ms.memory_id = r.id
             AND s.normalized_name = $4) THEN 0.001::float8 ELSE 0::float8 END`,
      `(SELECT ${distance} FROM memory_embeddings e
        WHERE e.user_id = r.user_id AND e.scope_id = r.scope_id AND e.memory_id = r.id
          AND e.revision = r.revision AND e.model = $11 AND e.dimension = $12 LIMIT 1) ASC`,
      `(SELECT 1 - ${distance} FROM memory_embeddings e
        WHERE e.user_id = r.user_id AND e.scope_id = r.scope_id AND e.memory_id = r.id
          AND e.revision = r.revision AND e.model = $11 AND e.dimension = $12 LIMIT 1) AS semantic_similarity`,
    );
    return rows.map((row) => ({
      ...row,
      semantic_similarity: Number(row.semantic_similarity ?? row.score),
    }));
  }

  private changeCandidates(
    client: PoolClient,
    actor: ActorContext,
    scopeIds: readonly string[],
    query: ReturnType<typeof recallQuerySchema.parse>,
    limit: number,
  ): Promise<CandidateRow[]> {
    return this.candidateQuery(
      client,
      `AND (r.statement ILIKE $10 ESCAPE '\\' OR r.context::text ILIKE $10 ESCAPE '\\'
          OR similarity(r.statement, $3) > 0.08 OR similarity(r.context::text, $3) > 0.08
      OR EXISTS (SELECT 1 FROM memory_subjects ms JOIN subjects s ON s.user_id = ms.user_id AND s.scope_id = ms.scope_id AND s.id = ms.subject_id
            WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id AND ms.memory_id = r.id
              AND (s.normalized_name = $4 OR s.normalized_name ILIKE $10 ESCAPE '\\')))
        AND EXISTS (SELECT 1 FROM change_log c WHERE c.user_id = r.user_id AND c.scope_id = r.scope_id
          AND c.memory_id = r.id AND c.memory_revision = r.revision
          AND c.created_at <= coalesce($6::timestamptz, clock_timestamp()))`,
      [
        actor.userId,
        scopeIds,
        query.query,
        normalizeName(query.query),
        query.valid_at ?? null,
        query.known_at ?? null,
        query.mode,
        query.memory_ids ?? [],
        query.subject_ids ?? [],
        `%${escapeLike(query.query)}%`,
        limit,
      ],
      `greatest(similarity(r.statement, $3), similarity(r.context::text, $3), CASE WHEN r.statement ILIKE $10 ESCAPE '\\' THEN 1 ELSE 0 END)::float8`,
      `r.recorded_at DESC`,
      `greatest(similarity(r.statement, $3), similarity(r.context::text, $3), CASE WHEN r.statement ILIKE $10 ESCAPE '\\' THEN 1 ELSE 0 END)::float8 AS lexical_similarity`,
    );
  }

  private async relatedCandidates(
    client: PoolClient,
    actor: ActorContext,
    scopeIds: readonly string[],
    query: ReturnType<typeof recallQuerySchema.parse>,
    roots: readonly CandidateRow[],
    limit: number,
  ): Promise<CandidateRow[]> {
    const ids = [...new Set(roots.map((row) => row.id))].slice(0, 50);
    if (ids.length === 0) return [];
    const result = await client.query<CandidateRow>(
      `${candidateCte()}
       , related(id, scope_id, depth) AS (
         SELECT CASE WHEN rel.from_memory_id = ANY($10::uuid[]) THEN rel.to_memory_id ELSE rel.from_memory_id END,
                rel.scope_id, 1
         FROM relations rel
         JOIN effective reached ON reached.user_id = rel.user_id AND reached.scope_id = rel.scope_id
           AND reached.id = CASE WHEN rel.from_memory_id = ANY($10::uuid[]) THEN rel.to_memory_id ELSE rel.from_memory_id END
         WHERE rel.user_id = $1 AND rel.scope_id = ANY($2::uuid[])
           AND (rel.from_memory_id = ANY($10::uuid[]) OR rel.to_memory_id = ANY($10::uuid[]))
           AND ${eligibilitySql('reached')} AND NOT ${rightsDeniedSql('reached')}
         UNION
         SELECT CASE WHEN rel.from_memory_id = related.id THEN rel.to_memory_id ELSE rel.from_memory_id END,
                rel.scope_id, related.depth + 1
         FROM related JOIN relations rel ON rel.user_id = $1 AND rel.scope_id = related.scope_id
           AND related.depth < 2 AND (rel.from_memory_id = related.id OR rel.to_memory_id = related.id)
         JOIN effective reached ON reached.user_id = rel.user_id AND reached.scope_id = rel.scope_id
           AND reached.id = CASE WHEN rel.from_memory_id = related.id THEN rel.to_memory_id ELSE rel.from_memory_id END
         WHERE ${eligibilitySql('reached')} AND NOT ${rightsDeniedSql('reached')}
       )
       SELECT r.id, r.scope_id, r.revision, r.lifecycle, r.contested, r.recorded_at,
         CASE WHEN lower(btrim(r.statement)) = lower(btrim($3)) THEN 1.5::float8
              WHEN EXISTS (SELECT 1 FROM memory_subjects ms JOIN subjects s
                ON s.user_id = ms.user_id AND s.scope_id = ms.scope_id AND s.id = ms.subject_id
                WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id AND ms.memory_id = r.id
                  AND s.normalized_name = $4) THEN 1.25::float8 ELSE 1::float8 END AS score,
         r.indexed_revision, r.committed_revision, true AS relation_match
       FROM effective r JOIN (SELECT DISTINCT id, scope_id FROM related) x ON x.id = r.id AND x.scope_id = r.scope_id
       WHERE ${eligibilitySql('r')} AND NOT ${rightsDeniedSql('r')}
         AND (cardinality($8::uuid[]) = 0 OR r.id = ANY($8::uuid[]))
         AND (cardinality($9::uuid[]) = 0 OR EXISTS (
           SELECT 1 FROM memory_subjects ms WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id
             AND ms.memory_id = r.id AND ms.subject_id = ANY($9::uuid[])))
       ORDER BY score DESC, r.recorded_at DESC LIMIT $11`,
      [
        actor.userId,
        scopeIds,
        query.query,
        normalizeName(query.query),
        query.valid_at ?? null,
        query.known_at ?? null,
        query.mode,
        query.memory_ids ?? [],
        query.subject_ids ?? [],
        ids,
        limit,
      ],
    );
    return result.rows;
  }

  private async candidateQuery(
    client: PoolClient,
    predicate: string,
    values: readonly unknown[],
    scoreExpression: string,
    orderExpression: string,
    extraSelect = '',
  ): Promise<CandidateRow[]> {
    const allValues = [...values];
    const sql = `${candidateCte()}
      SELECT r.id, r.scope_id, r.revision, r.lifecycle, r.contested, r.recorded_at,
        ${scoreExpression} AS score,
        r.indexed_revision, r.committed_revision${extraSelect.length === 0 ? '' : `, ${extraSelect}`}
        , (cardinality($8::uuid[]) > 0 OR cardinality($9::uuid[]) > 0) AS structured_match
      FROM effective r
      WHERE ${eligibilitySql('r')} AND NOT ${rightsDeniedSql('r')}
        AND (cardinality($8::uuid[]) = 0 OR r.id = ANY($8::uuid[]))
        AND (cardinality($9::uuid[]) = 0 OR EXISTS (
          SELECT 1 FROM memory_subjects ms WHERE ms.user_id = r.user_id AND ms.scope_id = r.scope_id
            AND ms.memory_id = r.id AND ms.subject_id = ANY($9::uuid[])))
        ${predicate}
      ORDER BY ${orderExpression}
      LIMIT $${allValues.length}`;
    const result = await client.query<CandidateRow>(sql, allValues);
    return result.rows;
  }

  private async indexLag(
    client: PoolClient,
    actor: ActorContext,
    scopeIds: readonly string[],
    query: ReturnType<typeof recallQuerySchema.parse>,
  ): Promise<boolean> {
    const result = await client.query<{ lagging: boolean }>(
      `WITH eligible AS (
         SELECT m.id, m.scope_id, m.revision, m.indexed_revision
         FROM memories m WHERE m.user_id = $1 AND m.scope_id = ANY($2::uuid[])
           AND m.lifecycle NOT IN ('forgotten', 'retracted')
           AND ($3::timestamptz IS NULL OR m.valid_from IS NULL OR m.valid_from <= $3)
           AND ($3::timestamptz IS NULL OR m.valid_to IS NULL OR m.valid_to > $3)
           AND NOT ${rightsDeniedSql('m')}
       ) SELECT coalesce(bool_or(indexed_revision < revision), false) AS lagging FROM eligible`,
      [actor.userId, scopeIds, query.valid_at ?? null],
    );
    return result.rows[0]?.lagging ?? false;
  }
}

function candidateCte(): string {
  return `WITH RECURSIVE effective AS (
    SELECT m.id, m.user_id, m.scope_id,
      coalesce(v.kind, m.kind) AS kind,
      coalesce(v.statement, m.statement) AS statement,
      coalesce(v.context, m.context) AS context,
      coalesce(v.lifecycle, m.lifecycle) AS lifecycle,
      coalesce(v.contested, m.contested) AS contested,
      coalesce(v.recorded_at, m.recorded_at) AS recorded_at,
      coalesce(v.revision, m.revision) AS revision,
      m.indexed_revision, m.committed_revision,
      CASE WHEN $6::timestamptz IS NULL THEN m.valid_from ELSE v.valid_from END AS valid_from,
      CASE WHEN $6::timestamptz IS NULL THEN m.valid_to ELSE v.valid_to END AS valid_to
    FROM memories m
    LEFT JOIN LATERAL (
      SELECT version.kind, version.statement, version.context, version.lifecycle, version.contested,
        version.recorded_at, version.revision, version.valid_from, version.valid_to
      FROM memory_versions version WHERE version.user_id = m.user_id AND version.scope_id = m.scope_id
        AND version.memory_id = m.id AND version.recorded_at <= $6
      ORDER BY version.revision DESC LIMIT 1
    ) v ON $6::timestamptz IS NOT NULL
    WHERE m.user_id = $1 AND m.scope_id = ANY($2::uuid[])
      AND ($6::timestamptz IS NULL OR v.revision IS NOT NULL)
  )`;
}

function eligibilitySql(alias: string): string {
  return `${alias}.lifecycle NOT IN ('forgotten', 'retracted')
    AND ($7::text = 'exploratory' OR ${alias}.lifecycle <> 'candidate')
    AND ($5::timestamptz IS NULL OR ${alias}.valid_from IS NULL OR ${alias}.valid_from <= $5)
    AND ($5::timestamptz IS NULL OR ${alias}.valid_to IS NULL OR ${alias}.valid_to > $5)`;
}

function rightsDeniedSql(alias: string): string {
  return `(EXISTS (
      SELECT 1 FROM memory_version_evidence me
      JOIN evidence e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
      JOIN sources s ON s.user_id = e.user_id AND s.scope_id = e.scope_id AND s.id = e.source_id
      WHERE me.user_id = ${alias}.user_id AND me.scope_id = ${alias}.scope_id
        AND me.memory_id = ${alias}.id AND me.revision = ${alias}.revision
        AND (s.rights_status <> 'granted' OR NOT s.consent
          OR EXISTS (SELECT 1 FROM suppressions sp WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id
            AND sp.object_id IN (${alias}.id, s.id, e.id)))
    ) OR EXISTS (
      SELECT 1 FROM suppressions sp WHERE sp.user_id = ${alias}.user_id
        AND sp.scope_id = ${alias}.scope_id AND sp.object_kind = 'memory' AND sp.object_id = ${alias}.id
    ))`;
}

function mergeRanks(
  mode: string,
  groups: readonly (readonly [readonly CandidateRow[], number])[],
  limit: number,
): CandidateRow[] {
  const rows = new Map<string, CandidateRow & { score: number }>();
  const exactKeys = new Set(groups[0]?.[0].map((row) => `${row.scope_id}:${row.id}`) ?? []);
  for (const [group, weight] of groups) {
    group.forEach((row, rank) => {
      const key = `${row.scope_id}:${row.id}`;
      const current = rows.get(key);
      const rrf = weight / (60 + rank + 1);
      rows.set(
        key,
        current === undefined
          ? { ...row, score: rrf }
          : { ...current, ...row, score: current.score + rrf },
      );
    });
  }
  return [...rows.values()]
    .sort((left, right) => {
      if (mode === 'historical') {
        const leftExact = exactKeys.has(`${left.scope_id}:${left.id}`);
        const rightExact = exactKeys.has(`${right.scope_id}:${right.id}`);
        if (leftExact !== rightExact) return leftExact ? -1 : 1;
      }
      return (
        right.score - left.score ||
        right.recorded_at.getTime() - left.recorded_at.getTime() ||
        left.id.localeCompare(right.id)
      );
    })
    .slice(0, limit);
}

function hasRetrievalSupport(
  candidate: CandidateRow,
  exactKeys: ReadonlySet<string>,
  semanticMinSimilarity: number,
): boolean {
  return (
    exactKeys.has(`${candidate.scope_id}:${candidate.id}`) ||
    candidate.structured_match === true ||
    candidate.relation_match === true ||
    (candidate.lexical_similarity ?? 0) >= 0.2 ||
    (candidate.semantic_similarity ?? 0) >= semanticMinSimilarity
  );
}

function lexicalTextWithoutOpaqueIds(expression: string): string {
  return `regexp_replace(lower(${expression}), '\\m(?=[0-9a-f]{8,}\\M)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]+\\M', ' ', 'g')`;
}

function normalizeName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function uncertaintyFor(memory: Record<string, unknown>): Record<string, unknown> {
  const epistemic = memory['epistemic'] as Record<string, unknown> | undefined;
  return {
    status: epistemic?.['status'] ?? 'unknown',
    contested: epistemic?.['contested'] ?? false,
    lifecycle: memory['lifecycle'] ?? 'unknown',
    authority:
      (memory['attribution'] as Record<string, unknown> | undefined)?.['authority'] ?? 'unknown',
  };
}

function buildContextPack(
  mode: string,
  items: readonly Record<string, unknown>[],
  insufficiencies: readonly string[],
  scopeIds: readonly string[],
  semanticComplete: boolean,
): Record<string, unknown> {
  return {
    mode,
    exact: items.some((item) => item['exact_match'] === true),
    unknown: items.length === 0,
    items: items.map((item) => {
      const memory = item['memory'] as Record<string, unknown>;
      return {
        memory_id: memory['id'],
        scope_id: memory['scope_id'],
        score: item['score'],
        exact_match: item['exact_match'],
        lexical_similarity: item['lexical_similarity'],
        semantic_similarity: item['semantic_similarity'],
        uncertainty: item['uncertainty'],
        indexed_revision: item['indexed_revision'],
        committed_revision: item['committed_revision'],
      };
    }),
    matches: items.map((item) => item['memory']),
    conflicts: conflictIds(items),
    insufficiencies: [...new Set(insufficiencies)],
    coverage: {
      scope_ids: scopeIds,
      complete: semanticComplete,
      index_lag: !semanticComplete && insufficiencies.includes('embedding_index_lag_fallback'),
    },
  };
}

function conflictIds(items: readonly Record<string, unknown>[]): unknown[] {
  return items
    .filter((item) => {
      const uncertainty = item['uncertainty'] as { contested?: boolean; status?: string };
      return uncertainty.contested === true || uncertainty.status === 'contested';
    })
    .map((item) => (item['memory'] as Record<string, unknown>)['id']);
}

function estimatePackTokens(value: unknown): number {
  // UTF-8 bytes conservatively bound tokenizer pieces and include the entire serialized pack.
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function embeddingWithDeadline(
  provider: EmbeddingProvider,
  texts: readonly string[],
  timeoutMs: number,
): Promise<readonly (readonly number[])[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('Embedding request timed out'));
      reject(new Error('Embedding request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.embed(texts, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
