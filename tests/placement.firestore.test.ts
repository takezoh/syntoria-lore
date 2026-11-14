import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  admissionDocumentId,
  createFirestoreClient,
  createMemoryRecordsRuntime,
  MemoryServiceError,
  ObservationService,
  type ConnectionAccess,
  type MemoryRecordsRuntime,
  type ObserveInput,
} from '../packages/memory-records/src/index.js';
import { DeterministicEmbeddingProvider } from '../apps/api/src/embeddings.js';

const run = promisify(execFile);
const projectId = `demo-place-${randomUUID().slice(0, 8)}`;
const databaseId = 'lore-placement';
const issuer = 'https://example.test';
const subject = 'synthetic-owner';

async function cli(...args: string[]) {
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
  // The CLI prints JSON whose shape depends on the command.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse(stdout).result as any;
}

let runtime: MemoryRecordsRuntime;
let service: ObservationService;
let firestore: ReturnType<typeof createFirestoreClient>;
let owner: ConnectionAccess;
let cedarOnly: ConnectionAccess;
let northwind: string;
let cedar: string;
let retail: string;
let deals: string;
let logistics: string;
let cedarProject: string;
const ids: Record<string, string> = {};

function resolve(connectionId: string) {
  return runtime.access.resolve({ issuer, subject, connectionId, clientId: 'shared-ai' });
}

async function observe(
  access: ConnectionAccess,
  key: string,
  extra: Partial<ObserveInput> = {},
): Promise<string> {
  const saved = await service.observe(access, {
    title: key,
    summary: `Observation ${key}.`,
    nature: 'event',
    subjects: ['Placement fixture'],
    asUser: false,
    idempotencyKey: key,
    ...extra,
  });
  ids[key] = saved.observation_id;
  return saved.observation_id;
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MemoryServiceError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected a failure');
}

const UNAVAILABLE = {
  code: 'invalid_input',
  message: 'The workspace, project or scope is not available',
};

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
      'synthetic',
      '--scope',
      'personal',
    ],
    { env: process.env },
  );
  await cli('init');
  northwind = (await cli('create-workspace', '--name', 'Northwind')).id;
  cedar = (await cli('create-workspace', '--name', 'Cedar')).id;
  const connection = await cli(
    'set-connection',
    '--connection',
    'new',
    '--workspaces',
    cedar,
    '--default-workspace',
    cedar,
  );
  runtime = createMemoryRecordsRuntime({
    projectId,
    databaseId,
    ledgerDatabaseId: 'lore-placement-deletions',
    cursorSecret: Buffer.alloc(32, 6),
  });
  service = new ObservationService({
    ledger: runtime.observations,
    access: runtime.access,
    embeddings: new DeterministicEmbeddingProvider(),
    log: () => {},
  });
  firestore = createFirestoreClient({ projectId, databaseId });
  owner = await resolve('shared-ai');
  cedarOnly = await resolve(connection.id);
  const create = async (workspaceId: string, parentId: string | null, name: string) =>
    (await service.changeProject(owner, { action: 'create', workspaceId, parentId, name })).project!
      .id;
  retail = await create(northwind, null, 'Retail');
  deals = await create(northwind, retail, 'Deals');
  logistics = await create(northwind, null, 'Logistics');
  cedarProject = await create(cedar, null, 'Platform');
}, 60_000);

afterAll(async () => {
  await service?.close();
  await runtime?.close();
  await firestore?.terminate();
});

