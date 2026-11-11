export const memoryKinds = [
  'decision',
  'fact',
  'preference',
  'hypothesis',
  'experience',
  'procedure',
] as const;

export type MemoryKind = (typeof memoryKinds)[number];
export type Lifecycle = 'candidate' | 'active' | 'superseded' | 'retracted';
export type ApprovalProvenance = 'person' | 'policy';

export type KindDetails =
  | {
      kind: 'decision';
      question: string;
      choice: string;
      reason: string;
      decider: string;
      decisionTime: string;
      alternatives?: string[];
      reconsiderAt?: string;
    }
  | {
      kind: 'fact';
      subject: string;
      claim: string;
      speakerOrObserver?: string;
      observationTime?: string;
    }
  | {
      kind: 'preference';
      preferenceOwner: string;
      appliesWhere: string;
    }
  | {
      kind: 'hypothesis';
      hypothesis: string;
      assumptions: string[];
      verification: string;
    }
  | {
      kind: 'experience';
      condition: string;
      action: string;
      outcome: string;
      reusableWhere: string;
    }
  | {
      kind: 'procedure';
      purpose: string;
      prerequisites: string[];
      steps: string[];
      cautions: string[];
    };

export interface SourceReference {
  provider: string;
  accountOrTenant: string;
  resourceId: string;
  uri?: string;
  title?: string;
  locator?: string;
  version?: string;
  speaker?: string;
  eventTime?: string;
  rights?: string[];
  lineage?: string[];
}

export interface Attribution {
  speaker: string | null;
  role: 'user' | 'third-party' | 'ai' | 'unknown';
}

export type Writer =
  { kind: 'person'; id: string } | { kind: 'ai'; id: string; connectionId: string };

export interface Approval {
  status: 'none' | 'approved';
  provenance?: ApprovalProvenance;
  protectedChangeId?: string;
}

export interface ValidInterval {
  from: string | null;
  until: string | null;
}

export interface MemoryRevision {
  revision: number;
  changeKind: 'create' | 'refine' | 'corroborate' | 'supersede' | 'retract' | 'contest';
  reason: string;
  writer: Writer;
  approval: Approval;
  requestingConnectionId: string | null;
  gateClientId: string | null;
  recordedAt: string;
  sourceReferences: SourceReference[];
}

export interface MemoryRecord {
  id: string;
  tenantId: string;
  scopeId: string;
  schemaVersion: number;
  kind: MemoryKind;
  title: string;
  statement: string;
  details: KindDetails;
  subjectIds: string[];
  aliases: Array<{ value: string; from: string | null; until: string | null }>;
  assumptions: string[];
  attribution: Attribution;
  lifecycle: Lifecycle;
  contested: boolean;
  needsRecheck: boolean;
  suppressed: boolean;
  valid: ValidInterval;
  compartmentIds: string[];
  supersedes: string | null;
  supersededBy: string | null;
  revision: MemoryRevision;
}

export interface ChangeAuthorityInput {
  writer: Writer;
  protectedChange: boolean;
  approval: Approval;
}

export type DerivedAuthority = 'user' | 'proposal';

export function deriveAuthority(input: ChangeAuthorityInput): DerivedAuthority {
  if (
    input.protectedChange &&
    input.approval.status === 'approved' &&
    (input.approval.provenance === 'person' || input.approval.provenance === 'policy') &&
    typeof input.approval.protectedChangeId === 'string' &&
    input.approval.protectedChangeId.length > 0
  ) {
    return 'user';
  }
  return 'proposal';
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value['trim']().length > 0;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  const secondText = match[6];
  const offset = match[7];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined ||
    offset === undefined
  ) {
    return false;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }
  return true;
};

