import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  AccessDeniedError,
  authorizationDocumentId,
  connectionPrincipalIds,
  createFirestoreClient,
  MEMORY_AUTHORIZATION_COLLECTION,
  createMemoryRecordsRuntime,
  ObservationService,
  type ConnectionAccess,
  type MemoryRecordsRuntime,
} from '../packages/memory-records/src/index.js';
import { DeterministicEmbeddingProvider } from '../apps/api/src/embeddings.js';

const run = promisify(execFile);
const projectId = `demo-wsp-${randomUUID().slice(0, 8)}`;
const databaseId = 'lore-workspaces';
const issuer = 'https://example.test';
const subject = 'synthetic-owner';
const tenant = 'synthetic';
const scope = 'personal';

interface CliResult {
  readonly code: number;
  // The CLI prints JSON whose shape depends on the command.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly output: any;
}

async function cli(...args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await run(
      process.execPath,
      [
        'scripts/manage-connections.mjs',
        ...args,
        '--project',
        projectId,
        '--database',
        databaseId,
        '--issuer',
        issuer,
        '--subject',
        subject,
      ],
      { env: process.env },
    );
    return { code: 0, output: JSON.parse(stdout) };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, output: JSON.parse(failure.stderr?.split('\n')[0] ?? '{}') };
  }
}

const base64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

let runtime: MemoryRecordsRuntime;
let service: ObservationService;
let firestore: ReturnType<typeof createFirestoreClient>;
let northwind: string;
let cedar: string;
let cedarConnection: string;
let owner: ConnectionAccess;
let cedarOnly: ConnectionAccess;
const ids: Record<string, string> = {};

function resolve(connectionId: string): Promise<ConnectionAccess> {
  return runtime.access.resolve({ issuer, subject, connectionId, clientId: 'shared-ai' });
}

beforeAll(async () => {
  await run(
    process.execPath,
    [
      'scripts/admit-subject.mjs',
      '--project',
      projectId,
      '--database',
      databaseId,
      '--issuer',
      issuer,
      '--subject',
      subject,
      '--tenant',
      tenant,
      '--scope',
      scope,
    ],
    { env: process.env },
  );
  runtime = createMemoryRecordsRuntime({
    projectId,
    databaseId,
    ledgerDatabaseId: 'lore-workspace-deletions',
    cursorSecret: Buffer.alloc(32, 7),
  });
  service = new ObservationService({
    ledger: runtime.observations,
    access: runtime.access,
    embeddings: new DeterministicEmbeddingProvider(),
    log: () => {},
  });
  firestore = createFirestoreClient({ projectId, databaseId });
});

afterAll(async () => {
  await service?.close();
  await runtime?.close();
  await firestore?.terminate();
});

describe('workspace and connection registry', () => {
  it('creates workspaces and connections through the operator tool', async () => {
    const init = await cli('init', '--note', 'synthetic setup');
    expect(init.code).toBe(0);
    expect(init.output.result).toMatchObject({
      id: 'default',
      path: '/mcp',
      allowance: ['inbox', 'workspaces:all'],
      active: true,
    });

    const first = await cli(
      'create-workspace',
      '--name',
      'Northwind',
      '--description',
      'Company A',
    );
    const second = await cli('create-workspace', '--name', 'Cedar');
    expect(first.code).toBe(0);
    northwind = first.output.result.id;
    cedar = second.output.result.id;
    expect(northwind).toMatch(/^wsp_[a-f0-9]{32}$/u);

    const duplicate = await cli('create-workspace', '--name', '  ｎｏｒｔｈｗｉｎｄ ');
    expect(duplicate).toMatchObject({ code: 1, output: { error: 'conflict' } });

    const notGranted = await cli(
      'set-connection',
      '--connection',
      'new',
      '--workspaces',
      cedar,
      '--default-workspace',
      northwind,
    );
    expect(notGranted).toMatchObject({ code: 1, output: { error: 'invalid_input' } });
    const noDefault = await cli('set-connection', '--connection', 'new', '--workspaces', cedar);
    expect(noDefault).toMatchObject({ code: 1, output: { error: 'invalid_input' } });
    const unknownWorkspace = await cli(
      'set-connection',
      '--connection',
      'new',
      '--workspaces',
      `wsp_${'0'.repeat(32)}`,
      '--inbox',
    );
    expect(unknownWorkspace).toMatchObject({ code: 1, output: { error: 'not_found' } });
    const unknownConnection = await cli(
      'set-connection',
      '--connection',
      `con_${'0'.repeat(32)}`,
      '--workspaces',
      cedar,
      '--default-workspace',
      cedar,
    );
    expect(unknownConnection).toMatchObject({ code: 1, output: { error: 'not_found' } });

    const created = await cli(
      'set-connection',
      '--connection',
      'new',
      '--workspaces',
      cedar,
      '--default-workspace',
      cedar,
    );
    expect(created.code).toBe(0);
    cedarConnection = created.output.result.id;
    expect(created.output.result).toMatchObject({
      path: `/mcp/c/${cedarConnection}`,
      allowance: [cedar],
      epoch: 1,
      active: true,
    });

    const shown = await cli('show');
    expect(shown.output.result.workspaces.map((item: { name: string }) => item.name)).toEqual([
      'Cedar',
      'Northwind',
    ]);
    expect(shown.output.result.connections).toHaveLength(2);
    const history = await firestore
      .collection('memoryTenants')
      .doc(base64url(tenant))
      .collection('scopes')
      .doc(base64url(scope))
      .collection('accessHistory')
      .get();
    // init (worker and default), two workspaces and one connection.
    expect(history.size).toBe(5);
  });
});

