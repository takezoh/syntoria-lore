import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import {
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
} from '@google-cloud/firestore';
import { createFirestoreClient } from './firestore-client.js';
import {
  deriveAuthority,
  isSourceReference,
  isMemoryRecord,
  selectCurrentView,
  selectHistoricalView,
  type ApprovalProvenance,
  type MemoryRecord,
} from './index.js';

const MAX_CHANGES = 40;
const MAX_FEED_PAGE = 100;
const MAX_DECISION_CANDIDATES = 50;
const MAX_DECISION_CHECKS = 10;
const MAX_RECORD_BYTES = 900_000;
const MAX_CHANGE_SET_BYTES = 2 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 4096;

declare const verifiedActorCapabilityBrand: unique symbol;

export interface VerifiedActorCapability {
  readonly [verifiedActorCapabilityBrand]: true;
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorKind: 'person' | 'connection' | 'worker';
  readonly connectionId: string;
  readonly gateClientId: string;
  readonly scopeIds: readonly string[];
  readonly compartmentAllowance: readonly string[];
  readonly authorizationEpoch: number;
  readonly protectedChangeApproval?: {
    readonly provenance: ApprovalProvenance;
    readonly protectedChangeId: string;
    readonly requestDigest: string;
  };
}

export type MemoryChange =
  | { readonly kind: 'create'; readonly record: MemoryRecord }
  | {
      readonly kind: 'refine' | 'corroborate' | 'retract' | 'contest';
      readonly record: MemoryRecord;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: 'supersede';
      readonly previous: MemoryRecord;
      readonly replacement: MemoryRecord;
      readonly expectedRevision: number;
    };

export interface CommitChangeSet {
  readonly scopeId: string;
  readonly idempotencyKey: string;
  readonly changes: readonly MemoryChange[];
}

export interface CommitReceipt {
  readonly sequence: number;
  readonly recordIds: readonly string[];
  readonly replayed: boolean;
}

export interface ChangeFeedEntry {
  readonly sequence: number;
  readonly operation: MemoryChange['kind'] | 'batch' | 'deletion';
  readonly recordIds: readonly string[];
  readonly revisionNumbers: readonly number[];
  readonly compartmentIds: readonly string[];
}

export interface ChangeFeedPage {
  readonly entries: readonly ChangeFeedEntry[];
  readonly cursor: string;
  readonly hasMore: boolean;
}

export interface DeletionLedgerEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly recordId: string;
}

export interface DeletionLedgerSnapshot {
  readonly head: number;
  readonly entries: readonly DeletionLedgerEntry[];
}

export interface DeletionLedger {
  append(entry: DeletionLedgerEntry): Promise<void>;
  includes(entryId: string): Promise<boolean>;
  head(): Promise<number>;
  snapshot(): Promise<DeletionLedgerSnapshot>;
}

export interface ForgetResult {
  readonly status: 'stopped' | 'pending';
  readonly requestId: string;
}

export interface RecordHistory {
  /** The latest revision, which may be an AI proposal that current reads do not return. */
  readonly latest: MemoryRecord;
  /** The current view at the requested valid time, or null when nothing applies. */
  readonly current: MemoryRecord | null;
  /** Disclosable revisions in revision order. */
  readonly revisions: readonly MemoryRecord[];
  /** Revisions withheld because of the allowance or a revoked source. */
  readonly withheldRevisions: number;
}

export type CaptureJobStatus = 'accepted' | 'processing' | 'committed' | 'held' | 'failed';

export interface CaptureJob {
  readonly id: string;
  readonly scopeId: string;
  readonly sourceReference: import('./index.js').SourceReference;
  readonly syncRange: { readonly from: string; readonly until: string };
  readonly status: CaptureJobStatus;
  readonly reason?: string;
  readonly recordIds?: readonly string[];
  readonly modelVersion?: string;
  readonly promptVersion?: string;
  readonly preparedChanges?: readonly MemoryChange[] | null;
}

export interface IndexJob {
  readonly sequence: number;
  readonly recordIds: readonly string[];
  readonly status: 'pending' | 'complete';
}

export interface SearchIndexEntry {
  readonly recordId: string;
  readonly revision: number;
  readonly compartmentIds: readonly string[];
  readonly terms: readonly string[];
  readonly subjectIds: readonly string[];
  readonly aliases: readonly string[];
  readonly embedding: {
    readonly modelId: string;
    readonly dimension: number;
    readonly values: readonly number[];
  };
}

export interface RecallCandidateQuery {
  readonly terms: readonly string[];
  readonly recordId?: string;
  readonly subjectIds: readonly string[];
  readonly aliases: readonly string[];
  readonly embedding?: {
    readonly modelId: string;
    readonly dimension: number;
    readonly values: readonly number[];
  };
  readonly validAt: string;
  readonly knownAt: string;
  readonly includeProposals?: boolean;
  readonly limit: number;
}

export interface RecallCandidateResult {
  readonly items: readonly {
    readonly record: MemoryRecord;
    readonly score: number;
    readonly freshness: 'current' | 'recent-overlay' | 'stale-index';
  }[];
  readonly insufficiencies: readonly string[];
  readonly indexLag: { readonly indexedThrough: number; readonly latestChange: number };
}

export class MemoryRepositoryError extends Error {
  constructor(
    readonly code:
      | 'invalid_actor'
      | 'authorization_denied'
      | 'stale_authorization'
      | 'invalid_change_set'
      | 'change_set_too_large'
      | 'conflict'
      | 'idempotency_conflict'
      | 'resync_required'
      | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryRepositoryError';
  }
}

interface IdempotencyDocument {
  digest: string;
  receipt: Omit<CommitReceipt, 'replayed'>;
}

interface AuthorizationDocument {
  active: boolean;
  tenantId: string;
  principalId: string;
  actorKind: VerifiedActorCapability['actorKind'];
  connectionId: string;
  gateClientId: string;
  authorizationEpoch: number;
  compartmentAllowance: string[];
  revokedSourceReferences: string[];
}

interface ProtectedApprovalDocument {
  principalId: string;
  connectionId: string;
  gateClientId: string;
  provenance: ApprovalProvenance;
  protectedChangeId: string;
  requestDigest: string;
}

interface CursorPayload {
  version: 1;
  scopeId: string;
  principalId: string;
  authorizationEpoch: number;
  allowanceDigest: string;
  sequence: number;
}

interface DecisionCandidateMetadata {
  id: string;
  kind: string;
  lifecycle: string;
  suppressed: boolean;
  subjectIds: string[];
  compartmentIds: string[];
  valid: MemoryRecord['valid'];
  details: { kind: string; question?: string };
}

