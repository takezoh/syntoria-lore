import { randomUUID } from 'node:crypto';
import {
  isMemoryRecord,
  isSourceReference,
  type Attribution,
  type KindDetails,
  type MemoryKind,
  type MemoryRecord,
  type SourceReference,
} from './index.js';
import {
  type CaptureJob,
  type CommitChangeSet,
  type CommitReceipt,
  FirestoreMemoryRecordRepository,
  type VerifiedActorCapability,
} from './firestore-repository.js';

export interface FetchedCaptureSource {
  readonly text: string;
  readonly version: string;
  /** Trusted labels from the authorized source configuration. */
  readonly compartmentIds: readonly string[];
  readonly locations: readonly {
    readonly locator: string;
    readonly start: number;
    readonly end: number;
    readonly speaker?: string;
    readonly speakerRole?: Attribution['role'];
  }[];
}

/** The implementation must enforce consent, scope, rights and the configured sync range. */
export interface AuthorizedSourceFetcher {
  isEnabledAndConsented(input: {
    readonly actor: VerifiedActorCapability;
    readonly source: SourceReference;
    readonly syncRange: { readonly from: string; readonly until: string };
  }): Promise<boolean>;
  fetch(
    actor: VerifiedActorCapability,
    source: SourceReference,
    syncRange: { readonly from: string; readonly until: string },
  ): Promise<FetchedCaptureSource>;
}