describe('workspace labels on observations', () => {
  it('limits a connection to its granted workspaces and keeps Shared and Inbox apart', async () => {
    owner = await resolve('shared-ai');
    cedarOnly = await resolve(cedarConnection);
    expect(service.describeAccess(owner).compartment_allowance).toEqual([
      'inbox',
      'workspaces:all',
    ]);
    expect(service.describeAccess(cedarOnly).compartment_allowance).toEqual([cedar]);

    const write = async (
      access: ConnectionAccess,
      key: string,
      summary: string,
      compartmentIds?: string[],
    ) => {
      const saved = await service.observe(access, {
        title: key,
        summary,
        nature: 'event',
        asUser: false,
        subjects: [`Subject ${key}`],
        idempotencyKey: key,
        ...(compartmentIds === undefined ? {} : { compartmentIds }),
      });
      ids[key] = saved.observation_id;
    };
    await write(owner, 'inbox-note', 'Quartz pricing note awaiting a company.');
    await write(owner, 'northwind-fact', 'Quartz negotiation price for the retail deal.', [
      northwind,
    ]);
    await write(owner, 'cedar-fact', 'Quartz renewal schedule for the platform.', [cedar]);
    await write(cedarOnly, 'cedar-own', 'Quartz onboarding checklist written in Cedar.', [cedar]);

    for (const key of ['inbox-note', 'northwind-fact', 'cedar-fact', 'cedar-own'])
      await expect(service.getObservation(owner, ids[key]!)).resolves.toBeDefined();
    await expect(service.getObservation(cedarOnly, ids['cedar-fact']!)).resolves.toBeDefined();
    await expect(service.getObservation(cedarOnly, ids['northwind-fact']!)).rejects.toThrow();
    await expect(service.getObservation(cedarOnly, ids['inbox-note']!)).rejects.toThrow();

    // Term search reaches labeled observations because the worker reads every label.
    const found = (access: ConnectionAccess) =>
      service
        .recall(access, { query: 'quartz', limit: 30 })
        .then((result) =>
          result.items.flatMap((item) =>
            'observation' in item && item.observation !== undefined
              ? [item.observation.observation_id]
              : [],
          ),
        );
    expect(new Set(await found(owner))).toEqual(
      new Set([ids['inbox-note'], ids['northwind-fact'], ids['cedar-fact'], ids['cedar-own']]),
    );
    expect(new Set(await found(cedarOnly))).toEqual(new Set([ids['cedar-fact'], ids['cedar-own']]));

    const feed = await service.getChanges(cedarOnly, undefined, 100);
    expect(new Set(feed.entries.flatMap((entry) => entry.recordIds))).toEqual(
      new Set([ids['cedar-fact'], ids['cedar-own']]),
    );

    // A connection cannot write outside its grant, and without the Inbox grant not to the Inbox.
    await expect(
      service.observe(cedarOnly, {
        title: 'Outside',
        summary: 'A Northwind write from the Cedar connection.',
        nature: 'event',
        asUser: false,
        subjects: ['Outside'],
        idempotencyKey: 'outside',
        compartmentIds: [northwind],
      }),
    ).rejects.toThrow();
    await expect(
      service.observe(cedarOnly, {
        title: 'Inbox',
        summary: 'An Inbox write from the Cedar connection.',
        nature: 'event',
        asUser: false,
        subjects: ['Inbox'],
        idempotencyKey: 'inbox-from-cedar',
      }),
    ).rejects.toThrow();
  });

  it('reads an observation stored before labels existed as an Inbox item', async () => {
    await service.observe(owner, {
      title: 'Legacy',
      summary: 'Basalt note written before workspaces.',
      nature: 'event',
      asUser: false,
      subjects: ['Legacy'],
      idempotencyKey: 'legacy',
    });
    const scopeRef = firestore
      .collection('memoryTenants')
      .doc(base64url(tenant))
      .collection('scopes')
      .doc(base64url(scope));
    const observation = (
      await scopeRef.collection('observations').where('title', '==', 'Legacy').get()
    ).docs[0]!;
    const observationId = String(observation.get('id'));
    const index = await scopeRef
      .collection('observationIndex')
      .where('observationId', '==', observationId)
      .get();
    const changes = await scopeRef
      .collection('changes')
      .where('recordIds', 'array-contains', observationId)
      .get();
    expect(index.size).toBe(1);
    expect(changes.size).toBe(1);
    // Rewrite the documents without labels, as they were stored before ADR 0012, with General [].
    const withoutLabel = async (document: (typeof index.docs)[number]) => {
      const rest = { ...document.data() };
      delete rest['label'];
      await document.ref.set({ ...rest, compartmentIds: [] });
    };
    await withoutLabel(observation);
    await withoutLabel(index.docs[0]!);
    await withoutLabel(changes.docs[0]!);

    await expect(service.getObservation(owner, observationId)).resolves.toBeDefined();
    await expect(service.getObservation(cedarOnly, observationId)).rejects.toThrow();
    const cedarFound = await service.recall(cedarOnly, { query: 'basalt', limit: 30 });
    expect(JSON.stringify(cedarFound)).not.toContain(observationId);
    const ownerFound = await service.recall(owner, { query: 'basalt', limit: 30 });
    expect(JSON.stringify(ownerFound)).toContain(observationId);
    const feed = await service.getChanges(cedarOnly, undefined, 100);
    expect(feed.entries.flatMap((entry) => entry.recordIds)).not.toContain(observationId);
  });

  it('denies a further connection that was never provisioned and creates nothing for it', async () => {
    const unknown = `con_${'1'.repeat(32)}`;
    await expect(resolve(unknown)).rejects.toBeInstanceOf(AccessDeniedError);
    const principals = connectionPrincipalIds(issuer, subject, unknown);
    for (const principalId of [principals.connection, principals.person]) {
      const document = await firestore
        .collection(MEMORY_AUTHORIZATION_COLLECTION)
        .doc(authorizationDocumentId(tenant, principalId, scope))
        .get();
      expect(document.exists).toBe(false);
    }
  });

  it('makes a changed or deactivated grant take effect on the next request', async () => {
    const before = cedarOnly;
    const widened = await cli(
      'set-connection',
      '--connection',
      cedarConnection,
      '--workspaces',
      `${cedar},${northwind}`,
      '--default-workspace',
      cedar,
    );
    expect(widened.output.result).toMatchObject({ epoch: 2, allowance: [cedar, northwind].sort() });
    await expect(service.getObservation(before, ids['cedar-fact']!)).rejects.toThrow();
    const after = await resolve(cedarConnection);
    await expect(service.getObservation(after, ids['northwind-fact']!)).resolves.toBeDefined();
    await expect(service.getObservation(after, ids['inbox-note']!)).rejects.toThrow();

    const deactivated = await cli('deactivate-connection', '--connection', cedarConnection);
    expect(deactivated.output.result).toMatchObject({ active: false, epoch: 3 });
    await expect(resolve(cedarConnection)).rejects.toThrow();
    await expect(cli('deactivate-connection', '--connection', 'default')).resolves.toMatchObject({
      code: 1,
      output: { error: 'invalid_input' },
    });
  });
});