function nonempty(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('/') &&
    Buffer.byteLength(value, 'utf8') <= 1024
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function memoryForgetDigest(scopeId: string, recordId: string, requestId: string): string {
  return digest(['forget', scopeId, recordId, requestId]);
}

export function memoryChangeDigest(scopeId: string, changes: readonly MemoryChange[]): string {
  return digest({ scopeId, changes });
}

function id(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** The collection that holds one authorization document per tenant, principal and scope. */
export const MEMORY_AUTHORIZATION_COLLECTION = 'memoryAuthorization';

/** The document ID of the authorization for one tenant, principal and scope. */
export function authorizationDocumentId(
  tenantId: string,
  principalId: string,
  scopeId: string,
): string {
  return id(`${tenantId}_${principalId}_${scopeId}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function recallTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('und');
  const tokens = new Set(
    (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (word) => !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(word),
    ),
  );
  for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ??
    []) {
    const points = [...run];
    if (points.length === 1) tokens.add(points[0]!);
    for (let index = 0; index + 1 < points.length; index += 1)
      tokens.add(`${points[index]}${points[index + 1]}`);
  }
  return [...tokens];
}

function isSearchIndexEntry(value: unknown): value is SearchIndexEntry {
  if (!isObject(value) || !isObject(value['embedding'])) return false;
  const embedding = value['embedding'];
  return (
    nonempty(value['recordId']) &&
    Number.isSafeInteger(value['revision']) &&
    Number(value['revision']) > 0 &&
    Array.isArray(value['compartmentIds']) &&
    value['compartmentIds'].every(nonempty) &&
    Array.isArray(value['terms']) &&
    value['terms'].every(nonempty) &&
    Array.isArray(value['subjectIds']) &&
    value['subjectIds'].every(nonempty) &&
    Array.isArray(value['aliases']) &&
    value['aliases'].every(nonempty) &&
    nonempty(embedding['modelId']) &&
    Number.isSafeInteger(embedding['dimension']) &&
    Number(embedding['dimension']) > 0 &&
    Array.isArray(embedding['values']) &&
    embedding['values'].length === embedding['dimension'] &&
    embedding['values'].every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return stableJson(sortedUnique(left)) === stableJson(sortedUnique(right));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDecisionCandidateMetadata(value: unknown): value is DecisionCandidateMetadata {
  if (!isObject(value) || !isObject(value['details']) || !isObject(value['valid'])) return false;
  const valid = value['valid'];
  const validTime = (time: unknown) =>
    time === null || (typeof time === 'string' && Number.isFinite(Date.parse(time)));
  return (
    typeof value['id'] === 'string' &&
    typeof value['kind'] === 'string' &&
    typeof value['lifecycle'] === 'string' &&
    typeof value['suppressed'] === 'boolean' &&
    Array.isArray(value['subjectIds']) &&
    value['subjectIds'].every((item) => typeof item === 'string') &&
    Array.isArray(value['compartmentIds']) &&
    value['compartmentIds'].every((item) => typeof item === 'string') &&
    typeof value['details']['kind'] === 'string' &&
    (value['kind'] !== 'decision' ||
      (value['details']['kind'] === 'decision' &&
        typeof value['details']['question'] === 'string')) &&
    validTime(valid['from']) &&
    validTime(valid['until'])
  );
}

function recordsOf(change: MemoryChange): MemoryRecord[] {
  return change.kind === 'supersede' ? [change.previous, change.replacement] : [change.record];
}

function labelsOf(change: MemoryChange): string[] {
  return sortedUnique(recordsOf(change).flatMap((record) => record.compartmentIds));
}

function changeRecords(
  change: MemoryChange,
): Array<{ record: MemoryRecord; expected: number | null }> {
  if (change.kind === 'create') return [{ record: change.record, expected: null }];
  if (change.kind === 'supersede') {
    return [
      { record: change.previous, expected: change.expectedRevision },
      { record: change.replacement, expected: null },
    ];
  }
  return [{ record: change.record, expected: change.expectedRevision }];
}

function containsOnly(values: readonly string[], allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return values.every((value) => set.has(value));
}

function assertActor(actor: VerifiedActorCapability, scopeId: string): void {
  if (
    !actor ||
    !nonempty(actor.tenantId) ||
    !nonempty(actor.principalId) ||
    !['person', 'connection', 'worker'].includes(actor.actorKind) ||
    !nonempty(actor.connectionId) ||
    !nonempty(actor.gateClientId) ||
    !Array.isArray(actor.scopeIds) ||
    !actor.scopeIds.every(nonempty) ||
    !Array.isArray(actor.compartmentAllowance) ||
    !actor.compartmentAllowance.every(nonempty) ||
    !Number.isSafeInteger(actor.authorizationEpoch) ||
    actor.authorizationEpoch < 0 ||
    (actor.protectedChangeApproval !== undefined &&
      (!['person', 'policy'].includes(actor.protectedChangeApproval.provenance) ||
        !nonempty(actor.protectedChangeApproval.protectedChangeId) ||
        !/^[a-f0-9]{64}$/u.test(actor.protectedChangeApproval.requestDigest))) ||
    !actor.scopeIds.includes(scopeId) ||
    Buffer.byteLength(id(`${actor.tenantId}_${actor.principalId}_${scopeId}`), 'utf8') > 1500
  ) {
    throw new MemoryRepositoryError('invalid_actor', 'A verified actor capability is required');
  }
}

function assertWorkerActor(actor: VerifiedActorCapability): void {
  if (actor.actorKind !== 'worker') {
    throw new MemoryRepositoryError(
      'authorization_denied',
      'Derived index operations require a worker',
    );
  }
}

function assertRecord(record: MemoryRecord, actor: VerifiedActorCapability, scopeId: string): void {
  if (
    !isMemoryRecord(record) ||
    record.tenantId !== actor.tenantId ||
    record.scopeId !== scopeId ||
    Buffer.byteLength(stableJson(record), 'utf8') > MAX_RECORD_BYTES ||
    Buffer.byteLength(id(record.id), 'utf8') > 1500 ||
    record.subjectIds.length > 20 ||
    record.subjectIds.some((subjectId) => Buffer.byteLength(subjectId, 'utf8') > 128) ||
    record.compartmentIds.length > 20 ||
    record.compartmentIds.some((compartmentId) => Buffer.byteLength(compartmentId, 'utf8') > 128) ||
    (record.details.kind === 'decision' &&
      Buffer.byteLength(record.details.question, 'utf8') > 512) ||
    !containsOnly(record.compartmentIds, actor.compartmentAllowance)
  ) {
    throw new MemoryRepositoryError(
      'authorization_denied',
      'The record is outside the actor allowance',
    );
  }
}

function recordIds(changes: readonly MemoryChange[]): string[] {
  return [...new Set(changes.flatMap((change) => recordsOf(change).map((record) => record.id)))];
}

function encodeCursor(payload: CursorPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function decodeCursor(cursor: string, secret: Buffer): CursorPayload {
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new MemoryRepositoryError('resync_required', 'Invalid change-feed cursor');
  }
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra !== undefined) {
    throw new MemoryRepositoryError('resync_required', 'Invalid change-feed cursor');
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    throw new MemoryRepositoryError('resync_required', 'Invalid change-feed cursor');
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new MemoryRepositoryError('resync_required', 'Invalid change-feed cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new MemoryRepositoryError('resync_required', 'Invalid change-feed cursor');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as CursorPayload).version !== 1 ||
    !nonempty((parsed as CursorPayload).scopeId) ||
    !nonempty((parsed as CursorPayload).principalId) ||
    !nonempty((parsed as CursorPayload).allowanceDigest) ||
    !Number.isSafeInteger((parsed as CursorPayload).authorizationEpoch) ||
    !Number.isSafeInteger((parsed as CursorPayload).sequence) ||
    (parsed as CursorPayload).sequence < 0
  ) {
    throw new MemoryRepositoryError('resync_required', 'Invalid change-feed cursor');
  }
  return parsed as CursorPayload;
}

/**
 * The only module that may import the Firestore client. Actor capabilities must come from the
 * authenticated authorization path; persisted authorization state is re-read for every operation.
 */
export class FirestoreMemoryRecordRepository {
  private readonly cursorSecret: Buffer;

  constructor(
    private readonly firestore: Firestore,
    cursorSecret: Uint8Array,
    private readonly deletionLedger: DeletionLedger,
  ) {
    if (cursorSecret.byteLength < 32)
      throw new TypeError('Cursor signing secret must be at least 32 bytes');
    this.cursorSecret = Buffer.from(cursorSecret);
  }

  async close(): Promise<void> {
    await this.firestore.terminate();
  }

  async acceptCaptureJob(
    actor: VerifiedActorCapability,
    scopeId: string,
    jobId: string,
    sourceReference: import('./index.js').SourceReference,
    syncRange: { readonly from: string; readonly until: string },
  ): Promise<CaptureJob> {
    assertActor(actor, scopeId);
    if (actor.actorKind === 'person' || !nonempty(jobId)) {
      throw new MemoryRepositoryError('authorization_denied', 'Invalid background capture actor');
    }
    const source = { ...sourceReference };
    if (
      !isSourceReference(source) ||
      !syncRange ||
      !Number.isFinite(Date.parse(syncRange.from)) ||
      !Number.isFinite(Date.parse(syncRange.until)) ||
      Date.parse(syncRange.from) >= Date.parse(syncRange.until)
    ) {
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid capture source reference');
    }
    const ref = this.captureJobRef(actor, scopeId, jobId);
    const requestDigest = digest([scopeId, source, syncRange]);
    return this.firestore.runTransaction(async (transaction) => {
      const [authorization, existing] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        transaction.get(ref),
      ]);
      const current = this.assertCurrentAuthorization(
        actor,
        authorization.data() as AuthorizationDocument | undefined,
      );
      if (current.revokedSourceReferences.includes(sourceReferenceKey(source))) {
        throw new MemoryRepositoryError(
          'authorization_denied',
          'Capture source rights are revoked',
        );
      }
      if (existing.exists) {
        const prior = existing.data() as CaptureJob & { requestDigest?: string };
        if (prior.requestDigest !== requestDigest) {
          throw new MemoryRepositoryError(
            'idempotency_conflict',
            'Capture job identity was reused',
          );
        }
        return prior;
      }
      const job: CaptureJob = {
        id: jobId,
        scopeId,
        sourceReference: source,
        syncRange,
        status: 'accepted',
      };
      transaction.create(ref, { ...job, requestDigest });
      return job;
    });
  }

  async getCaptureJob(
    actor: VerifiedActorCapability,
    scopeId: string,
    jobId: string,
  ): Promise<CaptureJob | null> {
    assertActor(actor, scopeId);
    const [auth, snapshot] = await Promise.all([
      this.authorizationRef(actor, scopeId).get(),
      this.captureJobRef(actor, scopeId, jobId).get(),
    ]);
    this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
    return snapshot.exists ? (snapshot.data() as CaptureJob) : null;
  }

  async listPendingIndexJobs(
    actor: VerifiedActorCapability,
    scopeId: string,
    limit = 20,
  ): Promise<IndexJob[]> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid index-job page size');
    await this.assertRestoreReady(actor, scopeId);
    const [authorization, jobs] = await Promise.all([
      this.authorizationRef(actor, scopeId).get(),
      this.scopeRef(actor, scopeId)
        .collection('indexJobs')
        .where('status', '==', 'pending')
        .limit(limit)
        .get(),
    ]);
    this.assertCurrentAuthorization(
      actor,
      authorization.data() as AuthorizationDocument | undefined,
    );
    return jobs.docs.map((document) => ({
      sequence: Number(document.get('sequence')),
      recordIds: document.get('recordIds') as string[],
      status: 'pending',
    }));
  }

  async getRecordForIndex(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
  ): Promise<MemoryRecord | null> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    await this.assertRestoreReady(actor, scopeId);
    return this.firestore.runTransaction(async (transaction) => {
      const [authorizationSnapshot, recordSnapshot, suppressionSnapshot] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        transaction.get(this.recordRef(actor, scopeId, recordId)),
        transaction.get(this.suppressionRef(actor, scopeId, recordId)),
      ]);
      const authorization = this.assertCurrentAuthorization(
        actor,
        authorizationSnapshot.data() as AuthorizationDocument | undefined,
      );
      if (!recordSnapshot.exists || suppressionSnapshot.exists) return null;
      const record: unknown = recordSnapshot.data();
      if (
        !isMemoryRecord(record) ||
        record.suppressed ||
        !this.matchesStoredIdentity(actor, scopeId, recordId, record) ||
        !containsOnly(record.compartmentIds, actor.compartmentAllowance)
      )
        return null;
      this.assertSourceRights(record, authorization);
      return record;
    });
  }

  async getRecordsForIndex(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
  ): Promise<MemoryRecord[] | null> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    await this.assertRestoreReady(actor, scopeId);
    return this.firestore.runTransaction(async (transaction) => {
      const [authorizationSnapshot, currentSnapshot, suppressionSnapshot, revisions, indexed] =
        await Promise.all([
          transaction.get(this.authorizationRef(actor, scopeId)),
          transaction.get(this.recordRef(actor, scopeId, recordId)),
          transaction.get(this.suppressionRef(actor, scopeId, recordId)),
          transaction.get(this.recordRef(actor, scopeId, recordId).collection('revisions')),
          transaction.get(this.indexCollection(actor, scopeId).where('recordId', '==', recordId)),
        ]);
      const authorization = this.assertCurrentAuthorization(
        actor,
        authorizationSnapshot.data() as AuthorizationDocument | undefined,
      );
      if (
        !currentSnapshot.exists ||
        suppressionSnapshot.exists ||
        !this.matchesStoredIdentity(
          actor,
          scopeId,
          recordId,
          currentSnapshot.data() as MemoryRecord,
        )
      )
        return null;
      const current = currentSnapshot.data() as MemoryRecord;
      if (
        !isMemoryRecord(current) ||
        current.suppressed ||
        !containsOnly(current.compartmentIds, actor.compartmentAllowance)
      )
        return null;
      const indexedRevisions = new Set(
        indexed.docs.map((document) => Number(document.get('revision'))),
      );
      const records = revisions.docs
        .map((document) => document.data() as unknown)
        .filter(isMemoryRecord)
        .filter((record) => record.id === recordId && !record.suppressed)
        .filter((record) => containsOnly(record.compartmentIds, actor.compartmentAllowance))
        .filter((record) => !this.hasRevokedSource(record, authorization))
        .filter((record) => !indexedRevisions.has(record.revision.revision))
        .sort((left, right) => left.revision.revision - right.revision.revision);
      return records;
    });
  }

  async writeSearchIndexEntry(
    actor: VerifiedActorCapability,
    scopeId: string,
    entry: SearchIndexEntry,
  ): Promise<boolean> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    if (
      !isSearchIndexEntry(entry) ||
      !containsOnly(entry.compartmentIds, actor.compartmentAllowance)
    )
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid derived index entry');
    await this.assertRestoreReady(actor, scopeId);
    return this.firestore.runTransaction(async (transaction) => {
      const [authorizationSnapshot, recordSnapshot, suppressionSnapshot, revisionSnapshot] =
        await Promise.all([
          transaction.get(this.authorizationRef(actor, scopeId)),
          transaction.get(this.recordRef(actor, scopeId, entry.recordId)),
          transaction.get(this.suppressionRef(actor, scopeId, entry.recordId)),
          transaction.get(
            this.recordRef(actor, scopeId, entry.recordId)
              .collection('revisions')
              .doc(String(entry.revision)),
          ),
        ]);
      const authorization = this.assertCurrentAuthorization(
        actor,
        authorizationSnapshot.data() as AuthorizationDocument | undefined,
      );
      if (!recordSnapshot.exists || suppressionSnapshot.exists || !revisionSnapshot.exists)
        return false;
      const record: unknown = recordSnapshot.data();
      if (
        !isMemoryRecord(record) ||
        !this.matchesStoredIdentity(actor, scopeId, entry.recordId, record) ||
        record.suppressed ||
        !containsOnly(record.compartmentIds, actor.compartmentAllowance)
      )
        return false;
      this.assertSourceRights(record, authorization);
      const indexedRevision = revisionSnapshot.data() as unknown;
      if (
        !isMemoryRecord(indexedRevision) ||
        indexedRevision.revision.revision !== entry.revision ||
        this.hasRevokedSource(indexedRevision, authorization)
      )
        return false;
      const indexRef = this.indexEntryRef(actor, scopeId, entry.recordId, entry.revision);
      const prior = await transaction.get(indexRef);
      if (prior.exists) return false;
      transaction.create(indexRef, {
        ...entry,
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  async removeSearchIndexEntry(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
    expectedRevision: number,
  ): Promise<boolean> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    await this.assertRestoreReady(actor, scopeId);
    return this.firestore.runTransaction(async (transaction) => {
      const [authorization, current, suppression, index] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        transaction.get(this.recordRef(actor, scopeId, recordId)),
        transaction.get(this.suppressionRef(actor, scopeId, recordId)),
        transaction.get(this.indexCollection(actor, scopeId).where('recordId', '==', recordId)),
      ]);
      this.assertCurrentAuthorization(
        actor,
        authorization.data() as AuthorizationDocument | undefined,
      );
      if (index.empty) return false;
      if (current.exists && !suppression.exists) return false;
      for (const document of index.docs) {
        if (Number(document.get('revision')) <= expectedRevision) transaction.delete(document.ref);
      }
      return true;
    });
  }

  async completeIndexJob(
    actor: VerifiedActorCapability,
    scopeId: string,
    job: IndexJob,
  ): Promise<void> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    await this.assertRestoreReady(actor, scopeId);
    await this.firestore.runTransaction(async (transaction) => {
      const authorization = await transaction.get(this.authorizationRef(actor, scopeId));
      this.assertCurrentAuthorization(
        actor,
        authorization.data() as AuthorizationDocument | undefined,
      );
      const jobRef = this.jobRef(actor, scopeId, job.sequence);
      const [snapshot, state] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(this.indexStateRef(actor, scopeId)),
      ]);
      if (!snapshot.exists)
        throw new MemoryRepositoryError('not_found', 'Index job does not exist');
      let indexedThrough = Number(state.get('indexedThrough') ?? 0);
      const next = indexedThrough + 1;
      const refs = Array.from({ length: Math.max(0, job.sequence - indexedThrough) }, (_, offset) =>
        this.jobRef(actor, scopeId, next + offset),
      );
      const priorJobs =
        refs.length > 0 ? await Promise.all(refs.map((ref) => transaction.get(ref))) : [];
      for (const prior of priorJobs) {
        if (!prior.exists || (prior.get('status') !== 'complete' && prior.id !== jobRef.id)) break;
        indexedThrough += 1;
      }
      transaction.set(jobRef, {
        ...snapshot.data(),
        status: 'complete',
        completedAt: new Date().toISOString(),
      });
      transaction.set(this.indexStateRef(actor, scopeId), { indexedThrough });
    });
  }

  async readRecallCandidates(
    actor: VerifiedActorCapability,
    scopeId: string,
    query: RecallCandidateQuery,
  ): Promise<RecallCandidateResult> {
    assertActor(actor, scopeId);
    await this.assertRestoreReady(actor, scopeId);
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      !Number.isFinite(Date.parse(query.validAt)) ||
      !Number.isFinite(Date.parse(query.knownAt))
    )
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid recall bounds or times');
    const maxIndexEntries = 1000;
    const maxOverlayChanges = 500;
    const [authorizationSnapshot, indexSnapshot, stateSnapshot, sequenceSnapshot] =
      await Promise.all([
        this.authorizationRef(actor, scopeId).get(),
        this.indexCollection(actor, scopeId)
          .limit(maxIndexEntries + 1)
          .get(),
        this.indexStateRef(actor, scopeId).get(),
        this.sequenceRef(actor, scopeId).get(),
      ]);
    this.assertCurrentAuthorization(
      actor,
      authorizationSnapshot.data() as AuthorizationDocument | undefined,
    );
    const indexedThrough = Number(stateSnapshot.get('indexedThrough') ?? 0);
    const latestChange = Number(sequenceSnapshot.get('sequence') ?? 0);
    const changesSnapshot = await this.changeCollection(actor, scopeId)
      .where('sequence', '>', indexedThrough)
      .orderBy('sequence')
      .limit(maxOverlayChanges + 1)
      .get();
    const pendingChanges = changesSnapshot.docs;
    const overlayDocs = pendingChanges.slice(0, maxOverlayChanges);
    const insufficiencies = new Set<string>();
    if (indexSnapshot.size > maxIndexEntries) insufficiencies.add('index-candidate-limit');
    if (pendingChanges.length > maxOverlayChanges) insufficiencies.add('overlay-candidate-limit');
    if (latestChange > indexedThrough) insufficiencies.add('index-lag');

    const indexDocs = indexSnapshot.docs.slice(0, maxIndexEntries);
    const candidateScores = new Map<
      string,
      { revisionScores: Map<number, number>; overlay: boolean; exactId: boolean }
    >();
    const queryTerms = new Set(query.terms);
    const querySubjects = new Set(query.subjectIds);
    const queryAliases = new Set(query.aliases);
    const cosine = (left: readonly number[], right: readonly number[]): number => {
      if (left.length === 0 || left.length !== right.length) return 0;
      let dot = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < left.length; i += 1) {
        dot += left[i]! * right[i]!;
        a += left[i]! ** 2;
        b += right[i]! ** 2;
      }
      return a === 0 || b === 0 ? 0 : dot / Math.sqrt(a * b);
    };
    for (const document of indexDocs) {
      const raw = document.data();
      if (!isSearchIndexEntry(raw)) {
        insufficiencies.add('invalid-index-entry');
        continue;
      }
      const entry = raw;
      if (document.id !== this.indexEntryId(entry.recordId, entry.revision)) continue;
      if (!containsOnly(entry.compartmentIds, actor.compartmentAllowance)) continue;
      const termMatches = entry.terms.filter((term) => queryTerms.has(term)).length;
      const exactId = entry.recordId === query.recordId;
      const subjectMatch = entry.subjectIds.some((subject) => querySubjects.has(subject));
      const aliasMatch = entry.aliases.some((alias) => queryAliases.has(alias));
      const vectorScore =
        query.embedding &&
        entry.embedding?.modelId === query.embedding.modelId &&
        entry.embedding.dimension === query.embedding.dimension
          ? cosine(entry.embedding.values, query.embedding.values)
          : 0;
      const score =
        (exactId ? 1000 : 0) +
        (subjectMatch ? 100 : 0) +
        (aliasMatch ? 80 : 0) +
        termMatches * 2 +
        vectorScore;
      if (score > 0) {
        const candidate = candidateScores.get(entry.recordId) ?? {
          revisionScores: new Map<number, number>(),
          overlay: false,
          exactId: false,
        };
        candidate.revisionScores.set(
          entry.revision,
          Math.max(candidate.revisionScores.get(entry.revision) ?? 0, score),
        );
        candidateScores.set(entry.recordId, candidate);
      }
    }
    if (query.recordId) {
      const candidate = candidateScores.get(query.recordId) ?? {
        revisionScores: new Map<number, number>(),
        overlay: false,
        exactId: false,
      };
      candidate.overlay = true;
      candidate.exactId = true;
      candidateScores.set(query.recordId, candidate);
    }
    const overlayIds = new Set(
      overlayDocs.flatMap((document) => document.get('recordIds') as string[]),
    );
    for (const recordId of overlayIds)
      candidateScores.set(recordId, {
        ...(candidateScores.get(recordId) ?? {
          revisionScores: new Map<number, number>(),
          overlay: false,
          exactId: false,
        }),
        overlay: true,
      });
    const requestedIds = [...candidateScores.keys()];
    const visible = await this.firestore.runTransaction(async (transaction) => {
      const auth = await transaction.get(this.authorizationRef(actor, scopeId));
      const authorization = this.assertCurrentAuthorization(
        actor,
        auth.data() as AuthorizationDocument | undefined,
      );
      const snapshots = await Promise.all(
        requestedIds.map((recordId) => transaction.get(this.recordRef(actor, scopeId, recordId))),
      );
      const suppressions = await Promise.all(
        requestedIds.map((recordId) =>
          transaction.get(this.suppressionRef(actor, scopeId, recordId)),
        ),
      );
      const histories = await Promise.all(
        requestedIds.map((recordId) =>
          transaction.get(this.recordRef(actor, scopeId, recordId).collection('revisions')),
        ),
      );
      const results: RecallCandidateResult['items'][number][] = [];
      requestedIds.forEach((recordId, index) => {
        const snapshot = snapshots[index];
        const suppression = suppressions[index];
        const history = histories[index];
        if (!snapshot || !suppression || !history || suppression.exists || !snapshot.exists) return;
        const current = snapshot.data() as unknown;
        if (
          !isMemoryRecord(current) ||
          current.suppressed ||
          !this.matchesStoredIdentity(actor, scopeId, recordId, current) ||
          !containsOnly(current.compartmentIds, actor.compartmentAllowance)
        )
          return;
        if (this.hasRevokedSource(current, authorization)) {
          insufficiencies.add('rights-withheld');
          return;
        }
        const revisions: MemoryRecord[] = [];
        for (const revision of history.docs) {
          const stored = revision.data() as unknown;
          if (
            !isMemoryRecord(stored) ||
            !this.matchesStoredIdentity(actor, scopeId, recordId, stored) ||
            revision.id !== String(stored.revision.revision)
          ) {
            insufficiencies.add('invalid-history');
            return;
          }
          revisions.push(stored);
        }
        revisions.sort((left, right) => left.revision.revision - right.revision.revision);
        if (
          revisions.length !== current.revision.revision ||
          revisions.some((revision, index) => revision.revision.revision !== index + 1)
        ) {
          insufficiencies.add('invalid-history');
          return;
        }
        const record = selectHistoricalView(
          revisions,
          query.knownAt,
          query.validAt,
          query.includeProposals === undefined ? {} : { includeProposals: query.includeProposals },
        );
        if (!record || !containsOnly(record.compartmentIds, actor.compartmentAllowance)) return;
        if (this.hasRevokedSource(record, authorization)) {
          insufficiencies.add('rights-withheld');
          return;
        }
        const candidate = candidateScores.get(recordId)!;
        let score = candidate.revisionScores.get(record.revision.revision) ?? 0;
        if (candidate.overlay) {
          const words = recallTokens(
            [
              record.title,
              record.statement,
              ...record.subjectIds,
              ...record.aliases.map((alias) => alias.value),
            ].join(' '),
          );
          const termMatches = words.filter((term) => query.terms.includes(term)).length;
          const exactId = candidate.exactId;
          const subjectMatch = record.subjectIds.some((subject) =>
            query.subjectIds.includes(subject),
          );
          const aliasMatch = record.aliases.some((alias) =>
            query.aliases.includes(alias.value.normalize('NFKC').toLocaleLowerCase('und')),
          );
          score = Math.max(
            score,
            (exactId ? 1000 : 0) +
              (subjectMatch ? 100 : 0) +
              (aliasMatch ? 80 : 0) +
              termMatches * 2,
          );
        }
        if (score <= 0) return;
        const fresh = !candidate.revisionScores.has(record.revision.revision)
          ? 'recent-overlay'
          : 'current';
        if (candidate.overlay && !candidate.revisionScores.has(record.revision.revision))
          insufficiencies.add('embedding-or-index-entry-missing');
        results.push({ record, score, freshness: fresh });
      });
      return results;
    });
    visible.sort(
      (left, right) =>
        right.score - left.score ||
        authorityRank(right.record) - authorityRank(left.record) ||
        left.record.id.localeCompare(right.record.id),
    );
    return {
      items: visible.slice(0, query.limit),
      insufficiencies: [...insufficiencies].sort(),
      indexLag: { indexedThrough, latestChange },
    };
  }

  async findCaptureMatch(
    actor: VerifiedActorCapability,
    scopeId: string,
    proposal: Pick<MemoryRecord, 'kind' | 'statement' | 'subjectIds' | 'valid'>,
  ): Promise<MemoryRecord | null> {
    assertActor(actor, scopeId);
    await this.assertRestoreReady(actor, scopeId);
    const [authorization, records] = await Promise.all([
      this.authorizationRef(actor, scopeId).get(),
      this.recordCollection(actor, scopeId).get(),
    ]);
    const currentAuthorization = this.assertCurrentAuthorization(
      actor,
      authorization.data() as AuthorizationDocument | undefined,
    );
    const wanted = stableJson({
      kind: proposal.kind,
      statement: proposal.statement.trim(),
      subjectIds: sortedUnique(proposal.subjectIds),
      valid: proposal.valid,
    });
    let candidateMatch: MemoryRecord | null = null;
    for (const snapshot of records.docs) {
      const candidate: unknown = snapshot.data();
      if (
        !isMemoryRecord(candidate) ||
        !['active', 'candidate'].includes(candidate.lifecycle) ||
        candidate.suppressed ||
        candidate.tenantId !== actor.tenantId ||
        candidate.scopeId !== scopeId ||
        !containsOnly(candidate.compartmentIds, actor.compartmentAllowance) ||
        candidate.revision.sourceReferences.some((source) =>
          currentAuthorization.revokedSourceReferences.includes(sourceReferenceKey(source)),
        )
      )
        continue;
      const existing = stableJson({
        kind: candidate.kind,
        statement: candidate.statement.trim(),
        subjectIds: sortedUnique(candidate.subjectIds),
        valid: candidate.valid,
      });
      if (existing === wanted) {
        if (candidate.lifecycle === 'active') return candidate;
        candidateMatch ??= candidate;
      }
    }
    return candidateMatch;
  }

  async updateCaptureJob(
    actor: VerifiedActorCapability,
    scopeId: string,
    jobId: string,
    status: CaptureJobStatus,
    metadata: Pick<
      CaptureJob,
      'reason' | 'recordIds' | 'modelVersion' | 'promptVersion' | 'preparedChanges'
    > = {},
  ): Promise<CaptureJob> {
    assertActor(actor, scopeId);
    const ref = this.captureJobRef(actor, scopeId, jobId);
    return this.firestore.runTransaction(async (transaction) => {
      const [auth, snapshot] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        transaction.get(ref),
      ]);
      this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
      if (!snapshot.exists) throw new MemoryRepositoryError('not_found', 'Capture job not found');
      const prior = snapshot.data() as CaptureJob;
      const allowed: Record<CaptureJobStatus, readonly CaptureJobStatus[]> = {
        accepted: ['accepted', 'processing', 'held', 'failed'],
        processing: ['processing', 'committed', 'held', 'failed'],
        held: ['processing', 'held', 'failed'],
        committed: ['committed'],
        failed: ['failed'],
      };
      if (!allowed[prior.status].includes(status)) {
        throw new MemoryRepositoryError('conflict', 'Invalid capture job transition');
      }
      if (Array.isArray(metadata.preparedChanges)) {
        const bytes = Buffer.byteLength(stableJson(metadata.preparedChanges), 'utf8');
        if (bytes > 850_000) {
          throw new MemoryRepositoryError(
            'change_set_too_large',
            'Prepared capture exceeds the durable job size limit',
          );
        }
        if (
          prior.preparedChanges !== undefined &&
          stableJson(prior.preparedChanges) !== stableJson(metadata.preparedChanges)
        ) {
          throw new MemoryRepositoryError('conflict', 'Capture job already has prepared changes');
        }
      }
      const job = { ...prior, ...metadata, status };
      transaction.set(ref, job);
      return job;
    });
  }

  async forget(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
    requestId: string,
  ): Promise<ForgetResult> {
    assertActor(actor, scopeId);
    if (actor.actorKind !== 'person' || !nonempty(recordId) || !nonempty(requestId)) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Forget requires an approved person change',
      );
    }
    const requestDigest = memoryForgetDigest(scopeId, recordId, requestId);
    const approval = actor.protectedChangeApproval;
    if (!approval || approval.requestDigest !== requestDigest) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Forget approval does not match the request',
      );
    }
    const ledgerEntry: DeletionLedgerEntry = {
      id: digest([actor.tenantId, scopeId, requestId]),
      tenantId: actor.tenantId,
      scopeId,
      recordId,
    };
    const requestRef = this.forgetRequestRef(actor, scopeId, requestId);
    await this.firestore.runTransaction(async (transaction) => {
      const [auth, current, sequence, prior, persistedApproval, suppression, indexState] =
        await Promise.all([
          transaction.get(this.authorizationRef(actor, scopeId)),
          transaction.get(this.recordRef(actor, scopeId, recordId)),
          transaction.get(this.sequenceRef(actor, scopeId)),
          transaction.get(requestRef),
          transaction.get(this.protectedApprovalRef(actor, scopeId, approval.protectedChangeId)),
          transaction.get(this.suppressionRef(actor, scopeId, recordId)),
          transaction.get(this.indexStateRef(actor, scopeId)),
        ]);
      this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
      const priorRequest = prior.data() as { requestDigest?: string } | undefined;
      if (prior.exists && priorRequest?.requestDigest !== requestDigest) {
        throw new MemoryRepositoryError(
          'idempotency_conflict',
          'Forget request identity was reused',
        );
      }
      if (!prior.exists && (!persistedApproval.exists || !current.exists)) {
        throw new MemoryRepositoryError('not_found', 'Record or controlled approval was not found');
      }
      const storedApproval = persistedApproval.data() as ProtectedApprovalDocument | undefined;
      if (
        storedApproval &&
        (storedApproval.principalId !== actor.principalId ||
          storedApproval.connectionId !== actor.connectionId ||
          storedApproval.gateClientId !== actor.gateClientId ||
          storedApproval.provenance !== approval.provenance ||
          storedApproval.requestDigest !== requestDigest)
      )
        throw new MemoryRepositoryError(
          'authorization_denied',
          'Persisted Forget approval is invalid',
        );
      if (prior.exists) return;
      // A new Forget applies only to a record the actor can currently see; an unknown, hidden or
      // already suppressed record reads as not found, so the request reveals nothing about it.
      const stored: unknown = current.data();
      if (
        suppression.exists ||
        !isMemoryRecord(stored) ||
        stored.suppressed ||
        !this.matchesStoredIdentity(actor, scopeId, recordId, stored) ||
        !containsOnly(stored.compartmentIds, actor.compartmentAllowance)
      ) {
        throw new MemoryRepositoryError('not_found', 'Record or controlled approval was not found');
      }
      const nextSequence = Number(sequence.get('sequence') ?? 0) + 1;
      // The deletion marker has no index work. A completed job keeps the per-scope job sequence
      // contiguous, so indexedThrough can advance past it instead of stalling at the marker.
      transaction.create(this.jobRef(actor, scopeId, nextSequence), {
        sequence: nextSequence,
        recordIds: [],
        revisions: [],
        status: 'complete',
        completedAt: new Date().toISOString(),
      });
      if (Number(indexState.get('indexedThrough') ?? 0) === nextSequence - 1) {
        transaction.set(this.indexStateRef(actor, scopeId), { indexedThrough: nextSequence });
      }
      transaction.set(this.suppressionRef(actor, scopeId, recordId), {
        deletionId: ledgerEntry.id,
      });
      transaction.create(this.forgetRequestRef(actor, scopeId, requestId), {
        ledgerEntry,
        requestDigest,
      });
      transaction.set(this.sequenceRef(actor, scopeId), { sequence: nextSequence });
      transaction.create(this.changeRef(actor, scopeId, nextSequence), {
        sequence: nextSequence,
        operation: 'deletion',
        recordIds: [],
        revisionNumbers: [],
        compartmentIds: [],
      });
      transaction.create(this.deletionIntentRef(actor, scopeId, ledgerEntry.id), {
        id: ledgerEntry.id,
        recordId,
        state: 'pending',
      });
    });
    try {
      if (!(await this.deletionLedger.includes(ledgerEntry.id)))
        await this.deletionLedger.append(ledgerEntry);
      if (!(await this.deletionLedger.includes(ledgerEntry.id)))
        return { status: 'pending', requestId };
      await this.applyLedgerSnapshot(actor, scopeId);
      return { status: 'stopped', requestId };
    } catch {
      return { status: 'pending', requestId };
    }
  }

  async purge(
    actor: VerifiedActorCapability,
    scopeId: string,
    deletionId: string,
  ): Promise<boolean> {
    assertActor(actor, scopeId);
    if (actor.actorKind !== 'worker')
      throw new MemoryRepositoryError('authorization_denied', 'Purge requires a worker');
    const authorization = await this.authorizationRef(actor, scopeId).get();
    this.assertCurrentAuthorization(
      actor,
      authorization.data() as AuthorizationDocument | undefined,
    );
    const intentRef = this.deletionIntentRef(actor, scopeId, deletionId);
    const intent = await intentRef.get();
    if (!intent.exists || !(await this.deletionLedger.includes(deletionId))) return false;
    const recordId = String(intent.get('recordId'));
    const recordRef = this.recordRef(actor, scopeId, recordId);
    await this.deleteSubcollections(recordRef);
    const searchEntries = await this.indexCollection(actor, scopeId)
      .where('recordId', '==', recordId)
      .get();
    for (const entry of searchEntries.docs) await entry.ref.delete();
    const jobs = await this.scopeRef(actor, scopeId)
      .collection('indexJobs')
      .where('recordIds', 'array-contains', recordId)
      .get();
    // Remove the forgotten record from queued jobs but keep each job, so the job sequence stays
    // contiguous and indexedThrough can still advance past it.
    for (const document of jobs.docs) {
      const revisions: unknown = document.get('revisions');
      await document.ref.update({
        recordIds: (document.get('recordIds') as string[]).filter((value) => value !== recordId),
        revisions: Array.isArray(revisions)
          ? revisions.filter((revision) => isObject(revision) && revision['recordId'] !== recordId)
          : [],
      });
    }
    await recordRef.delete();
    const remaining = await recordRef.collection('revisions').limit(1).get();
    if (
      !remaining.empty ||
      (await recordRef.get()).exists ||
      (await recordRef.listCollections()).length > 0
    )
      return false;
    await intentRef.set({ id: deletionId, state: 'complete' });
    return true;
  }

  async reconcileRestore(actor: VerifiedActorCapability, scopeId: string): Promise<number> {
    assertActor(actor, scopeId);
    if (actor.actorKind !== 'worker')
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Restore reconciliation requires a worker',
      );
    const authorization = await this.authorizationRef(actor, scopeId).get();
    this.assertCurrentAuthorization(
      actor,
      authorization.data() as AuthorizationDocument | undefined,
    );
    return this.applyLedgerSnapshot(actor, scopeId);
  }

  /**
   * Whether the scope's restore checkpoint matches the deletion-ledger head. A ledger that cannot
   * be read throws instead of reporting readiness.
   */
  async isRestoreReady(actor: VerifiedActorCapability, scopeId: string): Promise<boolean> {
    assertActor(actor, scopeId);
    try {
      await this.assertRestoreReady(actor, scopeId);
      return true;
    } catch (error) {
      if (error instanceof MemoryRepositoryError) return false;
      throw error;
    }
  }

  /** Deletion IDs whose Forget is recorded but whose stored data is not purged yet. */
  async listPendingDeletions(
    actor: VerifiedActorCapability,
    scopeId: string,
    limit = 20,
  ): Promise<string[]> {
    assertActor(actor, scopeId);
    if (actor.actorKind !== 'worker')
      throw new MemoryRepositoryError('authorization_denied', 'Purge requires a worker');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid deletion page size');
    const [authorization, intents] = await Promise.all([
      this.authorizationRef(actor, scopeId).get(),
      this.scopeRef(actor, scopeId)
        .collection('deletionIntents')
        .where('state', '==', 'pending')
        .limit(limit)
        .get(),
    ]);
    this.assertCurrentAuthorization(
      actor,
      authorization.data() as AuthorizationDocument | undefined,
    );
    return intents.docs.map((document) => String(document.get('id'))).filter(nonempty);
  }

  /**
   * Persists the controlled approval that an approval policy granted to this person actor. Only
   * the policy path may call it: the actor must carry a `policy` approval for one exact request
   * digest. Recording the same approval again is a no-op; a different request under the same
   * approval ID conflicts.
   */
  async recordPolicyApproval(actor: VerifiedActorCapability, scopeId: string): Promise<void> {
    assertActor(actor, scopeId);
    const approval = actor.protectedChangeApproval;
    if (actor.actorKind !== 'person' || !approval || approval.provenance !== 'policy') {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Only a person actor with a policy approval can record it',
      );
    }
    const document: ProtectedApprovalDocument = {
      principalId: actor.principalId,
      connectionId: actor.connectionId,
      gateClientId: actor.gateClientId,
      provenance: approval.provenance,
      protectedChangeId: approval.protectedChangeId,
      requestDigest: approval.requestDigest,
    };
    const ref = this.protectedApprovalRef(actor, scopeId, approval.protectedChangeId);
    await this.firestore.runTransaction(async (transaction) => {
      const [authorization, existing] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        transaction.get(ref),
      ]);
      this.assertCurrentAuthorization(
        actor,
        authorization.data() as AuthorizationDocument | undefined,
      );
      if (existing.exists) {
        const stored = existing.data() as Partial<ProtectedApprovalDocument>;
        const same = (Object.keys(document) as Array<keyof ProtectedApprovalDocument>).every(
          (key) => stored[key] === document[key],
        );
        if (!same) {
          throw new MemoryRepositoryError(
            'idempotency_conflict',
            'The approval was already recorded for a different request',
          );
        }
        return;
      }
      transaction.create(ref, { ...document, approvedAt: new Date().toISOString() });
    });
  }

  /**
   * Pins the recorded time of one idempotent request, so a retry with the same key rebuilds the
   * same change set and replays instead of conflicting. Stores only the input digest and the
   * time, never content. A different input under the same key conflicts.
   */
  async pinRequest(
    actor: VerifiedActorCapability,
    scopeId: string,
    idempotencyKey: string,
    inputDigest: string,
    proposedRecordedAt: string,
  ): Promise<{ readonly recordedAt: string; readonly replayed: boolean }> {
    assertActor(actor, scopeId);
    if (
      !nonempty(idempotencyKey) ||
      !/^[a-f0-9]{64}$/u.test(inputDigest) ||
      !Number.isFinite(Date.parse(proposedRecordedAt))
    ) {
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid request pin');
    }
    const ref = this.scopeRef(actor, scopeId)
      .collection('requestPins')
      .doc(digest([actor.principalId, idempotencyKey]));
    return this.firestore.runTransaction(async (transaction) => {
      const [authorization, existing] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        transaction.get(ref),
      ]);
      this.assertCurrentAuthorization(
        actor,
        authorization.data() as AuthorizationDocument | undefined,
      );
      if (existing.exists) {
        const recordedAt: unknown = existing.get('recordedAt');
        if (existing.get('inputDigest') !== inputDigest || typeof recordedAt !== 'string') {
          throw new MemoryRepositoryError(
            'idempotency_conflict',
            'Idempotency key was used for a different request',
          );
        }
        return { recordedAt, replayed: true };
      }
      transaction.create(ref, { inputDigest, recordedAt: proposedRecordedAt });
      return { recordedAt: proposedRecordedAt, replayed: false };
    });
  }

  /**
   * Reads one record's latest state and revision history, including an AI proposal, under the
   * same identity, allowance, suppression and source-rights checks as current reads. Revisions
   * outside the allowance or with a revoked source are withheld and counted.
   */
  async getRecordHistory(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
    validAt = new Date().toISOString(),
  ): Promise<RecordHistory | null> {
    assertActor(actor, scopeId);
    await this.assertRestoreReady(actor, scopeId);
    if (!nonempty(recordId) || !Number.isFinite(Date.parse(validAt)))
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid record ID or time');
    return this.firestore.runTransaction(async (transaction) => {
      const auth = await transaction.get(this.authorizationRef(actor, scopeId));
      const authorization = this.assertCurrentAuthorization(
        actor,
        auth.data() as AuthorizationDocument | undefined,
      );
      const ref = this.recordRef(actor, scopeId, recordId);
      const [current, suppression, history] = await Promise.all([
        transaction.get(ref),
        transaction.get(this.suppressionRef(actor, scopeId, recordId)),
        transaction.get(ref.collection('revisions')),
      ]);
      if (suppression.exists || !current.exists) return null;
      const latest: unknown = current.data();
      if (
        !isMemoryRecord(latest) ||
        latest.suppressed ||
        !this.matchesStoredIdentity(actor, scopeId, recordId, latest) ||
        !containsOnly(latest.compartmentIds, actor.compartmentAllowance)
      )
        return null;
      this.assertSourceRights(latest, authorization);
      const records: MemoryRecord[] = [];
      for (const snapshot of history.docs) {
        const stored: unknown = snapshot.data();
        if (
          !isMemoryRecord(stored) ||
          !this.matchesStoredIdentity(actor, scopeId, recordId, stored) ||
          snapshot.id !== String(stored.revision.revision)
        ) {
          throw new MemoryRepositoryError('conflict', 'Stored revision has an unsupported shape');
        }
        records.push(stored);
      }
      records.sort((left, right) => left.revision.revision - right.revision.revision);
      if (
        records.length !== latest.revision.revision ||
        records.some((record, index) => record.revision.revision !== index + 1)
      ) {
        throw new MemoryRepositoryError('conflict', 'Stored revision history is incomplete');
      }
      let currentView: MemoryRecord | null;
      try {
        currentView = selectCurrentView(records, validAt);
      } catch {
        throw new MemoryRepositoryError('conflict', 'Stored revision history is inconsistent');
      }
      const visible = records.filter(
        (record) =>
          containsOnly(record.compartmentIds, actor.compartmentAllowance) &&
          !this.hasRevokedSource(record, authorization),
      );
      return {
        latest,
        current: currentView,
        revisions: visible,
        withheldRevisions: records.length - visible.length,
      };
    });
  }

  /** A cheap read that fails when the database cannot be reached. */
  async checkAvailable(): Promise<void> {
    await this.firestore.collection(MEMORY_AUTHORIZATION_COLLECTION).limit(1).get();
  }

  private async applyLedgerSnapshot(
    actor: VerifiedActorCapability,
    scopeId: string,
  ): Promise<number> {
    const snapshot = await this.deletionLedger.snapshot();
    if (
      !Number.isSafeInteger(snapshot.head) ||
      snapshot.head < 0 ||
      snapshot.entries.length < snapshot.head
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Deletion ledger snapshot is incomplete',
      );
    }
    if (
      snapshot.entries.some(
        (entry) =>
          !nonempty(entry.id) ||
          !nonempty(entry.tenantId) ||
          !nonempty(entry.scopeId) ||
          !nonempty(entry.recordId),
      )
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Deletion ledger contains an invalid entry',
      );
    }
    for (const entry of snapshot.entries) {
      if (
        entry.tenantId !== actor.tenantId ||
        entry.scopeId !== scopeId ||
        !nonempty(entry.recordId) ||
        !nonempty(entry.id)
      )
        continue;
      await this.firestore.runTransaction(async (transaction) => {
        const [suppression, intent] = await Promise.all([
          transaction.get(this.suppressionRef(actor, scopeId, entry.recordId)),
          transaction.get(this.deletionIntentRef(actor, scopeId, entry.id)),
        ]);
        if (!suppression.exists)
          transaction.set(this.suppressionRef(actor, scopeId, entry.recordId), {
            deletionId: entry.id,
          });
        if (!intent.exists)
          transaction.set(this.deletionIntentRef(actor, scopeId, entry.id), {
            id: entry.id,
            recordId: entry.recordId,
            state: 'pending',
          });
      });
    }
    const currentHead = await this.deletionLedger.head();
    if (currentHead !== snapshot.head) return this.applyLedgerSnapshot(actor, scopeId);
    await this.scopeRef(actor, scopeId)
      .collection('management')
      .doc('ledgerCheckpoint')
      .set({ head: snapshot.head });
    return snapshot.head;
  }

  private async assertRestoreReady(actor: VerifiedActorCapability, scopeId: string): Promise<void> {
    const [head, checkpoint] = await Promise.all([
      this.deletionLedger.head(),
      this.scopeRef(actor, scopeId).collection('management').doc('ledgerCheckpoint').get(),
    ]);
    if ((checkpoint.get('head') ?? 0) !== head) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Deletion ledger restore barrier is not satisfied',
      );
    }
  }

  private async deleteSubcollections(reference: DocumentReference): Promise<void> {
    for (const collection of await reference.listCollections()) {
      while (true) {
        const page = await collection.limit(400).get();
        if (page.empty) break;
        for (const document of page.docs) await this.deleteSubcollections(document.ref);
        const batch = this.firestore.batch();
        page.docs.forEach((document) => batch.delete(document.ref));
        await batch.commit();
      }
    }
  }

  async commit(actor: VerifiedActorCapability, changeSet: CommitChangeSet): Promise<CommitReceipt> {
    const receipt = await this.commitChangeSet(actor, changeSet, false);
    if (!receipt) throw new Error('A new commit did not return a receipt');
    return receipt;
  }

  async replayCommittedChangeSet(
    actor: VerifiedActorCapability,
    changeSet: CommitChangeSet,
  ): Promise<CommitReceipt | null> {
    return this.commitChangeSet(actor, changeSet, true);
  }

  private async commitChangeSet(
    actor: VerifiedActorCapability,
    changeSet: CommitChangeSet,
    replayOnly: boolean,
  ): Promise<CommitReceipt | null> {
    assertActor(actor, changeSet.scopeId);
    await this.assertRestoreReady(actor, changeSet.scopeId);
    this.validateChangeSet(actor, changeSet);
    const requestDigest = memoryChangeDigest(changeSet.scopeId, changeSet.changes);
    const affectedIds = recordIds(changeSet.changes);
    const authRef = this.authorizationRef(actor, changeSet.scopeId);
    const idemRef = this.idempotencyRef(actor, changeSet.scopeId, changeSet.idempotencyKey);
    const sequenceRef = this.sequenceRef(actor, changeSet.scopeId);
    const approvalIds = sortedUnique(
      changeSet.changes
        .flatMap((change) => recordsOf(change))
        .filter((record) => record.revision.approval.status === 'approved')
        .map((record) => record.revision.approval.protectedChangeId!)
        .filter(nonempty),
    );
    const approvalRefs = approvalIds.map((approvalId) =>
      this.protectedApprovalRef(actor, changeSet.scopeId, approvalId),
    );
    const committedAt = new Date().toISOString();

    return this.firestore.runTransaction(async (transaction) => {
      const authorizationSnapshot = await transaction.get(authRef);
      const authorization = this.assertCurrentAuthorization(
        actor,
        authorizationSnapshot.data() as AuthorizationDocument | undefined,
      );

      const idempotencySnapshot = await transaction.get(idemRef);
      const currentRefs = affectedIds.map((recordId) =>
        this.recordRef(actor, changeSet.scopeId, recordId),
      );
      const currentSnapshots = await Promise.all(currentRefs.map((ref) => transaction.get(ref)));
      const suppressionRefs = affectedIds.map((recordId) =>
        this.suppressionRef(actor, changeSet.scopeId, recordId),
      );
      const suppressionSnapshots = await Promise.all(
        suppressionRefs.map((ref) => transaction.get(ref)),
      );
      const sequenceSnapshot = await transaction.get(sequenceRef);
      const approvalSnapshots = await Promise.all(approvalRefs.map((ref) => transaction.get(ref)));
      const approvals = new Map<string, ProtectedApprovalDocument | undefined>();
      approvalIds.forEach((approvalId, index) => {
        const snapshot = approvalSnapshots[index];
        approvals.set(
          approvalId,
          snapshot?.exists ? (snapshot.data() as ProtectedApprovalDocument) : undefined,
        );
      });

      if (idempotencySnapshot.exists) {
        const stored = idempotencySnapshot.data() as IdempotencyDocument;
        if (stored.digest !== requestDigest) {
          throw new MemoryRepositoryError(
            'idempotency_conflict',
            'Idempotency key was used for a different request',
          );
        }
        this.assertReplayDisclosure(
          affectedIds,
          currentSnapshots,
          suppressionSnapshots,
          actor,
          changeSet.scopeId,
          authorization,
        );
        return { ...stored.receipt, replayed: true };
      }
      if (replayOnly) return null;

      const currentById = new Map<string, MemoryRecord | null>();
      affectedIds.forEach((recordId, index) => {
        const snapshot = currentSnapshots[index];
        const suppression = suppressionSnapshots[index];
        if (!snapshot || !suppression) throw new Error('Firestore transaction read mismatch');
        const current = snapshot.exists ? (snapshot.data() as MemoryRecord) : null;
        if (current !== null && !isMemoryRecord(current)) {
          throw new MemoryRepositoryError('conflict', 'Stored record has an unsupported shape');
        }
        if (current) this.assertStoredRecord(actor, changeSet.scopeId, recordId, current);
        if (suppression.exists || current?.suppressed) {
          throw new MemoryRepositoryError(
            'authorization_denied',
            'Suppressed records cannot be changed',
          );
        }
        if (current) this.assertSourceRights(current, authorization);
        currentById.set(recordId, current);
      });

      this.assertExpectedRevisions(changeSet.changes, currentById);
      for (const change of changeSet.changes) {
        for (const record of recordsOf(change)) {
          this.assertSourceRights(record, authorization);
          this.assertPersistedApproval(actor, record, approvals, requestDigest);
        }
        const target = change.kind === 'supersede' ? change.previous : change.record;
        const prior = currentById.get(target.id);
        if (prior) {
          this.assertExistingChangeAuthority(actor, change, prior, target);
          this.assertCompartmentChangeAuthority(actor, prior, target);
        }
        if (actor.actorKind !== 'person' && change.kind === 'corroborate') {
          if (!prior)
            throw new MemoryRepositoryError('conflict', 'Corroboration target does not exist');
          this.assertCorroborationOnly(actor, prior, change.record);
        }
      }
      await this.assertNoConflictingDecisions(transaction, actor, changeSet, currentById);

      const priorSequence = Number(sequenceSnapshot.get('sequence') ?? 0);
      if (!Number.isSafeInteger(priorSequence) || priorSequence < 0) {
        throw new MemoryRepositoryError('conflict', 'Invalid scope sequence state');
      }
      const sequence = priorSequence + 1;
      const receipt: Omit<CommitReceipt, 'replayed'> = { sequence, recordIds: affectedIds };
      const logRef = this.changeRef(actor, changeSet.scopeId, sequence);
      const jobRef = this.jobRef(actor, changeSet.scopeId, sequence);
      const revisionWrites: Array<{ ref: DocumentReference; record: MemoryRecord }> = [];
      const currentWrites: Array<{ ref: DocumentReference; record: MemoryRecord }> = [];

      for (const change of changeSet.changes) {
        for (const item of changeRecords(change)) {
          const record = this.withRequestingActor(item.record, actor);
          const ref = this.recordRef(actor, changeSet.scopeId, record.id);
          currentWrites.push({ ref, record });
          revisionWrites.push({
            ref: ref.collection('revisions').doc(String(record.revision.revision)),
            record,
          });
        }
      }

      for (const write of currentWrites) {
        if (write.record.revision.revision === 1) transaction.create(write.ref, write.record);
        else transaction.set(write.ref, write.record);
      }
      for (const write of revisionWrites) transaction.create(write.ref, write.record);
      transaction.set(sequenceRef, { sequence });
      transaction.create(logRef, {
        sequence,
        operation: changeSet.changes.length === 1 ? changeSet.changes[0]!.kind : 'batch',
        recordIds: affectedIds,
        revisionNumbers: revisionWrites.map(({ record }) => record.revision.revision),
        compartmentIds: sortedUnique(changeSet.changes.flatMap(labelsOf)),
        createdAt: committedAt,
      });
      transaction.create(jobRef, {
        sequence,
        recordIds: affectedIds,
        revisions: revisionWrites.map(({ record }) => ({
          recordId: record.id,
          revision: record.revision.revision,
        })),
        status: 'pending',
      });
      transaction.create(idemRef, { digest: requestDigest, receipt });
      return { ...receipt, replayed: false };
    });
  }

  async getCurrent(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
    validAt = new Date().toISOString(),
  ): Promise<MemoryRecord | null> {
    assertActor(actor, scopeId);
    await this.assertRestoreReady(actor, scopeId);
    if (!nonempty(recordId))
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid record ID');
    return this.firestore.runTransaction(async (transaction) => {
      const auth = await transaction.get(this.authorizationRef(actor, scopeId));
      const authorization = this.assertCurrentAuthorization(
        actor,
        auth.data() as AuthorizationDocument | undefined,
      );
      const [recordSnapshot, suppressionSnapshot] = await Promise.all([
        transaction.get(this.recordRef(actor, scopeId, recordId)),
        transaction.get(this.suppressionRef(actor, scopeId, recordId)),
      ]);
      if (suppressionSnapshot.exists || !recordSnapshot.exists) return null;
      const record = recordSnapshot.data() as MemoryRecord;
      if (!isMemoryRecord(record) || record.suppressed) return null;
      if (!this.matchesStoredIdentity(actor, scopeId, recordId, record)) return null;
      this.assertSourceRights(record, authorization);
      if (!containsOnly(record.compartmentIds, actor.compartmentAllowance)) return null;
      return selectCurrentView([record], validAt);
    });
  }

  async getHistorical(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
    knownAt: string,
    validAt: string,
  ): Promise<MemoryRecord | null> {
    assertActor(actor, scopeId);
    await this.assertRestoreReady(actor, scopeId);
    return this.firestore.runTransaction(async (transaction) => {
      const auth = await transaction.get(this.authorizationRef(actor, scopeId));
      const authorization = this.assertCurrentAuthorization(
        actor,
        auth.data() as AuthorizationDocument | undefined,
      );
      const ref = this.recordRef(actor, scopeId, recordId);
      const [current, suppression, history] = await Promise.all([
        transaction.get(ref),
        transaction.get(this.suppressionRef(actor, scopeId, recordId)),
        transaction.get(ref.collection('revisions')),
      ]);
      if (suppression.exists || !current.exists) return null;
      const currentRecord: unknown = current.data();
      if (!isMemoryRecord(currentRecord)) {
        throw new MemoryRepositoryError('conflict', 'Stored record has an unsupported shape');
      }
      if (!this.matchesStoredIdentity(actor, scopeId, recordId, currentRecord)) return null;
      const records = history.docs.map((snapshot) => snapshot.data() as MemoryRecord);
      if (records.some((record) => !isMemoryRecord(record))) {
        throw new MemoryRepositoryError('conflict', 'Stored revision has an unsupported shape');
      }
      if (
        history.docs.some(
          (snapshot, index) =>
            !this.matchesStoredIdentity(actor, scopeId, recordId, records[index]!) ||
            snapshot.id !== String(records[index]!.revision.revision),
        )
      )
        return null;
      records.sort((left, right) => left.revision.revision - right.revision.revision);
      const currentRevision = currentRecord.revision.revision;
      if (
        records.length !== currentRevision ||
        records.some((record, index) => record.revision.revision !== index + 1)
      ) {
        throw new MemoryRepositoryError('conflict', 'Stored revision history is incomplete');
      }
      const result = selectHistoricalView(records, knownAt, validAt);
      if (result) this.assertSourceRights(result, authorization);
      return result && containsOnly(result.compartmentIds, actor.compartmentAllowance)
        ? result
        : null;
    });
  }

  async getChanges(
    actor: VerifiedActorCapability,
    scopeId: string,
    cursor: string | null,
    pageSize = 50,
  ): Promise<ChangeFeedPage> {
    assertActor(actor, scopeId);
    await this.assertRestoreReady(actor, scopeId);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_FEED_PAGE) {
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid change-feed page size');
    }
    const allowanceDigest = digest(sortedUnique(actor.compartmentAllowance));
    const parsed = cursor === null ? null : decodeCursor(cursor, this.cursorSecret);
    if (
      parsed &&
      (parsed.scopeId !== scopeId ||
        parsed.principalId !== actor.principalId ||
        parsed.authorizationEpoch !== actor.authorizationEpoch ||
        parsed.allowanceDigest !== allowanceDigest)
    ) {
      throw new MemoryRepositoryError(
        'resync_required',
        'Change-feed cursor requires resynchronization',
      );
    }
    const after = parsed?.sequence ?? 0;

    return this.firestore.runTransaction(async (transaction) => {
      const auth = await transaction.get(this.authorizationRef(actor, scopeId));
      const authorization = this.assertCurrentAuthorization(
        actor,
        auth.data() as AuthorizationDocument | undefined,
      );
      const query: Query = this.changeCollection(actor, scopeId)
        .where('sequence', '>', after)
        .orderBy('sequence')
        .limit(pageSize + 1);
      const snapshot = await transaction.get(query);
      const hasMore = snapshot.docs.length > pageSize;
      const selected = snapshot.docs.slice(0, pageSize);
      const entries: ChangeFeedEntry[] = [];
      for (const document of selected) {
        const entry = document.data() as ChangeFeedEntry;
        if (!containsOnly(entry.compartmentIds, actor.compartmentAllowance)) continue;
        if (entry.operation === 'deletion' || entry.recordIds.length === 0) {
          entries.push(entry);
          continue;
        }
        const disclosure = await Promise.all(
          entry.recordIds.map(async (recordId, index) => {
            const recordRef = this.recordRef(actor, scopeId, recordId);
            const [record, suppression, revision] = await Promise.all([
              transaction.get(recordRef),
              transaction.get(this.suppressionRef(actor, scopeId, recordId)),
              entry.revisionNumbers[index] === undefined
                ? Promise.resolve(null)
                : transaction.get(
                    recordRef.collection('revisions').doc(String(entry.revisionNumbers[index])),
                  ),
            ]);
            if (!record.exists || suppression.exists) return false;
            const value = record.data() as MemoryRecord;
            const historical = revision?.exists ? (revision.data() as MemoryRecord) : value;
            if (
              !isMemoryRecord(value) ||
              !isMemoryRecord(historical) ||
              value.suppressed ||
              !containsOnly(value.compartmentIds, actor.compartmentAllowance) ||
              !containsOnly(historical.compartmentIds, actor.compartmentAllowance)
            )
              return false;
            try {
              this.assertSourceRights(value, authorization);
              this.assertSourceRights(historical, authorization);
              return true;
            } catch {
              return false;
            }
          }),
        );
        if (disclosure.every(Boolean)) entries.push(entry);
      }
      const lastSequence = selected.at(-1)?.get('sequence') as number | undefined;
      const nextSequence = lastSequence ?? after;
      return {
        entries,
        cursor: encodeCursor(
          {
            version: 1,
            scopeId,
            principalId: actor.principalId,
            authorizationEpoch: actor.authorizationEpoch,
            allowanceDigest,
            sequence: nextSequence,
          },
          this.cursorSecret,
        ),
        hasMore,
      };
    });
  }

  private validateChangeSet(actor: VerifiedActorCapability, changeSet: CommitChangeSet): void {
    if (!nonempty(changeSet.scopeId) || !nonempty(changeSet.idempotencyKey)) {
      throw new MemoryRepositoryError(
        'invalid_change_set',
        'Scope and idempotency key are required',
      );
    }
    if (!Array.isArray(changeSet.changes) || changeSet.changes.length === 0) {
      throw new MemoryRepositoryError(
        'invalid_change_set',
        'A change set must contain at least one change',
      );
    }
    if (Buffer.byteLength(stableJson(changeSet), 'utf8') > MAX_CHANGE_SET_BYTES) {
      throw new MemoryRepositoryError(
        'change_set_too_large',
        'Change set exceeds the transaction byte limit',
      );
    }
    if (changeSet.changes.length > MAX_CHANGES) {
      throw new MemoryRepositoryError(
        'change_set_too_large',
        'Change set exceeds the transaction limit',
      );
    }
    const ids = new Set<string>();
    for (const change of changeSet.changes) {
      if (
        !['create', 'refine', 'corroborate', 'supersede', 'retract', 'contest'].includes(
          change.kind,
        )
      ) {
        throw new MemoryRepositoryError('invalid_change_set', 'Unsupported change operation');
      }
      for (const record of recordsOf(change)) {
        assertRecord(record, actor, changeSet.scopeId);
        this.assertChangeAuthority(actor, change.kind, record);
        if (ids.has(record.id))
          throw new MemoryRepositoryError(
            'invalid_change_set',
            'A record may appear only once per change set',
          );
        ids.add(record.id);
      }
      if (
        change.kind !== 'create' &&
        (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 1)
      ) {
        throw new MemoryRepositoryError('invalid_change_set', 'An expected revision is required');
      }
      if (change.kind === 'create' && change.record.revision.revision !== 1) {
        throw new MemoryRepositoryError(
          'invalid_change_set',
          'A created record must start at revision one',
        );
      }
      if (change.kind === 'create' && change.record.revision.changeKind !== 'create') {
        throw new MemoryRepositoryError(
          'invalid_change_set',
          'A created record must use a create revision',
        );
      }
      if (
        change.kind !== 'create' &&
        change.kind !== 'supersede' &&
        change.record.revision.changeKind !== change.kind
      ) {
        throw new MemoryRepositoryError(
          'invalid_change_set',
          'Change kind must match the revision',
        );
      }
      if (change.kind === 'supersede') {
        if (
          change.previous.id === change.replacement.id ||
          change.previous.revision.revision !== change.expectedRevision + 1 ||
          change.replacement.revision.revision !== 1 ||
          change.previous.lifecycle !== 'superseded' ||
          change.previous.revision.changeKind !== 'supersede' ||
          change.replacement.revision.changeKind !== 'create' ||
          change.previous.supersededBy !== change.replacement.id ||
          change.replacement.supersedes !== change.previous.id
        ) {
          throw new MemoryRepositoryError(
            'invalid_change_set',
            'Supersede records must preserve the value-model links',
          );
        }
      }
      if (change.kind === 'retract' && change.record.revision.changeKind !== 'retract') {
        throw new MemoryRepositoryError(
          'invalid_change_set',
          'Retraction must use a retract revision',
        );
      }
      if (change.kind === 'refine') {
        if (
          change.record.revision.writer.kind === 'ai' &&
          change.record.attribution.role === 'user'
        ) {
          throw new MemoryRepositoryError(
            'authorization_denied',
            'An AI cannot refine a user-attributed record',
          );
        }
      }
    }
  }

  private assertChangeAuthority(
    actor: VerifiedActorCapability,
    operation: MemoryChange['kind'],
    record: MemoryRecord,
  ): void {
    if (actor.actorKind !== 'person') {
      if (operation === 'corroborate') {
        if (
          record.revision.writer.kind !== 'ai' ||
          record.revision.writer.connectionId !== actor.connectionId ||
          record.lifecycle !== 'active' ||
          record.revision.approval.status !== 'none'
        ) {
          throw new MemoryRepositoryError(
            'authorization_denied',
            'AI corroboration must retain the active state without user authority',
          );
        }
        return;
      }
      if (
        record.revision.writer.kind !== 'ai' ||
        record.revision.writer.connectionId !== actor.connectionId ||
        record.lifecycle !== 'candidate' ||
        record.revision.approval.status !== 'none' ||
        operation === 'supersede' ||
        operation === 'retract'
      ) {
        throw new MemoryRepositoryError(
          'authorization_denied',
          'A non-person actor may only submit an unapproved AI candidate',
        );
      }
      return;
    }

    if (
      record.revision.writer.kind !== 'person' ||
      record.revision.writer.id !== actor.principalId
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Person changes must name the authenticated writer',
      );
    }
    const approval = record.revision.approval;
    if (approval.status === 'approved') {
      if (
        !actor.protectedChangeApproval ||
        approval.provenance !== actor.protectedChangeApproval.provenance ||
        approval.protectedChangeId !== actor.protectedChangeApproval.protectedChangeId
      ) {
        throw new MemoryRepositoryError(
          'authorization_denied',
          'Approval provenance must come from the controlled confirmation path',
        );
      }
    }
    if ((operation === 'supersede' || operation === 'retract') && approval.status !== 'approved') {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'This operation requires an approved protected change',
      );
    }
  }

  private assertCorroborationOnly(
    actor: VerifiedActorCapability,
    current: MemoryRecord,
    updated: MemoryRecord,
  ): void {
    const { revision: currentRevision, ...currentContent } = current;
    const { revision: updatedRevision, ...updatedContent } = updated;
    const priorSources = currentRevision.sourceReferences;
    const updatedSources = updatedRevision.sourceReferences;
    const sourceIdentity = (source: MemoryRecord['revision']['sourceReferences'][number]) =>
      `${source.provider}\u0000${source.accountOrTenant}\u0000${source.resourceId}`;
    const currentIdentities = priorSources.map(sourceIdentity);
    const updatedIdentities = updatedSources.map(sourceIdentity);
    if (
      stableJson(currentContent) !== stableJson(updatedContent) ||
      updatedRevision.revision !== currentRevision.revision + 1 ||
      updatedRevision.changeKind !== 'corroborate' ||
      updatedRevision.writer.kind !== 'ai' ||
      updatedRevision.writer.connectionId !== actor.connectionId ||
      updatedRevision.approval.status !== 'none' ||
      updatedIdentities.length <= currentIdentities.length ||
      new Set(updatedIdentities).size !== updatedIdentities.length ||
      currentIdentities.some((identity) => !updatedIdentities.includes(identity)) ||
      priorSources.some(
        (source) =>
          !updatedSources.some((candidate) => stableJson(candidate) === stableJson(source)),
      )
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'AI corroboration may add independent sources but cannot change record content',
      );
    }
  }

  private assertExpectedRevisions(
    changes: readonly MemoryChange[],
    currentById: Map<string, MemoryRecord | null>,
  ): void {
    for (const change of changes) {
      for (const item of changeRecords(change)) {
        const current = currentById.get(item.record.id) ?? null;
        if (item.expected === null) {
          if (current !== null)
            throw new MemoryRepositoryError('conflict', 'Record already exists');
        } else if (current === null) {
          throw new MemoryRepositoryError('authorization_denied', 'Record is unavailable');
        } else if (current.revision.revision !== item.expected) {
          throw new MemoryRepositoryError('conflict', 'Expected revision is stale');
        }
        if (current && item.record.revision.revision !== current.revision.revision + 1) {
          throw new MemoryRepositoryError('conflict', 'Revision number must increase by one');
        }
      }
    }
  }

  private async assertNoConflictingDecisions(
    transaction: FirebaseFirestore.Transaction,
    actor: VerifiedActorCapability,
    changeSet: CommitChangeSet,
    currentById: Map<string, MemoryRecord | null>,
  ): Promise<void> {
    const incoming = changeSet.changes
      .flatMap((change) => recordsOf(change))
      .filter((record) => record.kind === 'decision' && record.lifecycle === 'active');
    const incomingByKey = new Map<string, MemoryRecord[]>();
    let decisionChecks = 0;
    for (const record of incoming) {
      const question = record.details.kind === 'decision' ? record.details.question : '';
      for (const subjectId of record.subjectIds) {
        decisionChecks += 1;
        if (decisionChecks > MAX_DECISION_CHECKS) {
          throw new MemoryRepositoryError(
            'change_set_too_large',
            'Decision conflict check exceeds its bound',
          );
        }
        const key = `${subjectId}\u0000${question}`;
        const competingIncoming = incomingByKey.get(key) ?? [];
        if (competingIncoming.some((existing) => intervalsOverlap(existing.valid, record.valid))) {
          throw new MemoryRepositoryError(
            'conflict',
            'Change set contains competing active decisions',
          );
        }
        competingIncoming.push(record);
        incomingByKey.set(key, competingIncoming);
        const query = this.recordCollection(actor, changeSet.scopeId)
          .where('subjectIds', 'array-contains', subjectId)
          .limit(MAX_DECISION_CANDIDATES + 1)
          .select(
            'id',
            'kind',
            'lifecycle',
            'suppressed',
            'subjectIds',
            'details.kind',
            'details.question',
            'valid',
            'compartmentIds',
          );
        const candidates = await transaction.get(query);
        if (candidates.size > MAX_DECISION_CANDIDATES) {
          throw new MemoryRepositoryError(
            'change_set_too_large',
            'Decision conflict check exceeds its bound',
          );
        }
        for (const candidate of candidates.docs) {
          const existing: unknown = candidate.data();
          if (!isDecisionCandidateMetadata(existing)) {
            throw new MemoryRepositoryError(
              'conflict',
              'Decision conflict index has an unsupported shape',
            );
          }
          if (
            existing.id === record.id ||
            currentById.has(existing.id) ||
            existing.kind !== 'decision' ||
            existing.lifecycle !== 'active' ||
            existing.suppressed ||
            existing.details.kind !== 'decision' ||
            existing.details.question !== question ||
            !existing.subjectIds.includes(subjectId) ||
            !containsOnly(existing.compartmentIds, actor.compartmentAllowance)
          )
            continue;
          if (intervalsOverlap(existing.valid, record.valid)) {
            throw new MemoryRepositoryError(
              'conflict',
              'An active decision already exists for this subject and question',
            );
          }
        }
      }
    }
  }

  private assertCurrentAuthorization(
    actor: VerifiedActorCapability,
    document: AuthorizationDocument | undefined,
  ): AuthorizationDocument {
    if (!document || document.active !== true) {
      throw new MemoryRepositoryError('authorization_denied', 'Actor authorization is unavailable');
    }
    if (
      document.tenantId !== actor.tenantId ||
      document.principalId !== actor.principalId ||
      document.actorKind !== actor.actorKind ||
      document.connectionId !== actor.connectionId ||
      document.gateClientId !== actor.gateClientId ||
      document.authorizationEpoch !== actor.authorizationEpoch ||
      !Array.isArray(document.compartmentAllowance) ||
      !sameStrings(document.compartmentAllowance, actor.compartmentAllowance) ||
      !Array.isArray(document.revokedSourceReferences) ||
      !document.revokedSourceReferences.every(nonempty)
    ) {
      throw new MemoryRepositoryError('stale_authorization', 'Actor authorization has changed');
    }
    return document;
  }

  private assertReplayDisclosure(
    affectedIds: readonly string[],
    currentSnapshots: readonly DocumentSnapshot[],
    suppressionSnapshots: readonly DocumentSnapshot[],
    actor: VerifiedActorCapability,
    scopeId: string,
    authorization: AuthorizationDocument,
  ): void {
    affectedIds.forEach((recordId, index) => {
      const current = currentSnapshots[index];
      const suppression = suppressionSnapshots[index];
      if (!current || !suppression || suppression.exists || !current.exists) {
        throw new MemoryRepositoryError(
          'authorization_denied',
          'Stored response is no longer disclosable',
        );
      }
      const record = current.data() as MemoryRecord;
      if (
        !isMemoryRecord(record) ||
        record.suppressed ||
        record.id !== recordId ||
        record.tenantId !== actor.tenantId ||
        record.scopeId !== scopeId ||
        !containsOnly(record.compartmentIds, actor.compartmentAllowance)
      ) {
        throw new MemoryRepositoryError(
          'authorization_denied',
          'Stored response is no longer disclosable',
        );
      }
      this.assertSourceRights(record, authorization);
    });
  }

  private assertStoredRecord(
    actor: VerifiedActorCapability,
    scopeId: string,
    documentId: string,
    record: MemoryRecord,
  ): void {
    if (
      !this.matchesStoredIdentity(actor, scopeId, documentId, record) ||
      !containsOnly(record.compartmentIds, actor.compartmentAllowance)
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'The stored record is outside the actor identity or compartment allowance',
      );
    }
  }

  private matchesStoredIdentity(
    actor: VerifiedActorCapability,
    scopeId: string,
    documentId: string,
    record: MemoryRecord,
  ): boolean {
    return (
      record.id === documentId && record.tenantId === actor.tenantId && record.scopeId === scopeId
    );
  }

  private assertExistingChangeAuthority(
    actor: VerifiedActorCapability,
    change: MemoryChange,
    current: MemoryRecord,
    updated: MemoryRecord,
  ): void {
    if (actor.actorKind === 'person') return;
    if (change.kind === 'corroborate') return;
    if (
      change.kind === 'supersede' ||
      change.kind === 'retract' ||
      current.lifecycle !== 'candidate' ||
      current.revision.approval.status !== 'none' ||
      current.revision.writer.kind !== 'ai' ||
      current.revision.writer.connectionId !== actor.connectionId
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'A connection may change only its own unapproved candidate',
      );
    }
    if (
      change.kind === 'refine' &&
      (updated.id !== current.id ||
        updated.tenantId !== current.tenantId ||
        updated.scopeId !== current.scopeId ||
        updated.kind !== current.kind ||
        stableJson(updated.attribution) !== stableJson(current.attribution))
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'A connection cannot rewrite stored identity, kind or attribution',
      );
    }
  }

  private assertCompartmentChangeAuthority(
    actor: VerifiedActorCapability,
    current: MemoryRecord,
    updated: MemoryRecord,
  ): void {
    const relaxesLabel = current.compartmentIds.some(
      (compartmentId) => !updated.compartmentIds.includes(compartmentId),
    );
    if (
      relaxesLabel &&
      (actor.actorKind !== 'person' || updated.revision.approval.status !== 'approved')
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Removing a compartment requires an approved protected change',
      );
    }
  }

  private assertSourceRights(record: MemoryRecord, authorization: AuthorizationDocument): void {
    if (this.hasRevokedSource(record, authorization)) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'A source right no longer permits this record',
      );
    }
  }

  private hasRevokedSource(record: MemoryRecord, authorization: AuthorizationDocument): boolean {
    const revoked = new Set(authorization.revokedSourceReferences);
    return record.revision.sourceReferences.some((source) =>
      revoked.has(`${source.provider}\u0000${source.accountOrTenant}\u0000${source.resourceId}`),
    );
  }

  private assertPersistedApproval(
    actor: VerifiedActorCapability,
    record: MemoryRecord,
    approvals: Map<string, ProtectedApprovalDocument | undefined>,
    requestDigest: string,
  ): void {
    const approval = record.revision.approval;
    if (approval.status !== 'approved') return;
    const supplied = actor.protectedChangeApproval;
    const persisted = approval.protectedChangeId
      ? approvals.get(approval.protectedChangeId)
      : undefined;
    if (
      !supplied ||
      !persisted ||
      supplied.provenance !== approval.provenance ||
      supplied.protectedChangeId !== approval.protectedChangeId ||
      persisted.principalId !== actor.principalId ||
      persisted.connectionId !== actor.connectionId ||
      persisted.gateClientId !== actor.gateClientId ||
      persisted.provenance !== supplied.provenance ||
      persisted.protectedChangeId !== supplied.protectedChangeId ||
      supplied.requestDigest !== requestDigest ||
      persisted.requestDigest !== supplied.requestDigest
    ) {
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Approval provenance must match a current controlled approval record',
      );
    }
  }

  private withRequestingActor(record: MemoryRecord, actor: VerifiedActorCapability): MemoryRecord {
    return {
      ...record,
      revision: {
        ...record.revision,
        requestingConnectionId: actor.connectionId,
        gateClientId: actor.gateClientId,
      },
    };
  }

  private authorizationRef(actor: VerifiedActorCapability, scopeId: string): DocumentReference {
    return this.firestore
      .collection(MEMORY_AUTHORIZATION_COLLECTION)
      .doc(authorizationDocumentId(actor.tenantId, actor.principalId, scopeId));
  }

  private scopeRef(actor: VerifiedActorCapability, scopeId: string): DocumentReference {
    return this.firestore
      .collection('memoryTenants')
      .doc(id(actor.tenantId))
      .collection('scopes')
      .doc(id(scopeId));
  }

  private recordCollection(actor: VerifiedActorCapability, scopeId: string) {
    return this.scopeRef(actor, scopeId).collection('records');
  }

  private indexCollection(actor: VerifiedActorCapability, scopeId: string) {
    return this.scopeRef(actor, scopeId).collection('searchIndex');
  }

  private indexEntryRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
    revision: number,
  ): DocumentReference {
    return this.indexCollection(actor, scopeId).doc(this.indexEntryId(recordId, revision));
  }

  private indexEntryId(recordId: string, revision: number): string {
    return id(`${recordId}\u0000${revision}`);
  }

  private indexStateRef(actor: VerifiedActorCapability, scopeId: string): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('metadata').doc('indexState');
  }

  private recordRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
  ): DocumentReference {
    return this.recordCollection(actor, scopeId).doc(id(recordId));
  }

  private suppressionRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    recordId: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('suppressions').doc(id(recordId));
  }

  private forgetRequestRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    requestId: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId)
      .collection('forgetRequests')
      .doc(digest([actor.principalId, requestId]));
  }

  private deletionIntentRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    deletionId: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('deletionIntents').doc(id(deletionId));
  }

  private sequenceRef(actor: VerifiedActorCapability, scopeId: string): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('management').doc('sequence');
  }

  private protectedApprovalRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    protectedChangeId: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('approvals').doc(id(protectedChangeId));
  }

  private changeCollection(actor: VerifiedActorCapability, scopeId: string) {
    return this.scopeRef(actor, scopeId).collection('changes');
  }

  private changeRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    sequence: number,
  ): DocumentReference {
    return this.changeCollection(actor, scopeId).doc(String(sequence).padStart(16, '0'));
  }

  private jobRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    sequence: number,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId)
      .collection('indexJobs')
      .doc(String(sequence).padStart(16, '0'));
  }

  private idempotencyRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    key: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId)
      .collection('idempotency')
      .doc(digest([actor.principalId, key]));
  }

  private captureJobRef(actor: VerifiedActorCapability, scopeId: string, jobId: string) {
    return this.scopeRef(actor, scopeId)
      .collection('captureJobs')
      .doc(digest([actor.principalId, jobId]));
  }
}

function sourceReferenceKey(source: import('./index.js').SourceReference): string {
  return `${source.provider}\u0000${source.accountOrTenant}\u0000${source.resourceId}`;
}

function authorityRank(record: MemoryRecord): number {
  return deriveAuthority({
    writer: record.revision.writer,
    protectedChange: record.revision.approval.status === 'approved',
    approval: record.revision.approval,
  }) === 'user'
    ? 1
    : 0;
}

export function createFirestoreMemoryRecordRepository(options: {
  projectId: string;
  cursorSecret: Uint8Array;
  databaseId?: string;
  deletionLedger: DeletionLedger;
}): FirestoreMemoryRecordRepository {
  if (!nonempty(options.projectId)) throw new TypeError('Firestore project ID is required');
  if (!options.deletionLedger) throw new TypeError('An independent deletion ledger is required');
  return new FirestoreMemoryRecordRepository(
    createFirestoreClient({
      projectId: options.projectId,
      ...(options.databaseId === undefined ? {} : { databaseId: options.databaseId }),
    }),
    options.cursorSecret,
    options.deletionLedger,
  );
}

function intervalsOverlap(left: MemoryRecord['valid'], right: MemoryRecord['valid']): boolean {
  const leftFrom = left.from === null ? Number.NEGATIVE_INFINITY : Date.parse(left.from);
  const leftUntil = left.until === null ? Number.POSITIVE_INFINITY : Date.parse(left.until);
  const rightFrom = right.from === null ? Number.NEGATIVE_INFINITY : Date.parse(right.from);
  const rightUntil = right.until === null ? Number.POSITIVE_INFINITY : Date.parse(right.until);
  return leftFrom < rightUntil && rightFrom < leftUntil;
}