function validDetails(kind: MemoryKind, value: unknown): value is KindDetails {
  if (!isObject(value) || value['kind'] !== kind) return false;
  switch (kind) {
    case 'decision':
      return (
        hasOnlyKeys(value, [
          'kind',
          'question',
          'choice',
          'reason',
          'decider',
          'decisionTime',
          'alternatives',
          'reconsiderAt',
        ]) &&
        isNonEmptyString(value['question']) &&
        isNonEmptyString(value['choice']) &&
        isNonEmptyString(value['reason']) &&
        isNonEmptyString(value['decider']) &&
        isIsoDate(value['decisionTime']) &&
        (value['alternatives'] === undefined ||
          (Array.isArray(value['alternatives']) &&
            value['alternatives'].every(isNonEmptyString))) &&
        (value['reconsiderAt'] === undefined || isIsoDate(value['reconsiderAt']))
      );
    case 'fact':
      return (
        hasOnlyKeys(value, ['kind', 'subject', 'claim', 'speakerOrObserver', 'observationTime']) &&
        isNonEmptyString(value['subject']) &&
        isNonEmptyString(value['claim']) &&
        (value['speakerOrObserver'] === undefined ||
          isNonEmptyString(value['speakerOrObserver'])) &&
        (value['observationTime'] === undefined || isIsoDate(value['observationTime']))
      );
    case 'preference':
      return (
        hasOnlyKeys(value, ['kind', 'preferenceOwner', 'appliesWhere']) &&
        isNonEmptyString(value['preferenceOwner']) &&
        isNonEmptyString(value['appliesWhere'])
      );
    case 'hypothesis':
      return (
        hasOnlyKeys(value, ['kind', 'hypothesis', 'assumptions', 'verification']) &&
        isNonEmptyString(value['hypothesis']) &&
        Array.isArray(value['assumptions']) &&
        value['assumptions'].every(isNonEmptyString) &&
        isNonEmptyString(value['verification'])
      );
    case 'experience':
      return (
        hasOnlyKeys(value, ['kind', 'condition', 'action', 'outcome', 'reusableWhere']) &&
        isNonEmptyString(value['condition']) &&
        isNonEmptyString(value['action']) &&
        isNonEmptyString(value['outcome']) &&
        isNonEmptyString(value['reusableWhere'])
      );
    case 'procedure':
      return (
        hasOnlyKeys(value, ['kind', 'purpose', 'prerequisites', 'steps', 'cautions']) &&
        isNonEmptyString(value['purpose']) &&
        Array.isArray(value['prerequisites']) &&
        value['prerequisites'].every(isNonEmptyString) &&
        Array.isArray(value['steps']) &&
        value['steps'].length > 0 &&
        value['steps'].every(isNonEmptyString) &&
        Array.isArray(value['cautions']) &&
        value['cautions'].every(isNonEmptyString)
      );
  }
}

function validWriter(value: unknown): value is Writer {
  if (!isObject(value) || !isNonEmptyString(value['id'])) return false;
  if (value['kind'] === 'person') return hasOnlyKeys(value, ['kind', 'id']);
  return (
    value['kind'] === 'ai' &&
    hasOnlyKeys(value, ['kind', 'id', 'connectionId']) &&
    isNonEmptyString(value['connectionId'])
  );
}

function validApproval(value: unknown): value is Approval {
  if (!isObject(value)) return false;
  if (value['status'] === 'none') return hasOnlyKeys(value, ['status']);
  return (
    value['status'] === 'approved' &&
    hasOnlyKeys(value, ['status', 'provenance', 'protectedChangeId']) &&
    (value['provenance'] === 'person' || value['provenance'] === 'policy') &&
    isNonEmptyString(value['protectedChangeId'])
  );
}

const sourceReferenceKeys = [
  'provider',
  'accountOrTenant',
  'resourceId',
  'uri',
  'title',
  'locator',
  'version',
  'speaker',
  'eventTime',
  'rights',
  'lineage',
] as const;

function validSourceReference(value: unknown): value is SourceReference {
  if (!isObject(value)) return false;
  return (
    hasOnlyKeys(value, sourceReferenceKeys) &&
    isNonEmptyString(value['provider']) &&
    isNonEmptyString(value['accountOrTenant']) &&
    isNonEmptyString(value['resourceId']) &&
    (value['uri'] === undefined || isNonEmptyString(value['uri'])) &&
    (value['title'] === undefined ||
      (isNonEmptyString(value['title']) && value['title'].length <= 200)) &&
    (value['locator'] === undefined || isNonEmptyString(value['locator'])) &&
    (value['version'] === undefined || isNonEmptyString(value['version'])) &&
    (value['speaker'] === undefined || isNonEmptyString(value['speaker'])) &&
    (value['eventTime'] === undefined || isIsoDate(value['eventTime'])) &&
    (value['rights'] === undefined ||
      (Array.isArray(value['rights']) && value['rights'].every(isNonEmptyString))) &&
    (value['lineage'] === undefined ||
      (Array.isArray(value['lineage']) && value['lineage'].every(isNonEmptyString)))
  );
}

