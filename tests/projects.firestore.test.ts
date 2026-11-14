import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createFirestoreClient,
  createMemoryRecordsRuntime,
  MemoryServiceError,
  ObservationService,
  type ConnectionAccess,
  type MemoryRecordsRuntime,
  type ProjectChange,
} from '../packages/memory-records/src/index.js';
import { DeterministicEmbeddingProvider } from '../apps/api/src/embeddings.js';

const run = promisify(execFile);
const projectId = `demo-prj-${randomUUID().slice(0, 8)}`;
const databaseId = 'lore-projects';
const issuer = 'https://example.test';
const subject = 'synthetic-owner';
const tenant = 'synthetic';
const scope = 'personal';

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

const base64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

let runtime: MemoryRecordsRuntime;
let service: ObservationService;
let firestore: ReturnType<typeof createFirestoreClient>;
let owner: ConnectionAccess;
let northwind: string;
let cedar: string;

function change(access: ConnectionAccess, value: ProjectChange) {
  return service.changeProject(access, value);
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MemoryServiceError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected the change to fail');
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
  await cli('init');
  northwind = (await cli('create-workspace', '--name', 'Northwind', '--description', 'Company A'))
    .id;
  cedar = (await cli('create-workspace', '--name', 'Cedar')).id;
  runtime = createMemoryRecordsRuntime({
    projectId,
    databaseId,
    ledgerDatabaseId: 'lore-project-deletions',
    cursorSecret: Buffer.alloc(32, 8),
  });
  service = new ObservationService({
    ledger: runtime.observations,
    access: runtime.access,
    embeddings: new DeterministicEmbeddingProvider(),
    log: () => {},
  });
  firestore = createFirestoreClient({ projectId, databaseId });
  owner = await runtime.access.resolve({
    issuer,
    subject,
    connectionId: 'shared-ai',
    clientId: 'shared-ai',
  });
});

afterAll(async () => {
  await service?.close();
  await runtime?.close();
  await firestore?.terminate();
});

