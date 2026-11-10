import type { MemoryRecord } from './index.js';
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
  readonly byteBudget: number;
  readonly limit?: number;
}

export interface RecallItem {
  readonly record: MemoryRecord;
  readonly score: number;
  readonly freshness: 'current' | 'recent-overlay' | 'stale-index';
}

export interface ContextPack {
  readonly items: readonly RecallItem[];
  readonly byteLength: number;
  readonly insufficiencies: readonly string[];
  readonly indexLag: { readonly indexedThrough: number; readonly latestChange: number };
  readonly emptyMeaning: 'no-supported-match';
}

export function tokenizeSearchText(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('und');
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = new Set(
    words.filter(
      (word) => !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(word),
    ),
  );
  const japaneseRuns =
    normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const run of japaneseRuns) {
    const points = [...run];
    if (points.length === 1) tokens.add(points[0]!);
    for (let index = 0; index + 1 < points.length; index += 1)
      tokens.add(`${points[index]}${points[index + 1]}`);
  }
  return [...tokens].sort();
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
  const text = [
    record.title,
    record.statement,
    ...record.subjectIds,
    ...record.aliases.map((item) => item.value),
  ].join(' ');
  return {
    recordId: record.id,
    revision: record.revision.revision,
    compartmentIds: [...record.compartmentIds],
    terms: tokenizeSearchText(text),
    subjectIds: [...record.subjectIds],
    aliases: record.aliases.map((item) => item.value.normalize('NFKC').toLocaleLowerCase('und')),
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
      ...(query.recordId === undefined ? {} : { recordId: query.recordId }),
      subjectIds: query.subjectIds ?? [],
      aliases: (query.aliases ?? []).map((alias) =>
        alias.normalize('NFKC').toLocaleLowerCase('und'),
      ),
      ...(embedding === undefined ? {} : { embedding }),
      validAt: query.validAt,
      knownAt: query.knownAt ?? new Date().toISOString(),
      limit: query.limit ?? 10,
    });
    const insufficiencies = new Set(result.insufficiencies);
    const items: RecallItem[] = [];
    for (const item of result.items) {
      const candidate = {
        record: item.record,
        score: item.score,
        freshness: item.freshness,
      } satisfies RecallItem;
      if (
        measuredPack([...items, candidate], [...insufficiencies], result.indexLag).byteLength >
        query.byteBudget
      ) {
        insufficiencies.add('byte-budget-dropped-matches');
        continue;
      }
      items.push(candidate);
    }
    let pack = measuredPack(items, [...insufficiencies], result.indexLag);
    while (pack.byteLength > query.byteBudget && items.length > 0) {
      items.pop();
      insufficiencies.add('byte-budget-dropped-matches');
      pack = measuredPack(items, [...insufficiencies], result.indexLag);
    }
    if (pack.byteLength > query.byteBudget)
      throw new TypeError('Recall byteBudget is too small for the Context Pack metadata');
    return pack;
  }
}

export type { IndexJob };

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
