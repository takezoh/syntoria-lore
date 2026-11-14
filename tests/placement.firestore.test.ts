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
// Seeding thousands of synthetic index entries with vectors needs FieldValue; only this test does.
// eslint-disable-next-line no-restricted-imports
import { FieldValue } from '@google-cloud/firestore';

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

describe('placement queries and context', () => {
  const keys = new Map<string, string>();
  const place = async (key: string, extra: Partial<ObserveInput>, access = owner) => {
    const saved = await service.observe(access, {
      title: key,
      summary: `Query fixture ${key}.`,
      nature: 'event',
      subjects: ['Query fixture'],
      asUser: false,
      idempotencyKey: `q-${key}`,
      ...extra,
    });
    keys.set(saved.observation_id, key);
  };
  const timeline = async (extra: { where?: unknown; context?: string }, access = owner) =>
    (await service.getTimeline(access, { subjects: ['Query fixture'], limit: 100, ...extra }))
      .observations;
  const selected = async (where: unknown, access = owner) =>
    (await timeline({ where }, access)).map((item) => keys.get(item.observation_id)).sort();
  const leaf = (field: string, op: string, value: unknown) =>
    op === 'in' ? { field, op, values: value } : { field, op, value };

  beforeAll(async () => {
    await place('price', { workspaceId: northwind, projectId: retail });
    await place('rule', { workspaceId: northwind, projectId: retail, scope: 'workspace' });
    await place('memo', { workspaceId: northwind });
    await place('lesson', { workspaceId: northwind, projectId: retail, scope: 'shared' });
    await place('note', { workspaceId: null });
    await place('deal', { workspaceId: northwind, projectId: deals, scope: retail });
    await place('logistics', { workspaceId: northwind, projectId: logistics });
    await place('cedar', { workspaceId: cedar, projectId: cedarProject });
  });

  it('selects by usability, combinations and unassigned places', async () => {
    expect(await selected(leaf('usable_in', 'eq', retail))).toEqual(
      ['deal', 'lesson', 'memo', 'price', 'rule'].sort(),
    );
    expect(await selected(leaf('usable_in', 'eq', logistics))).toEqual(
      ['lesson', 'logistics', 'memo', 'rule'].sort(),
    );
    expect(
      await selected({ or: [leaf('usable_in', 'eq', cedar), leaf('workspace_id', 'eq', null)] }),
    ).toEqual(['lesson', 'note']);
    expect(
      await selected({
        and: [leaf('workspace_id', 'eq', northwind), { not: leaf('usable_in', 'eq', logistics) }],
      }),
    ).toEqual(['deal', 'price']);
    expect(await selected(leaf('project_id', 'in', [retail]))).toEqual(
      ['deal', 'lesson', 'price', 'rule'].sort(),
    );
    expect(await selected(leaf('scope', 'eq', 'shared'))).toEqual(['lesson']);
    // The same query from the Cedar connection sees only what its allowance shows.
    expect(await selected(leaf('scope', 'in', ['shared', 'project']), cedarOnly)).toEqual([
      'cedar',
      'lesson',
    ]);
  });

  it('marks usability in a context without filtering', async () => {
    const usable = Object.fromEntries(
      (await timeline({ context: logistics })).map((item) => [
        keys.get(item.observation_id),
        item.usable,
      ]),
    );
    expect(usable).toEqual({
      price: false,
      rule: true,
      memo: true,
      lesson: true,
      note: false,
      deal: false,
      logistics: true,
      cedar: false,
    });
    const recalled = await service.recall(owner, {
      query: 'Query fixture',
      context: retail,
      where: leaf('workspace_id', 'eq', null),
    });
    const views = recalled.items.flatMap((item) =>
      item.type === 'event' ? [item.observation] : item.evidence,
    );
    // Search may also find Inbox items of other fixtures; every result must be in the Inbox.
    expect(views.map((view) => keys.get(view.observation_id))).toContain('note');
    expect(views.every((view) => view.workspace === null && view.scope.kind === 'inbox')).toBe(
      true,
    );
    expect(views.every((view) => view.usable === false)).toBe(true);
  });

  it('refuses a place outside the allowance like an unknown one', async () => {
    const unknown = await failure(
      timeline({ where: leaf('workspace_id', 'eq', `wsp_${'0'.repeat(32)}`) }),
    );
    expect(unknown).toEqual({
      code: 'invalid_input',
      message: 'Unknown workspace or project in the query',
    });
    expect(
      await failure(timeline({ where: leaf('workspace_id', 'eq', northwind) }, cedarOnly)),
    ).toEqual(unknown);
    expect(await failure(timeline({ context: retail }, cedarOnly))).toEqual(unknown);
    expect((await failure(timeline({ where: { or: [] } }))).message).toBe(
      'or needs at least one condition',
    );
  });

  it('computes a topic within the query', async () => {
    const status = (value: string): Partial<ObserveInput> => ({
      nature: 'state',
      subjects: ['Query topic'],
      aspect: 'review status',
      value,
      summary: `Review is ${value}.`,
    });
    await place('status-inbox', { ...status('pending'), title: 'status-inbox', workspaceId: null });
    await place('status-retail', {
      ...status('approved'),
      title: 'status-retail',
      workspaceId: northwind,
      projectId: retail,
    });
    const current = async (where?: unknown) =>
      (
        await service.getTimeline(owner, {
          subjects: ['Query topic'],
          aspect: 'review status',
          ...(where === undefined ? {} : { where }),
        })
      ).topic?.current.value;
    expect(await current()).toBe('approved');
    expect(await current(leaf('workspace_id', 'eq', null))).toBe('pending');
    expect(await current(leaf('usable_in', 'eq', retail))).toBe('approved');
  });

  it('lists the Inbox page by page with a cursor bound to the query and reader', async () => {
    const inbox = leaf('workspace_id', 'eq', null);
    const first = await service.listObservations(owner, { where: inbox, limit: 2 });
    expect(first.observations).toHaveLength(2);
    expect(first.observations.every((item) => item.workspace === null)).toBe(true);
    expect(first.cursor).not.toBeNull();
    const seen = new Set(first.observations.map((item) => item.observation_id));
    let cursor = first.cursor;
    while (cursor !== null) {
      const page = await service.listObservations(owner, { where: inbox, limit: 2, cursor });
      for (const item of page.observations) {
        expect(item.workspace).toBeNull();
        expect(seen.has(item.observation_id)).toBe(false);
        seen.add(item.observation_id);
      }
      cursor = page.cursor;
    }
    expect([...seen].some((id) => keys.get(id) === 'note')).toBe(true);
    expect(
      (
        await failure(
          service.listObservations(owner, {
            where: leaf('scope', 'eq', 'shared'),
            cursor: first.cursor!,
          }),
        )
      ).code,
    ).toBe('resync_required');
    expect(
      (await failure(service.listObservations(cedarOnly, { cursor: first.cursor! }))).code,
    ).toBe('resync_required');
  });
});

