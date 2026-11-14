import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApiApp, type ApiApp } from '../apps/api/src/app.js';
import { loadConfig } from '../apps/api/src/config.js';
import { DeterministicEmbeddingProvider } from '../apps/api/src/embeddings.js';
import { MemoryService } from '@memory/memory-records';
import { admissionDocumentId } from '../packages/memory-records/src/index.js';

const execFileAsync = promisify(execFile);
const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
const projectId = `demo-api-${process.pid}-${randomUUID().slice(0, 8)}`;
const memoryDatabase = 'lore-memory-records';
const ledgerDatabase = 'lore-deletion-ledger';
const accessIssuer = 'https://access.example.com';
const accessAudience = 'synthetic-access-app';
const ownerEmail = 'owner@example.com';
/** The admission issuer the service maps the owner to; every test admits its own subject. */
const issuer = 'https://identity.example.com';

/** A client credential: the admission it reaches and the connection it uses. */
interface Grant {
  readonly subject: string;
  /** `undefined` is the default connection at `/mcp`; otherwise a provisioned `con_…` ID. */
  readonly connection: string | undefined;
}

// Tool results are checked field by field, so they are read loosely here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content: Array<{ type: string; text?: string }>;
}

/** One service instance per admission, as Access mode maps one owner to one admission. */
interface Instance {
  readonly app: ApiApp;
  readonly server: Server;
  readonly baseUrl: string;
  readonly resourceUrl: string;
}

const grants = new Map<string, Grant>();
const instances = new Map<string, Instance>();
const clients: Client[] = [];
const logs: Readonly<Record<string, unknown>>[] = [];
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwk: JWK;
let failEmbeddingText: string | undefined;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Starts, once per admission subject, a service configured for that owner admission. */
async function instance(subject: string): Promise<Instance> {
  const existing = instances.get(subject);
  if (existing) return existing;
  const server = createServer();
  const baseUrl = `http://127.0.0.1:${await listen(server)}`;
  const resourceUrl = `${baseUrl}/mcp`;
  const config = loadConfig({
    NODE_ENV: 'test',
    ALLOW_LOOPBACK_HTTP: '1',
    FIRESTORE_PROJECT_ID: projectId,
    FIRESTORE_DATABASE_ID: memoryDatabase,
    LEDGER_DATABASE_ID: ledgerDatabase,
    ACCESS_ISSUER: accessIssuer,
    ACCESS_AUDIENCE: accessAudience,
    ACCESS_OWNER_EMAIL: ownerEmail,
    OWNER_ADMISSION_ISSUER: issuer,
    OWNER_ADMISSION_SUBJECT: subject,
    MCP_RESOURCE_URL: resourceUrl,
    CURSOR_HMAC_KEYS: `test=${Buffer.alloc(32, 9).toString('base64url')}`,
    CURSOR_HMAC_ACTIVE_KEY: 'test',
    EMBEDDING_PROVIDER: 'deterministic',
  });
  const deterministic = new DeterministicEmbeddingProvider();
  const app = createApiApp(config, {
    accessKeys: createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'local' }] }),
    log: (event) => logs.push(event),
    embeddings: {
      async embed(text) {
        if (failEmbeddingText !== undefined && text.includes(failEmbeddingText))
          throw new Error('Synthetic embedding outage');
        return deterministic.embed(text);
      },
    },
  });
  server.on('request', app.listener);
  const created = { app, server, baseUrl, resourceUrl };
  instances.set(subject, created);
  return created;
}

async function assertion(email = ownerEmail): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' })
    .setIssuer(accessIssuer)
    .setAudience(accessAudience)
    .setSubject('synthetic-access-user')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

/** A handle for a client of the admission's default connection or of a further connection. */
function grant(subject: string, connection?: string): string {
  const token = randomUUID();
  grants.set(token, { subject, connection });
  return token;
}

/** The endpoint and Access header a handle uses. */
async function endpoint(token: string): Promise<{ url: string; headers: Record<string, string> }> {
  const found = grants.get(token);
  if (!found) throw new Error('Unknown grant');
  const { resourceUrl } = await instance(found.subject);
  return {
    url: found.connection === undefined ? resourceUrl : `${resourceUrl}/c/${found.connection}`,
    headers: { 'cf-access-jwt-assertion': await assertion() },
  };
}

async function admit(subject: string, tenant: string, scope: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      'scripts/admit-subject.mjs',
      '--project',
      projectId,
      '--database',
      memoryDatabase,
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
  return JSON.parse(stdout) as { action: string; documentId: string };
}

