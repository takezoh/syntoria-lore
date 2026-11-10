import { createHash, randomBytes } from 'node:crypto';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { isMemoryRecord, isSourceReference, type MemoryRecord } from './index.js';
import { createFirestoreClient } from './firestore-client.js';
import { FirestoreDeletionLedger } from './firestore-deletion-ledger.js';
import {
  FirestoreMemoryRecordRepository,
  sourceMetadataMigrationApply,
  sourceMetadataMigrationDryRun,
  sourceMetadataMigrationManifestSha256,
  sourceMetadataMigrationVerify,
  type SourceMetadataMigrationAddition,
  type SourceMetadataMigrationEvidence,
  type SourceMetadataMigrationManifest,
  type SourceMetadataMigrationResult,
} from './firestore-repository.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

interface ReviewedPlanEntry {
  readonly recordId: string;
  readonly expectedRevision: number;
  readonly additions: readonly SourceMetadataMigrationAddition[];
}

interface ReviewedEvidence {
  readonly field: string;
  readonly revision: number;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly valueSha256: string;
}

interface SnapshotDocument {
  readonly path: string;
  readonly data: Record<string, unknown>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function dataHash(value: unknown): string {
  return sha256(stableJson(value));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validateEvidenceOffset(value: unknown): value is ReviewedEvidence {
  return (
    object(value) &&
    typeof value['field'] === 'string' &&
    ['uri', 'title', 'version', 'locator', 'rights'].includes(value['field']) &&
    Number.isSafeInteger(value['revision']) &&
    Number(value['revision']) > 0 &&
    Number.isSafeInteger(value['startUtf16']) &&
    Number(value['startUtf16']) >= 0 &&
    Number.isSafeInteger(value['endUtf16']) &&
    Number(value['endUtf16']) > Number(value['startUtf16']) &&
    typeof value['valueSha256'] === 'string' &&
    SHA256.test(value['valueSha256'])
  );
}

function listCollection(snapshot: unknown, collectionName: string): SnapshotDocument[] {
  if (!object(snapshot) || !object(snapshot['collections'])) {
    throw new TypeError('Snapshot has no collection map');
  }
  const matches = Object.entries(snapshot['collections']).filter(([key]) =>
    key.endsWith(`/${collectionName}`),
  );
  if (matches.length !== 1 || !Array.isArray(matches[0]?.[1])) {
    throw new TypeError(`Snapshot must contain exactly one ${collectionName} collection`);
  }
  return matches[0]![1].map((item: unknown) => {
    if (!object(item) || typeof item['path'] !== 'string' || !object(item['data'])) {
      throw new TypeError(`Snapshot contains an invalid ${collectionName} document`);
    }
    return { path: item['path'], data: item['data'] };
  });
}

function validateReviewedAddition(
  value: unknown,
  histories: ReadonlyMap<number, MemoryRecord>,
): SourceMetadataMigrationAddition {
  if (!object(value) || !isSourceReference(value['source']) || !Array.isArray(value['evidence'])) {
    throw new TypeError('Reviewed source addition or evidence is invalid');
  }
  const source = value['source'];
  if (
    source.provider !== 'google-drive' ||
    !source.uri ||
    Object.keys(source).some(
      (key) =>
        ![
          'provider',
          'accountOrTenant',
          'resourceId',
          'uri',
          'title',
          'locator',
          'version',
          'rights',
        ].includes(key),
    )
  ) {
    throw new TypeError('Reviewed source uses fields outside the migration contract');
  }
  let uri: URL;
  try {
    uri = new URL(source.uri);
  } catch {
    throw new TypeError('Reviewed source URI is invalid');
  }
  if (
    uri.protocol !== 'https:' ||
    !['docs.google.com', 'docs.example.test'].includes(uri.hostname) ||
    uri.search !== '' ||
    uri.hash !== '' ||
    !/^\/document\/d\/[A-Za-z0-9_-]+$/u.test(uri.pathname) ||
    source.accountOrTenant !== uri.host ||
    source.resourceId !== `uri_${sha256(source.uri)}` ||
    (source.rights !== undefined && stableJson(source.rights) !== stableJson(['confidential']))
  ) {
    throw new TypeError('Reviewed source does not follow the existing MCP source mapping');
  }
  const required = [
    'uri',
    ...(source.title === undefined ? [] : ['title']),
    ...(source.version === undefined ? [] : ['version']),
    ...(source.locator === undefined ? [] : ['locator']),
    ...(source.rights === undefined ? [] : ['rights']),
  ];
  const evidence = value['evidence'];
  if (
    evidence.length !== required.length ||
    evidence.some(
      (item: unknown) =>
        !object(item) ||
        !['uri', 'title', 'version', 'locator', 'rights'].includes(String(item['field'])) ||
        !validateEvidenceOffset(item),
    )
  ) {
    throw new TypeError('Reviewed source evidence must cover each supplied metadata field once');
  }
  const seen = new Set<string>();
  const normalized: SourceMetadataMigrationEvidence[] = [];
  for (const item of evidence) {
    if (!object(item)) throw new TypeError('Reviewed source evidence is invalid');
    const field = String(item['field']);
    if (seen.has(field) || !required.includes(field)) {
      throw new TypeError('Reviewed source evidence has duplicate or unneeded fields');
    }
    seen.add(field);
    const span = item as unknown as SourceMetadataMigrationEvidence;
    const record = histories.get(span.revision);
    const excerpt = record?.revision.reason.slice(span.startUtf16, span.endUtf16) ?? '';
    const expected =
      field === 'uri'
        ? source.uri
        : field === 'title'
          ? source.title
          : field === 'version'
            ? source.version
            : field === 'locator'
              ? source.locator
              : '機密';
    if (
      !excerpt ||
      sha256(excerpt) !== span.valueSha256 ||
      (field === 'rights' ? !excerpt.includes(expected ?? '') : excerpt !== expected)
    ) {
      throw new TypeError('Reviewed source evidence does not match stored reason text');
    }
    normalized.push({
      revision: span.revision,
      field: field as SourceMetadataMigrationEvidence['field'],
      startUtf16: span.startUtf16,
      endUtf16: span.endUtf16,
      valueSha256: span.valueSha256,
    });
  }
  if (!required.every((field) => seen.has(field))) {
    throw new TypeError('Reviewed source evidence is incomplete');
  }
  return { source, evidence: normalized };
}

/** Build an immutable manifest from an operator-reviewed source plan and the private read snapshot. */
export function prepareSourceMetadataMigration(
  snapshot: unknown,
  planInput: unknown,
  target: {
    readonly projectId: string;
    readonly databaseId: string;
    readonly deletionLedgerDatabaseId: string;
  },
  migrationId: string,
  recordedAt = new Date().toISOString(),
): SourceMetadataMigrationManifest {
  if (
    !isIdentifier(migrationId) ||
    !/^[a-z][a-z0-9-]{4,29}$/u.test(target.projectId) ||
    !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/u.test(target.databaseId) ||
    !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/u.test(target.deletionLedgerDatabaseId) ||
    typeof recordedAt !== 'string' ||
    !Number.isFinite(Date.parse(recordedAt))
  ) {
    throw new TypeError('Migration ID or pinned record time is invalid');
  }
  if (!object(planInput) || !Array.isArray(planInput['entries'])) {
    throw new TypeError('Reviewed source plan has no entries array');
  }
  const currentDocs = listCollection(snapshot, 'records');
  const revisionDocs = listCollection(snapshot, 'revisions');
  const indexDocs = listCollection(snapshot, 'searchIndex');
  const metadataDocs = listCollection(snapshot, 'metadata');
  const managementDocs = listCollection(snapshot, 'management');
  if (currentDocs.length !== 51 || revisionDocs.length !== 52 || indexDocs.length !== 52) {
    throw new TypeError('Private snapshot does not match the reviewed 51-record migration scope');
  }
  const records = new Map<string, MemoryRecord>();
  const tenantIds = new Set<string>();
  const scopeIds = new Set<string>();
  for (const document of currentDocs) {
    const record = document.data;
    if (!isMemoryRecord(record) || records.has(record.id)) {
      throw new TypeError('Snapshot current record is invalid or duplicated');
    }
    records.set(record.id, record);
    tenantIds.add(record.tenantId);
    scopeIds.add(record.scopeId);
  }
  if (tenantIds.size !== 1 || scopeIds.size !== 1) {
    throw new TypeError('Snapshot spans more than one tenant or scope');
  }
  const tenantId = [...tenantIds][0]!;
  const scopeId = [...scopeIds][0]!;
  const historyByRecord = new Map<string, Map<number, MemoryRecord>>();
  for (const document of revisionDocs) {
    const revision = document.data;
    if (!isMemoryRecord(revision) || !records.has(revision.id)) {
      throw new TypeError('Snapshot contains invalid or unrelated revision history');
    }
    const history = historyByRecord.get(revision.id) ?? new Map<number, MemoryRecord>();
    if (history.has(revision.revision.revision)) {
      throw new TypeError('Snapshot contains duplicate record revisions');
    }
    history.set(revision.revision.revision, revision);
    historyByRecord.set(revision.id, history);
  }
  const indexesByRecord = new Map<string, Map<number, Record<string, unknown>>>();
  for (const document of indexDocs) {
    const entry = document.data;
    if (
      typeof entry['recordId'] !== 'string' ||
      !Number.isSafeInteger(entry['revision']) ||
      !records.has(entry['recordId'])
    ) {
      throw new TypeError('Snapshot contains an invalid or unrelated search index');
    }
    const indexes =
      indexesByRecord.get(entry['recordId']) ?? new Map<number, Record<string, unknown>>();
    if (indexes.has(Number(entry['revision']))) {
      throw new TypeError('Snapshot contains duplicate search index revisions');
    }
    indexes.set(Number(entry['revision']), entry);
    indexesByRecord.set(entry['recordId'], indexes);
  }
  const sequenceValues = managementDocs
    .map((document) => document.data['sequence'])
    .filter((value) => value !== undefined);
  const indexedValues = metadataDocs
    .map((document) => document.data['indexedThrough'])
    .filter((value) => value !== undefined);
  if (
    sequenceValues.length !== 1 ||
    indexedValues.length !== 1 ||
    !Number.isSafeInteger(sequenceValues[0]) ||
    !Number.isSafeInteger(indexedValues[0]) ||
    sequenceValues[0] !== indexedValues[0]
  ) {
    throw new TypeError('Snapshot scope sequence and index watermark are not caught up');
  }

  const planEntries = planInput['entries'] as unknown[];
  if (planEntries.length !== 51)
    throw new TypeError('Reviewed plan must name every current record exactly once');
  const planned = new Map<string, ReviewedPlanEntry>();
  for (const value of planEntries) {
    if (
      !object(value) ||
      typeof value['recordId'] !== 'string' ||
      !Number.isSafeInteger(value['expectedRevision']) ||
      !Array.isArray(value['additions']) ||
      planned.has(value['recordId'])
    ) {
      throw new TypeError('Reviewed plan contains an invalid or duplicate record entry');
    }
    if (value['additions'].length === 0) {
      throw new TypeError('Every reviewed record needs at least one source addition');
    }
    planned.set(value['recordId'], value as unknown as ReviewedPlanEntry);
  }
  if ([...planned.keys()].some((recordId) => !records.has(recordId))) {
    throw new TypeError('Reviewed plan contains a record outside the snapshot');
  }

  const entries: SourceMetadataMigrationManifest['entries'][number][] = [];
  let sourceCount = 0;
  let titleCount = 0;
  let versionCount = 0;
  let locatorCount = 0;
  let confidentialCount = 0;
  const distinctUris = new Set<string>();
  let originalSourceCount = 0;
  for (const [recordId, current] of [...records.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const plan = planned.get(recordId);
    const history = historyByRecord.get(recordId);
    const indexes = indexesByRecord.get(recordId);
    if (
      !plan ||
      !history ||
      !indexes ||
      plan.expectedRevision !== current.revision.revision ||
      current.revision.writer.kind !== 'ai' ||
      current.revision.approval.status !== 'none' ||
      current.lifecycle !== 'candidate' ||
      current.suppressed !== false ||
      history.size !== current.revision.revision ||
      !history.has(current.revision.revision) ||
      !indexes.has(current.revision.revision)
    ) {
      throw new TypeError('Reviewed plan and snapshot current revision do not agree');
    }
    const currentSources = current.revision.sourceReferences;
    originalSourceCount += currentSources.length;
    for (const source of currentSources) {
      if (source.provider !== 'lore-mcp') {
        throw new TypeError('Migration scope contains an unexpected existing source reference');
      }
    }
    const historyObject = new Map<number, MemoryRecord>();
    const revisionHashes: Record<string, string> = {};
    for (let revision = 1; revision <= current.revision.revision; revision += 1) {
      const item = history.get(revision);
      if (!item) throw new TypeError('Snapshot record history is not contiguous');
      historyObject.set(revision, item);
      revisionHashes[String(revision)] = dataHash(item);
    }
    const recordTimeProbe = {
      ...current,
      revision: {
        ...current.revision,
        revision: current.revision.revision + 1,
        changeKind: 'refine' as const,
        recordedAt,
      },
    };
    const recordedAtMillis = Date.parse(recordedAt);
    if (
      !isMemoryRecord(recordTimeProbe) ||
      [...historyObject.values()].some(
        (revision) => recordedAtMillis <= Date.parse(revision.revision.recordedAt),
      )
    ) {
      throw new TypeError(
        'Pinned record time must be a valid ISO time later than every existing revision',
      );
    }
    const indexHashes: Record<string, string> = {};
    for (const [revision, item] of [...indexes.entries()].sort(([a], [b]) => a - b)) {
      indexHashes[String(revision)] = dataHash(item);
    }
    const additions: SourceMetadataMigrationAddition[] = [];
    const seen = new Set<string>();
    for (const reviewedAddition of plan.additions) {
      const addition = validateReviewedAddition(reviewedAddition, historyObject);
      const reference = addition.source;
      const key = `${reference.provider}\u0000${reference.accountOrTenant}\u0000${reference.resourceId}`;
      if (
        seen.has(key) ||
        currentSources.some(
          (existing: unknown) =>
            object(existing) &&
            existing['provider'] === reference.provider &&
            existing['accountOrTenant'] === reference.accountOrTenant &&
            existing['resourceId'] === reference.resourceId,
        )
      ) {
        throw new TypeError('Reviewed plan source is duplicated or already present');
      }
      seen.add(key);
      additions.push(addition);
      sourceCount += 1;
      distinctUris.add(reference.uri!);
      if (reference.title !== undefined) titleCount += 1;
      if (reference.version !== undefined) versionCount += 1;
      if (reference.locator !== undefined) locatorCount += 1;
      if (reference.rights !== undefined) confidentialCount += 1;
    }
    if (additions.length === 0)
      throw new TypeError('Every selected record must receive a source addition');
    entries.push({
      recordId,
      expectedRevision: current.revision.revision,
      expectedCurrentSha256: dataHash(current),
      expectedRevisionSha256: revisionHashes,
      expectedIndexRevisionSha256: indexHashes,
      additions,
    });
  }
  if (
    planned.size !== records.size ||
    sourceCount !== 55 ||
    distinctUris.size !== 43 ||
    titleCount !== 49 ||
    versionCount !== 50 ||
    locatorCount !== 1 ||
    confidentialCount !== 5 ||
    originalSourceCount !== 52
  ) {
    throw new TypeError(
      'Reviewed source metadata counts do not match the accepted migration contract',
    );
  }
  const body = {
    schemaVersion: 'source-metadata-migration/v1' as const,
    migrationId,
    target,
    tenantId,
    scopeId,
    recordedAt,
    expectedSequence: Number(sequenceValues[0]),
    expectedIndexedThrough: Number(indexedValues[0]),
    entries,
  };
  const manifest = { ...body, sha256: sourceMetadataMigrationManifestSha256(body) };
  if (!SHA256.test(manifest.sha256)) throw new Error('Could not hash source metadata manifest');
  return manifest;
}

export interface SourceMetadataOperatorOptions {
  readonly projectId: string;
  readonly databaseId: string;
  readonly deletionLedgerDatabaseId: string;
}

export interface SourceMetadataOperator {
  readonly operatorEmail: string;
  dryRun(manifest: SourceMetadataMigrationManifest): Promise<SourceMetadataMigrationResult>;
  apply(manifest: SourceMetadataMigrationManifest): Promise<SourceMetadataMigrationResult>;
  verify(manifest: SourceMetadataMigrationManifest): Promise<SourceMetadataMigrationResult>;
  close(): Promise<void>;
}

function loopbackEmulator(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Number(url.port) > 0 &&
      Number(url.port) <= 65535
    );
  } catch {
    return false;
  }
}

async function verifiedOperatorEmail(auth: GoogleAuth): Promise<string> {
  try {
    const client = await auth.getClient();
    const access = await client.getAccessToken();
    const token = access.token;
    if (!token) throw new Error('token unavailable');
    return verifiedOperatorEmailFromTokenInfo(await new OAuth2Client().getTokenInfo(token));
  } catch {
    throw new Error('Could not verify the Google IAM operator credentials.');
  }
}

/** Normalize only exact verified-email representations returned by Google tokeninfo. */
export function verifiedOperatorEmailFromTokenInfo(info: unknown, now = Date.now()): string {
  if (!object(info)) throw new TypeError('Google token identity is invalid');
  const email = info['email'];
  const separator = typeof email === 'string' ? email.indexOf('@') : -1;
  const emailVerified =
    info['email_verified'] === 'true' ||
    info['email_verified'] === true ||
    info['verified_email'] === true;
  const expiryDate = info['expiry_date'];
  if (
    typeof email !== 'string' ||
    email.trim() !== email ||
    separator <= 0 ||
    separator !== email.lastIndexOf('@') ||
    separator === email.length - 1 ||
    /\s/u.test(email) ||
    !emailVerified ||
    typeof expiryDate !== 'number' ||
    !Number.isFinite(expiryDate) ||
    !Number.isFinite(now) ||
    expiryDate <= now
  ) {
    throw new TypeError('Google token identity is invalid');
  }
  return email;
}

/** Open the private maintenance capability; production identity comes only from its ADC token. */
export async function openSourceMetadataOperator(
  options: SourceMetadataOperatorOptions,
): Promise<SourceMetadataOperator> {
  if (
    !isIdentifier(options.projectId) ||
    !isIdentifier(options.databaseId) ||
    !isIdentifier(options.deletionLedgerDatabaseId)
  ) {
    throw new TypeError('Explicit project and database identifiers are required');
  }
  const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
  const emulator = emulatorHost !== undefined && emulatorHost !== '';
  if (emulator && (!loopbackEmulator(emulatorHost) || !options.projectId.startsWith('demo-'))) {
    throw new TypeError(
      'Only loopback Firestore emulators with synthetic demo- project IDs are allowed',
    );
  }
  const auth = emulator ? undefined : new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const operatorEmail = emulator
    ? 'emulator-operator@example.test'
    : await verifiedOperatorEmail(auth!);
  const firestore = createFirestoreClient({
    projectId: options.projectId,
    databaseId: options.databaseId,
    ...(auth === undefined ? {} : { auth }),
  });
  const ledgerFirestore = createFirestoreClient({
    projectId: options.projectId,
    databaseId: options.deletionLedgerDatabaseId,
    ...(auth === undefined ? {} : { auth }),
  });
  const ledger = new FirestoreDeletionLedger(ledgerFirestore);
  const repository = new FirestoreMemoryRecordRepository(firestore, randomBytes(32), ledger);
  const assertTarget = (manifest: SourceMetadataMigrationManifest) => {
    if (
      manifest.target.projectId !== options.projectId ||
      manifest.target.databaseId !== options.databaseId ||
      manifest.target.deletionLedgerDatabaseId !== options.deletionLedgerDatabaseId
    ) {
      throw new TypeError('Manifest target does not match the explicit operator target');
    }
  };
  return {
    operatorEmail,
    dryRun: (manifest) => {
      assertTarget(manifest);
      return repository[sourceMetadataMigrationDryRun](manifest, operatorEmail);
    },
    apply: (manifest) => {
      assertTarget(manifest);
      return repository[sourceMetadataMigrationApply](manifest, operatorEmail);
    },
    verify: (manifest) => {
      assertTarget(manifest);
      return repository[sourceMetadataMigrationVerify](manifest, operatorEmail);
    },
    async close() {
      await Promise.all([repository.close(), ledger.close()]);
    },
  };
}