export interface CitedSpan {
  readonly locator: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

export interface ExtractedMemoryProposal {
  readonly kind: MemoryKind;
  readonly title: string;
  readonly statement: string;
  readonly details: KindDetails;
  readonly subjectIds: readonly string[];
  readonly aliases: MemoryRecord['aliases'];
  readonly assumptions: readonly string[];
  readonly attribution: Attribution;
  readonly valid: MemoryRecord['valid'];
  readonly compartmentIds: readonly string[];
  readonly spans: readonly CitedSpan[];
}

export interface VersionedExtraction {
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly proposals: readonly ExtractedMemoryProposal[];
}

export interface VersionedGenerativeExtractor {
  extract(input: {
    readonly text: string;
    readonly source: SourceReference;
  }): Promise<VersionedExtraction>;
}

export interface CaptureResult {
  readonly job: CaptureJob;
  readonly receipt?: CommitReceipt;
}

const MAX_ATTEMPTS = 2;

function errorType(error: unknown): string {
  return error instanceof Error ? 'provider error' : 'unknown error';
}

function sourceKey(source: SourceReference): string {
  return `${source.provider}\u0000${source.accountOrTenant}\u0000${source.resourceId}`;
}

function lineageKeys(source: SourceReference): Set<string> {
  return new Set(source.lineage?.length ? source.lineage : [sourceKey(source)]);
}

function hasIndependentLineage(
  existing: readonly SourceReference[],
  incoming: readonly SourceReference[],
): boolean {
  const prior = new Set(existing.flatMap((source) => [...lineageKeys(source)]));
  return incoming.every((source) => {
    const keys = lineageKeys(source);
    return ![...keys].some((key) => prior.has(key));
  });
}

function recordIdentity(record: Pick<MemoryRecord, 'kind' | 'statement' | 'subjectIds' | 'valid'>) {
  return JSON.stringify({
    kind: record.kind,
    statement: record.statement.trim(),
    subjectIds: [...record.subjectIds].sort(),
    valid: record.valid,
  });
}

function validateSpans(
  spans: unknown,
  fetched: FetchedCaptureSource,
): spans is readonly CitedSpan[] {
  return (
    Array.isArray(spans) &&
    spans.length > 0 &&
    spans.every((item) => {
      if (
        !isObject(item) ||
        typeof item['locator'] !== 'string' ||
        typeof item['quote'] !== 'string' ||
        typeof item['start'] !== 'number' ||
        typeof item['end'] !== 'number'
      )
        return false;
      const span = item as unknown as CitedSpan;
      const location = fetched.locations.find((item) => item.locator === span.locator);
      return (
        Number.isSafeInteger(span.start) &&
        Number.isSafeInteger(span.end) &&
        span.start >= 0 &&
        span.end > span.start &&
        span.end <= fetched.text.length &&
        location !== undefined &&
        Number.isSafeInteger(location.start) &&
        Number.isSafeInteger(location.end) &&
        location.start <= span.start &&
        span.end <= location.end &&
        span.locator.trim().length > 0 &&
        span.quote.length > 0 &&
        fetched.text.slice(span.start, span.end) === span.quote
      );
    })
  );
}

function withSourceVersion(source: SourceReference, version: string, locator: string) {
  return {
    ...source,
    version,
    locator,
  };
}

function toCandidate(
  actor: VerifiedActorCapability,
  scopeId: string,
  proposal: ExtractedMemoryProposal,
  references: SourceReference[],
  modelVersion: string,
  attribution: Attribution,
  compartmentIds: readonly string[],
): MemoryRecord {
  const writerId = `extractor:${modelVersion}`;
  const record: MemoryRecord = {
    id: randomUUID(),
    tenantId: actor.tenantId,
    scopeId,
    schemaVersion: 1,
    kind: proposal.kind,
    title: proposal.title,
    statement: proposal.statement,
    details: proposal.details,
    subjectIds: [...proposal.subjectIds],
    aliases: [...proposal.aliases],
    assumptions: [...proposal.assumptions],
    attribution,
    lifecycle: 'candidate',
    contested: false,
    needsRecheck: false,
    suppressed: false,
    valid: proposal.valid,
    compartmentIds: [...compartmentIds],
    supersedes: null,
    supersededBy: null,
    revision: {
      revision: 1,
      changeKind: 'create',
      reason: 'AI capture proposal held for review',
      writer: { kind: 'ai', id: writerId, connectionId: actor.connectionId },
      approval: { status: 'none' },
      requestingConnectionId: actor.connectionId,
      gateClientId: actor.gateClientId,
      recordedAt: new Date().toISOString(),
      sourceReferences: references,
    },
  };
  if (!isMemoryRecord(record)) throw new Error('Extractor returned an invalid memory proposal');
  return record;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFetchedLocation(value: unknown, textLength: number): boolean {
  if (!isObject(value)) return false;
  const start = value['start'];
  const end = value['end'];
  const speaker = value['speaker'];
  const speakerRole = value['speakerRole'];
  return (
    isNonEmptyString(value['locator']) &&
    typeof start === 'number' &&
    Number.isSafeInteger(start) &&
    start >= 0 &&
    typeof end === 'number' &&
    Number.isSafeInteger(end) &&
    end > start &&
    end <= textLength &&
    (speaker === undefined || isNonEmptyString(speaker)) &&
    (speakerRole === undefined ||
      ['user', 'third-party', 'ai', 'unknown'].includes(String(speakerRole)))
  );
}

function attributionFromSource(
  spans: readonly CitedSpan[],
  fetched: FetchedCaptureSource,
): Attribution {
  const citedLocations = spans.map((span) =>
    fetched.locations.find((location) => location.locator === span.locator),
  );
  if (citedLocations.length === 0 || citedLocations.some((location) => !location)) {
    return { speaker: null, role: 'unknown' };
  }
  const speakers = citedLocations.map((location) => location?.speaker);
  const roles = citedLocations.map((location) => location?.speakerRole ?? 'unknown');
  if (
    speakers.some((speaker) => !isNonEmptyString(speaker)) ||
    new Set(speakers).size !== 1 ||
    new Set(roles).size !== 1
  ) {
    return { speaker: null, role: 'unknown' };
  }
  return { speaker: speakers[0]!, role: roles[0]! };
}

function isProposalEnvelope(value: unknown): value is ExtractedMemoryProposal {
  if (!isObject(value)) return false;
  return (
    typeof value['kind'] === 'string' &&
    isNonEmptyString(value['title']) &&
    isNonEmptyString(value['statement']) &&
    isObject(value['details']) &&
    Array.isArray(value['subjectIds']) &&
    Array.isArray(value['aliases']) &&
    Array.isArray(value['assumptions']) &&
    isObject(value['valid']) &&
    Array.isArray(value['spans'])
  );
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export class MemoryCaptureService {
  constructor(
    private readonly repository: FirestoreMemoryRecordRepository,
    private readonly sourceFetcher: AuthorizedSourceFetcher,
    private readonly extractor: VersionedGenerativeExtractor,
  ) {}

  /** Explicit remembers bypass extraction and salience selection and commit synchronously. */
  remember(actor: VerifiedActorCapability, changeSet: CommitChangeSet): Promise<CommitReceipt> {
    return this.repository.commit(actor, changeSet);
  }

  async capture(
    actor: VerifiedActorCapability,
    input: {
      readonly scopeId: string;
      readonly jobId: string;
      readonly source: SourceReference;
      readonly syncRange: { readonly from: string; readonly until: string };
    },
  ): Promise<CaptureResult> {
    if (!isSourceReference(input.source)) throw new TypeError('Invalid capture source reference');
    let job = await this.repository.acceptCaptureJob(
      actor,
      input.scopeId,
      input.jobId,
      input.source,
      input.syncRange,
    );
    if (job.status === 'committed' || job.status === 'failed') return { job };
    await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'processing');
    let authorized: boolean;
    try {
      authorized = await this.sourceFetcher.isEnabledAndConsented({
        actor,
        source: input.source,
        syncRange: input.syncRange,
      });
    } catch {
      authorized = false;
    }
    if (!authorized) {
      if (Array.isArray(job.preparedChanges)) {
        let receipt: CommitReceipt | null;
        try {
          receipt = await this.repository.replayCommittedChangeSet(actor, {
            scopeId: input.scopeId,
            idempotencyKey: `capture:${input.jobId}`,
            changes: job.preparedChanges,
          });
        } catch (error) {
          job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
            reason: `Capture replay failed (${errorType(error)})`,
          });
          return { job };
        }
        if (receipt) {
          job = await this.repository.updateCaptureJob(
            actor,
            input.scopeId,
            input.jobId,
            'committed',
            {
              recordIds: receipt.recordIds,
              ...(job.modelVersion === undefined ? {} : { modelVersion: job.modelVersion }),
              ...(job.promptVersion === undefined ? {} : { promptVersion: job.promptVersion }),
              preparedChanges: null,
            },
          );
          return { job, receipt };
        }
      }
      job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
        reason: 'Source is not enabled with consent for this sync range',
      });
      return { job };
    }
    if (Array.isArray(job.preparedChanges)) {
      return this.commitPrepared(actor, input, job, job.preparedChanges);
    }

    let fetched: FetchedCaptureSource;
    try {
      fetched = await retry(() => this.sourceFetcher.fetch(actor, input.source, input.syncRange));
    } catch (error) {
      const reason = `Source fetch failed after ${MAX_ATTEMPTS} attempts (${errorType(error)})`;
      job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
        reason,
      });
      return { job };
    }
    if (
      !fetched ||
      typeof fetched.text !== 'string' ||
      !isNonEmptyString(fetched.version) ||
      !Array.isArray(fetched.compartmentIds) ||
      !fetched.compartmentIds.every(isNonEmptyString) ||
      !Array.isArray(fetched.locations) ||
      !fetched.locations.every((location) => isFetchedLocation(location, fetched.text.length))
    ) {
      job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
        reason: 'Source fetch returned no current text and version',
      });
      return { job };
    }

    let extraction: VersionedExtraction;
    try {
      extraction = await retry(() =>
        this.extractor.extract({ text: fetched.text, source: input.source }),
      );
    } catch (error) {
      job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
        reason: `Extractor failed after ${MAX_ATTEMPTS} attempts (${errorType(error)})`,
      });
      return { job };
    }
    if (
      !isObject(extraction) ||
      !Array.isArray(extraction['proposals']) ||
      !isNonEmptyString(extraction['modelVersion']) ||
      !isNonEmptyString(extraction['promptVersion']) ||
      !extraction['proposals'].every(isProposalEnvelope)
    ) {
      job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
        reason: 'Extractor returned an invalid versioned result',
      });
      return { job };
    }

    const changes: CommitChangeSet['changes'][number][] = [];
    const seen = new Set<string>();
    for (const proposal of extraction.proposals) {
      if (!validateSpans(proposal.spans, fetched)) {
        job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
          reason: 'A cited quote does not match the fetched source at its locator',
          modelVersion: extraction.modelVersion,
          promptVersion: extraction.promptVersion,
        });
        return { job };
      }
      const references = [
        withSourceVersion(
          input.source,
          fetched.version,
          [...new Set(proposal.spans.map((span: CitedSpan) => span.locator))].join(','),
        ),
      ];
      if (references.some((reference) => sourceKey(reference) !== sourceKey(input.source))) {
        job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
          reason: 'A proposal cited a source outside this capture job',
          modelVersion: extraction.modelVersion,
          promptVersion: extraction.promptVersion,
        });
        return { job };
      }
      let candidate: MemoryRecord;
      try {
        candidate = toCandidate(
          actor,
          input.scopeId,
          proposal,
          references,
          extraction.modelVersion,
          attributionFromSource(proposal.spans, fetched),
          fetched.compartmentIds,
        );
      } catch {
        job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'held', {
          reason: 'Extractor returned a malformed memory proposal',
          modelVersion: extraction.modelVersion,
          promptVersion: extraction.promptVersion,
        });
        return { job };
      }
      const identity = recordIdentity(candidate);
      if (seen.has(identity)) continue;
      seen.add(identity);

      const match = await this.repository.findCaptureMatch(actor, input.scopeId, candidate);
      if (match) {
        if (match.lifecycle !== 'active') continue;
        const incoming = candidate.revision.sourceReferences;
        if (!hasIndependentLineage(match.revision.sourceReferences, incoming)) continue;
        const corroborated: MemoryRecord = {
          ...match,
          revision: {
            ...match.revision,
            revision: match.revision.revision + 1,
            changeKind: 'corroborate',
            reason: 'Independent source lineage corroborated the existing memory',
            writer: candidate.revision.writer,
            approval: { status: 'none' },
            requestingConnectionId: actor.connectionId,
            gateClientId: actor.gateClientId,
            recordedAt: new Date().toISOString(),
            sourceReferences: [...match.revision.sourceReferences, ...incoming],
          },
        };
        changes.push({
          kind: 'corroborate',
          record: corroborated,
          expectedRevision: match.revision.revision,
        });
      } else {
        changes.push({ kind: 'create', record: candidate });
      }
    }

    job = await this.repository.updateCaptureJob(actor, input.scopeId, input.jobId, 'processing', {
      modelVersion: extraction.modelVersion,
      promptVersion: extraction.promptVersion,
      preparedChanges: changes,
    });
    return this.commitPrepared(actor, input, job, changes);
  }

  private async commitPrepared(
    actor: VerifiedActorCapability,
    input: { readonly scopeId: string; readonly jobId: string },
    job: CaptureJob,
    changes: readonly CommitChangeSet['changes'][number][],
  ): Promise<CaptureResult> {
    let receipt: CommitReceipt | undefined;
    if (changes.length > 0) {
      try {
        receipt = await this.repository.commit(actor, {
          scopeId: input.scopeId,
          idempotencyKey: `capture:${input.jobId}`,
          changes,
        });
      } catch (error) {
        const held = await this.repository.updateCaptureJob(
          actor,
          input.scopeId,
          input.jobId,
          'held',
          {
            reason: `Capture commit failed (${errorType(error)})`,
            preparedChanges: changes,
          },
        );
        return { job: held };
      }
    }
    const committed = await this.repository.updateCaptureJob(
      actor,
      input.scopeId,
      input.jobId,
      'committed',
      {
        recordIds: receipt?.recordIds ?? [],
        ...(job.modelVersion === undefined ? {} : { modelVersion: job.modelVersion }),
        ...(job.promptVersion === undefined ? {} : { promptVersion: job.promptVersion }),
        preparedChanges: null,
      },
    );
    return { job: committed, ...(receipt === undefined ? {} : { receipt }) };
  }
}