describe('placement of observations', () => {
  it('records workspace, project and scope, and approves a wider scope by policy', async () => {
    await observe(owner, 'price', { workspaceId: northwind, projectId: retail });
    await observe(owner, 'rule', { workspaceId: northwind, projectId: retail, scope: 'workspace' });
    await observe(owner, 'memo', { workspaceId: northwind });
    await observe(owner, 'lesson', {
      workspaceId: northwind,
      projectId: retail,
      scope: 'shared',
      derivedFrom: [ids['price']!],
    });
    await observe(owner, 'note');
    await observe(owner, 'ancestor', { workspaceId: northwind, projectId: deals, scope: retail });

    const view = (key: string) => service.getObservation(owner, ids[key]!);
    expect(await view('price')).toMatchObject({
      workspace: { id: northwind, name: 'Northwind' },
      project: { id: retail, name: 'Retail', path: ['Retail'] },
      scope: { kind: 'project', project: { id: retail } },
      scope_approval: null,
      origin_hidden: false,
    });
    expect(await view('rule')).toMatchObject({
      scope: { kind: 'workspace' },
      scope_approval: 'policy',
    });
    expect(await view('memo')).toMatchObject({
      workspace: { id: northwind },
      project: null,
      scope: { kind: 'workspace' },
      scope_approval: null,
    });
    expect(await view('lesson')).toMatchObject({
      scope: { kind: 'shared' },
      derived_from: [ids['price']],
      scope_approval: 'policy',
    });
    expect(await view('note')).toMatchObject({
      workspace: null,
      project: null,
      scope: { kind: 'inbox' },
    });
    expect(await view('ancestor')).toMatchObject({
      project: { path: ['Retail', 'Deals'] },
      scope: { kind: 'project', project: { id: retail, path: ['Retail'] } },
      scope_approval: 'policy',
    });
  });

  it('refuses a placement that does not fit, with one message for every reason', async () => {
    const cases: Partial<ObserveInput>[] = [
      { workspaceId: northwind, projectId: deals, scope: logistics },
      { workspaceId: northwind, projectId: cedarProject },
      { workspaceId: `wsp_${'0'.repeat(32)}` },
      { workspaceId: northwind, projectId: `prj_${'0'.repeat(32)}` },
    ];
    for (const [index, extra] of cases.entries())
      expect(await failure(observe(owner, `misfit-${index}`, extra))).toEqual(UNAVAILABLE);
    // A request whose shape is wrong is told why; that depends on no stored data.
    expect(await failure(observe(owner, 'misfit-project', { projectId: retail }))).toEqual({
      code: 'invalid_input',
      message: 'a project needs its workspace',
    });
    expect(
      await failure(
        observe(owner, 'misfit-inbox-scope', { workspaceId: null, scope: 'workspace' }),
      ),
    ).toEqual({ code: 'invalid_input', message: 'a workspace scope needs a workspace' });
    expect(
      (
        await failure(
          observe(owner, 'misfit-scope', { workspaceId: northwind, scope: 'everywhere' }),
        )
      ).code,
    ).toBe('invalid_input');
  });

  it("keeps another workspace's facts away and hides a Shared lesson's origin", async () => {
    const lesson = await service.getObservation(cedarOnly, ids['lesson']!);
    expect(lesson).toMatchObject({
      workspace: null,
      project: null,
      scope: { kind: 'shared' },
      derived_from: [],
      origin_hidden: true,
    });
    expect(JSON.stringify(lesson)).not.toContain(northwind);
    for (const key of ['price', 'rule', 'memo', 'note'])
      expect((await failure(service.getObservation(cedarOnly, ids[key]!))).code).toBe('not_found');

    expect(
      await failure(observe(cedarOnly, 'cedar-into-northwind', { workspaceId: northwind })),
    ).toEqual(UNAVAILABLE);
    expect(await failure(observe(cedarOnly, 'cedar-into-inbox', { workspaceId: null }))).toEqual(
      UNAVAILABLE,
    );
    // A Shared lesson without a workspace is an Inbox item too, so it needs the Inbox grant.
    expect(
      await failure(
        observe(cedarOnly, 'cedar-shared-inbox', { workspaceId: null, scope: 'shared' }),
      ),
    ).toEqual(UNAVAILABLE);
    expect(
      await failure(
        observe(cedarOnly, 'cedar-derived', { scope: 'shared', derivedFrom: [ids['price']!] }),
      ),
    ).toEqual({ code: 'invalid_input', message: 'An observation in derived_from was not found' });

    // The default workspace applies, and a Shared lesson from Cedar shows its origin to /mcp.
    await observe(cedarOnly, 'cedar-lesson', { scope: 'shared' });
    expect(await service.getObservation(owner, ids['cedar-lesson']!)).toMatchObject({
      workspace: { id: cedar, name: 'Cedar' },
      origin_hidden: false,
      scope_approval: 'policy',
    });
  });

  it('does not tell a writer how its state stands against states it may not see', async () => {
    const state = (key: string, value: string): Partial<ObserveInput> => ({
      nature: 'state',
      subjects: ['Shared counterpart'],
      aspect: 'contract status',
      value,
      summary: `The contract is ${value}.`,
      title: key,
    });
    await observe(owner, 'northwind-state', {
      workspaceId: northwind,
      ...state('northwind-state', 'agreed'),
    });
    const written = await service.observe(cedarOnly, {
      ...state('cedar-state', 'not agreed'),
      nature: 'state',
      subjects: ['Shared counterpart'],
      title: 'cedar-state',
      summary: 'The contract is not agreed.',
      asUser: false,
      idempotencyKey: 'cedar-state',
    });
    expect(written.relation).toBe('first');
    expect(JSON.stringify(written)).not.toContain(ids['northwind-state']!);
  });

  it('discloses a deletion marker only where the forgotten observation was visible', async () => {
    const forgotten = await observe(owner, 'forgotten-note', {
      summary: 'An Inbox note to forget.',
    });
    await service.forget(owner, {
      target: { observationId: forgotten },
      idempotencyKey: 'forget-inbox-note',
    });
    const operations = async (access: ConnectionAccess) =>
      (await service.getChanges(access, undefined, 100)).entries.map((entry) => entry.operation);
    expect(await operations(owner)).toContain('deletion');
    expect(await operations(cedarOnly)).not.toContain('deletion');
  });

  it('requires the automatic policy to widen a scope', async () => {
    const admission = firestore
      .collection('memoryAdmissions')
      .doc(admissionDocumentId(issuer, subject));
    await admission.update({ approvalPolicy: 'confirm' });
    try {
      const confirming = await resolve('shared-ai');
      expect(
        (
          await failure(
            observe(confirming, 'confirm-widen', {
              workspaceId: northwind,
              projectId: retail,
              scope: 'workspace',
            }),
          )
        ).code,
      ).toBe('user_required');
      await observe(confirming, 'confirm-narrow', { workspaceId: northwind, projectId: retail });
    } finally {
      await admission.update({ approvalPolicy: 'automatic' });
    }
  });
});

