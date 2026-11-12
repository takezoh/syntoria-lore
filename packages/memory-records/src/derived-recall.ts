import { deriveAuthority, type MemoryRecord } from './index.js';
import {
  hasNameOrTermMatch,
  normalizeSearchText,
  searchableText,
  SEARCH_TERMS_VERSION,
  tokenizeSearchText,
  type RecallMatchReason,
} from './search-terms.js';
import type {
  FirestoreMemoryRecordRepository,
  IndexJob,
  SearchIndexEntry,
} from './firestore-repository.js';

export interface Embedding {
  readonly modelId: string;
  readonly dimension: number;
  readonly values: readonly number[];
}

export interface EmbeddingProvider {
  embed(text: string): Promise<Embedding>;
}

export interface RecallQuery {
  readonly text?: string;
  readonly recordId?: string;
  readonly subjectIds?: readonly string[];
  readonly aliases?: readonly string[];
  readonly validAt: string;
  readonly knownAt?: string;
  readonly includeProposals?: boolean;
  /** True for a question about a past time. */
  readonly history?: boolean;
  readonly byteBudget: number;
  readonly limit?: number;
}

export interface RecallItem {
  readonly record: MemoryRecord;
  readonly authority: 'user' | 'proposal';
  readonly score: number;
  /** Why the record was returned; `semantic` alone means no name or term of the query matched. */
  readonly matched: readonly RecallMatchReason[];
  readonly freshness: 'current' | 'recent-overlay' | 'stale-index';
}

export interface ContextPack {
  readonly items: readonly RecallItem[];
  readonly byteLength: number;
  readonly insufficiencies: readonly string[];
  readonly indexLag: { readonly indexedThrough: number; readonly latestChange: number };
  readonly emptyMeaning: 'no-supported-match';
}

export function indexEntryFor(record: MemoryRecord, embedding: Embedding): SearchIndexEntry {
  if (
    !embedding ||
    typeof embedding.modelId !== 'string' ||
    embedding.modelId.trim().length === 0 ||
    !Number.isSafeInteger(embedding.dimension) ||
    embedding.dimension < 1 ||
    embedding.values.length !== embedding.dimension ||
    embedding.values.some((value) => !Number.isFinite(value))
  )
    throw new TypeError(
      'Embedding must have a model ID and a finite vector of the declared dimension',
    );
  return {
    recordId: record.id,
    revision: record.revision.revision,
    compartmentIds: [...record.compartmentIds],
    terms: tokenizeSearchText(searchableText(record)),
    termsVersion: SEARCH_TERMS_VERSION,
    subjectIds: [...record.subjectIds],
    aliases: record.aliases.map((item) => normalizeSearchText(item.value)),
    embedding: {
      modelId: embedding.modelId,
      dimension: embedding.dimension,
      values: [...embedding.values],
    },
  };
}