describe('projects inside a workspace', () => {
  it('creates, renames, moves and deletes projects under the hierarchy rules', async () => {
    const create = (parentId: string | null, name: string, workspaceId = northwind) =>
      change(owner, { action: 'create', workspaceId, parentId, name });
    const retail = (await create(null, 'Retail')).project!;
    const logistics = (await create(null, 'Logistics')).project!;
    const deals = (await create(retail.id, 'Deals')).project!;
    const quartz = (await create(deals.id, 'Quartz')).project!;
    const phase = await create(quartz.id, 'Phase one');
    expect(phase.project).toMatchObject({
      path: ['Retail', 'Deals', 'Quartz', 'Phase one'],
      depth: 4,
      workspaceId: northwind,
    });
    expect(phase.revision).toBe(5);

    expect(await failure(create(phase.project!.id, 'Too deep'))).toEqual({
      code: 'conflict',
      message: "a workspace's projects have at most 4 levels",
    });
    expect((await failure(create(null, ' ＲＥＴＡＩＬ '))).code).toBe('conflict');
    // The same name is fine under another parent and in another workspace.
    await create(logistics.id, 'Deals');
    await create(null, 'Retail', cedar);

    const renamed = await change(owner, {
      action: 'update',
      projectId: deals.id,
      name: 'Contracts',
      description: 'Contracts under negotiation',
    });
    expect(renamed.project).toMatchObject({
      path: ['Retail', 'Contracts'],
      description: 'Contracts under negotiation',
    });
    expect((await failure(create(retail.id, 'contracts'))).code).toBe('conflict');
    await create(retail.id, 'Deals');

    expect(
      await failure(change(owner, { action: 'update', projectId: retail.id, parentId: quartz.id })),
    ).toMatchObject({ code: 'conflict' });
    expect(
      (
        await failure(
          change(owner, { action: 'update', projectId: retail.id, parentId: logistics.id }),
        )
      ).message,
    ).toBe("a workspace's projects have at most 4 levels");
    const cedarRetail = (await service.listProjects(owner)).workspaces
      .find((workspace) => workspace.id === cedar)!
      .projects.find((project) => project.name === 'Retail')!;
    expect(
      await failure(
        change(owner, { action: 'update', projectId: quartz.id, parentId: cedarRetail.id }),
      ),
    ).toMatchObject({ code: 'conflict', message: 'parent is not a project of this workspace' });

    const moved = await change(owner, {
      action: 'update',
      projectId: quartz.id,
      parentId: logistics.id,
    });
    expect(moved.project?.path).toEqual(['Logistics', 'Quartz']);
    const listed = (await service.listProjects(owner)).workspaces.find(
      (workspace) => workspace.id === northwind,
    )!;
    expect(listed.projects.find((project) => project.name === 'Phase one')?.path).toEqual([
      'Logistics',
      'Quartz',
      'Phase one',
    ]);

    expect(await failure(change(owner, { action: 'delete', projectId: quartz.id }))).toMatchObject({
      code: 'project_in_use',
    });
    await change(owner, { action: 'delete', projectId: phase.project!.id });
    // An observation whose current project or project scope is the project keeps it in use.
    const scopeRef = firestore
      .collection('memoryTenants')
      .doc(base64url(tenant))
      .collection('scopes')
      .doc(base64url(scope));
    const marker = scopeRef.collection('observations').doc('synthetic-marker');
    await marker.set({ projectId: null, scope: { kind: 'project', projectId: quartz.id } });
    expect(await failure(change(owner, { action: 'delete', projectId: quartz.id }))).toMatchObject({
      code: 'project_in_use',
    });
    await marker.delete();
    expect(await change(owner, { action: 'delete', projectId: quartz.id })).toMatchObject({
      project: null,
    });

    const history = await scopeRef
      .collection('accessHistory')
      .where('operation', 'in', ['create-project', 'update-project', 'delete-project'])
      .get();
    // Eight creates, one rename, one move and two deletes succeeded; failures leave no entry.
    expect(history.size).toBe(12);
    expect(new Set(history.docs.map((item) => item.get('writer')))).toEqual(
      new Set([owner.actor.principalId]),
    );
  });

  it('keeps a connection to the projects of its granted workspaces', async () => {
    const created = await cli(
      'set-connection',
      '--connection',
      'new',
      '--workspaces',
      cedar,
      '--default-workspace',
      cedar,
    );
    const cedarOnly = await runtime.access.resolve({
      issuer,
      subject,
      connectionId: created.id,
      clientId: 'shared-ai',
    });
    const listed = await service.listProjects(cedarOnly);
    expect(listed.workspaces.map((workspace) => workspace.id)).toEqual([cedar]);
    expect(JSON.stringify(listed)).not.toContain('Northwind');

    const northwindProject = (await service.listProjects(owner)).workspaces
      .find((workspace) => workspace.id === northwind)!
      .projects.find((project) => project.name === 'Retail')!;
    expect(
      await failure(
        change(cedarOnly, {
          action: 'create',
          workspaceId: northwind,
          parentId: null,
          name: 'Elsewhere',
        }),
      ),
    ).toEqual({ code: 'invalid_input', message: 'Unknown workspace' });
    expect(
      await failure(
        change(cedarOnly, {
          action: 'create',
          workspaceId: `wsp_${'0'.repeat(32)}`,
          parentId: null,
          name: 'Elsewhere',
        }),
      ),
    ).toEqual({ code: 'invalid_input', message: 'Unknown workspace' });
    for (const value of [
      { action: 'update', projectId: northwindProject.id, name: 'Renamed' },
      { action: 'delete', projectId: northwindProject.id },
      { action: 'delete', projectId: `prj_${'0'.repeat(32)}` },
    ] as const)
      expect(await failure(change(cedarOnly, value))).toMatchObject({ code: 'not_found' });
    expect(
      (
        await change(cedarOnly, {
          action: 'create',
          workspaceId: cedar,
          parentId: null,
          name: 'Platform',
        })
      ).project?.path,
    ).toEqual(['Platform']);
  });
});