export function isSourceReference(value: unknown): value is SourceReference {
  return validSourceReference(value);
}

function validRevision(value: unknown): value is MemoryRevision {
  if (!isObject(value)) return false;
  return (
    hasOnlyKeys(value, [
      'revision',
      'changeKind',
      'reason',
      'writer',
      'approval',
      'requestingConnectionId',
      'gateClientId',
      'recordedAt',
      'sourceReferences',
    ]) &&
    Number.isSafeInteger(value['revision']) &&
    Number(value['revision']) > 0 &&
    ['create', 'refine', 'corroborate', 'supersede', 'retract', 'contest'].includes(
      String(value['changeKind']),
    ) &&
    isNonEmptyString(value['reason']) &&
    validWriter(value['writer']) &&
    validApproval(value['approval']) &&
    isNullableString(value['requestingConnectionId']) &&
    isNullableString(value['gateClientId']) &&
    isIsoDate(value['recordedAt']) &&
    Array.isArray(value['sourceReferences']) &&
    value['sourceReferences'].every(validSourceReference)
  );
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isObject(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'id',
      'tenantId',
      'scopeId',
      'schemaVersion',
      'kind',
      'title',
      'statement',
      'details',
      'subjectIds',
      'aliases',
      'assumptions',
      'attribution',
      'lifecycle',
      'contested',
      'needsRecheck',
      'suppressed',
      'valid',
      'compartmentIds',
      'supersedes',
      'supersededBy',
      'revision',
    ])
  ) {
    return false;
  }
  if (!memoryKinds.includes(value['kind'] as MemoryKind)) return false;
  const kind = value['kind'] as MemoryKind;
  return (
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['tenantId']) &&
    isNonEmptyString(value['scopeId']) &&
    Number.isSafeInteger(value['schemaVersion']) &&
    Number(value['schemaVersion']) > 0 &&
    isNonEmptyString(value['title']) &&
    isNonEmptyString(value['statement']) &&
    validDetails(kind, value['details']) &&
    Array.isArray(value['subjectIds']) &&
    value['subjectIds'].every(isNonEmptyString) &&
    Array.isArray(value['aliases']) &&
    value['aliases'].every(
      (alias) =>
        isObject(alias) &&
        hasOnlyKeys(alias, ['value', 'from', 'until']) &&
        isNonEmptyString(alias['value']) &&
        isNullableString(alias['from']) &&
        isNullableString(alias['until']) &&
        (alias['from'] === null || isIsoDate(alias['from'])) &&
        (alias['until'] === null || isIsoDate(alias['until'])),
    ) &&
    Array.isArray(value['assumptions']) &&
    value['assumptions'].every(isNonEmptyString) &&
    isObject(value['attribution']) &&
    hasOnlyKeys(value['attribution'], ['speaker', 'role']) &&
    (value['attribution']['speaker'] === null ||
      isNonEmptyString(value['attribution']['speaker'])) &&
    ['user', 'third-party', 'ai', 'unknown'].includes(String(value['attribution']['role'])) &&
    ['candidate', 'active', 'superseded', 'retracted'].includes(String(value['lifecycle'])) &&
    typeof value['contested'] === 'boolean' &&
    typeof value['needsRecheck'] === 'boolean' &&
    typeof value['suppressed'] === 'boolean' &&
    isObject(value['valid']) &&
    hasOnlyKeys(value['valid'], ['from', 'until']) &&
    isNullableString(value['valid']['from']) &&
    isNullableString(value['valid']['until']) &&
    (value['valid']['from'] === null || isIsoDate(value['valid']['from'])) &&
    (value['valid']['until'] === null || isIsoDate(value['valid']['until'])) &&
    Array.isArray(value['compartmentIds']) &&
    value['compartmentIds'].every(isNonEmptyString) &&
    isNullableString(value['supersedes']) &&
    isNullableString(value['supersededBy']) &&
    validRevision(value['revision'])
  );
}

export function assertMemoryRecord(value: unknown): asserts value is MemoryRecord {
  if (!isMemoryRecord(value)) throw new TypeError('Invalid Memory Record');
}