export class MemoryIndexWorker {
  constructor(
    private readonly repository: FirestoreMemoryRecordRepository,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async runPending(
    actor: Parameters<FirestoreMemoryRecordRepository['listPendingIndexJobs']>[0],
    scopeId: string,
    limit = 20,
  ): Promise<{
    completed: number;
    failed: number;
    failures: readonly { sequence: number; reason: string }[];
  }> {
    const jobs = await this.repository.listPendingIndexJobs(actor, scopeId, limit);
    let completed = 0;
    let failed = 0;
    const failures: Array<{ sequence: number; reason: string }> = [];
    for (const job of jobs) {
      try {
        for (const recordId of job.recordIds) {
          const records = await this.repository.getRecordsForIndex(actor, scopeId, recordId);
          if (records === null) {
            await this.repository.removeSearchIndexEntry(actor, scopeId, recordId, job.sequence);
            continue;
          }
          for (const record of records) {
            const value = [
              record.title,
              record.statement,
              ...record.subjectIds,
              ...record.aliases.map((item) => item.value),
            ].join('\n');
            const embedding = await this.embeddings.embed(value);
            await this.repository.writeSearchIndexEntry(
              actor,
              scopeId,
              indexEntryFor(record, embedding),
            );
          }
        }
        await this.repository.completeIndexJob(actor, scopeId, job);
        completed += 1;
      } catch (error) {
        failed += 1;
        failures.push({
          sequence: job.sequence,
          reason:
            error instanceof TypeError
              ? 'invalid-embedding'
              : error instanceof Error && 'code' in error
                ? 'repository-rejected-index'
                : 'indexing-failed',
        });
      }
    }
    return { completed, failed, failures };
  }

  /** Extends the current index by a bounded number of records; see the repository method. */
  async advanceCurrentIndex(
    actor: Parameters<FirestoreMemoryRecordRepository['advanceCurrentIndex']>[0],
    scopeId: string,
    limit = 100,
  ): Promise<{ complete: boolean; written: number }> {
    return this.repository.advanceCurrentIndex(actor, scopeId, limit);
  }
}

export class MemoryRecallService {
  constructor(
    private readonly repository: FirestoreMemoryRecordRepository,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async recall(
    actor: Parameters<FirestoreMemoryRecordRepository['readRecallCandidates']>[0],
    scopeId: string,
    query: RecallQuery,
  ): Promise<ContextPack> {
    if (!Number.isSafeInteger(query.byteBudget) || query.byteBudget < 1)
      throw new TypeError('Recall byteBudget must be a positive integer');
    if (
      !Number.isSafeInteger(query.limit ?? 10) ||
      (query.limit ?? 10) < 1 ||
      (query.limit ?? 10) > 100
    )
      throw new TypeError('Recall limit must be between 1 and 100');
    const terms = tokenizeSearchText(query.text ?? '');
    const embedding = terms.length > 0 ? await this.embeddings.embed(query.text ?? '') : undefined;
    const result = await this.repository.readRecallCandidates(actor, scopeId, {
      terms,
      text: normalizeSearchText(query.text ?? ''),
      ...(query.recordId === undefined ? {} : { recordId: query.recordId }),
      subjectIds: query.subjectIds ?? [],
      aliases: (query.aliases ?? []).map(normalizeSearchText),
      ...(embedding === undefined ? {} : { embedding }),
      validAt: query.validAt,
      knownAt: query.knownAt ?? new Date().toISOString(),
      ...(query.includeProposals === undefined ? {} : { includeProposals: query.includeProposals }),
      ...(query.history === undefined ? {} : { history: query.history }),
      limit: query.limit ?? 10,
    });
    const insufficiencies = new Set(result.insufficiencies);
    // Dropping a result that only similarity supports loses nothing the query asked for when
    // other results matched it by name or term, so the caller is not warned about it.
    const anyMatch = result.items.some((item) => hasNameOrTermMatch(item.matched));
    const isLoss = (item: { readonly matched: readonly RecallMatchReason[] }): boolean =>
      !anyMatch || hasNameOrTermMatch(item.matched);
    const items: RecallItem[] = [];
    for (const item of result.items) {
      const candidate = {
        record: item.record,
        authority: deriveAuthority({
          writer: item.record.revision.writer,
          protectedChange: item.record.revision.approval.status === 'approved',
          approval: item.record.revision.approval,
        }),
        score: item.score,
        matched: item.matched,
        freshness: item.freshness,
      } satisfies RecallItem;
      if (
        measuredPack([...items, candidate], [...insufficiencies], result.indexLag).byteLength >
        query.byteBudget
      ) {
        if (isLoss(candidate)) insufficiencies.add('byte-budget-dropped-matches');
        continue;
      }
      items.push(candidate);
    }
    let pack = measuredPack(items, [...insufficiencies], result.indexLag);
    while (pack.byteLength > query.byteBudget && items.length > 0) {
      const dropped = items.pop()!;
      if (isLoss(dropped)) insufficiencies.add('byte-budget-dropped-matches');
      pack = measuredPack(items, [...insufficiencies], result.indexLag);
    }
    if (pack.byteLength > query.byteBudget)
      throw new TypeError('Recall byteBudget is too small for the Context Pack metadata');
    return pack;
  }
}

export type { IndexJob };
export { tokenizeSearchText };

function measuredPack(
  items: readonly RecallItem[],
  insufficiencies: readonly string[],
  indexLag: ContextPack['indexLag'],
): ContextPack {
  let pack: ContextPack = {
    items,
    byteLength: 0,
    insufficiencies: [...new Set(insufficiencies)].sort(),
    indexLag,
    emptyMeaning: 'no-supported-match',
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = Buffer.byteLength(JSON.stringify(pack), 'utf8');
    if (measured === pack.byteLength) return pack;
    pack = { ...pack, byteLength: measured };
  }
  return pack;
}