/** Provisions a further connection of the admission with every workspace and the Inbox. */
async function provision(subject: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      'scripts/manage-connections.mjs',
      'set-connection',
      '--connection',
      'new',
      '--workspaces',
      'all',
      '--inbox',
      '--project',
      projectId,
      '--database',
      memoryDatabase,
      '--issuer',
      issuer,
      '--subject',
      subject,
    ],
    { env: process.env },
  );
  return String((JSON.parse(stdout) as { result: { id: string } }).result.id);
}

async function connect(token: string): Promise<Client> {
  const { url, headers } = await endpoint(token);
  const client = new Client({ name: 'lore-api-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  );
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  expect(result.content[0]?.type).toBe('text');
  return result.structuredContent as Item;
}

function errorCode(result: ToolResult): unknown {
  expect(result.isError).toBe(true);
  return (result.structuredContent?.['error'] as { code?: unknown } | undefined)?.code;
}

beforeAll(async () => {
  if (!emulatorHost) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  keys = await generateKeyPair('RS256');
  publicJwk = await exportJWK(keys.publicKey);
}, 30_000);

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const { server, app } of instances.values()) {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  }
});

describe('Lore API over Remote MCP', () => {
  it('retries a failed index without another observation write', async () => {
    const subject = 'github:recovery';
    await admit(subject, 'tenant-recovery', 'personal');
    const client = await connect(grant(subject));
    failEmbeddingText = 'recoverable-index-marker';
    try {
      const written = await ok(client, 'observe', {
        title: 'Index recovery',
        summary: 'recoverable-index-marker: retain stable retry keys.',
        nature: 'event',
        subjects: ['Recovery fixture'],
        idempotency_key: 'recovery-one',
      });
      const before = await ok(client, 'recall', { query: 'Recovery fixture' });
      expect(before.notes).toContain('index-pending');
      failEmbeddingText = undefined;
      let recovered = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await ok(client, 'recall', { query: 'Recovery fixture' });
        if (!result.notes.includes('index-pending')) {
          expect(
            result.items.some(
              (item: Item) =>
                item.type === 'event' && item.observation.observation_id === written.observation_id,
            ),
          ).toBe(true);
          recovered = true;
          break;
        }
      }
      expect(recovered).toBe(true);
    } finally {
      failEmbeddingText = undefined;
    }
  });

  it('serves health and readiness and refuses calls without a valid Access assertion', async () => {
    const { baseUrl, resourceUrl } = await instance('github:health');
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    // The service no longer advertises protected-resource metadata; Access owns discovery.
    expect((await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
      },
    };
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    for (const extra of [
      {},
      { authorization: 'Bearer opaque-legacy-token' },
      { 'cf-access-jwt-assertion': 'not.a.jwt' },
    ]) {
      const response = await fetch(resourceUrl, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: JSON.stringify(initialize),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBeNull();
    }
    const other = await fetch(resourceUrl, {
      method: 'POST',
      headers: { ...headers, 'cf-access-jwt-assertion': await assertion('other@example.com') },
      body: JSON.stringify(initialize),
    });
    expect(other.status).toBe(403);
  });

  it('serves a further connection only when provisioned and hides every other connection path', async () => {
    const subject = 'github:connections';
    await admit(subject, 'tenant-connections', 'personal');
    const provisioned = await provision(subject);
    const client = await connect(grant(subject, provisioned));
    const access = await ok(client, 'get_access');
    expect(access).toMatchObject({ compartment_allowance: ['inbox', 'workspaces:all'] });
    const own = await ok(await connect(grant(subject)), 'get_access');
    expect(access['principal_id']).not.toBe(own['principal_id']);

    const { resourceUrl } = await instance(subject);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
      },
    });
    const responses = [];
    for (const path of [`c/con_${'0'.repeat(32)}`, 'c/not-a-connection', `c/${provisioned}/x`]) {
      const response = await fetch(`${resourceUrl}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'cf-access-jwt-assertion': await assertion(),
        },
        body,
      });
      responses.push({ status: response.status, body: await response.json() });
    }
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'not_found', message: 'Not found' } });
    }
    // A connection of another admission is not found either.
    const otherSubject = 'github:connections-other';
    await admit(otherSubject, 'tenant-connections-other', 'personal');
    const foreign = await provision(otherSubject);
    await expect(connect(grant(subject, foreign))).rejects.toThrow();
  }, 60_000);

  it('lists and manages the projects of a workspace through MCP', async () => {
    const subject = 'github:projects';
    await admit(subject, 'tenant-projects', 'personal');
    const manage = (...args: string[]) =>
      execFileAsync(
        process.execPath,
        [
          'scripts/manage-connections.mjs',
          ...args,
          '--project',
          projectId,
          '--database',
          memoryDatabase,
          '--issuer',
          issuer,
          '--subject',
          subject,
        ],
        { env: process.env },
      ).then(({ stdout }) => JSON.parse(stdout).result as Item);
    await manage('init');
    const workspace = await manage('create-workspace', '--name', 'Northwind');
    const client = await connect(grant(subject));
    const created = await ok(client, 'manage_project', {
      action: 'create',
      workspace: workspace.id,
      name: 'Retail',
      description: 'Business X',
    });
    expect(created.project).toMatchObject({ path: ['Retail'], depth: 1 });
    const child = await ok(client, 'manage_project', {
      action: 'create',
      workspace: workspace.id,
      parent: created.project.id,
      name: 'Quartz deal',
    });
    expect(child.project.path).toEqual(['Retail', 'Quartz deal']);
    const listed = await ok(client, 'list_projects');
    expect(listed.workspaces).toEqual([
      expect.objectContaining({
        id: workspace.id,
        name: 'Northwind',
        revision: 2,
        projects: [
          expect.objectContaining({ name: 'Retail', description: 'Business X' }),
          expect.objectContaining({ name: 'Quartz deal', parentId: created.project.id }),
        ],
      }),
    ]);
    expect(
      errorCode(
        await call(client, 'manage_project', { action: 'delete', project: created.project.id }),
      ),
    ).toBe('project_in_use');
    expect(
      errorCode(
        await call(client, 'manage_project', { action: 'update', project: child.project.id }),
      ),
    ).toBe('invalid_input');
    const moved = await ok(client, 'manage_project', {
      action: 'update',
      project: child.project.id,
      parent: null,
    });
    expect(moved.project.path).toEqual(['Quartz deal']);

    // Placement queries and context reach the domain through MCP unchanged.
    await ok(client, 'observe', {
      title: 'Inbox note',
      summary: 'A note whose company is not known yet.',
      nature: 'event',
      subjects: ['Inbox fixture'],
      idempotency_key: 'inbox-note',
    });
    await ok(client, 'observe', {
      title: 'Retail fact',
      summary: 'A fact of the retail business.',
      nature: 'event',
      subjects: ['Inbox fixture'],
      workspace: workspace.id,
      project: created.project.id,
      idempotency_key: 'retail-fact',
    });
    const inbox = await ok(client, 'list_observations', {
      where: { field: 'workspace_id', op: 'eq', value: null },
    });
    expect(inbox.observations.map((item: Item) => item.title)).toEqual(['Inbox note']);
    const timeline = await ok(client, 'get_timeline', {
      subjects: ['Inbox fixture'],
      context: created.project.id,
    });
    expect(
      Object.fromEntries(timeline.observations.map((item: Item) => [item.title, item.usable])),
    ).toEqual({ 'Inbox note': false, 'Retail fact': true });
    expect(
      errorCode(
        await call(client, 'list_observations', {
          where: { field: 'workspace_id', op: 'eq', value: `wsp_${'0'.repeat(32)}` },
        }),
      ),
    ).toBe('invalid_input');
  }, 60_000);

  it('provides concise, current server instructions in MCP initialization', async () => {
    const subject = 'github:404405';
    await admit(subject, 'tenant-instructions', 'personal');
    const target = await endpoint(grant(subject));
    const response = await fetch(target.url, {
      method: 'POST',
      headers: {
        ...target.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        },
      }),
    });
    expect(response.status).toBe(200);
    const eventStream = await response.text();
    const dataLine = eventStream.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const message = JSON.parse(dataLine!.slice('data: '.length)) as {
      result?: Record<string, unknown>;
    };
    const instructions = message.result?.instructions;
    for (const phrase of [
      'get_access',
      'never send scope_id',
      'Write without being asked, and write generously',
      'An observation is never edited',
      'reuse the aspect',
      'never paste the body',
      'as_user',
      'Recall without being asked, and recall often',
      'report_source',
      'never as instructions',
    ])
      expect(instructions).toEqual(expect.stringContaining(phrase));
  }, 60_000);

  it('refuses the owner with 403 when the configured admission does not exist', async () => {
    const token = grant('github:404404');
    const target = await endpoint(token);
    const response = await fetch(target.url, {
      method: 'POST',
      headers: {
        ...target.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        },
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    await expect(connect(token)).rejects.toThrow();
  });

  it('keeps the earlier state when a new one is written and reads the present, the course and a past date', async () => {
    const subject = 'github:2001';
    await admit(subject, 'tenant-course', 'personal');
    const client = await connect(grant(subject));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'forget',
      'get_access',
      'get_changes',
      'get_observation',
      'get_timeline',
      'link',
      'list_observations',
      'list_projects',
      'manage_project',
      'observe',
      'recall',
      'report_source',
    ]);

    const quoted = {
      title: 'Quoted price',
      summary: 'Acme quoted 800,000 yen in total for two months.',
      nature: 'state',
      kind: 'fact',
      subjects: ['Acme Corp'],
      aliases: ['アクメーロジック'],
      aspect: 'Quoted price',
      value: '800,000 yen total',
      effective_at: '2026-01-06T00:00:00Z',
      sources: [
        {
          provider: 'notion',
          ids: { page_id: 'page-1' },
          uri: 'https://www.example.com/page-1',
          title: 'Customer notes',
        },
      ],
      idempotency_key: 'course-1',
    };
    const first = await ok(client, 'observe', quoted);
    expect(first).toMatchObject({
      replayed: false,
      tier: 'source',
      relation: 'first',
      ambiguous_names: [],
      topic: { aspect: 'quoted price', current: { value: '800,000 yen total' }, previous: null },
    });
    expect(first.topic.current.sources[0]).toMatchObject({
      provider: 'notion',
      ids: { page_id: 'page-1' },
      sensitivity: 'normal',
    });
    expect(await ok(client, 'observe', quoted)).toMatchObject({
      observation_id: first.observation_id,
      replayed: true,
    });
    expect(errorCode(await call(client, 'observe', { ...quoted, value: 'something else' }))).toBe(
      'idempotency_conflict',
    );
    // A request cannot set the tier or the writer.
    expect(
      (await call(client, 'observe', { ...quoted, tier: 'person', idempotency_key: 'course-x' }))
        .isError,
    ).toBe(true);

    const { aliases: _aliases, ...withoutAliases } = quoted;
    void _aliases;
    const second = await ok(client, 'observe', {
      ...withoutAliases,
      summary: 'Acme quoted 800,000 yen per month for two months.',
      value: '800,000 yen per month',
      effective_at: '2026-01-09T00:00:00Z',
      idempotency_key: 'course-2',
    });
    expect(second).toMatchObject({
      relation: 'follows',
      topic: {
        current: { value: '800,000 yen per month' },
        previous: { value: '800,000 yen total', observation_id: first.observation_id },
        changed: 'yes',
        changed_at: '2026-01-09T00:00:00Z',
        observations: 2,
      },
    });
    const visit = await ok(client, 'observe', {
      title: 'Visit to Acme',
      summary: 'Visited Acme; the price was discussed and not settled.',
      nature: 'event',
      subjects: ['Acme Corp'],
      effective_at: '2026-01-10T00:00:00Z',
      idempotency_key: 'course-3',
    });
    expect(visit).toMatchObject({ tier: 'inference', relation: null, topic: null });

    // A question written without spaces finds the subject through its katakana alias.
    const recalled = await ok(client, 'recall', {
      query: 'アクメーロジックの案件の進捗を教えて',
      intent: 'entity',
    });
    expect(recalled.subjects).toEqual([{ id: first.subject_ids[0], name: 'Acme Corp' }]);
    expect(recalled.items[0]).toMatchObject({
      type: 'topic',
      topic: {
        subject: { name: 'Acme Corp' },
        current: { value: '800,000 yen per month' },
        previous: { value: '800,000 yen total' },
        changed: 'yes',
      },
    });
    expect(recalled.items[0].matched).toContain('name');
    expect(recalled.items[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: '800,000 yen total',
          subject_names: ['Acme Corp'],
          effective_until: null,
        }),
      ]),
    );
    const contextual = await ok(client, 'recall', {
      query: 'Acme Corp quoted price',
      intent: 'contextual',
    });
    expect(contextual.items.some((item: Item) => item.type === 'topic')).toBe(true);
    expect(contextual.notes).not.toContain('semantic-search-unavailable');
    expect(
      recalled.items.some(
        (item: Item) => item.type === 'event' && item.observation.title === 'Visit to Acme',
      ),
    ).toBe(true);
    expect(recalled.notes).not.toContain('semantic-match-only');

    // Found by a term alone when no subject is named.
    const byTerm = await ok(client, 'recall', { query: 'settled' });
    expect(byTerm.subjects).toEqual([]);
    expect(byTerm.items[0]).toMatchObject({ type: 'event' });
    expect(byTerm.items[0].matched).toContain('terms');
    const unknown = await ok(client, 'recall', { query: 'Globex' });
    expect(unknown.items.every((item: Item) => item.matched.join() === 'semantic')).toBe(true);

    // What held on a past date, from what is known now.
    const past = await ok(client, 'recall', { query: 'Acme Corp', at: '2026-01-07T00:00:00Z' });
    expect(past.items).toHaveLength(1);
    expect(past.items[0].topic).toMatchObject({
      current: { value: '800,000 yen total' },
      previous: null,
    });

    const course = await ok(client, 'get_timeline', {
      subjects: ['Acme Corp'],
      aspect: 'quoted price',
    });
    expect(course.topic.course.map((item: Item) => item.value)).toEqual([
      '800,000 yen total',
      '800,000 yen per month',
    ]);
    const everything = await ok(client, 'get_timeline', { subjects: ['アクメーロジック'] });
    expect(everything.observations.map((item: Item) => item.title)).toEqual([
      'Visit to Acme',
      'Quoted price',
      'Quoted price',
    ]);

    await ok(client, 'report_source', {
      observation_id: first.observation_id,
      source_index: 0,
      status: 'changed',
    });
    const read = await ok(client, 'get_observation', { observation_id: first.observation_id });
    expect(read.sources[0].last_report).toMatchObject({ status: 'changed' });
    expect(read).toMatchObject({ tier: 'source', at: '2026-01-06T00:00:00Z' });

    const changes = await ok(client, 'get_changes');
    expect(changes.entries.map((entry: Item) => entry.operation)).toEqual([
      'observe',
      'observe',
      'observe',
    ]);
    expect(logs.some((event) => event['event'] === 'mcp.tool.failed')).toBe(false);
  }, 90_000);

  it('derives trust from who wrote an observation and keeps a disagreeing lower tier as a conflict', async () => {
    const subject = 'github:2002';
    await admit(subject, 'tenant-trust', 'personal');
    const first = await connect(grant(subject));
    const second = await connect(grant(subject, await provision(subject)));
    const status = {
      title: 'Contract status',
      nature: 'state',
      subjects: ['Initech'],
      aspect: 'contract status',
    };
    const stated = await ok(first, 'observe', {
      ...status,
      summary: 'The user says the contract with Initech is not agreed yet.',
      value: 'not agreed',
      as_user: true,
      idempotency_key: 'trust-1',
    });
    expect(stated).toMatchObject({ tier: 'person', relation: 'first' });

    // Another AI infers otherwise: it does not take over.
    const inferred = await ok(second, 'observe', {
      ...status,
      summary: 'A message suggests the contract with Initech was agreed.',
      value: 'agreed',
      idempotency_key: 'trust-2',
    });
    expect(inferred).toMatchObject({
      tier: 'inference',
      relation: 'conflicts',
      topic: { current: { value: 'not agreed', tier: 'person' }, changed: 'no' },
    });
    expect(inferred.topic.conflicts.map((item: Item) => item.value)).toEqual(['agreed']);
    // Nor can it withdraw what the person stated.
    const withdrawn = await ok(second, 'observe', {
      ...status,
      summary: 'Withdrawing the statement that the contract is not agreed.',
      retracts: stated.observation_id,
      idempotency_key: 'trust-3',
    });
    expect(withdrawn.topic.current).toMatchObject({ value: 'not agreed', tier: 'person' });
    // A second writer stating the same value agrees with it.
    const agreeing = await ok(second, 'observe', {
      ...status,
      summary: 'The Initech contract is still not agreed according to the tracker.',
      value: 'Not agreed',
      sources: [{ provider: 'gmail', ids: { message_id: '<m1@example.com>' } }],
      idempotency_key: 'trust-4',
    });
    expect(agreeing).toMatchObject({
      tier: 'source',
      relation: 'restates',
      topic: { current: { value: 'not agreed' }, agreeing: 2 },
    });
    // The person changing their statement settles the conflict.
    const settled = await ok(first, 'observe', {
      ...status,
      summary: 'The user says the contract with Initech is now agreed.',
      value: 'agreed',
      as_user: true,
      idempotency_key: 'trust-5',
    });
    expect(settled).toMatchObject({
      relation: 'follows',
      topic: {
        current: { value: 'agreed', tier: 'person' },
        previous: { value: 'not agreed' },
        conflicts: [],
        changed: 'yes',
      },
    });

    // A connection cannot write into a workspace that does not exist or is not granted.
    expect(
      errorCode(
        await call(first, 'observe', {
          ...status,
          summary: 'A write into an unknown workspace.',
          value: 'agreed',
          workspace: `wsp_${'0'.repeat(32)}`,
          idempotency_key: 'trust-6',
        }),
      ),
    ).toBe('invalid_input');
  }, 90_000);

  it('resolves names without merging subjects and reads linked subjects and topics together', async () => {
    const subject = 'github:2003';
    await admit(subject, 'tenant-subjects', 'personal');
    const client = await connect(grant(subject));
    const east = await ok(client, 'observe', {
      title: 'East office headcount',
      summary: 'Globex East has forty people.',
      nature: 'state',
      subjects: ['Globex East'],
      aliases: ['Globex'],
      aspect: 'headcount',
      value: '40',
      idempotency_key: 'subjects-1',
    });
    const west = await ok(client, 'observe', {
      title: 'West office headcount',
      summary: 'Globex West has twelve people.',
      nature: 'state',
      subjects: ['Globex West'],
      aliases: ['Globex'],
      aspect: 'staff',
      value: '12',
      idempotency_key: 'subjects-2',
    });
    // The spelling already belongs to another subject, so it is reported and not reassigned.
    expect(west).toMatchObject({ alias_conflicts: ['globex'] });
    expect(west.subject_ids[0]).not.toBe(east.subject_ids[0]);
    expect((await ok(client, 'recall', { query: 'Globex' })).subjects).toEqual([
      { id: east.subject_ids[0], name: 'Globex East' },
    ]);

    await ok(client, 'link', { kind: 'same-subject', a: 'Globex East', b: 'Globex West' });
    const linked = await ok(client, 'recall', { query: 'Globex East' });
    expect(linked.items.map((item: Item) => item.topic?.current.value).sort()).toEqual([
      '12',
      '40',
    ]);
    await ok(client, 'link', {
      kind: 'same-subject',
      a: 'Globex East',
      b: 'Globex West',
      revoke: true,
    });
    const unlinked = await ok(client, 'recall', { query: 'Globex East' });
    expect(
      unlinked.items
        .filter((item: Item) => item.matched.includes('name'))
        .map((item: Item) => item.topic?.current.value),
    ).toEqual(['40']);

    // The same matter written under another aspect is read as one course once it is linked.
    await ok(client, 'observe', {
      title: 'East office staff',
      summary: 'Globex East grew to forty-five people.',
      nature: 'state',
      subjects: [east.subject_ids[0]],
      aspect: 'staff count',
      value: '45',
      effective_at: '2026-02-01T00:00:00Z',
      idempotency_key: 'subjects-3',
    });
    await ok(client, 'link', {
      kind: 'same-topic',
      subject: 'Globex East',
      a: 'headcount',
      b: 'staff count',
    });
    const course = await ok(client, 'get_timeline', {
      subjects: ['Globex East'],
      aspect: 'staff count',
    });
    expect(course.topic.course.map((item: Item) => item.value).sort()).toEqual(['40', '45']);
    expect(
      errorCode(
        await call(client, 'link', { kind: 'same-subject', a: 'Globex East', b: 'Nobody' }),
      ),
    ).toBe('invalid_input');
  }, 90_000);

  it('forgets an observation, a source and a subject, and rebuilds what was derived', async () => {
    const subject = 'github:2004';
    await admit(subject, 'tenant-forget-obs', 'personal');
    const client = await connect(grant(subject));
    const plan = { title: 'Launch date', nature: 'state', subjects: ['Hooli'], aspect: 'launch' };
    const old = await ok(client, 'observe', {
      ...plan,
      summary: 'Hooli plans to launch in March.',
      value: 'March',
      effective_at: '2026-01-01T00:00:00Z',
      idempotency_key: 'forget-1',
    });
    const latest = await ok(client, 'observe', {
      ...plan,
      summary: 'Hooli moved the launch to May.',
      value: 'May',
      effective_at: '2026-02-01T00:00:00Z',
      sources: [{ provider: 'slack', ids: { channel: 'C1', ts: '171.5' } }],
      idempotency_key: 'forget-2',
    });
    expect(
      await ok(client, 'forget', {
        observation_id: latest.observation_id,
        idempotency_key: 'forget-3',
      }),
    ).toMatchObject({ stopped: 1, pending: 0, use_stopped: true });
    expect(
      errorCode(await call(client, 'get_observation', { observation_id: latest.observation_id })),
    ).toBe('not_found');
    // The topic falls back to the state that remains, with no trace of the forgotten text.
    const after = await ok(client, 'recall', { query: 'Hooli' });
    expect(after.items).toHaveLength(1);
    expect(after.items[0].topic).toMatchObject({
      current: { value: 'March', observation_id: old.observation_id },
      previous: null,
      observations: 1,
    });
    expect(JSON.stringify(after)).not.toContain('May');
    expect(
      (await ok(client, 'recall', { query: 'moved' })).items.filter((item: Item) =>
        item.matched.includes('terms'),
      ),
    ).toEqual([]);

    await ok(client, 'observe', {
      title: 'Call with Hooli',
      summary: 'Hooli confirmed the budget on a call.',
      nature: 'event',
      subjects: ['Hooli'],
      sources: [{ provider: 'slack', ids: { ts: '171.9', channel: 'C1' } }],
      idempotency_key: 'forget-4',
    });
    expect(
      await ok(client, 'forget', {
        source: { provider: 'slack', ids: { channel: 'C1', ts: '171.9' } },
        idempotency_key: 'forget-5',
      }),
    ).toMatchObject({ stopped: 1, use_stopped: true });
    expect(
      await ok(client, 'forget', { subject: 'Hooli', idempotency_key: 'forget-6' }),
    ).toMatchObject({ stopped: 1, remaining: false });
    expect((await ok(client, 'recall', { query: 'Hooli' })).items).toEqual([]);
    expect(errorCode(await call(client, 'forget', { idempotency_key: 'forget-7' }))).toBe(
      'invalid_input',
    );
    const changes = await ok(client, 'get_changes');
    expect(changes.entries.map((entry: Item) => entry.operation)).toEqual([
      'deletion',
      'deletion',
      'deletion',
    ]);
    expect(changes.entries.every((entry: Item) => entry.recordIds.length === 0)).toBe(true);
    expect(logs.some((event) => event['event'] === 'observation.purge')).toBe(true);
  }, 90_000);

  it('converts existing Memory Records into observations found by the same names', async () => {
    const subject = 'github:2005';
    await admit(subject, 'tenant-legacy', 'personal');
    // Records written by the previous service, before any observation exists in the scope.
    const { app } = await instance(subject);
    const access = await app.runtime.access.resolve({
      issuer,
      subject,
      connectionId: 'shared-ai',
      clientId: 'shared-ai',
    });
    const legacy = new MemoryService({
      repository: app.runtime.repository,
      access: app.runtime.access,
      embeddings: new DeterministicEmbeddingProvider(),
      log: () => undefined,
    });
    await legacy.remember(access, {
      kind: 'fact',
      title: 'Umbrella proposal received',
      statement: 'Umbrella proposed a licence for 35,000 dollars; nothing is signed.',
      details: { subject: 'Umbrella', claim: 'Umbrella proposed a licence.' },
      subjectIds: ['Umbrella'],
      aliases: [{ value: 'アンブレラ' }],
      sourceReferences: [
        {
          provider: 'google-drive',
          accountOrTenant: 'docs.example.com',
          resourceId: 'file-1',
          uri: 'https://docs.example.com/document/d/file-1',
        },
      ],
      asUser: false,
      idempotencyKey: 'legacy-1',
    });
    const client = await connect(grant(subject));
    // The first write to the scope carries the conversion along.
    await ok(client, 'observe', {
      title: 'Unrelated note',
      summary: 'A note that starts the conversion.',
      nature: 'event',
      subjects: ['Elsewhere'],
      idempotency_key: 'legacy-2',
    });
    // The converted observation is indexed by the write after the one that converted it.
    await ok(client, 'observe', {
      title: 'Second note',
      summary: 'A note that lets the index catch up.',
      nature: 'event',
      subjects: ['Elsewhere'],
      idempotency_key: 'legacy-2b',
    });
    const found = await ok(client, 'recall', { query: 'アンブレラ' });
    expect(found.subjects).toEqual([{ id: expect.any(String), name: 'Umbrella' }]);
    const converted = found.items.filter((item: Item) => item.matched.includes('name'));
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({
      type: 'event',
      observation: {
        title: 'Umbrella proposal received',
        summary: 'Umbrella proposed a licence for 35,000 dollars; nothing is signed.',
        kind: 'fact',
        tier: 'source',
        aspect: null,
      },
    });
    expect(
      converted[0].observation.sources.some(
        (item: Item) => item.uri === 'https://docs.example.com/document/d/file-1',
      ),
    ).toBe(true);
    // Forgetting the observation also forgets the record it came from.
    await ok(client, 'forget', {
      observation_id: converted[0].observation.observation_id,
      idempotency_key: 'legacy-3',
    });
    expect((await legacy.recall(access, { query: 'Umbrella', mode: 'contextual' })).items).toEqual(
      [],
    );
  }, 90_000);

  it("returns user_required for the person's authority and for Forget under a policy other than automatic", async () => {
    const subject = 'github:2006';
    await admit(subject, 'tenant-confirm', 'personal');
    const response = await fetch(
      `http://${emulatorHost}/v1/projects/${projectId}/databases/${memoryDatabase}/documents/memoryAdmissions/${admissionDocumentId(issuer, subject)}?updateMask.fieldPaths=approvalPolicy`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: { approvalPolicy: { stringValue: 'confirm' } } }),
      },
    );
    expect(response.ok).toBe(true);
    const client = await connect(grant(subject));
    expect(await ok(client, 'get_access')).toMatchObject({ approval_policy: 'confirm' });
    const note = {
      title: 'A note',
      summary: 'An observation needs no approval.',
      nature: 'event',
      subjects: ['Confirm'],
    };
    const written = await ok(client, 'observe', { ...note, idempotency_key: 'confirm-1' });
    expect(written).toMatchObject({ tier: 'inference' });
    expect(
      errorCode(
        await call(client, 'observe', { ...note, as_user: true, idempotency_key: 'confirm-2' }),
      ),
    ).toBe('user_required');
    expect(
      errorCode(
        await call(client, 'forget', {
          observation_id: written.observation_id,
          idempotency_key: 'confirm-3',
        }),
      ),
    ).toBe('user_required');
    // Earlier tests moved the ledger head, so this new scope was reconciled before its first use.
    expect(logs.some((event) => event['event'] === 'observation.restore.reconciled')).toBe(true);
  }, 60_000);

  it('takes a misled writer out of every read and hides what a restored backup would bring back', async () => {
    const subject = 'github:2007';
    await admit(subject, 'tenant-suppress', 'personal');
    const trusted = await connect(grant(subject));
    const misled = await connect(grant(subject, await provision(subject)));
    const owner = { title: 'Owner', nature: 'state', subjects: ['Pied Piper'], aspect: 'owner' };
    const good = await ok(trusted, 'observe', {
      ...owner,
      summary: 'Pied Piper is owned by Richard.',
      value: 'Richard',
      effective_at: '2026-01-01T00:00:00Z',
      idempotency_key: 'suppress-1',
    });
    const bad = await ok(misled, 'observe', {
      ...owner,
      summary: 'Pied Piper is owned by Gavin.',
      value: 'Gavin',
      effective_at: '2026-01-02T00:00:00Z',
      idempotency_key: 'suppress-2',
    });
    expect(bad.topic.current.value).toBe('Gavin');

    const { app } = await instance(subject);
    const access = await app.runtime.access.resolve({
      issuer,
      subject,
      connectionId: 'shared-ai',
      clientId: 'shared-ai',
    });
    const worker = await app.runtime.access.worker(access);
    const misledPrincipal = String((await ok(misled, 'get_access'))['principal_id']);
    await app.runtime.observations.setWriterSuppression(worker, access.scopeId, {
      principalId: misledPrincipal,
      from: null,
      until: null,
      active: true,
    });
    const suppressed = await ok(trusted, 'recall', { query: 'Pied Piper' });
    expect(suppressed.items).toHaveLength(1);
    expect(suppressed.items[0].topic).toMatchObject({
      current: { value: 'Richard', observation_id: good.observation_id },
      previous: null,
    });
    expect(JSON.stringify(suppressed)).not.toContain('Gavin');
    expect(
      errorCode(await call(trusted, 'get_observation', { observation_id: bad.observation_id })),
    ).toBe('not_found');
    // Lifting it brings the observations back; nothing was deleted.
    await app.runtime.observations.setWriterSuppression(worker, access.scopeId, {
      principalId: misledPrincipal,
      from: null,
      until: null,
      active: false,
    });
    expect(
      (await ok(trusted, 'recall', { query: 'Pied Piper' })).items[0].topic.current.value,
    ).toBe('Gavin');

    // A backup restored after a Forget holds the observation without its forgotten mark; the
    // ledger then names it in a suppression document, and that alone must hide it.
    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
    const seeded = await fetch(
      `http://${emulatorHost}/v1/projects/${projectId}/databases/${memoryDatabase}/documents/memoryTenants/${encode('tenant-suppress')}/scopes/${encode('personal')}/suppressions?documentId=${encode(bad.observation_id)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
        body: JSON.stringify({ fields: { deletionId: { stringValue: 'deletion-demo' } } }),
      },
    );
    expect(seeded.ok).toBe(true);
    const restored = await ok(trusted, 'recall', { query: 'Pied Piper Gavin' });
    expect(restored.items[0].topic.current.value).toBe('Richard');
    expect(JSON.stringify(restored)).not.toContain('Gavin');
    const course = await ok(trusted, 'get_timeline', { subjects: ['Pied Piper'] });
    expect(course.observations.map((item: Item) => item.value)).toEqual(['Richard']);
  }, 90_000);
});