describe('subjects, aliases and links across workspaces', () => {
  async function named(
    access: ConnectionAccess,
    key: string,
    subjects: string[],
    extra: Partial<ObserveInput> = {},
  ) {
    const saved = await service.observe(access, {
      title: key,
      summary: `Observation ${key}.`,
      nature: 'event',
      subjects,
      asUser: false,
      idempotencyKey: key,
      ...extra,
    });
    return saved.subject_ids;
  }

  it("resolves names only through aliases a reader may see and never overwrites another workspace's", async () => {
    const [quartz] = await named(owner, 'alias-northwind', ['Quartz Holdings'], {
      workspaceId: northwind,
      aliases: ['QH'],
    });
    const runtimeLedger = runtime.observations;
    const resolve = async (access: ConnectionAccess, name: string) =>
      (await runtimeLedger.resolveNames(access.actor, access.scopeId, [name])).get(name) ?? [];
    expect(await resolve(owner, 'QH')).toEqual([quartz]);
    expect(await resolve(cedarOnly, 'QH')).toEqual([]);
    expect(await resolve(cedarOnly, 'Quartz Holdings')).toEqual([]);
    const recalled = await service.recall(cedarOnly, { query: 'Quartz Holdings QH' });
    expect(JSON.stringify(recalled)).not.toContain(quartz!);

    // Cedar gives the same short name to another subject; Northwind's entry stays.
    const [hydro] = await named(cedarOnly, 'alias-cedar', ['Quebec Hydro'], { aliases: ['QH'] });
    expect(await resolve(cedarOnly, 'QH')).toEqual([hydro]);
    expect(new Set(await resolve(owner, 'QH'))).toEqual(new Set([quartz, hydro]));

    // A subject ID outside the allowance is as unknown as one that does not exist.
    expect(await failure(named(cedarOnly, 'id-probe', [quartz!]))).toEqual({
      code: 'invalid_input',
      message: 'Unknown subject ID',
    });
    expect(await failure(named(cedarOnly, 'id-probe-none', [`sub_${'0'.repeat(32)}`]))).toEqual({
      code: 'invalid_input',
      message: 'Unknown subject ID',
    });
    expect(await runtimeLedger.getSubjects(cedarOnly.actor, cedarOnly.scopeId, [quartz!])).toEqual(
      [],
    );
    expect(
      (await runtimeLedger.getSubjects(owner.actor, owner.scopeId, [quartz!])).map(
        (item) => item.name,
      ),
    ).toEqual(['Quartz Holdings']);
  });

  it('keeps a link inside the workspace it was written in', async () => {
    const [acme] = await named(owner, 'link-acme-northwind', ['Acme'], { workspaceId: northwind });
    await named(cedarOnly, 'link-acme-cedar', ['Acme']);
    const [acmeCorp] = await named(owner, 'link-acme-corp', ['Acme Corporation'], {
      workspaceId: northwind,
    });
    await service.link(owner, {
      kind: 'same-subject',
      a: 'Acme',
      b: 'Acme Corporation',
      revoke: false,
      workspaceId: northwind,
    });
    const linked = (access: ConnectionAccess) =>
      runtime.observations.linkedSubjects(access.actor, access.scopeId, [acme!]);
    expect(new Set(await linked(owner))).toEqual(new Set([acme, acmeCorp]));
    expect(await linked(cedarOnly)).toEqual([acme]);

    // Cedar cannot link to a subject it may not see, and learns no more than for a missing one.
    const hidden = await failure(
      service.link(cedarOnly, { kind: 'same-subject', a: acme!, b: acmeCorp!, revoke: false }),
    );
    const missing = await failure(
      service.link(cedarOnly, {
        kind: 'same-subject',
        a: acme!,
        b: `sub_${'0'.repeat(32)}`,
        revoke: false,
      }),
    );
    expect(hidden).toEqual(missing);
    expect(hidden.code).toBe('not_found');
  });
});
