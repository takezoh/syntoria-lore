import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createFirestoreMemoryRecordRepository,
  MemoryCaptureService,
  type DeletionLedger,
  type DeletionLedgerSnapshot,
  type FirestoreMemoryRecordRepository,
  type MemoryRecord,
  type SourceReference,
  type VersionedExtraction,
  type VerifiedActorCapability,
} from '../packages/memory-records/src/index.js';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
const repositories: FirestoreMemoryRecordRepository[] = [];
const uniqueBody = 'transient capture text must never be written to Firestore';

class TestDeletionLedger implements DeletionLedger {
  async append(): Promise<void> {}
  async includes(): Promise<boolean> {
    return false;
  }
  async head(): Promise<number> {
    return 0;
  }
  async snapshot(): Promise<DeletionLedgerSnapshot> {
    return { head: 0, entries: [] };
  }
}

function encodeId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function documents(projectId: string, collectionPath: string) {
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/${collectionPath}`,
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not list Firestore documents: ${response.status}`);
  }
  if (!response.ok) return [] as Array<{ name: string; fields?: unknown }>;
  const body = (await response.json()) as { documents?: Array<{ name: string; fields?: unknown }> };
  return body.documents ?? [];
}

async function allCaptureDocuments(projectId: string, tenantId: string, scopeId: string) {
  const found = await documents(projectId, 'memoryAuthorization');
  const tenantPath = `memoryTenants/${encodeId(tenantId)}`;
  found.push(...(await documents(projectId, 'memoryTenants')));
  const scopePath = `${tenantPath}/scopes/${encodeId(scopeId)}`;
  found.push(...(await documents(projectId, `${tenantPath}/scopes`)));
  found.push(...(await documents(projectId, `${scopePath}/captureJobs`)));
  found.push(...(await documents(projectId, `${scopePath}/changes`)));
  found.push(...(await documents(projectId, `${scopePath}/indexJobs`)));
  found.push(...(await documents(projectId, `${scopePath}/idempotency`)));
  found.push(...(await documents(projectId, `${scopePath}/management`)));
  const records = await documents(projectId, `${scopePath}/records`);
  found.push(...records);
  for (const record of records) {
    found.push(...(await documents(projectId, `${record.name}/revisions`)));
  }
  return found;
}

async function context() {
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  const projectId = `demo-capture-${process.pid}-${randomUUID().replaceAll('-', '')}`;
  const actor = {
    tenantId: 'tenant-capture',
    principalId: 'connection-capture',
    actorKind: 'connection',
    connectionId: 'connection-capture',
    gateClientId: 'client-capture',
    scopeIds: ['scope-capture'],
    compartmentAllowance: ['work'],
    authorizationEpoch: 1,
  } as unknown as VerifiedActorCapability;
  const repository = createFirestoreMemoryRecordRepository({
    projectId,
    cursorSecret: Buffer.alloc(32, 8),
    deletionLedger: new TestDeletionLedger(),
  });
  repositories.push(repository);
  const response = await fetch(
    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryAuthorization?documentId=${encodeId('tenant-capture_connection-capture_scope-capture')}`,
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
          authorizationEpoch: { integerValue: '1' },
          compartmentAllowance: { arrayValue: { values: [{ stringValue: 'work' }] } },
          revokedSourceReferences: { arrayValue: { values: [] } },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Could not seed authorization: ${response.status}`);
  return { actor, projectId, repository };
}

const source: SourceReference = {
  provider: 'chat',
  accountOrTenant: 'account-capture',
  resourceId: 'source-capture',
  lineage: ['lineage-capture'],
};

