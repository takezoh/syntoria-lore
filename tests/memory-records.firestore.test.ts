import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createFirestoreMemoryRecordRepository,
  memoryChangeDigest,
  memoryForgetDigest,
  indexEntryFor,
  MemoryIndexWorker,
  MemoryRecallService,
  MemoryRepositoryError,
  type DeletionLedger,
  type DeletionLedgerEntry,
  type DeletionLedgerSnapshot,
  type FirestoreMemoryRecordRepository,
  type MemoryRecord,
  type VerifiedActorCapability,
} from '../packages/memory-records/src/index.js';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const secret = Buffer.alloc(32, 7);
const repositories: FirestoreMemoryRecordRepository[] = [];

class TestDeletionLedger implements DeletionLedger {
  readonly entries = new Map<string, DeletionLedgerEntry>();
  loseNextAppendResponse = false;
  unavailable = false;
  async append(entry: DeletionLedgerEntry): Promise<void> {
    if (this.unavailable) throw new Error('simulated ledger outage');
    this.entries.set(entry.id, entry);
    if (this.loseNextAppendResponse) {
      this.loseNextAppendResponse = false;
      throw new Error('simulated response loss after durable append');
    }
  }
  async includes(entryId: string): Promise<boolean> {
    if (this.unavailable) throw new Error('simulated ledger outage');
    return this.entries.has(entryId);
  }
  async head(): Promise<number> {
    if (this.unavailable) throw new Error('simulated ledger outage');
    return this.entries.size;
  }
  async snapshot(): Promise<DeletionLedgerSnapshot> {
    if (this.unavailable) throw new Error('simulated ledger outage');
    return { head: this.entries.size, entries: [...this.entries.values()] };
  }
}

function encodeId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function context(
  allowance: string[] = ['work'],
  epoch = 1,
  actorKind: VerifiedActorCapability['actorKind'] = 'person',
  revokedSourceReferences: string[] = [],
  protectedChangeApproval?: VerifiedActorCapability['protectedChangeApproval'],
  deletionLedger = new TestDeletionLedger(),
) {
  const projectId = `demo-memory-records-${process.pid}-${randomUUID().replaceAll('-', '')}`;
  const actor = {
    tenantId: 'tenant-demo',
    principalId: actorKind === 'person' ? 'person-demo' : 'principal-demo',
    actorKind,
    connectionId: 'connection-demo',
    gateClientId: 'client-demo',
    scopeIds: ['scope-demo'],
    compartmentAllowance: allowance,
    authorizationEpoch: epoch,
    ...(protectedChangeApproval === undefined ? {} : { protectedChangeApproval }),
  } as unknown as VerifiedActorCapability;
  const repository = createFirestoreMemoryRecordRepository({
    projectId,
    cursorSecret: secret,
    deletionLedger,
  });
  repositories.push(repository);
  await seedAuthorization(projectId, actor, revokedSourceReferences);
  return { actor, repository, projectId, deletionLedger };
}

async function copyFirestoreDocument(
  sourceProject: string,
  targetProject: string,
  documentPath: string,
): Promise<void> {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const url = (projectId: string) =>
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/${documentPath}`;
  const source = await fetch(url(sourceProject));
  if (!source.ok) throw new Error(`Could not read backup source document: ${source.status}`);
  const body = (await source.json()) as { fields: Record<string, unknown> };
  const target = await fetch(url(targetProject), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: body.fields }),
  });
  if (!target.ok) throw new Error(`Could not restore backup document: ${target.status}`);
}

async function copyRecordBackup(sourceProject: string, targetProject: string): Promise<void> {
  const tenantId = encodeId('tenant-demo');
  const scopeId = encodeId('scope-demo');
  const recordId = encodeId('record-1');
  const path = `memoryTenants/${tenantId}/scopes/${scopeId}/records/${recordId}`;
  await copyFirestoreDocument(sourceProject, targetProject, path);
  await copyFirestoreDocument(sourceProject, targetProject, `${path}/revisions/1`);
}

async function seedAuthorization(
  projectId: string,
  actor: VerifiedActorCapability,
  revokedSourceReferences: string[],
) {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const documentId = encodeId(`${actor.tenantId}_${actor.principalId}_${actor.scopeIds[0]}`);
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryAuthorization?documentId=${documentId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: {
          active: { booleanValue: true },
          tenantId: { stringValue: actor.tenantId },
          principalId: { stringValue: actor.principalId },
          actorKind: { stringValue: actor.actorKind },
          connectionId: { stringValue: actor.connectionId },
          gateClientId: { stringValue: actor.gateClientId },
          authorizationEpoch: { integerValue: String(actor.authorizationEpoch) },
          compartmentAllowance: {
            arrayValue: {
              values: actor.compartmentAllowance.map((value) => ({ stringValue: value })),
            },
          },
          revokedSourceReferences: {
            arrayValue: {
              values: revokedSourceReferences.map((value) => ({ stringValue: value })),
            },
          },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Could not seed Firestore authorization: ${response.status}`);
  if (actor.protectedChangeApproval) {
    const tenantId = encodeId(actor.tenantId);
    const scopeId = encodeId(actor.scopeIds[0]!);
    const approval = actor.protectedChangeApproval;
    const approvalResponse = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${tenantId}/scopes/${scopeId}/approvals?documentId=${encodeId(approval.protectedChangeId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fields: {
            principalId: { stringValue: actor.principalId },
            connectionId: { stringValue: actor.connectionId },
            gateClientId: { stringValue: actor.gateClientId },
            provenance: { stringValue: approval.provenance },
            protectedChangeId: { stringValue: approval.protectedChangeId },
            requestDigest: { stringValue: approval.requestDigest },
          },
        }),
      },
    );
    if (!approvalResponse.ok)
      throw new Error(`Could not seed approval: ${approvalResponse.status}`);
  }
}

async function seedSuppression(
  projectId: string,
  actor: VerifiedActorCapability,
  recordId: string,
) {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const tenantId = encodeId(actor.tenantId);
  const scopeId = encodeId(actor.scopeIds[0]!);
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${tenantId}/scopes/${scopeId}/suppressions?documentId=${encodeId(recordId)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { deletionId: { stringValue: 'deletion-demo' } } }),
    },
  );
  if (!response.ok) throw new Error(`Could not seed Firestore suppression: ${response.status}`);
}

async function revokeSources(
  projectId: string,
  actor: VerifiedActorCapability,
  revokedSourceReferences: string[],
) {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const documentId = encodeId(`${actor.tenantId}_${actor.principalId}_${actor.scopeIds[0]}`);
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryAuthorization/${documentId}?updateMask.fieldPaths=revokedSourceReferences`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: {
          revokedSourceReferences: {
            arrayValue: {
              values: revokedSourceReferences.map((value) => ({ stringValue: value })),
            },
          },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Could not update Firestore source rights: ${response.status}`);
}

async function patchFirestoreField(
  projectId: string,
  documentPath: string,
  field: string,
  value: { [key: string]: unknown },
): Promise<void> {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const fields: Record<string, unknown> = {};
  const parts = field.split('.');
  let target = fields;
  for (const part of parts.slice(0, -1)) {
    const nestedFields: Record<string, unknown> = {};
    target[part] = { mapValue: { fields: nestedFields } };
    target = nestedFields;
  }
  target[parts.at(-1)!] = value;
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/${documentPath}?updateMask.fieldPaths=${field}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }),
    },
  );
  if (!response.ok) throw new Error(`Could not patch Firestore field ${field}: ${response.status}`);
}

