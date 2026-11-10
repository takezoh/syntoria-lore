import { createHash } from 'node:crypto';
import { AccessDeniedError, type ConnectionAccess, type MemoryAccess } from './access.js';
import {
  MemoryIndexWorker,
  MemoryRecallService,
  type Embedding,
  type EmbeddingProvider,
} from './derived-recall.js';
import {
  memoryChangeDigest,
  memoryForgetDigest,
  MemoryRepositoryError,
  type ChangeFeedEntry,
  type FirestoreMemoryRecordRepository,
  type MemoryChange,
} from './firestore-repository.js';
import {
  applyRetract,
  applySupersede,
  deriveAuthority,
  isMemoryRecord,
  type Approval,
  type Attribution,
  type KindDetails,
  type MemoryKind,
  type MemoryRecord,
  type SourceReference,
  type Writer,
} from './index.js';

/** The source provider recorded on memories written through this service. */
export const SERVICE_SOURCE_PROVIDER = 'lore-mcp';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:~-]{1,200}$/u;
const RECORD_ID = /^[A-Za-z0-9._:~-]{1,200}$/u;

export type MemoryServiceErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'idempotency_conflict'
  | 'user_required'
  | 'resync_required'
  | 'stale_authorization'
  | 'too_large'
  | 'unavailable';

/** A stable, client-facing error. Messages never name records outside the caller's view. */
export class MemoryServiceError extends Error {
  constructor(
    readonly code: MemoryServiceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MemoryServiceError';
  }
}

export interface AliasInput {
  readonly value: string;
  readonly from?: string | null;
  readonly until?: string | null;
}

/** Memory content. `details` holds the kind-specific fields of the value model, without `kind`. */
export interface MemoryContentInput {
  readonly title: string;
  readonly statement: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly subjectIds?: readonly string[];
  readonly aliases?: readonly AliasInput[];
  readonly assumptions?: readonly string[];
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly compartmentIds?: readonly string[];
}