function captureService(repository: FirestoreMemoryRecordRepository, enabled = true) {
  return new MemoryCaptureService(
    repository,
    {
      async isEnabledAndConsented({ syncRange }) {
        return enabled && syncRange.from < syncRange.until;
      },
      async fetch() {
        return {
          text: uniqueBody,
          version: 'v1',
          compartmentIds: ['work'],
          locations: [
            {
              locator: 'message:0',
              start: 0,
              end: uniqueBody.length,
              speaker: 'Morgan',
              speakerRole: 'third-party',
            },
          ],
        };
      },
    },
    {
      async extract() {
        return {
          modelVersion: 'extractor-test-v1',
          promptVersion: 'capture-prompt-v1',
          proposals: [
            {
              kind: 'fact',
              title: 'A transiently captured fact',
              statement: 'Capture preserves the fact as an AI proposal',
              details: {
                kind: 'fact',
                subject: 'system',
                claim: 'Capture preserves the fact as an AI proposal',
              },
              subjectIds: ['system'],
              aliases: [],
              assumptions: [],
              attribution: { speaker: 'self-claimed-user', role: 'user' },
              valid: { from: null, until: null },
              compartmentIds: [],
              spans: [
                { locator: 'message:0', start: 0, end: uniqueBody.length, quote: uniqueBody },
              ],
            },
          ],
        };
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
});

describe('Memory Record capture', () => {
  it('stores a held candidate and capture metadata without persisting fetched source text', async () => {
    const { actor, projectId, repository } = await context();
    const service = captureService(repository);
    const result = await service.capture(actor, {
      scopeId: 'scope-capture',
      jobId: 'job-capture-1',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    });

    expect(result.job.status).toBe('committed');
    expect(result.job.modelVersion).toBe('extractor-test-v1');
    expect(result.job.promptVersion).toBe('capture-prompt-v1');
    expect(result.receipt?.recordIds).toHaveLength(1);
    const saved = await allCaptureDocuments(projectId, actor.tenantId, 'scope-capture');
    const body = JSON.stringify(saved);
    expect(body).toContain('"compartmentIds":{"arrayValue":{"values":[{"stringValue":"work"}]}}');
    expect(body).toContain('"speaker":{"stringValue":"Morgan"}');
    expect(body).toContain('"role":{"stringValue":"third-party"}');
    expect(body).not.toContain('self-claimed-user');
    const generalOnlyActor = {
      ...actor,
      principalId: 'connection-capture-general',
      connectionId: 'connection-capture-general',
      compartmentAllowance: [],
    } as VerifiedActorCapability;
    const authorizationResponse = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryAuthorization?documentId=${encodeId('tenant-capture_connection-capture-general_scope-capture')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fields: {
            active: { booleanValue: true },
            tenantId: { stringValue: generalOnlyActor.tenantId },
            principalId: { stringValue: generalOnlyActor.principalId },
            actorKind: { stringValue: generalOnlyActor.actorKind },
            connectionId: { stringValue: generalOnlyActor.connectionId },
            gateClientId: { stringValue: generalOnlyActor.gateClientId },
            authorizationEpoch: { integerValue: '1' },
            compartmentAllowance: { arrayValue: {} },
            revokedSourceReferences: { arrayValue: {} },
          },
        }),
      },
    );
    expect(authorizationResponse.ok).toBe(true);
    const proposalIdentity = {
      kind: 'fact' as const,
      statement: 'Capture preserves the fact as an AI proposal',
      subjectIds: ['system'],
      valid: { from: null, until: null },
    };
    expect(
      await repository.findCaptureMatch(actor, 'scope-capture', proposalIdentity),
    ).not.toBeNull();
    expect(
      await repository.findCaptureMatch(generalOnlyActor, 'scope-capture', proposalIdentity),
    ).toBeNull();
    expect(saved.length).toBeGreaterThan(5);
    expect(body).not.toContain(uniqueBody);
    expect(body).toContain('candidate');
    expect(body).toContain('message:0');
  });

  it('commits explicit remember synchronously without calling extraction', async () => {
    const { actor, projectId, repository } = await context();
    let extractionCalls = 0;
    const service = new MemoryCaptureService(
      repository,
      {
        async isEnabledAndConsented() {
          return false;
        },
        async fetch() {
          throw new Error('explicit remember must not fetch sources');
        },
      },
      {
        async extract() {
          extractionCalls += 1;
          throw new Error('explicit remember must not extract');
        },
      },
    );
    const record: MemoryRecord = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      scopeId: 'scope-capture',
      schemaVersion: 1,
      kind: 'fact',
      title: 'Explicit remember',
      statement: 'An explicit remember is committed directly',
      details: {
        kind: 'fact',
        subject: 'capture',
        claim: 'An explicit remember is committed directly',
      },
      subjectIds: ['capture'],
      aliases: [],
      assumptions: [],
      attribution: { speaker: 'assistant', role: 'ai' },
      lifecycle: 'candidate',
      contested: false,
      needsRecheck: false,
      suppressed: false,
      valid: { from: null, until: null },
      compartmentIds: ['work'],
      supersedes: null,
      supersededBy: null,
      revision: {
        revision: 1,
        changeKind: 'create',
        reason: 'Explicit remember request',
        writer: { kind: 'ai', id: 'assistant-capture', connectionId: actor.connectionId },
        approval: { status: 'none' },
        requestingConnectionId: null,
        gateClientId: null,
        recordedAt: new Date().toISOString(),
        sourceReferences: [],
      },
    };
    const receipt = await service.remember(actor, {
      scopeId: 'scope-capture',
      idempotencyKey: 'explicit-capture-1',
      changes: [{ kind: 'create', record }],
    });
    expect(receipt.sequence).toBe(1);
    expect(extractionCalls).toBe(0);
    const saved = await documents(
      projectId,
      `memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-capture')}/records`,
    );
    expect(saved).toHaveLength(1);
  });

  it('holds a proposal when the quoted text does not match at the cited span', async () => {
    const { actor, repository } = await context();
    const service = new MemoryCaptureService(
      repository,
      {
        async isEnabledAndConsented() {
          return true;
        },
        async fetch() {
          return {
            text: uniqueBody,
            version: 'v1',
            compartmentIds: ['work'],
            locations: [{ locator: 'message:0', start: 0, end: uniqueBody.length }],
          };
        },
      },
      {
        async extract() {
          return {
            modelVersion: 'extractor-test-v1',
            promptVersion: 'capture-prompt-v1',
            proposals: [
              {
                kind: 'fact',
                title: 'bad quote',
                statement: 'Not supported',
                details: { kind: 'fact', subject: 'system', claim: 'Not supported' },
                subjectIds: ['system'],
                aliases: [],
                assumptions: [],
                attribution: { speaker: null, role: 'unknown' },
                valid: { from: null, until: null },
                compartmentIds: ['work'],
                spans: [{ locator: 'message:0', start: 0, end: 5, quote: 'wrong' }],
              },
            ],
          };
        },
      },
    );
    const result = await service.capture(actor, {
      scopeId: 'scope-capture',
      jobId: 'job-capture-bad-quote',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    });
    expect(result.job.status).toBe('held');
    expect(result.job.reason).toContain('does not match');
  });

  it('does not create a second record when the same source lineage is resubmitted', async () => {
    const { actor, projectId, repository } = await context();
    const service = captureService(repository);
    const request = {
      scopeId: 'scope-capture',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    };
    await service.capture(actor, { ...request, jobId: 'job-capture-first' });
    const replay = await service.capture(actor, { ...request, jobId: 'job-capture-second' });
    expect(replay.job.status).toBe('committed');
    expect(replay.receipt).toBeUndefined();
    const response = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-capture')}/records`,
    );
    const documents = (await response.json()) as { documents?: unknown[] };
    expect(documents.documents).toHaveLength(1);
  });

  it('holds capture when the source is not enabled with consent for the requested range', async () => {
    const { actor, repository } = await context();
    const result = await captureService(repository, false).capture(actor, {
      scopeId: 'scope-capture',
      jobId: 'job-capture-disabled',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    });
    expect(result.job.status).toBe('held');
    expect(result.job.reason).toContain('enabled with consent');
  });

  it('holds source failures after bounded retries without persisting provider error text', async () => {
    const { actor, projectId, repository } = await context();
    let attempts = 0;
    const service = new MemoryCaptureService(
      repository,
      {
        async isEnabledAndConsented() {
          return true;
        },
        async fetch() {
          attempts += 1;
          throw new Error(uniqueBody);
        },
      },
      {
        async extract() {
          throw new Error('extractor should not run');
        },
      },
    );
    const result = await service.capture(actor, {
      scopeId: 'scope-capture',
      jobId: 'job-capture-fetch-failure',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    });
    expect(attempts).toBe(2);
    expect(result.job.status).toBe('held');
    expect(result.job.reason).toContain('Source fetch failed');
    const jobs = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-capture')}/captureJobs`,
    );
    expect(await jobs.text()).not.toContain(uniqueBody);
  });

  it('holds extractor failures after bounded retries', async () => {
    const { actor, projectId, repository } = await context();
    let attempts = 0;
    const service = new MemoryCaptureService(
      repository,
      {
        async isEnabledAndConsented() {
          return true;
        },
        async fetch() {
          return {
            text: uniqueBody,
            version: 'v1',
            compartmentIds: ['work'],
            locations: [{ locator: 'message:0', start: 0, end: uniqueBody.length }],
          };
        },
      },
      {
        async extract() {
          attempts += 1;
          const error = new Error('provider unavailable');
          error.name = uniqueBody;
          throw error;
        },
      },
    );
    const result = await service.capture(actor, {
      scopeId: 'scope-capture',
      jobId: 'job-capture-extractor-failure',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    });
    expect(attempts).toBe(2);
    expect(result.job.status).toBe('held');
    expect(result.job.reason).toContain('Extractor failed');
    expect(result.job.reason).not.toContain(uniqueBody);
    const saved = await allCaptureDocuments(projectId, actor.tenantId, 'scope-capture');
    expect(JSON.stringify(saved)).not.toContain(uniqueBody);
  });

  it('holds malformed extractor versions and proposal entries', async () => {
    const { actor, repository } = await context();
    const malformed: unknown[] = [
      { modelVersion: 7, promptVersion: 'prompt-v1', proposals: [] },
      { modelVersion: 'model-v1', promptVersion: 'prompt-v1', proposals: [null] },
    ];
    for (const [index, output] of malformed.entries()) {
      const service = new MemoryCaptureService(
        repository,
        {
          async isEnabledAndConsented() {
            return true;
          },
          async fetch() {
            return {
              text: uniqueBody,
              version: 'v1',
              compartmentIds: ['work'],
              locations: [{ locator: 'message:0', start: 0, end: uniqueBody.length }],
            };
          },
        },
        {
          async extract() {
            return output as VersionedExtraction;
          },
        },
      );
      const result = await service.capture(actor, {
        scopeId: 'scope-capture',
        jobId: `job-capture-malformed-${index}`,
        source,
        syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
      });
      expect(result.job.status).toBe('held');
      expect(result.job.reason).toContain('invalid versioned result');
      expect(result.job.reason).not.toContain(uniqueBody);
    }
  });

  it('reuses prepared changes after a lost commit response without duplicating records', async () => {
    const { actor, projectId, repository } = await context();
    const originalCommit = repository.commit.bind(repository);
    let loseResponse = true;
    const flakyRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (...args: Parameters<typeof repository.commit>) => {
            const receipt = await originalCommit(...args);
            if (loseResponse) {
              loseResponse = false;
              throw new Error('response lost after durable commit');
            }
            return receipt;
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as FirestoreMemoryRecordRepository;
    const request = {
      scopeId: 'scope-capture',
      jobId: 'job-capture-lost-response',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    };
    const held = await captureService(flakyRepository).capture(actor, request);
    expect(held.job.status).toBe('held');
    const replay = await captureService(repository).capture(actor, request);
    expect(replay.job.status).toBe('committed');
    expect(replay.receipt?.replayed).toBe(true);
    const response = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-capture')}/records`,
    );
    const documents = (await response.json()) as { documents?: unknown[] };
    expect(documents.documents).toHaveLength(1);
  });

  it('holds prepared changes when consent is withdrawn before retry', async () => {
    const { actor, projectId, repository } = await context();
    const originalCommit = repository.commit.bind(repository);
    let failBeforeCommit = true;
    const failingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (...args: Parameters<typeof repository.commit>) => {
            if (failBeforeCommit) {
              failBeforeCommit = false;
              throw new Error('temporary commit failure');
            }
            return originalCommit(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as FirestoreMemoryRecordRepository;
    const request = {
      scopeId: 'scope-capture',
      jobId: 'job-capture-consent-withdrawn',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    };

    const firstAttempt = await captureService(failingRepository).capture(actor, request);
    expect(firstAttempt.job.status).toBe('held');
    expect(firstAttempt.job.preparedChanges).toHaveLength(1);

    const retry = await captureService(repository, false).capture(actor, request);
    expect(retry.job.status).toBe('held');
    expect(retry.job.reason).toBe('Source is not enabled with consent for this sync range');

    const records = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-capture')}/records`,
    );
    const body = (await records.json()) as { documents?: unknown[] };
    expect(body.documents ?? []).toHaveLength(0);
  });

  it('reconciles a lost commit response after consent is withdrawn', async () => {
    const { actor, projectId, repository } = await context();
    const originalCommit = repository.commit.bind(repository);
    let loseResponse = true;
    const flakyRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (...args: Parameters<typeof repository.commit>) => {
            const receipt = await originalCommit(...args);
            if (loseResponse) {
              loseResponse = false;
              throw new Error('response lost after durable commit');
            }
            return receipt;
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as FirestoreMemoryRecordRepository;
    const request = {
      scopeId: 'scope-capture',
      jobId: 'job-capture-lost-response-consent-withdrawn',
      source,
      syncRange: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' },
    };

    const firstAttempt = await captureService(flakyRepository).capture(actor, request);
    expect(firstAttempt.job.status).toBe('held');
    expect(firstAttempt.job.preparedChanges).toHaveLength(1);

    const retry = await captureService(repository, false).capture(actor, request);
    expect(retry.job.status).toBe('committed');
    expect(retry.receipt?.replayed).toBe(true);
    expect(retry.job.preparedChanges).toBeNull();

    const records = await fetch(
      `http://${host}/v1/projects/${projectId}/databases/(default)/documents/memoryTenants/${encodeId(actor.tenantId)}/scopes/${encodeId('scope-capture')}/records`,
    );
    const body = (await records.json()) as { documents?: unknown[] };
    expect(body.documents).toHaveLength(1);
  });
});