export {
  authorizationDocumentId,
  createFirestoreMemoryRecordRepository,
  FirestoreMemoryRecordRepository,
  MEMORY_AUTHORIZATION_COLLECTION,
  memoryForgetDigest,
  memoryChangeDigest,
  MemoryRepositoryError,
  type RecordHistory,
  type ChangeFeedEntry,
  type ChangeFeedPage,
  type CommitChangeSet,
  type CommitReceipt,
  type CaptureJob,
  type CaptureJobStatus,
  type IndexJob,
  type SearchIndexEntry,
  type RecallCandidateQuery,
  type RecallCandidateResult,
  type DeletionLedger,
  type DeletionLedgerEntry,
  type DeletionLedgerSnapshot,
  type ForgetResult,
  type MemoryChange,
  type VerifiedActorCapability,
} from './firestore-repository.js';
export {
  MemoryCaptureService,
  type AuthorizedSourceFetcher,
  type CaptureResult,
  type CitedSpan,
  type ExtractedMemoryProposal,
  type FetchedCaptureSource,
  type VersionedExtraction,
  type VersionedGenerativeExtractor,
} from './capture.js';
export {
  AccessDeniedError,
  admissionDocumentId,
  AUTOMATIC_APPROVAL_POLICY,
  isAccessIdentifier,
  MEMORY_ADMISSIONS_COLLECTION,
  MemoryAccess,
  type AccessDeniedCode,
  type ConnectionAccess,
  type GatePrincipal,
} from './access.js';
export {
  createFirestoreDeletionLedger,
  FirestoreDeletionLedger,
} from './firestore-deletion-ledger.js';
export {
  createMemoryRecordsRuntime,
  type MemoryRecordsRuntime,
  type MemoryRecordsRuntimeOptions,
} from './runtime.js';
export {
  MemoryService,
  MemoryServiceError,
  SERVICE_SOURCE_PROVIDER,
  type AccessView,
  type AliasInput,
  type Authority,
  type ChangesView,
  type CorrectInput,
  type CorrectionChanges,
  type ForgetInput,
  type ForgetView,
  type MemoryContentInput,
  type MemoryServiceErrorCode,
  type MemoryServiceOptions,
  type MemoryView,
  type RecallInput,
  type RecallView,
  type RememberInput,
  type WriteResult,
} from './service.js';
export {
  indexEntryFor,
  MemoryIndexWorker,
  MemoryRecallService,
  tokenizeSearchText,
  type ContextPack,
  type Embedding,
  type EmbeddingProvider,
  type RecallItem,
  type RecallQuery,
} from './derived-recall.js';
export {
  MIN_TERM_COVERAGE,
  SEARCH_TERMS_VERSION,
  termCoverage,
  type RecallMatchReason,
} from './search-terms.js';

export interface AuthorizedChange {
  writer: Writer;
  protectedChange: boolean;
  approval: Approval;
}

export interface SupersedeResult {
  previous: MemoryRecord;
  replacement: MemoryRecord;
}

export function applySupersede(
  previous: MemoryRecord,
  replacement: MemoryRecord,
  validStart: string,
  reason: string,
  recordedAt: string,
  change: AuthorizedChange,
): SupersedeResult {
  assertMemoryRecord(previous);
  assertMemoryRecord(replacement);
  if (!isIsoDate(validStart)) throw new TypeError('validStart must be an ISO date');
  if (!isNonEmptyString(reason) || !isIsoDate(recordedAt)) {
    throw new TypeError('Supersede reason and recordedAt are required');
  }
  if (deriveAuthority(change) !== 'user') throw new Error('Supersede requires user authority');
  if (change.writer.kind !== 'person') throw new Error('Supersede requires a person writer');
  if (previous.id === replacement.id) throw new Error('Supersede requires a new record');
  if (previous.valid.from !== null && Date.parse(validStart) <= Date.parse(previous.valid.from)) {
    throw new Error('Replacement must start after the previous valid start');
  }
  if (replacement.valid.from !== validStart)
    throw new Error('Replacement must start at validStart');
  const closed: MemoryRecord = {
    ...previous,
    lifecycle: 'superseded',
    valid: { ...previous.valid, until: validStart },
    supersededBy: replacement.id,
    revision: {
      ...previous.revision,
      revision: previous.revision.revision + 1,
      changeKind: 'supersede',
      reason,
      writer: change.writer,
      approval: change.approval,
      requestingConnectionId: null,
      gateClientId: previous.revision.gateClientId,
      recordedAt,
    },
  };
  const linked: MemoryRecord = {
    ...replacement,
    supersedes: previous.id,
  };
  return { previous: closed, replacement: linked };
}