export interface RememberInput extends MemoryContentInput {
  readonly kind: MemoryKind;
  /** Record as the user's own memory; protected, so the approval policy decides. */
  readonly asUser: boolean;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export interface CorrectionChanges extends Partial<MemoryContentInput> {
  /** Only a supersede may change the kind. */
  readonly kind?: MemoryKind;
}

export interface CorrectInput {
  readonly recordId: string;
  readonly action: 'refine' | 'supersede' | 'retract';
  readonly expectedRevision: number;
  readonly reason: string;
  readonly asUser: boolean;
  readonly idempotencyKey: string;
  readonly changes?: CorrectionChanges;
}

export interface ForgetInput {
  readonly recordId: string;
  readonly idempotencyKey: string;
}

export interface RecallInput {
  readonly query: string;
  readonly mode: 'precise' | 'contextual' | 'historical';
  readonly knownAt?: string;
  readonly validAt?: string;
  readonly limit?: number;
}

export type Authority = 'user' | 'proposal';

export interface WriteResult {
  readonly record_id: string;
  readonly revision: number;
  readonly lifecycle: MemoryRecord['lifecycle'];
  readonly authority: Authority;
  readonly approval_provenance: 'policy' | null;
  readonly sequence: number;
  readonly replayed: boolean;
  readonly replacement_id?: string;
}

export interface ForgetView {
  readonly record_id: string;
  readonly status: 'stopped' | 'pending';
  readonly use_stopped: boolean;
}

export interface RecallView {
  readonly mode: RecallInput['mode'];
  readonly valid_at: string;
  readonly known_at: string;
  readonly items: readonly {
    readonly authority: Authority;
    readonly freshness: string;
    readonly score: number;
    readonly record: MemoryRecord;
  }[];
  readonly insufficiencies: readonly string[];
  readonly index_lag: { readonly indexed_through: number; readonly latest_change: number };
  readonly empty_meaning: string;
  readonly byte_length: number;
}

export interface MemoryView {
  readonly record_id: string;
  readonly kind: MemoryKind;
  readonly lifecycle: MemoryRecord['lifecycle'];
  readonly authority: Authority;
  readonly latest_revision: number;
  readonly supersedes: string | null;
  readonly superseded_by: string | null;
  /** The view that applies now, or null for a proposal, a retraction or an ended interval. */
  readonly current: MemoryRecord | null;
  readonly revisions: readonly MemoryRecord[];
  readonly withheld_revisions: number;
}

export interface ChangesView {
  readonly entries: readonly ChangeFeedEntry[];
  readonly cursor: string;
  readonly has_more: boolean;
}

export interface AccessView {
  readonly tenant_id: string;
  readonly scope_id: string;
  readonly compartment_allowance: readonly string[];
  readonly approval_policy: string;
  readonly principal_id: string;
}

export interface MemoryServiceOptions {
  readonly repository: FirestoreMemoryRecordRepository;
  readonly access: MemoryAccess;
  readonly embeddings: EmbeddingProvider;
  /** Index jobs to run in-process after each write. */
  readonly indexBatchSize?: number;
  readonly now?: () => Date;
  /** Receives content-free operational events. */
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

const RECALL_MODES = {
  precise: { limit: 5, byteBudget: 16_384 },
  contextual: { limit: 10, byteBudget: 49_152 },
  historical: { limit: 10, byteBudget: 49_152 },
} as const;

const REQUIRED_DETAILS: Readonly<Record<MemoryKind, string>> = {
  decision:
    'question, choice, reason, decider and decisionTime (optional alternatives, reconsiderAt)',
  fact: 'subject and claim (optional speakerOrObserver, observationTime)',
  preference: 'preferenceOwner and appliesWhere',
  hypothesis: 'hypothesis, assumptions and verification',
  experience: 'condition, action, outcome and reusableWhere',
  procedure: 'purpose, prerequisites, steps (at least one) and cautions',
};

function sha256(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function authorityOf(record: MemoryRecord): Authority {
  return deriveAuthority({
    writer: record.revision.writer,
    protectedChange: record.revision.approval.status === 'approved',
    approval: record.revision.approval,
  });
}

function later(now: Date, recordedAt: string): string {
  return Date.parse(recordedAt) > now.getTime() ? recordedAt : now.toISOString();
}

interface WriteAuthority {
  readonly writer: Writer;
  readonly approval: Approval;
  readonly attribution: Attribution;
  readonly protectedChangeId: string | null;
}

type Content = Pick<
  MemoryRecord,
  | 'title'
  | 'statement'
  | 'details'
  | 'subjectIds'
  | 'aliases'
  | 'assumptions'
  | 'valid'
  | 'compartmentIds'
>;

/**
 * The memory operations a connected AI client can request. Adapters validate input shape and
 * call this service; authority comes only from the {@link ConnectionAccess} that the access
 * module issued for a verified Gate principal and from the admission's approval policy.
 */
export class MemoryService {
  private readonly repository: FirestoreMemoryRecordRepository;
  private readonly access: MemoryAccess;
  private readonly recallService: MemoryRecallService;
  private readonly indexer: MemoryIndexWorker;
  private readonly indexBatchSize: number;
  private readonly now: () => Date;
  private readonly log: (event: Readonly<Record<string, unknown>>) => void;
  private readonly embeddings: EmbeddingProvider;

  constructor(options: MemoryServiceOptions) {
    this.repository = options.repository;
    this.access = options.access;
    this.embeddings = options.embeddings;
    this.recallService = new MemoryRecallService(options.repository, options.embeddings);
    this.indexer = new MemoryIndexWorker(options.repository, options.embeddings);
    this.indexBatchSize = options.indexBatchSize ?? 10;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  }

  describeAccess(access: ConnectionAccess): AccessView {
    return {
      tenant_id: access.tenantId,
      scope_id: access.scopeId,
      compartment_allowance: [...access.actor.compartmentAllowance],
      approval_policy: access.approvalPolicy,
      principal_id: access.actor.principalId,
    };
  }

  async remember(access: ConnectionAccess, input: RememberInput): Promise<WriteResult> {
    return this.run(access, async () => {
      const key = this.idempotencyKey(input.idempotencyKey);
      const content = this.content(access, input.kind, input, null);
      const reason =
        input.reason ?? (input.asUser ? 'Remembered for the user' : 'Proposed by an AI client');
      const inputDigest = sha256(
        stableJson({
          operation: 'remember',
          kind: input.kind,
          content,
          asUser: input.asUser,
          reason,
        }),
      );
      const { recordedAt } = await this.repository.pinRequest(
        access.actor,
        access.scopeId,
        key,
        inputDigest,
        this.now().toISOString(),
      );
      const authority = this.authority(access, input.asUser, 'remember', key);
      const record: MemoryRecord = {
        id: this.recordId(access, key),
        tenantId: access.tenantId,
        scopeId: access.scopeId,
        schemaVersion: 1,
        kind: input.kind,
        ...content,
        attribution: authority.attribution,
        lifecycle: input.asUser ? 'active' : 'candidate',
        contested: false,
        needsRecheck: false,
        suppressed: false,
        supersedes: null,
        supersededBy: null,
        revision: {
          revision: 1,
          changeKind: 'create',
          reason,
          writer: authority.writer,
          approval: authority.approval,
          requestingConnectionId: access.actor.connectionId,
          gateClientId: access.actor.gateClientId,
          recordedAt,
          sourceReferences: [this.source(access, key)],
        },
      };
      const receipt = await this.commit(access, key, [{ kind: 'create', record }], authority);
      await this.afterWrite(access);
      return this.writeResult(record, receipt);
    });
  }

  async correct(access: ConnectionAccess, input: CorrectInput): Promise<WriteResult> {
    return this.run(access, async () => {
      const key = this.idempotencyKey(input.idempotencyKey);
      const recordId = this.recordIdInput(input.recordId);
      if ((input.action === 'supersede' || input.action === 'retract') && !input.asUser) {
        throw new MemoryServiceError(
          'invalid_input',
          `${input.action} records the user's own correction: set as_user when the user asked for it`,
        );
      }
      if (input.action !== 'supersede' && input.changes?.kind !== undefined) {
        throw new MemoryServiceError('invalid_input', 'Only a supersede can change the kind');
      }
      if (input.action === 'retract' && input.changes !== undefined) {
        throw new MemoryServiceError('invalid_input', 'A retraction takes no replacement fields');
      }
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new MemoryServiceError(
          'invalid_input',
          'expected_revision must be a positive integer',
        );
      }
      const history = await this.repository.getRecordHistory(
        access.actor,
        access.scopeId,
        recordId,
      );
      if (!history) throw new MemoryServiceError('not_found', 'Memory not found');
      const base = history.revisions.find(
        (revision) => revision.revision.revision === input.expectedRevision,
      );
      if (!base) {
        throw new MemoryServiceError(
          'conflict',
          `expected_revision does not match; the latest revision is ${history.latest.revision.revision}`,
        );
      }
      const inputDigest = sha256(
        stableJson({
          operation: 'correct',
          recordId,
          action: input.action,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          asUser: input.asUser,
          changes: input.changes ?? null,
        }),
      );
      const { recordedAt } = await this.repository.pinRequest(
        access.actor,
        access.scopeId,
        key,
        inputDigest,
        later(this.now(), history.latest.revision.recordedAt),
      );
      const authority = this.authority(access, input.asUser, `correct-${input.action}`, key);
      const change = {
        writer: authority.writer,
        protectedChange: true,
        approval: authority.approval,
      };
      let changes: MemoryChange[];
      let replacementId: string | undefined;
      if (input.action === 'refine') {
        if (base.lifecycle !== 'active' && base.lifecycle !== 'candidate') {
          throw new MemoryServiceError(
            'invalid_input',
            `A ${base.lifecycle} memory cannot be refined`,
          );
        }
        const record: MemoryRecord = {
          ...base,
          ...this.content(access, base.kind, input.changes ?? {}, base),
          attribution: input.asUser ? authority.attribution : base.attribution,
          lifecycle: input.asUser ? 'active' : base.lifecycle,
          revision: {
            revision: base.revision.revision + 1,
            changeKind: 'refine',
            reason: input.reason,
            writer: authority.writer,
            approval: authority.approval,
            requestingConnectionId: access.actor.connectionId,
            gateClientId: access.actor.gateClientId,
            recordedAt,
            sourceReferences: this.withSource(
              base.revision.sourceReferences,
              this.source(access, key),
            ),
          },
        };
        changes = [{ kind: 'refine', record, expectedRevision: base.revision.revision }];
      } else if (input.action === 'retract') {
        if (base.lifecycle !== 'active' && base.lifecycle !== 'candidate') {
          throw new MemoryServiceError(
            'invalid_input',
            `A ${base.lifecycle} memory cannot be retracted`,
          );
        }
        const record = this.valueModel(() => applyRetract(base, input.reason, recordedAt, change));
        changes = [{ kind: 'retract', record, expectedRevision: base.revision.revision }];
      } else {
        if (base.lifecycle !== 'active') {
          throw new MemoryServiceError('invalid_input', 'Only an active memory can be superseded');
        }
        const kind = input.changes?.kind ?? base.kind;
        const validStart = input.changes?.validFrom ?? recordedAt;
        const content = this.content(access, kind, input.changes ?? {}, base);
        replacementId = this.recordId(access, key);
        const replacement: MemoryRecord = {
          id: replacementId,
          tenantId: access.tenantId,
          scopeId: access.scopeId,
          schemaVersion: 1,
          kind,
          ...content,
          valid: { from: validStart, until: input.changes?.validUntil ?? null },
          attribution: authority.attribution,
          lifecycle: 'active',
          contested: false,
          needsRecheck: false,
          suppressed: false,
          supersedes: null,
          supersededBy: null,
          revision: {
            revision: 1,
            changeKind: 'create',
            reason: input.reason,
            writer: authority.writer,
            approval: authority.approval,
            requestingConnectionId: access.actor.connectionId,
            gateClientId: access.actor.gateClientId,
            recordedAt,
            sourceReferences: [this.source(access, key)],
          },
        };
        this.assertValid(replacement);
        const result = this.valueModel(() =>
          applySupersede(base, replacement, validStart, input.reason, recordedAt, change),
        );
        changes = [
          {
            kind: 'supersede',
            previous: result.previous,
            replacement: result.replacement,
            expectedRevision: base.revision.revision,
          },
        ];
      }
      const receipt = await this.commit(access, key, changes, authority);
      await this.afterWrite(access);
      const first = changes[0]!;
      const written = first.kind === 'supersede' ? first.previous : first.record;
      return {
        ...this.writeResult(written, receipt),
        ...(replacementId === undefined ? {} : { replacement_id: replacementId }),
      };
    });
  }

  async forget(access: ConnectionAccess, input: ForgetInput): Promise<ForgetView> {
    return this.run(access, async () => {
      const key = this.idempotencyKey(input.idempotencyKey);
      const recordId = this.recordIdInput(input.recordId);
      // Request identity is per person principal, so two connections reusing one key never
      // share a deletion-ledger entry.
      const requestId = `forget_${sha256('lore-forget-v1', access.personPrincipalId, access.scopeId, key).slice(0, 40)}`;
      const protectedChangeId = this.protectedChangeId(access, 'forget', key);
      const actor = await this.access.approveByPolicy(access, {
        protectedChangeId,
        requestDigest: memoryForgetDigest(access.scopeId, recordId, requestId),
      });
      const result = await this.repository.forget(actor, access.scopeId, recordId, requestId);
      await this.afterWrite(access);
      return {
        record_id: recordId,
        status: result.status,
        use_stopped: result.status === 'stopped',
      };
    });
  }

  async recall(access: ConnectionAccess, input: RecallInput): Promise<RecallView> {
    return this.run(access, async () => {
      const now = this.now().toISOString();
      const mode = RECALL_MODES[input.mode];
      if (!mode) throw new MemoryServiceError('invalid_input', 'Unknown recall mode');
      if (
        input.mode !== 'historical' &&
        (input.knownAt !== undefined || input.validAt !== undefined)
      ) {
        throw new MemoryServiceError(
          'invalid_input',
          'known_at and valid_at apply only to historical recall',
        );
      }
      if (
        input.mode === 'historical' &&
        input.knownAt === undefined &&
        input.validAt === undefined
      ) {
        throw new MemoryServiceError(
          'invalid_input',
          'Historical recall needs known_at, valid_at or both',
        );
      }
      for (const time of [input.knownAt, input.validAt]) {
        if (time !== undefined && !Number.isFinite(Date.parse(time))) {
          throw new MemoryServiceError('invalid_input', 'known_at and valid_at must be ISO times');
        }
      }
      const knownAt = input.knownAt ?? now;
      const validAt = input.validAt ?? now;
      let embeddingFailed = false;
      const embeddings: EmbeddingProvider = {
        embed: async (text: string): Promise<Embedding> => {
          try {
            return await this.embeddings.embed(text);
          } catch {
            embeddingFailed = true;
            return { modelId: 'unavailable', dimension: 1, values: [0] };
          }
        },
      };
      const pack = await new MemoryRecallService(this.repository, embeddings).recall(
        access.actor,
        access.scopeId,
        {
          text: input.query,
          validAt,
          knownAt,
          byteBudget: mode.byteBudget,
          limit: input.limit ?? mode.limit,
        },
      );
      if (embeddingFailed) this.log({ event: 'memory.recall.embedding_unavailable' });
      return {
        mode: input.mode,
        valid_at: validAt,
        known_at: knownAt,
        items: pack.items.map((item) => ({
          authority: authorityOf(item.record),
          freshness: item.freshness,
          score: item.score,
          record: item.record,
        })),
        insufficiencies: embeddingFailed
          ? [...new Set([...pack.insufficiencies, 'embedding-unavailable'])].sort()
          : pack.insufficiencies,
        index_lag: {
          indexed_through: pack.indexLag.indexedThrough,
          latest_change: pack.indexLag.latestChange,
        },
        empty_meaning: pack.emptyMeaning,
        byte_length: pack.byteLength,
      };
    });
  }

  async getMemory(access: ConnectionAccess, recordIdInput: string): Promise<MemoryView> {
    return this.run(access, async () => {
      const recordId = this.recordIdInput(recordIdInput);
      const history = await this.repository.getRecordHistory(
        access.actor,
        access.scopeId,
        recordId,
        this.now().toISOString(),
      );
      if (!history) throw new MemoryServiceError('not_found', 'Memory not found');
      return {
        record_id: recordId,
        kind: history.latest.kind,
        lifecycle: history.latest.lifecycle,
        authority: authorityOf(history.latest),
        latest_revision: history.latest.revision.revision,
        supersedes: history.latest.supersedes,
        superseded_by: history.latest.supersededBy,
        current: history.current,
        revisions: history.revisions,
        withheld_revisions: history.withheldRevisions,
      };
    });
  }

  async getChanges(
    access: ConnectionAccess,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<ChangesView> {
    return this.run(access, async () => {
      const page = await this.repository.getChanges(
        access.actor,
        access.scopeId,
        cursor ?? null,
        limit ?? 50,
      );
      return { entries: page.entries, cursor: page.cursor, has_more: page.hasMore };
    });
  }

  private async run<T>(access: ConnectionAccess, operation: () => Promise<T>): Promise<T> {
    try {
      await this.ensureRestoreReady(access);
      return await operation();
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Reads stay closed while the scope's restore checkpoint lags the deletion ledger. Before an
   * operation, apply every ledger entry to the scope; a ledger that cannot be read fails the
   * operation.
   */
  private async ensureRestoreReady(access: ConnectionAccess): Promise<void> {
    if (await this.repository.isRestoreReady(access.actor, access.scopeId)) return;
    const worker = await this.access.worker(access);
    const head = await this.repository.reconcileRestore(worker, access.scopeId);
    this.log({ event: 'memory.restore.reconciled', ledger_head: head });
  }

  /** Purges recorded Forgets and indexes a bounded batch. Never fails the write. */
  private async afterWrite(access: ConnectionAccess): Promise<void> {
    try {
      const worker = await this.access.worker(access);
      for (const deletionId of await this.repository.listPendingDeletions(
        worker,
        access.scopeId,
        10,
      )) {
        const purged = await this.repository.purge(worker, access.scopeId, deletionId);
        this.log({ event: 'memory.purge', purged });
      }
      const covered = access.actor.compartmentAllowance.every((compartment) =>
        worker.compartmentAllowance.includes(compartment),
      );
      if (!covered) {
        // Leaving the jobs pending keeps the records in the unindexed-change overlay.
        this.log({ event: 'memory.index.skipped', reason: 'worker-allowance-narrower' });
        return;
      }
      const result = await this.indexer.runPending(worker, access.scopeId, this.indexBatchSize);
      if (result.failed > 0) {
        this.log({
          event: 'memory.index.failed',
          failed: result.failed,
          reasons: result.failures.map((failure) => failure.reason),
        });
      }
    } catch (error) {
      this.log({
        event: 'memory.after_write.failed',
        error: error instanceof MemoryRepositoryError ? error.code : 'unexpected',
      });
    }
  }

  private async commit(
    access: ConnectionAccess,
    key: string,
    changes: MemoryChange[],
    authority: WriteAuthority,
  ) {
    for (const change of changes) {
      if (change.kind === 'supersede') {
        this.assertValid(change.previous);
        this.assertValid(change.replacement);
      } else this.assertValid(change.record);
    }
    const actor =
      authority.protectedChangeId === null
        ? access.actor
        : await this.access.approveByPolicy(access, {
            protectedChangeId: authority.protectedChangeId,
            requestDigest: memoryChangeDigest(access.scopeId, changes),
          });
    return this.repository.commit(actor, { scopeId: access.scopeId, idempotencyKey: key, changes });
  }

  private writeResult(
    record: MemoryRecord,
    receipt: { readonly sequence: number; readonly replayed: boolean },
  ): WriteResult {
    return {
      record_id: record.id,
      revision: record.revision.revision,
      lifecycle: record.lifecycle,
      authority: authorityOf(record),
      approval_provenance: record.revision.approval.provenance === 'policy' ? 'policy' : null,
      sequence: receipt.sequence,
      replayed: receipt.replayed,
    };
  }

  private authority(
    access: ConnectionAccess,
    asUser: boolean,
    operation: string,
    key: string,
  ): WriteAuthority {
    if (asUser) {
      const protectedChangeId = this.protectedChangeId(access, operation, key);
      return {
        writer: { kind: 'person', id: access.personPrincipalId },
        approval: { status: 'approved', provenance: 'policy', protectedChangeId },
        attribution: { speaker: `subject:${access.subjectKey}`, role: 'user' },
        protectedChangeId,
      };
    }
    return {
      writer: { kind: 'ai', id: access.actor.principalId, connectionId: access.actor.connectionId },
      approval: { status: 'none' },
      attribution: { speaker: `gate-client:${access.actor.gateClientId}`, role: 'ai' },
      protectedChangeId: null,
    };
  }

  private protectedChangeId(access: ConnectionAccess, operation: string, key: string): string {
    return `policy_${sha256('lore-approval-v1', access.personPrincipalId, access.scopeId, operation, key).slice(0, 40)}`;
  }

  private recordId(access: ConnectionAccess, key: string): string {
    return `mem_${sha256('lore-record-v1', access.actor.principalId, access.scopeId, key).slice(0, 32)}`;
  }

  private source(access: ConnectionAccess, key: string): SourceReference {
    return {
      provider: SERVICE_SOURCE_PROVIDER,
      accountOrTenant: access.actor.gateClientId,
      resourceId: key,
    };
  }

  private withSource(
    existing: readonly SourceReference[],
    added: SourceReference,
  ): SourceReference[] {
    const same = (source: SourceReference) =>
      source.provider === added.provider &&
      source.accountOrTenant === added.accountOrTenant &&
      source.resourceId === added.resourceId;
    return existing.some(same) ? [...existing] : [...existing, added];
  }

  private content(
    access: ConnectionAccess,
    kind: MemoryKind,
    input: Partial<MemoryContentInput>,
    base: MemoryRecord | null,
  ): Content {
    let details: KindDetails;
    if (input.details !== undefined) {
      details = { ...input.details, kind } as unknown as KindDetails;
    } else if (base !== null && base.kind === kind) {
      details = base.details;
    } else {
      throw new MemoryServiceError(
        'invalid_input',
        `${kind} details are required: ${REQUIRED_DETAILS[kind]}`,
      );
    }
    const compartmentIds = unique(input.compartmentIds ?? base?.compartmentIds ?? []).sort();
    const allowance = new Set(access.actor.compartmentAllowance);
    if (compartmentIds.some((compartment) => !allowance.has(compartment))) {
      throw new MemoryServiceError(
        'forbidden',
        "A compartment is outside this connection's allowance; call get_access",
      );
    }
    const valid = {
      from: input.validFrom !== undefined ? input.validFrom : (base?.valid.from ?? null),
      until: input.validUntil !== undefined ? input.validUntil : (base?.valid.until ?? null),
    };
    if (
      valid.from !== null &&
      valid.until !== null &&
      Date.parse(valid.from) >= Date.parse(valid.until)
    ) {
      throw new MemoryServiceError('invalid_input', 'valid_from must be before valid_until');
    }
    const title = input.title ?? base?.title;
    const statement = input.statement ?? base?.statement;
    if (title === undefined || statement === undefined) {
      throw new MemoryServiceError('invalid_input', 'title and statement are required');
    }
    return {
      title,
      statement,
      details,
      subjectIds: unique(input.subjectIds ?? base?.subjectIds ?? []),
      aliases:
        input.aliases?.map((alias) => ({
          value: alias.value,
          from: alias.from ?? null,
          until: alias.until ?? null,
        })) ?? (base ? [...base.aliases] : []),
      assumptions: [...(input.assumptions ?? base?.assumptions ?? [])],
      valid,
      compartmentIds,
    };
  }

  private assertValid(record: MemoryRecord): void {
    const kind: MemoryKind = record.kind;
    if (!isMemoryRecord(record)) {
      throw new MemoryServiceError(
        'invalid_input',
        `The memory is incomplete: ${kind} details need ${REQUIRED_DETAILS[kind]}; text fields must not be blank and times must be ISO 8601 with an offset`,
      );
    }
  }

  private valueModel<T>(apply: () => T): T {
    try {
      return apply();
    } catch (error) {
      throw new MemoryServiceError(
        'invalid_input',
        error instanceof Error ? error.message : 'The change is not valid',
      );
    }
  }

  private idempotencyKey(value: string): string {
    if (!IDEMPOTENCY_KEY.test(value)) {
      throw new MemoryServiceError(
        'invalid_input',
        'idempotency_key must be 1 to 200 characters of letters, digits and ._:~-',
      );
    }
    return value;
  }

  private recordIdInput(value: string): string {
    if (!RECORD_ID.test(value)) throw new MemoryServiceError('not_found', 'Memory not found');
    return value;
  }

  private translate(error: unknown): unknown {
    if (error instanceof MemoryServiceError) return error;
    if (error instanceof AccessDeniedError) {
      return error.code === 'user_required'
        ? new MemoryServiceError('user_required', error.message)
        : new MemoryServiceError('forbidden', 'This connection is not authorized for the change');
    }
    if (error instanceof MemoryRepositoryError) {
      switch (error.code) {
        case 'not_found':
          return new MemoryServiceError('not_found', 'Memory not found');
        case 'conflict':
          return new MemoryServiceError(
            'conflict',
            'The memory changed or conflicts with an existing one; read it again and reconsider',
          );
        case 'idempotency_conflict':
          return new MemoryServiceError(
            'idempotency_conflict',
            'This idempotency_key was already used for a different request',
          );
        case 'resync_required':
          return new MemoryServiceError(
            'resync_required',
            'The cursor is no longer valid; read the changes again without a cursor',
          );
        case 'stale_authorization':
          return new MemoryServiceError(
            'stale_authorization',
            "The connection's authorization changed during the request; try again",
            true,
          );
        case 'invalid_change_set':
          return new MemoryServiceError('invalid_input', 'The request is not a valid change');
        case 'change_set_too_large':
          return new MemoryServiceError('too_large', 'The change is too large');
        case 'invalid_actor':
        case 'authorization_denied':
          return new MemoryServiceError(
            'forbidden',
            'This connection is not allowed to read or change this memory',
          );
      }
    }
    return error;
  }
}