describe('classification', () => {
  const statuses = async (
    access: ConnectionAccess,
    items: Parameters<ObservationService['classify']>[1]['items'],
    key: string,
  ) => (await service.classify(access, { items, idempotencyKey: key })).results;

  it('moves an Inbox item into a project without changing what it says', async () => {
    const id = await observe(owner, 'to-classify', { summary: 'Zirconia supplier rated well.' });
    const before = await service.getObservation(owner, id);
    expect(
      await statuses(
        owner,
        [{ observationId: id, workspaceId: northwind, projectId: logistics }],
        'c-1',
      ),
    ).toEqual([{ observation_id: id, status: 'classified' }]);
    const after = await service.getObservation(owner, id);
    expect(after).toMatchObject({
      summary: before.summary,
      title: before.title,
      workspace: { id: northwind },
      project: { id: logistics, path: ['Logistics'] },
      scope: { kind: 'project' },
    });
    const inbox = await service.listObservations(owner, {
      where: { field: 'workspace_id', op: 'eq', value: null },
      limit: 100,
    });
    expect(inbox.observations.map((item) => item.observation_id)).not.toContain(id);
    const found = await service.recall(owner, {
      query: 'zirconia supplier',
      where: { field: 'usable_in', op: 'eq', value: logistics },
    });
    expect(JSON.stringify(found)).toContain(id);
    const changes = await service.getChanges(owner, undefined, 100);
    expect(
      changes.entries.some(
        (entry) => entry.operation === 'classify' && entry.recordIds.includes(id),
      ),
    ).toBe(true);
    const records = await firestore
      .collectionGroup('classifications')
      .where('observationId', '==', id)
      .get();
    expect(records.size).toBe(1);
    expect(records.docs[0]?.get('from')).toMatchObject({
      workspaceId: null,
      scope: { kind: 'inbox' },
    });

    // The same request replays; the same key with another placement conflicts.
    expect(
      await statuses(
        owner,
        [{ observationId: id, workspaceId: northwind, projectId: logistics }],
        'c-1',
      ),
    ).toEqual([{ observation_id: id, status: 'replayed' }]);
    expect(
      (await statuses(owner, [{ observationId: id, workspaceId: northwind }], 'c-1'))[0],
    ).toMatchObject({ status: 'failed', error: { code: 'idempotency_conflict' } });
  });

  it('takes an observation out of reach of a connection that loses it', async () => {
    const id = await observe(cedarOnly, 'cedar-move', { summary: 'Basaltic onboarding note.' });
    const finds = async (access: ConnectionAccess) =>
      JSON.stringify(await service.recall(access, { query: 'basaltic onboarding' })).includes(id);
    expect(await finds(cedarOnly)).toBe(true);
    expect(
      await statuses(
        owner,
        [{ observationId: id, workspaceId: northwind, projectId: retail }],
        'c-2',
      ),
    ).toEqual([{ observation_id: id, status: 'classified' }]);
    expect(await finds(cedarOnly)).toBe(false);
    expect((await failure(service.getObservation(cedarOnly, id))).code).toBe('not_found');
  });

  it('refuses what a connection may not classify, item by item', async () => {
    const results = await statuses(
      cedarOnly,
      [
        { observationId: ids['lesson']!, workspaceId: cedar },
        { observationId: `obs_${'0'.repeat(32)}`, workspaceId: cedar },
        { observationId: ids['cedar-lesson']!, workspaceId: northwind },
        // A malformed scope fails on its own; the other items still report their results.
        { observationId: ids['ancestor']!, workspaceId: cedar, scope: 'everywhere' },
      ],
      'c-3',
    );
    expect(results[0]).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: 'The observation cannot be classified' },
    });
    expect(results[1]?.error).toEqual(results[0]?.error);
    expect(results[2]).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: 'The workspace, project or scope is not available' },
    });
    expect(results[3]).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
  });

  it('needs the automatic policy for every classification', async () => {
    const id = await observe(owner, 'confirm-classify');
    const admission = firestore
      .collection('memoryAdmissions')
      .doc(admissionDocumentId(issuer, subject));
    await admission.update({ approvalPolicy: 'confirm' });
    try {
      const confirming = await resolve('shared-ai');
      expect(
        (await statuses(confirming, [{ observationId: id, workspaceId: northwind }], 'c-4'))[0],
      ).toMatchObject({ status: 'failed', error: { code: 'user_required' } });
    } finally {
      await admission.update({ approvalPolicy: 'automatic' });
    }
  });
});

