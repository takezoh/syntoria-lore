import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizationDocumentId,
  type MemoryRecord,
  type SourceReference,
} from '../packages/memory-records/src/index.js';
import {
  openSourceMetadataOperator,
  prepareSourceMetadataMigration,
} from '../packages/memory-records/src/operator-maintenance.js';
import { sourceMetadataMigrationManifestSha256 } from '../packages/memory-records/src/firestore-repository.js';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const tenantId = 'tenant-demo';
const scopeId = 'scope-demo';
const memoryDatabase = 'memory-records-test';
const ledgerDatabase = 'deletion-ledger-test';
const operators: Array<Awaited<ReturnType<typeof openSourceMetadataOperator>>> = [];

interface Fixture {
  readonly projectId: string;
  readonly snapshot: unknown;
  readonly plan: unknown;
  readonly records: readonly MemoryRecord[];
  readonly histories: readonly MemoryRecord[];
  readonly indexes: readonly Record<string, unknown>[];
  readonly manifest: ReturnType<typeof prepareSourceMetadataMigration>;
}

function encodeId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encodeValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
  }
  throw new TypeError('Unsupported Firestore fixture value');
}

function encodeFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
}

function decodeValue(value: Record<string, unknown>): unknown {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value['stringValue'];
  if ('booleanValue' in value) return value['booleanValue'];
  if ('integerValue' in value) return Number(value['integerValue']);
  if ('doubleValue' in value) return value['doubleValue'];
  if ('arrayValue' in value) {
    const array = value['arrayValue'] as { values?: Array<Record<string, unknown>> };
    return (array.values ?? []).map(decodeValue);
  }
  if ('mapValue' in value) {
    const map = value['mapValue'] as { fields?: Record<string, Record<string, unknown>> };
    return decodeFields(map.fields ?? {});
  }
  return undefined;
}

function decodeFields(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]),
  );
}

function basePath(tenant = tenantId, scope = scopeId): string {
  return `memoryTenants/${encodeId(tenant)}/scopes/${encodeId(scope)}`;
}

function recordPath(recordId: string): string {
  return `${basePath()}/records/${encodeId(recordId)}`;
}

function indexId(recordId: string, revision: number): string {
  return encodeId(`${recordId}\u0000${revision}`);
}

async function putDocument(projectId: string, databaseId: string, path: string, data: unknown) {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/${databaseId}/documents/${path}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: encodeFields(data as Record<string, unknown>) }),
    },
  );
  if (!response.ok) throw new Error(`Firestore fixture write failed: ${response.status}`);
}

async function getDocument(projectId: string, databaseId: string, path: string) {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/${databaseId}/documents/${path}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore fixture read failed: ${response.status}`);
  const body = (await response.json()) as { fields?: Record<string, Record<string, unknown>> };
  return decodeFields(body.fields ?? {});
}

async function listCollection(projectId: string, databaseId: string, path: string) {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/${databaseId}/documents/${path}?pageSize=1000`,
  );
  if (!response.ok) throw new Error(`Firestore fixture listing failed: ${response.status}`);
  const body = (await response.json()) as {
    documents?: Array<{ name: string; fields?: Record<string, Record<string, unknown>> }>;
  };
  return (body.documents ?? []).map((document) => ({
    path: document.name.split(`/documents/`)[1] ?? '',
    data: decodeFields(document.fields ?? {}),
  }));
}

function sourceUri(index: number): string {
  return `https://docs.example.test/document/d/demo-source-${index}`;
}

function sourceReference(
  uri: string,
  options: { title?: string; locator?: string; version?: string; confidential?: boolean } = {},
): SourceReference {
  return {
    provider: 'google-drive',
    accountOrTenant: 'docs.example.test',
    resourceId: `uri_${hashText(uri)}`,
    uri,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.locator === undefined ? {} : { locator: options.locator }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.confidential ? { rights: ['confidential'] } : {}),
  };
}

function existingSources(recordIndex: number): SourceReference[] {
  const refs: SourceReference[] = [
    { provider: 'lore-mcp', accountOrTenant: 'client-demo', resourceId: `request-${recordIndex}` },
  ];
  if (recordIndex === 0) {
    refs.push({
      provider: 'lore-mcp',
      accountOrTenant: 'client-demo',
      resourceId: 'request-refined',
    });
  }
  return refs;
}