async function seedDeletionMarker(
  projectId: string,
  actor: VerifiedActorCapability,
  sequence: number,
) {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const tenantId = encodeId(actor.tenantId);
  const scopeId = encodeId(actor.scopeIds[0]!);
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${tenantId}/scopes/${scopeId}/changes?documentId=${String(sequence).padStart(16, '0')}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: {
          sequence: { integerValue: String(sequence) },
          operation: { stringValue: 'deletion' },
          recordIds: { arrayValue: { values: [] } },
          revisionNumbers: { arrayValue: { values: [] } },
          compartmentIds: { arrayValue: { values: [] } },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Could not seed Firestore deletion marker: ${response.status}`);
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'record-1',
    tenantId: 'tenant-demo',
    scopeId: 'scope-demo',
    schemaVersion: 1,
    kind: 'decision',
    title: 'Storage choice',
    statement: 'Use the selected storage design',
    details: {
      kind: 'decision',
      question: 'Which store?',
      choice: 'Memory Records',
      reason: 'The design was accepted',
      decider: 'person-demo',
      decisionTime: '2026-01-01T00:00:00.000Z',
    },
    subjectIds: ['project-demo'],
    aliases: [],
    assumptions: [],
    attribution: { speaker: 'person-demo', role: 'user' },
    lifecycle: 'active',
    contested: false,
    needsRecheck: false,
    suppressed: false,
    valid: { from: '2026-01-01T00:00:00.000Z', until: null },
    compartmentIds: ['work'],
    supersedes: null,
    supersededBy: null,
    revision: {
      revision: 1,
      changeKind: 'create',
      reason: 'Created from a protected change',
      writer: { kind: 'person', id: 'person-demo' },
      approval: { status: 'none' },
      requestingConnectionId: null,
      gateClientId: null,
      recordedAt: '2026-01-01T00:00:00.000Z',
      sourceReferences: [],
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
});

describe('Firestore Memory Record repository', () => {
  it('indexes commits, overlays index lag, fences stale jobs, and bounds Context Packs', async () => {
    const { actor, repository, projectId, deletionLedger } = await context();
    const embeddings = {
      async embed(text: string) {
        const values = [0, 0, 0, 0];
        for (const point of text.normalize('NFKC').toLocaleLowerCase('und')) {
          const bucket = point.codePointAt(0)! % values.length;
          values[bucket] = values[bucket]! + 1;
        }
        return { modelId: 'deterministic-test', dimension: values.length, values };
      },
    };
    const workerActor = {
      ...actor,
      actorKind: 'worker',
      principalId: 'worker-demo',
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, workerActor, []);
    const workerRepository = createFirestoreMemoryRecordRepository({
      projectId,
      cursorSecret: secret,
      deletionLedger,
    });
    repositories.push(workerRepository);
    const worker = new MemoryIndexWorker(workerRepository, embeddings);
    const recall = new MemoryRecallService(repository, embeddings);
    const sourcedRecord = record({
      revision: {
        ...record().revision,
        sourceReferences: [
          { provider: 'chat', accountOrTenant: 'tenant-demo', resourceId: 'source-1' },
        ],
      },
    });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'derived-first',
      changes: [{ kind: 'create', record: sourcedRecord }],
    });
    await expect(repository.listPendingIndexJobs(actor, 'scope-demo')).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    const failingWorker = new MemoryIndexWorker(workerRepository, {
      async embed() {
        throw new Error('simulated provider failure');
      },
    });
    expect(await failingWorker.runPending(workerActor, 'scope-demo')).toEqual({
      completed: 0,
      failed: 1,
      failures: [{ sequence: 1, reason: 'indexing-failed' }],
    });
    expect(await worker.runPending(workerActor, 'scope-demo')).toEqual({
      completed: 1,
      failed: 0,
      failures: [],
    });
    const first = await recall.recall(actor, 'scope-demo', {
      text: 'Memory Records',
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-03-01T00:00:00.000Z',
      byteBudget: 10000,
    });
    expect(first.items.map((item) => item.record.id)).toEqual(['record-1']);
    expect(first.items[0]?.record.revision.approval).toEqual({ status: 'none' });
    expect(first.indexLag).toEqual({ indexedThrough: 1, latestChange: 1 });

    const revised = record({
      statement: 'Use the new Memory Records index',
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        recordedAt: '2026-02-01T00:00:00.000Z',
        sourceReferences: sourcedRecord.revision.sourceReferences,
      },
    });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'derived-second',
      changes: [{ kind: 'refine', expectedRevision: 1, record: revised }],
    });
    const stale = await workerRepository.getRecordForIndex(workerActor, 'scope-demo', 'record-1');
    expect(stale?.revision.revision).toBe(2);
    expect(await worker.runPending(workerActor, 'scope-demo')).toEqual({
      completed: 1,
      failed: 0,
      failures: [],
    });
    expect(stale).not.toBeNull();
    expect(
      await workerRepository.writeSearchIndexEntry(
        workerActor,
        'scope-demo',
        indexEntryFor(record(), await embeddings.embed('old version')),
      ),
    ).toBe(false);
    const latest = await recall.recall(actor, 'scope-demo', {
      text: 'new Memory Records index',
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-03-01T00:00:00.000Z',
      byteBudget: 10000,
    });
    expect(latest.items[0]?.record.revision.revision).toBe(2);
    expect(latest.items[0]?.freshness).toBe('current');
    const historical = await recall.recall(actor, 'scope-demo', {
      text: 'settled',
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-01-15T00:00:00.000Z',
      byteBudget: 10000,
    });
    expect(historical.items.map((item) => [item.record.id, item.record.revision.revision])).toEqual(
      [['record-1', 1]],
    );

    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'derived-overlay',
      changes: [
        {
          kind: 'create',
          record: record({
            id: 'record-2',
            title: 'Fresh overlay',
            statement: 'An unindexed Japanese 記憶 entry for Memory Records',
            subjectIds: ['project-other'],
            details: {
              kind: 'decision',
              question: 'Which other store?',
              choice: 'A test fixture',
              reason: 'Keep the overlay fixture independent',
              decider: 'person-demo',
              decisionTime: '2026-01-01T00:00:00.000Z',
            },
          }),
        },
      ],
    });
    const overlay = await recall.recall(actor, 'scope-demo', {
      text: 'Japanese 記憶',
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-03-01T00:00:00.000Z',
      byteBudget: 10000,
    });
    expect(overlay.items.map((item) => item.record.id)).toContain('record-2');
    expect(overlay.items.find((item) => item.record.id === 'record-2')?.freshness).toBe(
      'recent-overlay',
    );
    expect(overlay.insufficiencies).toContain('index-lag');
    const tooSmall = await recall.recall(actor, 'scope-demo', {
      recordId: 'record-2',
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-03-01T00:00:00.000Z',
      byteBudget: 400,
    });
    expect(tooSmall.items).toEqual([]);
    expect(tooSmall.insufficiencies).toContain('byte-budget-dropped-matches');
    expect(tooSmall.byteLength).toBeLessThanOrEqual(400);
    expect(tooSmall.byteLength).toBe(Buffer.byteLength(JSON.stringify(tooSmall), 'utf8'));
    await expect(
      recall.recall(actor, 'scope-demo', {
        recordId: 'record-2',
        validAt: '2026-03-01T00:00:00.000Z',
        knownAt: '2026-03-01T00:00:00.000Z',
        byteBudget: 1,
      }),
    ).rejects.toThrow('too small for the Context Pack metadata');

    await revokeSources(projectId, actor, ['chat\u0000tenant-demo\u0000source-1']);
    const afterRevocation = await recall.recall(actor, 'scope-demo', {
      text: 'Memory Records',
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-03-01T00:00:00.000Z',
      byteBudget: 10000,
    });
    expect(afterRevocation.items.map((item) => item.record.id)).toEqual(['record-2']);
    expect(afterRevocation.insufficiencies).toContain('rights-withheld');
    expect(JSON.stringify(afterRevocation)).not.toContain('record-1');
  });

  it('commits atomically, replays the same key, and rejects a changed replay', async () => {
    const { actor, repository } = await context();
    const changeSet = {
      scopeId: 'scope-demo',
      idempotencyKey: 'remember-1',
      changes: [{ kind: 'create' as const, record: record() }],
    };
    const committed = await repository.commit(actor, changeSet);
    const replay = await repository.commit(actor, changeSet);
    expect(committed).toMatchObject({ sequence: 1, replayed: false });
    expect(replay).toMatchObject({ sequence: 1, replayed: true });
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toMatchObject({
      id: 'record-1',
      revision: { requestingConnectionId: 'connection-demo', gateClientId: 'client-demo' },
    });
    await expect(
      repository.commit(actor, {
        ...changeSet,
        changes: [{ kind: 'create', record: record({ statement: 'A different request' }) }],
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it.each([
    ['identity', 'id', { stringValue: 'different-record' }],
    ['document path', 'revision.revision', { integerValue: '2' }],
  ])(
    'withholds Recall when stored revision %s does not match its path',
    async (_case, field, value) => {
      const { actor, repository, projectId, deletionLedger } = await context();
      const embeddings = {
        async embed() {
          return { modelId: 'deterministic-test', dimension: 2, values: [1, 0] };
        },
      };
      const workerActor = {
        ...actor,
        actorKind: 'worker',
        principalId: 'worker-demo',
      } as unknown as VerifiedActorCapability;
      await seedAuthorization(projectId, workerActor, []);
      const workerRepository = createFirestoreMemoryRecordRepository({
        projectId,
        cursorSecret: secret,
        deletionLedger,
      });
      repositories.push(workerRepository);
      await repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: `recall-history-${field}`,
        changes: [{ kind: 'create', record: record() }],
      });
      const worker = new MemoryIndexWorker(workerRepository, embeddings);
      expect(await worker.runPending(workerActor, 'scope-demo')).toMatchObject({
        completed: 1,
        failed: 0,
      });
      const revisionPath = `memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-demo')}/records/${encodeId('record-1')}/revisions/1`;
      await patchFirestoreField(projectId, revisionPath, field, value);
      const recall = new MemoryRecallService(repository, embeddings);
      const pack = await recall.recall(actor, 'scope-demo', {
        text: 'Database choice',
        validAt: '2026-03-01T00:00:00.000Z',
        knownAt: '2026-03-01T00:00:00.000Z',
        byteBudget: 10000,
      });
      expect(pack.items).toEqual([]);
      expect(pack.insufficiencies).toContain('invalid-history');
      expect(JSON.stringify(pack)).not.toContain('record-1');
    },
  );

  it('fails a stale compare-and-set without committing another record', async () => {
    const { actor, repository } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'create',
      changes: [{ kind: 'create', record: record() }],
    });
    const makeRevision = (statement: string): MemoryRecord => ({
      ...record({ statement }),
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
    });
    const result = await Promise.allSettled([
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'update-a',
        changes: [{ kind: 'refine', expectedRevision: 1, record: makeRevision('A') }],
      }),
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'update-b',
        changes: [{ kind: 'refine', expectedRevision: 1, record: makeRevision('B') }],
      }),
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const current = await repository.getCurrent(actor, 'scope-demo', 'record-1');
    expect(current?.revision.revision).toBe(2);
    expect(current?.statement).toMatch(/^[AB]$/u);
  });

  it('rejects a historical read when the persisted current revision is missing', async () => {
    const { actor, repository, projectId } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'historical-integrity',
      changes: [{ kind: 'create', record: record() }],
    });
    const tenantId = encodeId(actor.tenantId);
    const scopeId = encodeId('scope-demo');
    const recordId = encodeId('record-1');
    const response = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${tenantId}/scopes/${scopeId}/records/${recordId}/revisions/1`,
      { method: 'DELETE' },
    );
    expect(response.ok).toBe(true);

    await expect(
      repository.getHistorical(
        actor,
        'scope-demo',
        'record-1',
        '2026-02-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects a historical read when an earlier persisted revision is missing', async () => {
    const { actor, repository, projectId } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'history-gap-create',
      changes: [{ kind: 'create', record: record() }],
    });
    const refined = record({
      statement: 'Updated decision',
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
    });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'history-gap-refine',
      changes: [{ kind: 'refine', expectedRevision: 1, record: refined }],
    });
    const tenantId = encodeId(actor.tenantId);
    const scopeId = encodeId('scope-demo');
    const recordId = encodeId('record-1');
    const response = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${tenantId}/scopes/${scopeId}/records/${recordId}/revisions/1`,
      { method: 'DELETE' },
    );
    expect(response.ok).toBe(true);

    await expect(
      repository.getHistorical(
        actor,
        'scope-demo',
        'record-1',
        '2026-01-15T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('selects a complete historical series beyond revision nine', async () => {
    const { actor, repository } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'history-order-create',
      changes: [{ kind: 'create', record: record() }],
    });
    for (let revision = 2; revision <= 10; revision += 1) {
      const updated = record({
        statement: `revision-${revision}`,
        revision: {
          ...record().revision,
          revision,
          changeKind: 'refine',
          recordedAt: new Date(Date.UTC(2026, 0, revision)).toISOString(),
        },
      });
      await repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: `history-order-${revision}`,
        changes: [{ kind: 'refine', expectedRevision: revision - 1, record: updated }],
      });
    }

    await expect(
      repository.getHistorical(
        actor,
        'scope-demo',
        'record-1',
        '2026-02-01T00:00:00.000Z',
        '2026-01-15T00:00:00.000Z',
      ),
    ).resolves.toMatchObject({ revision: { revision: 10 }, statement: 'revision-10' });
  });

  it('denies stale authorization and records outside the current allowance', async () => {
    const { actor, repository } = await context(['work'], 1);
    await expect(
      repository.commit(
        { ...actor, authorizationEpoch: 2 },
        {
          scopeId: 'scope-demo',
          idempotencyKey: 'stale',
          changes: [{ kind: 'create', record: record() }],
        },
      ),
    ).rejects.toMatchObject({ code: 'stale_authorization' });
    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'restricted',
        changes: [{ kind: 'create', record: record({ compartmentIds: ['health'] }) }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  it('rejects an overlapping active decision without partially writing the change set', async () => {
    const { actor, repository } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'first-decision',
      changes: [{ kind: 'create', record: record() }],
    });
    const competing = record({
      id: 'record-2',
      subjectIds: ['project-demo', 'other-subject'],
      title: 'Conflicting storage choice',
    });
    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'competing-decision',
        changes: [{ kind: 'create', record: competing }],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-2')).toBeNull();
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toMatchObject({
      id: 'record-1',
    });
  });

  it('commits same-question decisions with adjacent valid intervals in one change set', async () => {
    const { actor, repository } = await context();
    const first = record({
      valid: { from: '2026-01-01T00:00:00.000Z', until: '2026-06-01T00:00:00.000Z' },
    });
    const second = record({
      id: 'record-2',
      title: 'Later storage choice',
      valid: { from: '2026-06-01T00:00:00.000Z', until: null },
    });

    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'adjacent-decisions',
        changes: [
          { kind: 'create', record: first },
          { kind: 'create', record: second },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 1, recordIds: ['record-1', 'record-2'], replayed: false });
    expect(
      await repository.getHistorical(
        actor,
        'scope-demo',
        'record-1',
        '2026-11-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).toMatchObject({ id: 'record-1' });
    expect(
      await repository.getHistorical(
        actor,
        'scope-demo',
        'record-2',
        '2026-11-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
      ),
    ).toMatchObject({ id: 'record-2' });
  });

  it('rejects overlapping same-question decisions within one change set without partial writes', async () => {
    const { actor, repository } = await context();
    const first = record({
      valid: { from: '2026-01-01T00:00:00.000Z', until: '2026-07-01T00:00:00.000Z' },
    });
    const second = record({
      id: 'record-2',
      title: 'Conflicting storage choice',
      valid: { from: '2026-06-01T00:00:00.000Z', until: null },
    });

    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'overlapping-batch-decisions',
        changes: [
          { kind: 'create', record: first },
          { kind: 'create', record: second },
        ],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toBeNull();
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-2')).toBeNull();
  });

  it('keeps connection-authored AI proposals out of current reads', async () => {
    const { actor, repository } = await context(['work'], 1, 'connection');
    const proposal = record({
      lifecycle: 'candidate',
      attribution: { speaker: 'person-demo', role: 'user' },
      revision: {
        ...record().revision,
        writer: { kind: 'ai', id: 'assistant-demo', connectionId: actor.connectionId },
        approval: { status: 'none' },
      },
    });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'candidate',
      changes: [{ kind: 'create', record: proposal }],
    });
    expect(await repository.getCurrent(actor, 'scope-demo', proposal.id)).toBeNull();
  });

  it('moves the index watermark past jobs that finished before an earlier one', async () => {
    const { actor, repository, projectId } = await context([]);
    for (const recordId of ['first', 'second', 'third'])
      await repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: `out-of-order-${recordId}`,
        changes: [
          {
            kind: 'create',
            record: record({
              id: recordId,
              kind: 'fact',
              details: { kind: 'fact', subject: recordId, claim: `A claim about ${recordId}` },
              compartmentIds: [],
            }),
          },
        ],
      });
    const workerActor = {
      ...actor,
      actorKind: 'worker',
      principalId: 'worker-demo',
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, workerActor, []);
    const jobs = (await repository.listPendingIndexJobs(workerActor, 'scope-demo')).sort(
      (left, right) => left.sequence - right.sequence,
    );
    expect(jobs.map((job) => job.sequence)).toEqual([1, 2, 3]);
    const watermark = async () =>
      (
        await repository.readRecallCandidates(actor, 'scope-demo', {
          terms: [],
          subjectIds: [],
          aliases: [],
          validAt: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-03-01T00:00:00.000Z',
          limit: 1,
        })
      ).indexLag.indexedThrough;
    await repository.completeIndexJob(workerActor, 'scope-demo', jobs[2]!);
    await repository.completeIndexJob(workerActor, 'scope-demo', jobs[1]!);
    expect(await watermark()).toBe(0);
    await repository.completeIndexJob(workerActor, 'scope-demo', jobs[0]!);
    expect(await watermark()).toBe(3);
  });

  it('ranks a named record above records that share only common terms and reports why each matched', async () => {
    const { actor, repository, projectId, deletionLedger } = await context([]);
    const fact = (id: string, title: string, statement: string, aliases: string[] = []) =>
      record({
        id,
        title,
        statement,
        kind: 'fact',
        details: { kind: 'fact', subject: 'Example business', claim: statement },
        // A subject may contain a slash, as a repository name does; it must still be indexed.
        subjectIds: ['Example business', 'example/repository'],
        aliases: aliases.map((value) => ({ value, from: null, until: null })),
        compartmentIds: [],
      });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'named-recall',
      changes: [
        {
          kind: 'create',
          record: fact(
            'named',
            'Acmeの提示金額の食い違い',
            'Acmeの提示金額は2か月総額80万円と80万円×2か月の記載で矛盾している。',
            ['アクメーロジック'],
          ),
        },
        {
          kind: 'create',
          record: fact('study', '教材の進捗', '教材の購入は済み、読了の進捗は未確認。'),
        },
        {
          kind: 'create',
          record: fact('agents', '開発の進捗', '開発エージェントの比較は進捗を分けて評価する。'),
        },
        {
          kind: 'create',
          record: fact('plan', '計画の進捗', '既存実装の進捗に依存しない新規計画とする。'),
        },
      ],
    });
    const workerActor = {
      ...actor,
      actorKind: 'worker',
      principalId: 'worker-demo',
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, workerActor, []);
    const workerRepository = createFirestoreMemoryRecordRepository({
      projectId,
      cursorSecret: secret,
      deletionLedger,
    });
    repositories.push(workerRepository);
    // Every text embeds to the same vector, so similarity cannot tell the records apart.
    const embeddings = {
      async embed() {
        return { modelId: 'flat-test', dimension: 2, values: [1, 1] };
      },
    };
    expect(
      await new MemoryIndexWorker(workerRepository, embeddings).runPending(
        workerActor,
        'scope-demo',
      ),
    ).toMatchObject({ completed: 1, failed: 0 });
    const recall = new MemoryRecallService(repository, embeddings);
    expect(
      (
        await recall.recall(actor, 'scope-demo', {
          text: 'example/repository',
          validAt: '2026-03-01T00:00:00.000Z',
          knownAt: '2026-03-01T00:00:00.000Z',
          byteBudget: 20_000,
        })
      ).indexLag,
    ).toEqual({ indexedThrough: 1, latestChange: 1 });
    const at = {
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-03-01T00:00:00.000Z',
      byteBudget: 20_000,
    };

    const byName = await recall.recall(actor, 'scope-demo', { ...at, text: 'Acme' });
    expect(byName.items[0]?.record.id).toBe('named');
    expect(byName.items[0]?.matched).toContain('terms');
    expect(byName.items.slice(1).every((item) => !item.matched.includes('terms'))).toBe(true);

    const question = await recall.recall(actor, 'scope-demo', {
      ...at,
      text: 'アクメーロジックの案件の進捗を教えて',
    });
    expect(question.items[0]?.record.id).toBe('named');
    expect(question.items[0]?.matched).toContain('alias');
    expect(question.insufficiencies).not.toContain('semantic-match-only');

    const unknown = await recall.recall(actor, 'scope-demo', { ...at, text: 'Globex' });
    expect(unknown.items.every((item) => item.matched.join() === 'semantic')).toBe(true);
    expect(unknown.insufficiencies).toContain('semantic-match-only');

    // The same questions give the same answers from the current index, one entry per record.
    // Entries written before the current index existed are rebuilt from the per-revision
    // index, so the entries the worker just wrote are removed first.
    for (const recordId of ['named', 'study', 'agents', 'plan']) {
      const removed = await fetch(
        `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${encodeId('tenant-demo')}/scopes/${encodeId('scope-demo')}/currentIndex/${encodeId(recordId)}`,
        { method: 'DELETE', headers: { authorization: 'Bearer owner' } },
      );
      expect(removed.ok).toBe(true);
    }
    const indexer = new MemoryIndexWorker(workerRepository, embeddings);
    expect(await indexer.advanceCurrentIndex(workerActor, 'scope-demo', 3)).toEqual({
      complete: false,
      written: 3,
    });
    expect(await indexer.advanceCurrentIndex(workerActor, 'scope-demo', 3)).toEqual({
      complete: true,
      written: 1,
    });
    expect(await indexer.advanceCurrentIndex(workerActor, 'scope-demo', 3)).toEqual({
      complete: true,
      written: 0,
    });
    const currentByName = await recall.recall(actor, 'scope-demo', { ...at, text: 'Acme' });
    expect(currentByName.items[0]?.record.id).toBe('named');
    expect(currentByName.items[0]?.matched).toContain('terms');
    expect(currentByName.items[0]?.freshness).toBe('current');
    const currentQuestion = await recall.recall(actor, 'scope-demo', {
      ...at,
      text: 'アクメーロジックの案件の進捗を教えて',
    });
    expect(currentQuestion.items[0]?.record.id).toBe('named');
    expect(currentQuestion.items[0]?.matched).toContain('alias');
    const currentUnknown = await recall.recall(actor, 'scope-demo', { ...at, text: 'Globex' });
    expect(currentUnknown.insufficiencies).toContain('semantic-match-only');

    // A new revision replaces the record's entry instead of adding one, and recall follows it.
    const renamed = fact(
      'named',
      'Initechの提示金額の食い違い',
      'Initechの提示金額は記載が矛盾している。',
    );
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'named-recall-refine',
      changes: [
        {
          kind: 'refine',
          expectedRevision: 1,
          record: {
            ...renamed,
            revision: {
              ...renamed.revision,
              revision: 2,
              changeKind: 'refine',
              recordedAt: '2026-02-01T00:00:00.000Z',
            },
          },
        },
      ],
    });
    // Until the change is indexed it is found through the overlay of unindexed changes.
    const pending = await recall.recall(actor, 'scope-demo', { ...at, text: 'Initech' });
    expect(pending.items[0]?.record.revision.revision).toBe(2);
    expect(pending.items[0]?.freshness).toBe('recent-overlay');
    expect(await indexer.runPending(workerActor, 'scope-demo')).toMatchObject({ completed: 1 });
    const indexed = await recall.recall(actor, 'scope-demo', { ...at, text: 'Initech' });
    expect(indexed.items[0]?.record.id).toBe('named');
    expect(indexed.items[0]?.matched).toContain('terms');
    expect(indexed.items[0]?.freshness).toBe('current');
    const former = await recall.recall(actor, 'scope-demo', { ...at, text: 'Acme' });
    expect(former.items.every((item) => !item.matched.includes('terms'))).toBe(true);
    // A question about the past still reads every revision's entry.
    const past = await recall.recall(actor, 'scope-demo', {
      ...at,
      knownAt: '2026-01-15T00:00:00.000Z',
      history: true,
      text: 'Acme',
    });
    expect(past.items[0]?.record.revision.revision).toBe(1);
    expect(past.items[0]?.matched).toContain('terms');
  }, 30_000);

  it('recalls indexed proposals only when selected and still enforces rights, allowance, and suppression', async () => {
    const { actor, repository, projectId, deletionLedger } = await context(
      ['work'],
      1,
      'connection',
    );
    const proposal = record({
      id: 'proposal-work',
      title: 'Private editor theme',
      statement: 'The private editor theme follows a confidential source',
      kind: 'fact',
      details: {
        kind: 'fact',
        subject: 'editor',
        claim: 'The private editor theme follows a confidential source',
      },
      lifecycle: 'candidate',
      compartmentIds: ['work'],
      attribution: { speaker: null, role: 'ai' },
      revision: {
        ...record().revision,
        writer: { kind: 'ai', id: 'assistant-demo', connectionId: actor.connectionId },
        approval: { status: 'none' },
        sourceReferences: [
          {
            provider: 'docs',
            accountOrTenant: 'private.example.test',
            resourceId: 'private-guide',
            uri: 'https://private.example.test/guide',
            rights: ['confidential'],
          },
        ],
      },
    });
    const suppressedProposal = record({
      id: 'proposal-suppressed',
      title: 'Suppressed editor theme',
      statement: 'A suppressed editor theme proposal',
      kind: 'fact',
      details: { kind: 'fact', subject: 'editor', claim: 'A suppressed editor theme proposal' },
      lifecycle: 'candidate',
      compartmentIds: [],
      attribution: { speaker: null, role: 'ai' },
      revision: {
        ...record().revision,
        writer: { kind: 'ai', id: 'assistant-demo', connectionId: actor.connectionId },
        approval: { status: 'none' },
      },
    });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'proposal-recall',
      changes: [
        { kind: 'create', record: proposal },
        { kind: 'create', record: suppressedProposal },
      ],
    });

    const workerActor = {
      ...actor,
      actorKind: 'worker',
      principalId: 'worker-demo',
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, workerActor, []);
    const workerRepository = createFirestoreMemoryRecordRepository({
      projectId,
      cursorSecret: secret,
      deletionLedger,
    });
    repositories.push(workerRepository);
    const worker = new MemoryIndexWorker(workerRepository, {
      async embed(text) {
        return { modelId: 'candidate-test', dimension: 1, values: [text.length] };
      },
    });
    expect(await worker.runPending(workerActor, 'scope-demo')).toMatchObject({
      completed: 1,
      failed: 0,
    });

    const recall = new MemoryRecallService(repository, {
      async embed(text) {
        return { modelId: 'candidate-test', dimension: 1, values: [text.length] };
      },
    });
    const recallInput = {
      validAt: '2026-03-01T00:00:00.000Z',
      knownAt: '2026-03-01T00:00:00.000Z',
      byteBudget: 10_000,
    };
    expect(
      (
        await recall.recall(actor, 'scope-demo', {
          ...recallInput,
          recordId: proposal.id,
        })
      ).items,
    ).toEqual([]);
    const included = await recall.recall(actor, 'scope-demo', {
      ...recallInput,
      recordId: proposal.id,
      includeProposals: true,
    });
    expect(included.items.map((item) => item.record.id)).toEqual(['proposal-work']);
    expect(included.items[0]?.record.revision.sourceReferences[0]?.rights).toEqual([
      'confidential',
    ]);
    expect(included.byteLength).toBe(Buffer.byteLength(JSON.stringify(included), 'utf8'));

    const restrictedActor = {
      ...actor,
      principalId: 'connection-limited',
      connectionId: 'connection-limited',
      compartmentAllowance: [],
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, restrictedActor, []);
    expect(
      (
        await recall.recall(restrictedActor, 'scope-demo', {
          ...recallInput,
          recordId: proposal.id,
          includeProposals: true,
        })
      ).items,
    ).toEqual([]);

    await seedSuppression(projectId, actor, suppressedProposal.id);
    expect(
      (
        await recall.recall(actor, 'scope-demo', {
          ...recallInput,
          recordId: suppressedProposal.id,
          includeProposals: true,
        })
      ).items,
    ).toEqual([]);

    await revokeSources(projectId, actor, ['docs\u0000private.example.test\u0000private-guide']);
    const afterRevocation = await recall.recall(actor, 'scope-demo', {
      ...recallInput,
      recordId: proposal.id,
      includeProposals: true,
    });
    expect(afterRevocation.items).toEqual([]);
    expect(afterRevocation.insufficiencies).toContain('rights-withheld');
  });

  it('allows AI corroboration only when it preserves the memory and adds a new source', async () => {
    const { actor: person, repository, projectId } = await context();
    await repository.commit(person, {
      scopeId: 'scope-demo',
      idempotencyKey: 'person-memory',
      changes: [{ kind: 'create', record: record() }],
    });
    const connection: VerifiedActorCapability = {
      tenantId: person.tenantId,
      principalId: 'connection-principal-demo',
      actorKind: 'connection',
      connectionId: person.connectionId,
      gateClientId: person.gateClientId,
      scopeIds: person.scopeIds,
      compartmentAllowance: person.compartmentAllowance,
      authorizationEpoch: person.authorizationEpoch,
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, connection, []);
    const independentSource = {
      provider: 'chat',
      accountOrTenant: 'account-demo',
      resourceId: 'second-message',
    };
    const corroborated: MemoryRecord = {
      ...record(),
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'corroborate',
        writer: { kind: 'ai', id: 'assistant-demo', connectionId: connection.connectionId },
        approval: { status: 'none' },
        recordedAt: '2026-02-01T00:00:00.000Z',
        sourceReferences: [...record().revision.sourceReferences, independentSource],
      },
    };
    await repository.commit(connection, {
      scopeId: 'scope-demo',
      idempotencyKey: 'ai-corroboration',
      changes: [{ kind: 'corroborate', expectedRevision: 1, record: corroborated }],
    });
    const altered = {
      ...corroborated,
      statement: 'Changed content',
      revision: {
        ...corroborated.revision,
        revision: 3,
        recordedAt: '2026-03-01T00:00:00.000Z',
        sourceReferences: [
          ...corroborated.revision.sourceReferences,
          { provider: 'chat', accountOrTenant: 'account-demo', resourceId: 'third-message' },
        ],
      },
    };
    await expect(
      repository.commit(connection, {
        scopeId: 'scope-demo',
        idempotencyKey: 'ai-content-change',
        changes: [{ kind: 'corroborate', expectedRevision: 2, record: altered }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(await repository.getCurrent(person, 'scope-demo', 'record-1')).toMatchObject({
      statement: record().statement,
      revision: { revision: 2 },
    });
  });

  it('does not accept model-supplied approval without controlled approval authority', async () => {
    const { actor, repository } = await context();
    const approvedRecord = record({
      revision: {
        ...record().revision,
        approval: {
          status: 'approved',
          provenance: 'person',
          protectedChangeId: 'forged-change',
        },
      },
    });
    const changes = [{ kind: 'create' as const, record: approvedRecord }];
    const unapprovedActor = {
      ...actor,
      protectedChangeApproval: {
        provenance: 'person' as const,
        protectedChangeId: 'forged-change',
        requestDigest: memoryChangeDigest('scope-demo', changes),
      },
    } as unknown as VerifiedActorCapability;
    await expect(
      repository.commit(unapprovedActor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'forged-approval',
        changes,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  it('accepts a protected change only when its persisted approval binds the exact request', async () => {
    const approvedRecord = record({
      revision: {
        ...record().revision,
        approval: {
          status: 'approved',
          provenance: 'person',
          protectedChangeId: 'change-demo',
        },
      },
    });
    const changes = [{ kind: 'create' as const, record: approvedRecord }];
    const approval = {
      provenance: 'person' as const,
      protectedChangeId: 'change-demo',
      requestDigest: memoryChangeDigest('scope-demo', changes),
    };
    const { actor, repository } = await context(['work'], 1, 'person', [], approval);
    const receipt = await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'approved-create',
      changes,
    });
    expect(receipt).toMatchObject({ sequence: 1, replayed: false });
  });

  it('denies a commit whose source rights are currently revoked', async () => {
    const source = {
      provider: 'chat',
      accountOrTenant: 'account-demo',
      resourceId: 'message-demo',
    };
    const sourceKey = `${source.provider}\u0000${source.accountOrTenant}\u0000${source.resourceId}`;
    const { actor, repository } = await context(['work'], 1, 'person', [sourceKey]);
    const sourcedRecord = record({
      revision: { ...record().revision, sourceReferences: [source] },
    });
    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'revoked-source',
        changes: [{ kind: 'create', record: sourcedRecord }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toBeNull();
  });

  it('denies writes when the stored record compartment is outside the current allowance', async () => {
    const { actor, repository, projectId } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'restricted-record',
      changes: [{ kind: 'create', record: record() }],
    });
    const authorizationPath = `memoryAuthorization/${encodeId(`${actor.tenantId}_${actor.principalId}_scope-demo`)}`;
    await patchFirestoreField(projectId, authorizationPath, 'compartmentAllowance', {
      arrayValue: { values: [] },
    });
    const narrowedActor = { ...actor, compartmentAllowance: [] } as VerifiedActorCapability;
    const update = record({
      compartmentIds: [],
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        reason: 'attempted rewrite outside prior allowance',
      },
    });
    const restricted = await repository
      .commit(narrowedActor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'rewrite-restricted-record',
        changes: [{ kind: 'refine', record: update, expectedRevision: 1 }],
      })
      .catch((error: unknown) => error);
    expect(restricted).toMatchObject({ code: 'authorization_denied' });
    const missing = record({
      id: 'missing-record',
      compartmentIds: [],
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        reason: 'attempted update of a missing record',
      },
    });
    const missingResult = await repository
      .commit(narrowedActor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'rewrite-missing-record',
        changes: [{ kind: 'refine', record: missing, expectedRevision: 1 }],
      })
      .catch((error: unknown) => error);
    expect(missingResult).toMatchObject({ code: 'authorization_denied' });
    expect((restricted as MemoryRepositoryError).code).toBe(
      (missingResult as MemoryRepositoryError).code,
    );
  });

  it.each(['refine', 'contest'] as const)(
    'does not let a connection rewrite an active user record by claiming candidate state on %s',
    async (kind) => {
      const { actor: person, repository, projectId } = await context();
      await repository.commit(person, {
        scopeId: 'scope-demo',
        idempotencyKey: `active-user-${kind}`,
        changes: [{ kind: 'create', record: record() }],
      });
      const connection = {
        ...person,
        principalId: 'connection-principal-demo',
        actorKind: 'connection' as const,
      } as unknown as VerifiedActorCapability;
      await seedAuthorization(projectId, connection, []);
      const forged = record({
        attribution: { speaker: 'assistant-demo', role: 'ai' },
        lifecycle: 'candidate',
        statement: 'Overwrite an active user decision',
        revision: {
          ...record().revision,
          revision: 2,
          changeKind: kind,
          writer: { kind: 'ai', id: 'assistant-demo', connectionId: connection.connectionId },
          recordedAt: '2026-02-01T00:00:00.000Z',
        },
      });
      await expect(
        repository.commit(connection, {
          scopeId: 'scope-demo',
          idempotencyKey: `forged-active-${kind}`,
          changes: [{ kind, record: forged, expectedRevision: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await repository.getCurrent(person, 'scope-demo', 'record-1')).toMatchObject({
        statement: record().statement,
        attribution: { role: 'user' },
        lifecycle: 'active',
        revision: { revision: 1 },
      });
    },
  );

  it('lets a connection change only its own unapproved candidate', async () => {
    const { actor: owner, repository, projectId } = await context(['work'], 1, 'connection');
    const candidate = record({
      lifecycle: 'candidate',
      attribution: { speaker: 'assistant-demo', role: 'ai' },
      revision: {
        ...record().revision,
        writer: { kind: 'ai', id: 'assistant-demo', connectionId: owner.connectionId },
        approval: { status: 'none' },
      },
    });
    await repository.commit(owner, {
      scopeId: 'scope-demo',
      idempotencyKey: 'owner-candidate',
      changes: [{ kind: 'create', record: candidate }],
    });
    const ownerUpdate = {
      ...candidate,
      statement: 'Refined by its owning connection',
      revision: {
        ...candidate.revision,
        revision: 2,
        changeKind: 'refine' as const,
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
    };
    await expect(
      repository.commit(owner, {
        scopeId: 'scope-demo',
        idempotencyKey: 'owner-candidate-refine',
        changes: [{ kind: 'refine', record: ownerUpdate, expectedRevision: 1 }],
      }),
    ).resolves.toMatchObject({ sequence: 2, replayed: false });
    const changedAttribution = {
      ...ownerUpdate,
      attribution: { speaker: 'different-assistant', role: 'ai' as const },
      revision: {
        ...ownerUpdate.revision,
        revision: 3,
        recordedAt: '2026-03-01T00:00:00.000Z',
      },
    };
    await expect(
      repository.commit(owner, {
        scopeId: 'scope-demo',
        idempotencyKey: 'owner-candidate-attribution-rewrite',
        changes: [{ kind: 'refine', record: changedAttribution, expectedRevision: 2 }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const other = {
      ...owner,
      principalId: 'other-connection-principal',
      connectionId: 'other-connection',
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, other, []);
    const attempted = {
      ...ownerUpdate,
      statement: 'Changed by another connection',
      revision: {
        ...ownerUpdate.revision,
        revision: 3,
        changeKind: 'refine' as const,
        writer: { kind: 'ai' as const, id: 'other-assistant', connectionId: other.connectionId },
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
    };
    await expect(
      repository.commit(other, {
        scopeId: 'scope-demo',
        idempotencyKey: 'other-candidate-refine',
        changes: [{ kind: 'refine', record: attempted, expectedRevision: 2 }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  it('requires a controlled approval to relax a compartment label', async () => {
    const relaxed = record({
      compartmentIds: [],
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
    });
    const protectedChangeId = 'label-relaxation-approval';
    const change = { kind: 'refine' as const, record: relaxed, expectedRevision: 1 };
    const approvedRecord = {
      ...relaxed,
      revision: {
        ...relaxed.revision,
        approval: {
          status: 'approved' as const,
          provenance: 'person' as const,
          protectedChangeId,
        },
      },
    };
    const approvedChange = { ...change, record: approvedRecord };
    const approval = {
      provenance: 'person' as const,
      protectedChangeId,
      requestDigest: memoryChangeDigest('scope-demo', [approvedChange]),
    };
    const { actor, repository } = await context(['work'], 1, 'person', [], approval);
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'label-source',
      changes: [{ kind: 'create', record: record() }],
    });
    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'unapproved-label-relaxation',
        changes: [change],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'approved-label-relaxation',
      changes: [approvedChange],
    });
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toMatchObject({
      compartmentIds: [],
      revision: { revision: 2 },
    });
  });

  it('does not let a connection relax its own candidate compartment label', async () => {
    const { actor, repository } = await context(['work'], 1, 'connection');
    const candidate = record({
      lifecycle: 'candidate',
      revision: {
        ...record().revision,
        writer: { kind: 'ai', id: 'assistant-demo', connectionId: actor.connectionId },
        approval: { status: 'none' },
      },
    });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'connection-label-source',
      changes: [{ kind: 'create', record: candidate }],
    });
    const relaxed = {
      ...candidate,
      compartmentIds: [],
      revision: {
        ...candidate.revision,
        revision: 2,
        changeKind: 'refine' as const,
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
    };
    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'connection-label-relaxation',
        changes: [{ kind: 'refine', record: relaxed, expectedRevision: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  it.each([
    ['id', 'different-record'],
    ['tenantId', 'different-tenant'],
    ['scopeId', 'different-scope'],
  ])('hides current and historical reads with a mismatched stored %s', async (field, value) => {
    const { actor, repository, projectId } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: `read-identity-${field}`,
      changes: [{ kind: 'create', record: record() }],
    });
    const documentPath = `memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-demo')}/records/${encodeId('record-1')}`;
    await patchFirestoreField(projectId, documentPath, field, { stringValue: value });
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toBeNull();
    expect(
      await repository.getHistorical(
        actor,
        'scope-demo',
        'record-1',
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).toBeNull();
  });

  it.each([
    ['id', 'different-record'],
    ['tenantId', 'different-tenant'],
    ['scopeId', 'different-scope'],
  ])(
    'hides historical reads when a stored revision %s mismatches its path',
    async (field, value) => {
      const { actor, repository, projectId } = await context();
      await repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: `history-identity-${field}`,
        changes: [{ kind: 'create', record: record() }],
      });
      const revisionPath = `memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-demo')}/records/${encodeId('record-1')}/revisions/1`;
      await patchFirestoreField(projectId, revisionPath, field, { stringValue: value });
      expect(
        await repository.getHistorical(
          actor,
          'scope-demo',
          'record-1',
          '2026-03-01T00:00:00.000Z',
          '2026-03-01T00:00:00.000Z',
        ),
      ).toBeNull();
    },
  );

  it.each([
    ['id', 'different-record'],
    ['tenantId', 'different-tenant'],
    ['scopeId', 'different-scope'],
  ])(
    'denies a write when the stored %s does not match its Firestore path',
    async (field, value) => {
      const { actor, repository, projectId } = await context();
      await repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: `stored-${field}`,
        changes: [{ kind: 'create', record: record() }],
      });
      const documentPath = `memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-demo')}/records/${encodeId('record-1')}`;
      await patchFirestoreField(projectId, documentPath, field, { stringValue: value });
      const update = record({
        revision: {
          ...record().revision,
          revision: 2,
          changeKind: 'refine',
          reason: 'attempted write through a mismatched stored record',
        },
      });
      await expect(
        repository.commit(actor, {
          scopeId: 'scope-demo',
          idempotencyKey: `write-${field}`,
          changes: [{ kind: 'refine', record: update, expectedRevision: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    },
  );

  it('rechecks source rights before returning current and historical records', async () => {
    const source = {
      provider: 'chat',
      accountOrTenant: 'account-demo',
      resourceId: 'message-demo',
    };
    const sourceKey = `${source.provider}\u0000${source.accountOrTenant}\u0000${source.resourceId}`;
    const { actor, repository, projectId } = await context();
    const sourcedRecord = record({
      revision: { ...record().revision, sourceReferences: [source] },
    });
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'source-current',
      changes: [{ kind: 'create', record: sourcedRecord }],
    });
    await revokeSources(projectId, actor, [sourceKey]);
    await expect(repository.getCurrent(actor, 'scope-demo', 'record-1')).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(
      repository.getHistorical(
        actor,
        'scope-demo',
        'record-1',
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect((await repository.getChanges(actor, 'scope-demo', null)).entries).toEqual([]);
  });

  it('binds change-feed cursors to scope, principal, epoch and allowance and rejects tampering', async () => {
    const { actor, repository } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'create',
      changes: [{ kind: 'create', record: record() }],
    });
    const page = await repository.getChanges(actor, 'scope-demo', null);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ sequence: 1, recordIds: ['record-1'] });
    await expect(
      repository.getChanges(actor, 'scope-demo', `${page.cursor}x`),
    ).rejects.toMatchObject({
      code: 'resync_required',
    });
    await expect(
      repository.getChanges({ ...actor, compartmentAllowance: [] }, 'scope-demo', page.cursor),
    ).rejects.toBeInstanceOf(MemoryRepositoryError);
  });

  it('returns content-free deletion markers in the ordered change feed', async () => {
    const { actor, repository, projectId } = await context();
    await seedDeletionMarker(projectId, actor, 1);
    const page = await repository.getChanges(actor, 'scope-demo', null);
    expect(page.entries).toEqual([
      {
        sequence: 1,
        operation: 'deletion',
        recordIds: [],
        revisionNumbers: [],
        compartmentIds: [],
      },
    ]);
  });

  it('never returns a suppressed record through current or historical reads', async () => {
    const { actor, repository, projectId } = await context();
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'create',
      changes: [{ kind: 'create', record: record() }],
    });
    await seedSuppression(projectId, actor, 'record-1');
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toBeNull();
    await expect(
      repository.commit(actor, {
        scopeId: 'scope-demo',
        idempotencyKey: 'create',
        changes: [{ kind: 'create', record: record() }],
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(
      await repository.getHistorical(
        actor,
        'scope-demo',
        'record-1',
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).toBeNull();
  });

  it('stops use only after ledger durability and replays a lost append response by inclusion', async () => {
    const requestId = 'forget-request';
    const protectedChangeApproval = {
      provenance: 'person' as const,
      protectedChangeId: 'forget-approval',
      requestDigest: memoryForgetDigest('scope-demo', 'record-1', requestId),
    };
    const { actor, repository, projectId, deletionLedger } = await context(
      ['work'],
      1,
      'person',
      [],
      protectedChangeApproval,
    );
    await repository.commit(actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'forget-target',
      changes: [{ kind: 'create', record: record() }],
    });
    // Index the record and warm the in-memory copy of the current index before the Forget.
    const indexWorker = {
      tenantId: actor.tenantId,
      actorKind: 'worker',
      principalId: 'index-worker-demo',
      connectionId: actor.connectionId,
      gateClientId: actor.gateClientId,
      scopeIds: actor.scopeIds,
      compartmentAllowance: actor.compartmentAllowance,
      authorizationEpoch: actor.authorizationEpoch,
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, indexWorker, []);
    const flatEmbeddings = {
      async embed() {
        return { modelId: 'flat-test', dimension: 2, values: [1, 1] };
      },
    };
    const indexer = new MemoryIndexWorker(repository, flatEmbeddings);
    expect(await indexer.runPending(indexWorker, 'scope-demo')).toMatchObject({ completed: 1 });
    expect(await indexer.advanceCurrentIndex(indexWorker, 'scope-demo')).toMatchObject({
      complete: true,
    });
    const recallBeforeForget = new MemoryRecallService(repository, flatEmbeddings);
    const now = new Date().toISOString();
    const present = { validAt: now, knownAt: now, byteBudget: 10_000, text: 'Memory Records' };
    expect((await recallBeforeForget.recall(actor, 'scope-demo', present)).items).toHaveLength(1);
    const scopeDocuments = `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${encodeId('tenant-demo')}/scopes/${encodeId('scope-demo')}`;
    const readDocument = (path: string) =>
      fetch(`${scopeDocuments}/${path}`, { headers: { authorization: 'Bearer owner' } });
    expect((await readDocument(`currentIndex/${encodeId('record-1')}`)).status).toBe(200);

    deletionLedger.loseNextAppendResponse = true;
    expect(await repository.forget(actor, 'scope-demo', 'record-1', requestId)).toEqual({
      status: 'pending',
      requestId,
    });
    expect(deletionLedger.entries).toHaveProperty('size', 1);
    await expect(repository.getCurrent(actor, 'scope-demo', 'record-1')).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    expect(await repository.forget(actor, 'scope-demo', 'record-1', requestId)).toEqual({
      status: 'stopped',
      requestId,
    });
    expect(await repository.getCurrent(actor, 'scope-demo', 'record-1')).toBeNull();
    const worker = {
      tenantId: actor.tenantId,
      actorKind: 'worker',
      principalId: 'worker-demo',
      connectionId: actor.connectionId,
      gateClientId: actor.gateClientId,
      scopeIds: actor.scopeIds,
      compartmentAllowance: actor.compartmentAllowance,
      authorizationEpoch: actor.authorizationEpoch,
    } as unknown as VerifiedActorCapability;
    await seedAuthorization(projectId, worker, []);
    expect(await repository.reconcileRestore(worker, 'scope-demo')).toBe(1);
    expect(
      await repository.purge(worker, 'scope-demo', [...deletionLedger.entries.keys()][0]!),
    ).toBe(true);
    expect(await deletionLedger.head()).toBe(1);
    expect((await repository.getChanges(worker, 'scope-demo', null)).entries).toEqual([
      expect.objectContaining({ operation: 'deletion', recordIds: [] }),
    ]);
    // The purge removes the record's current-index entry and moves the scope's generation, so
    // no process keeps the forgotten record's derived terms or embedding in memory.
    expect((await readDocument(`currentIndex/${encodeId('record-1')}`)).status).toBe(404);
    const state = (await (await readDocument('metadata/currentIndex')).json()) as {
      fields: { generation?: { integerValue: string } };
    };
    expect(Number(state.fields.generation?.integerValue)).toBeGreaterThanOrEqual(1);
    expect((await recallBeforeForget.recall(actor, 'scope-demo', present)).items).toHaveLength(0);
  });

  it('keeps a pre-Forget backup closed during ledger outage, then applies the retried deletion', async () => {
    const requestId = 'restore-after-outage';
    const ledger = new TestDeletionLedger();
    const approval = {
      provenance: 'person' as const,
      protectedChangeId: 'outage-approval',
      requestDigest: memoryForgetDigest('scope-demo', 'record-1', requestId),
    };
    const source = await context(['work'], 1, 'person', [], approval, ledger);
    const restored = await context(['work'], 1, 'worker', [], undefined, ledger);
    await source.repository.commit(source.actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'outage-backup-source',
      changes: [{ kind: 'create', record: record() }],
    });
    await copyRecordBackup(source.projectId, restored.projectId);

    ledger.unavailable = true;
    expect(
      await source.repository.forget(source.actor, 'scope-demo', 'record-1', requestId),
    ).toEqual({
      status: 'pending',
      requestId,
    });
    await expect(
      restored.repository.getCurrent(restored.actor, 'scope-demo', 'record-1'),
    ).rejects.toThrow();
    ledger.unavailable = false;
    expect(
      await source.repository.forget(source.actor, 'scope-demo', 'record-1', requestId),
    ).toEqual({
      status: 'stopped',
      requestId,
    });
    expect(await restored.repository.reconcileRestore(restored.actor, 'scope-demo')).toBe(1);
    expect(
      await restored.repository.getCurrent(restored.actor, 'scope-demo', 'record-1'),
    ).toBeNull();
  });

  it('applies a durable ledger entry to a pre-Forget backup when its append response was lost', async () => {
    const requestId = 'restore-after-lost-response';
    const ledger = new TestDeletionLedger();
    const approval = {
      provenance: 'person' as const,
      protectedChangeId: 'lost-response-approval',
      requestDigest: memoryForgetDigest('scope-demo', 'record-1', requestId),
    };
    const source = await context(['work'], 1, 'person', [], approval, ledger);
    const restored = await context(['work'], 1, 'worker', [], undefined, ledger);
    await source.repository.commit(source.actor, {
      scopeId: 'scope-demo',
      idempotencyKey: 'lost-response-backup-source',
      changes: [{ kind: 'create', record: record() }],
    });
    await copyRecordBackup(source.projectId, restored.projectId);

    ledger.loseNextAppendResponse = true;
    expect(
      await source.repository.forget(source.actor, 'scope-demo', 'record-1', requestId),
    ).toEqual({
      status: 'pending',
      requestId,
    });
    expect(await ledger.head()).toBe(1);
    await expect(
      restored.repository.getCurrent(restored.actor, 'scope-demo', 'record-1'),
    ).rejects.toThrow();
    expect(await restored.repository.reconcileRestore(restored.actor, 'scope-demo')).toBe(1);
    expect(
      await restored.repository.getCurrent(restored.actor, 'scope-demo', 'record-1'),
    ).toBeNull();
  });
});