describe('label keys, stale index entries and crowded members', () => {
  const scopePath = () =>
    firestore
      .collection('memoryTenants')
      .doc(Buffer.from('synthetic', 'utf8').toString('base64url'))
      .collection('scopes')
      .doc(Buffer.from('personal', 'utf8').toString('base64url'));
  let northwindOnly: ConnectionAccess;

  beforeAll(async () => {
    const created = await cli(
      'set-connection',
      '--connection',
      'new',
      '--workspaces',
      northwind,
      '--default-workspace',
      northwind,
    );
    northwindOnly = await resolve(created.id);
    const worker = await runtime.access.worker(owner);
    for (let run = 0; run < 20; run++)
      if ((await runtime.observations.backfillLabelKeys(worker, owner.scopeId, 500)).done) break;
    expect(
      (await scopePath().collection('metadata').doc('labelKeyBackfill').get()).get('done'),
    ).toBe(true);
  }, 60_000);

  it('does not let an index entry built before a classification overwrite the new placement', async () => {
    const id = await observe(owner, 'stale-index', { summary: 'Gallium stale index check.' });
    const worker = await runtime.access.worker(owner);
    const before = await runtime.observations.getObservationForIndex(worker, owner.scopeId, id);
    expect(before?.label).toEqual(['inbox']);
    await service.classify(owner, {
      items: [{ observationId: id, workspaceId: northwind }],
      idempotencyKey: 'stale-index',
    });
    await runtime.observations.writeObservationIndexEntry(worker, owner.scopeId, {
      observationId: id,
      terms: ['gallium'],
      subjectIds: before!.subjectIds,
      topicKey: null,
      nature: 'event',
      at: before!.recordedAt,
      label: before!.label,
      placement: before!.placement,
      embedding: await new DeterministicEmbeddingProvider().embed('Gallium stale index check.'),
    });
    const entry = await scopePath()
      .collection('observationIndex')
      .where('observationId', '==', id)
      .get();
    for (const document of entry.docs) expect(document.get('label')).toEqual([northwind]);
    expect(
      JSON.stringify(await service.recall(cedarOnly, { query: 'gallium stale index' })),
    ).not.toContain(id);
  });

  it('makes a classified subject name resolvable in its new workspace', async () => {
    await observe(owner, 'moved-subject', { subjects: ['Moved Subject'] });
    const resolveName = async (access: ConnectionAccess) =>
      (
        await runtime.observations.resolveNames(access.actor, access.scopeId, ['Moved Subject'])
      ).get('Moved Subject') ?? [];
    expect(await resolveName(cedarOnly)).toEqual([]);
    await service.classify(owner, {
      items: [{ observationId: ids['moved-subject']!, workspaceId: cedar }],
      idempotencyKey: 'moved-subject',
    });
    expect(await resolveName(cedarOnly)).toHaveLength(1);
  });

  it('finds what a reader may see even when another workspace names the same member 1,050 times', async () => {
    const [crowded] = (
      await service.observe(owner, {
        title: 'Crowded fact',
        summary: 'Cobalt tariff schedule for the retail business, reviewed weekly.',
        nature: 'event',
        subjects: ['Crowded Subject'],
        workspaceId: northwind,
        asUser: false,
        idempotencyKey: 'crowded-fact',
      })
    ).subject_ids;
    const [partner] = (
      await service.observe(owner, {
        title: 'Crowded partner',
        summary: 'The partner of the crowded subject.',
        nature: 'event',
        subjects: ['Crowded Partner'],
        workspaceId: northwind,
        asUser: false,
        idempotencyKey: 'crowded-partner',
      })
    ).subject_ids;
    await service.link(owner, {
      kind: 'same-subject',
      a: 'Crowded Subject',
      b: 'Crowded Partner',
      revoke: false,
      workspaceId: northwind,
    });
    const crowdedId = (
      await scopePath().collection('observations').where('title', '==', 'Crowded fact').get()
    ).docs[0]!.get('id') as string;

    // Synthetic Cedar documents that sort before the visible ones and are nearer to the query.
    const embedding = await new DeterministicEmbeddingProvider().embed('cobalt tariff schedule');
    for (let start = 0; start < 1050; start += 350) {
      const batch = firestore.batch();
      for (let index = start; index < start + 350; index++) {
        const suffix = String(index).padStart(5, '0');
        batch.set(scopePath().collection('observations').doc(`!crowd-${suffix}`), {
          subjectIds: [crowded],
          label: [cedar],
          labelKey: cedar,
        });
        batch.set(scopePath().collection('observationIndex').doc(`!crowd-${suffix}`), {
          observationId: `obs_${suffix.padStart(32, 'f')}`,
          terms: ['cobalt', 'tariff', 'schedule'],
          subjectIds: [crowded],
          label: [cedar],
          labelKey: cedar,
          at: '2026-11-14T00:00:00.000Z',
          embeddingModelId: embedding.modelId,
          embedding: FieldValue.vector([...embedding.values]),
        });
        batch.set(scopePath().collection('links').doc(`!crowd-${suffix}`), {
          kind: 'same-subject',
          members: [crowded, `sub_${suffix.padStart(32, 'e')}`],
          label: [cedar],
          labelKey: cedar,
          active: true,
        });
      }
      await batch.commit();
    }

    const reach = async () => ({
      found: JSON.stringify(
        await service.recall(northwindOnly, { query: 'cobalt tariff schedule', limit: 30 }),
      ).includes(crowdedId),
      named: (
        await runtime.observations.getSubjects(northwindOnly.actor, northwindOnly.scopeId, [
          crowded!,
        ])
      ).length,
      linked: (
        await runtime.observations.linkedSubjects(northwindOnly.actor, northwindOnly.scopeId, [
          crowded!,
        ])
      ).includes(partner!),
    });
    const state = scopePath().collection('metadata').doc('labelKeyBackfill');
    // Reading a fixed number of documents and filtering afterwards loses all three.
    await state.update({ done: false });
    expect(await reach()).toEqual({ found: false, named: 0, linked: false });
    await state.update({ done: true });
    expect(await reach()).toEqual({ found: true, named: 1, linked: true });
  }, 120_000);

  it('notes waiting index work only when the reader may see it', async () => {
    const queue = scopePath().collection('observationIndexQueue').doc('!pending');
    await queue.set({
      observationId: `obs_${'d'.repeat(32)}`,
      labelKey: northwind,
      queuedAt: '2026-11-14T00:00:00.000Z',
    });
    try {
      expect((await service.recall(cedarOnly, { query: 'anything waiting' })).notes).not.toContain(
        'index-pending',
      );
      expect((await service.recall(northwindOnly, { query: 'anything waiting' })).notes).toContain(
        'index-pending',
      );
    } finally {
      await queue.delete();
    }
  });
});