function makeRecord(recordIndex: number, revisionNumber: number, reason: string): MemoryRecord {
  return {
    id: `record-${String(recordIndex).padStart(3, '0')}`,
    tenantId,
    scopeId,
    schemaVersion: 1,
    kind: 'fact',
    title: `Synthetic memory ${recordIndex}`,
    statement: `Synthetic assertion ${recordIndex}`,
    details: { kind: 'fact', subject: 'synthetic subject', claim: `claim ${recordIndex}` },
    subjectIds: ['subject-demo'],
    aliases: [],
    assumptions: [],
    attribution: { speaker: 'connection-owner', role: 'ai' },
    lifecycle: 'candidate',
    contested: false,
    needsRecheck: false,
    suppressed: false,
    valid: { from: null, until: null },
    compartmentIds: [],
    supersedes: null,
    supersededBy: null,
    revision: {
      revision: revisionNumber,
      changeKind: revisionNumber === 1 ? 'create' : 'refine',
      reason,
      writer: { kind: 'ai', id: 'connection-owner', connectionId: 'connection-owner' },
      approval: { status: 'none' },
      requestingConnectionId: 'connection-owner',
      gateClientId: 'client-owner',
      recordedAt: `2026-01-${String((recordIndex % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      sourceReferences: existingSources(recordIndex),
    },
  };
}

function indexEntry(record: MemoryRecord, revision: number): Record<string, unknown> {
  return {
    recordId: record.id,
    revision,
    compartmentIds: [...record.compartmentIds],
    terms: ['synthetic', 'assertion'],
    subjectIds: ['subject-demo'],
    aliases: [],
    embedding: { modelId: 'fixture-model', dimension: 2, values: [0.25, -0.5] },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function evidence(
  field: 'uri' | 'title' | 'version' | 'locator' | 'rights',
  revision: MemoryRecord,
  value: string,
) {
  const startUtf16 = revision.revision.reason.indexOf(value);
  if (startUtf16 < 0) throw new Error('Synthetic reason evidence was not found');
  return {
    field,
    revision: revision.revision.revision,
    startUtf16,
    endUtf16: startUtf16 + value.length,
    valueSha256: hashText(value),
  };
}

function fixture(): Fixture {
  const projectId = `demo-src-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const records: MemoryRecord[] = [];
  const histories: MemoryRecord[] = [];
  const indexes: Record<string, unknown>[] = [];
  const planEntries: Array<Record<string, unknown>> = [];
  for (let recordIndex = 0; recordIndex < 51; recordIndex += 1) {
    const uriIndexes = [recordIndex < 43 ? recordIndex : recordIndex % 43];
    if (recordIndex === 50) uriIndexes.push(0, 1, 2, 3);
    const isConfidential = recordIndex === 50;
    const marker = '機密本文の引用・要約は含めず所在を登録';
    const uriValues = uriIndexes.map(sourceUri);
    const parts = [
      ...uriValues,
      ...(recordIndex > 0 && recordIndex < 49
        ? [`Synthetic title ${recordIndex}`, `v-${recordIndex}`]
        : []),
      ...(recordIndex === 50 ? [marker] : []),
      ...(recordIndex === 50 ? ['v-50'] : []),
    ];
    const reason =
      recordIndex === 0 ? `Refined source pointer: ${uriValues[0]}` : parts.join(' ; ');
    const currentRevision = recordIndex === 0 ? 2 : 1;
    const current = makeRecord(recordIndex, currentRevision, reason);
    records.push(current);
    if (recordIndex === 0) {
      const oldReason = `${uriValues[0]} ; Synthetic title 0 ; v-0 ; section 2`;
      histories.push(makeRecord(recordIndex, 1, oldReason));
      indexes.push(indexEntry(current, 1));
    }
    histories.push(current);
    indexes.push(indexEntry(current, currentRevision));

    const additions = uriValues.map((uri, sourceIndex) => {
      const refs = [evidence('uri', current, uri)];
      const sourceTitle = recordIndex < 49 ? `Synthetic title ${recordIndex}` : undefined;
      const sourceVersion =
        recordIndex < 49
          ? `v-${recordIndex}`
          : recordIndex === 50 && sourceIndex === 0
            ? 'v-50'
            : undefined;
      const sourceLocator = recordIndex === 0 ? 'section 2' : undefined;
      let evidenceRecord = current;
      if (recordIndex === 0) evidenceRecord = histories[0]!;
      if (sourceTitle !== undefined) refs.push(evidence('title', evidenceRecord, sourceTitle));
      if (sourceVersion !== undefined)
        refs.push(evidence('version', evidenceRecord, sourceVersion));
      if (sourceLocator !== undefined)
        refs.push(evidence('locator', evidenceRecord, sourceLocator));
      if (isConfidential) refs.push(evidence('rights', current, marker));
      return {
        source: sourceReference(uri, {
          ...(sourceTitle === undefined ? {} : { title: sourceTitle }),
          ...(sourceVersion === undefined ? {} : { version: sourceVersion }),
          ...(sourceLocator === undefined ? {} : { locator: sourceLocator }),
          confidential: isConfidential,
        }),
        evidence: refs,
      };
    });
    planEntries.push({ recordId: current.id, expectedRevision: currentRevision, additions });
  }
  const currentDocs = records.map((data) => ({
    path: `${basePath()}/records/${encodeId(data.id)}`,
    data,
  }));
  const revisionDocs = histories.map((data) => ({
    path: `${basePath()}/records/${encodeId(data.id)}/revisions/${data.revision.revision}`,
    data,
  }));
  const indexDocs = indexes.map((data) => ({
    path: `${basePath()}/searchIndex/${indexId(String(data['recordId']), Number(data['revision']))}`,
    data,
  }));
  const snapshot = {
    collections: {
      'memory-records-demo/records': currentDocs,
      'memory-records-demo/revisions': revisionDocs,
      'memory-records-demo/searchIndex': indexDocs,
      'memory-records-demo/metadata': [
        { path: `${basePath()}/metadata/indexState`, data: { indexedThrough: 52 } },
      ],
      'memory-records-demo/management': [
        { path: `${basePath()}/management/sequence`, data: { sequence: 52 } },
      ],
    },
  };
  const target = {
    projectId,
    databaseId: memoryDatabase,
    deletionLedgerDatabaseId: ledgerDatabase,
  };
  const manifest = prepareSourceMetadataMigration(
    snapshot,
    { entries: planEntries },
    target,
    'synthetic-source-migration',
    '2026-11-10T00:00:00.000Z',
  );
  return {
    projectId,
    snapshot,
    plan: { entries: planEntries },
    records,
    histories,
    indexes,
    manifest,
  };
}

function manifestWithRecordedAt(manifest: Fixture['manifest'], recordedAt: string) {
  const nextManifest = { ...manifest, recordedAt };
  const { sha256: priorDigest, ...body } = nextManifest;
  void priorDigest;
  return { ...body, sha256: sourceMetadataMigrationManifestSha256(body) };
}

async function seedFixture(value: Fixture, pendingEarlierJob = false) {
  const { projectId, records, histories, indexes } = value;
  const base = basePath();
  const docs: Array<{ database: string; path: string; data: unknown }> = [];
  records.forEach((record) =>
    docs.push({
      database: memoryDatabase,
      path: `${base}/records/${encodeId(record.id)}`,
      data: record,
    }),
  );
  histories.forEach((record) =>
    docs.push({
      database: memoryDatabase,
      path: `${base}/records/${encodeId(record.id)}/revisions/${record.revision.revision}`,
      data: record,
    }),
  );
  indexes.forEach((entry) =>
    docs.push({
      database: memoryDatabase,
      path: `${base}/searchIndex/${indexId(String(entry['recordId']), Number(entry['revision']))}`,
      data: entry,
    }),
  );
  const authorizationId = authorizationDocumentId(tenantId, 'connection-owner', scopeId);
  docs.push({
    database: memoryDatabase,
    path: `memoryAuthorization/${authorizationId}`,
    data: {
      active: true,
      tenantId,
      principalId: 'connection-owner',
      actorKind: 'connection',
      connectionId: 'connection-owner',
      gateClientId: 'client-owner',
      authorizationEpoch: 1,
      compartmentAllowance: [],
      revokedSourceReferences: [],
    },
  });
  docs.push(
    { database: memoryDatabase, path: `${base}/management/sequence`, data: { sequence: 52 } },
    { database: memoryDatabase, path: `${base}/metadata/indexState`, data: { indexedThrough: 52 } },
    { database: memoryDatabase, path: `${base}/management/ledgerCheckpoint`, data: { head: 0 } },
  );
  if (pendingEarlierJob) {
    docs.push({
      database: memoryDatabase,
      path: `${base}/indexJobs/0000000000000007`,
      data: { sequence: 7, recordIds: ['record-000'], revisions: [], status: 'pending' },
    });
  }
  for (let offset = 0; offset < docs.length; offset += 24) {
    await Promise.all(
      docs
        .slice(offset, offset + 24)
        .map((document) => putDocument(projectId, document.database, document.path, document.data)),
    );
  }
}

async function openOperator(value: Fixture) {
  const operator = await openSourceMetadataOperator({
    projectId: value.projectId,
    databaseId: memoryDatabase,
    deletionLedgerDatabaseId: ledgerDatabase,
  });
  operators.push(operator);
  return operator;
}

afterEach(async () => {
  await Promise.all(operators.splice(0).map((operator) => operator.close()));
});

describe('operator source metadata migration', () => {
  it('rejects non-ISO and non-monotonic recordedAt values during preparation', () => {
    const value = fixture();
    const target = {
      projectId: value.projectId,
      databaseId: memoryDatabase,
      deletionLedgerDatabaseId: ledgerDatabase,
    };
    expect(() =>
      prepareSourceMetadataMigration(
        value.snapshot,
        value.plan,
        target,
        'synthetic-source-migration-invalid-iso',
        'November 10, 2026',
      ),
    ).toThrow(/valid ISO/u);
    expect(() =>
      prepareSourceMetadataMigration(
        value.snapshot,
        value.plan,
        target,
        'synthetic-source-migration-stale-time',
        '2025-12-31T23:59:59.999Z',
      ),
    ).toThrow(/later than every existing revision/u);
  });

  it('appends 55 reviewed references atomically and replays without writes', async () => {
    if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
    const value = fixture();
    await seedFixture(value);
    const operator = await openOperator(value);
    await expect(operator.dryRun(value.manifest)).resolves.toMatchObject({
      sequence: 53,
      indexedThrough: 53,
      recordIds: expect.arrayContaining(['record-000']),
      replayed: false,
    });
    const result = await operator.apply(value.manifest);
    expect(result).toMatchObject({ sequence: 53, indexedThrough: 53, replayed: false });
    await expect(operator.verify(value.manifest)).resolves.toMatchObject({ replayed: true });

    const currentDocs = await listCollection(
      value.projectId,
      memoryDatabase,
      `${basePath()}/records`,
    );
    const revisionPages = await Promise.all(
      value.records.map((record) =>
        listCollection(value.projectId, memoryDatabase, `${recordPath(record.id)}/revisions`),
      ),
    );
    const revisionDocs = revisionPages.flat();
    const indexDocs = await listCollection(
      value.projectId,
      memoryDatabase,
      `${basePath()}/searchIndex`,
    );
    const [sequence, indexState, change, job, receipts, audits] = await Promise.all([
      getDocument(value.projectId, memoryDatabase, `${basePath()}/management/sequence`),
      getDocument(value.projectId, memoryDatabase, `${basePath()}/metadata/indexState`),
      getDocument(value.projectId, memoryDatabase, `${basePath()}/changes/0000000000000053`),
      getDocument(value.projectId, memoryDatabase, `${basePath()}/indexJobs/0000000000000053`),
      listCollection(
        value.projectId,
        memoryDatabase,
        `${basePath()}/sourceMetadataMigrationReceipts`,
      ),
      listCollection(
        value.projectId,
        memoryDatabase,
        `${basePath()}/sourceMetadataMigrationAudits`,
      ),
    ]);
    expect(currentDocs).toHaveLength(51);
    expect(revisionDocs).toHaveLength(103);
    expect(indexDocs).toHaveLength(103);
    expect(sequence).toEqual({ sequence: 53 });
    expect(indexState).toEqual({ indexedThrough: 53 });
    expect(change).toMatchObject({ sequence: 53, operation: 'batch' });
    expect(job).toMatchObject({ sequence: 53, status: 'complete' });
    expect(receipts).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.data).toMatchObject({
      operatorEmail: 'emulator-operator@example.test',
      metadataEditor: 'emulator-operator@example.test',
      assertionWriter: 'Original record writers are retained on each revision.',
      sequence: 53,
      indexedThrough: 53,
    });
    const originalById = new Map(value.records.map((record) => [record.id, record]));
    const afterById = new Map(
      currentDocs.map((document) => [String(document.data['id']), document.data]),
    );
    for (const [recordId, original] of originalById) {
      const migrated = afterById.get(recordId) as MemoryRecord | undefined;
      expect(migrated).toBeDefined();
      expect(migrated?.revision.revision).toBe(original.revision.revision + 1);
      expect(migrated?.statement).toBe(original.statement);
      expect(migrated?.kind).toBe(original.kind);
      expect(migrated?.attribution).toEqual(original.attribution);
      expect(migrated?.lifecycle).toBe('candidate');
      expect(migrated?.revision.writer).toEqual(original.revision.writer);
      expect(migrated?.revision.approval).toEqual({ status: 'none' });
      expect(migrated?.revision.requestingConnectionId).toBeNull();
      expect(migrated?.revision.gateClientId).toBeNull();
      expect(
        migrated?.revision.sourceReferences.filter((source) => source.provider === 'lore-mcp'),
      ).toEqual(original.revision.sourceReferences);
    }
    const again = await operator.apply(value.manifest);
    expect(again).toMatchObject({ sequence: 53, indexedThrough: 53, replayed: true });
    expect(
      await listCollection(
        value.projectId,
        memoryDatabase,
        `${basePath()}/sourceMetadataMigrationReceipts`,
      ),
    ).toHaveLength(1);
  });

  it('rejects a stale manifest time in the transaction before any writes', async () => {
    if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
    const value = fixture();
    await seedFixture(value);
    const operator = await openOperator(value);
    const staleManifest = manifestWithRecordedAt(value.manifest, '2026-01-01T00:00:00.000Z');
    await expect(operator.apply(staleManifest)).rejects.toThrow(
      /record time must be later than every existing revision/u,
    );
    expect(
      await getDocument(value.projectId, memoryDatabase, `${basePath()}/management/sequence`),
    ).toEqual({ sequence: 52 });
    expect(
      await getDocument(value.projectId, memoryDatabase, `${basePath()}/metadata/indexState`),
    ).toEqual({ indexedThrough: 52 });
    expect(
      await getDocument(value.projectId, memoryDatabase, `${basePath()}/changes/0000000000000053`),
    ).toBeNull();
    expect(
      await getDocument(
        value.projectId,
        memoryDatabase,
        `${basePath()}/indexJobs/0000000000000053`,
      ),
    ).toBeNull();
    expect(
      await listCollection(
        value.projectId,
        memoryDatabase,
        `${basePath()}/sourceMetadataMigrationReceipts`,
      ),
    ).toHaveLength(0);
    expect(
      await listCollection(
        value.projectId,
        memoryDatabase,
        `${basePath()}/sourceMetadataMigrationAudits`,
      ),
    ).toHaveLength(0);
    expect(
      await listCollection(value.projectId, memoryDatabase, `${basePath()}/searchIndex`),
    ).toHaveLength(52);
  });

  it('rejects a stale current hash and a pending prior index job with zero writes', async () => {
    if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
    const stale = fixture();
    await seedFixture(stale);
    await putDocument(stale.projectId, memoryDatabase, recordPath('record-000'), {
      ...stale.records[0],
      statement: 'Changed after private snapshot',
    });
    const staleOperator = await openOperator(stale);
    await expect(staleOperator.apply(stale.manifest)).rejects.toThrow(
      /manifest|current record|migration baseline/u,
    );
    expect(
      await getDocument(stale.projectId, memoryDatabase, `${basePath()}/management/sequence`),
    ).toEqual({ sequence: 52 });
    expect(
      await listCollection(
        stale.projectId,
        memoryDatabase,
        `${basePath()}/sourceMetadataMigrationReceipts`,
      ),
    ).toHaveLength(0);

    const pending = fixture();
    await seedFixture(pending, true);
    const pendingOperator = await openOperator(pending);
    await expect(pendingOperator.apply(pending.manifest)).rejects.toThrow(
      /pending|caught up|index/u,
    );
    expect(
      await getDocument(pending.projectId, memoryDatabase, `${basePath()}/management/sequence`),
    ).toEqual({ sequence: 52 });
    expect(
      await getDocument(pending.projectId, memoryDatabase, `${basePath()}/metadata/indexState`),
    ).toEqual({ indexedThrough: 52 });
    expect(
      await listCollection(
        pending.projectId,
        memoryDatabase,
        `${basePath()}/sourceMetadataMigrationReceipts`,
      ),
    ).toHaveLength(0);
  });
});