export function applyRetract(
  record: MemoryRecord,
  reason: string,
  recordedAt: string,
  change: AuthorizedChange,
): MemoryRecord {
  assertMemoryRecord(record);
  if (!isNonEmptyString(reason)) throw new TypeError('Retraction reason is required');
  if (!isIsoDate(recordedAt)) throw new TypeError('recordedAt must be an ISO date');
  if (deriveAuthority(change) !== 'user') throw new Error('Retract requires user authority');
  if (change.writer.kind !== 'person') throw new Error('Retract requires a person writer');
  return {
    ...record,
    lifecycle: 'retracted',
    revision: {
      ...record.revision,
      revision: record.revision.revision + 1,
      changeKind: 'retract',
      reason,
      writer: change.writer,
      approval: change.approval,
      requestingConnectionId: null,
      gateClientId: record.revision.gateClientId,
      recordedAt,
    },
  };
}

export function selectHistoricalView(
  revisions: readonly MemoryRecord[],
  knownAt: string,
  validAt: string,
  options: { readonly includeProposals?: boolean } = {},
): MemoryRecord | null {
  if (!isIsoDate(knownAt) || !isIsoDate(validAt))
    throw new TypeError('History times must be ISO dates');
  const knowledgeCut = Date.parse(knownAt);
  const applicabilityCut = Date.parse(validAt);
  return selectAt(revisions, knowledgeCut, applicabilityCut, options);
}

export function selectCurrentView(
  revisions: readonly MemoryRecord[],
  validAt: string,
  options: { readonly includeProposals?: boolean } = {},
): MemoryRecord | null {
  if (!isIsoDate(validAt)) throw new TypeError('validAt must be an ISO date');
  return selectAt(revisions, Number.POSITIVE_INFINITY, Date.parse(validAt), options);
}

function selectAt(
  revisions: readonly MemoryRecord[],
  knowledgeCut: number,
  applicabilityCut: number,
  options: { readonly includeProposals?: boolean },
): MemoryRecord | null {
  for (const record of revisions) assertMemoryRecord(record);
  const first = revisions[0];
  if (first !== undefined) {
    const revisionNumbers = new Set<number>();
    let previousRecordedAt = Number.NEGATIVE_INFINITY;
    for (const record of [...revisions].sort(
      (left, right) => left.revision.revision - right.revision.revision,
    )) {
      if (
        record.id !== first.id ||
        record.tenantId !== first.tenantId ||
        record.scopeId !== first.scopeId
      ) {
        throw new TypeError('A revision series must belong to one record, tenant, and scope');
      }
      if (revisionNumbers.has(record.revision.revision)) {
        throw new TypeError('Revision numbers must be unique');
      }
      revisionNumbers.add(record.revision.revision);
      const recordedAt = Date.parse(record.revision.recordedAt);
      if (recordedAt < previousRecordedAt) {
        throw new TypeError('Recorded time must not move backwards across revisions');
      }
      previousRecordedAt = recordedAt;
    }
  }
  if (revisions.some((record) => record.suppressed)) return null;
  const latest = revisions
    .filter((record) => {
      return Date.parse(record.revision.recordedAt) <= knowledgeCut;
    })
    .reduce<MemoryRecord | null>(
      (best, record) =>
        best === null || record.revision.revision > best.revision.revision ? record : best,
      null,
    );
  if (
    latest === null ||
    latest.suppressed ||
    (latest.lifecycle === 'candidate' && options.includeProposals !== true) ||
    (options.includeProposals === false &&
      deriveAuthority({
        writer: latest.revision.writer,
        protectedChange: latest.revision.approval.status === 'approved',
        approval: latest.revision.approval,
      }) === 'proposal') ||
    latest.lifecycle === 'retracted'
  ) {
    return null;
  }
  const from =
    latest.valid.from === null ? Number.NEGATIVE_INFINITY : Date.parse(latest.valid.from);
  const until =
    latest.valid.until === null ? Number.POSITIVE_INFINITY : Date.parse(latest.valid.until);
  return applicabilityCut >= from && applicabilityCut < until ? latest : null;
}
