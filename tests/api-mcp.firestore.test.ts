import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
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
const resourceClientId = 'lore-mcp-resource';
const resourceClientSecret = 'synthetic-resource-secret';

interface Grant {
  readonly subject: string;
  readonly connectionId: string;
  readonly clientId: string;
}

// Tool results are checked field by field, so they are read loosely here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content: Array<{ type: string; text?: string }>;
}

const tokens = new Map<string, Grant>();
const clients: Client[] = [];
const logs: Readonly<Record<string, unknown>>[] = [];
let gate: Server;
let appServer: Server;
let app: ApiApp;
let issuer: string;
let baseUrl: string;
let resourceUrl: string;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function grant(subject: string, connectionId: string, clientId = 'test-ai-client'): string {
  const token = randomUUID().replaceAll('-', '');
  tokens.set(token, { subject, connectionId, clientId });
  return token;
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

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'lore-api-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resourceUrl), {
      authProvider: { token: async () => token },
    }),
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
  gate = createServer((request, response) => {
    void (async () => {
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'GET' && request.url === '/.well-known/openid-configuration') {
        send(200, { issuer, introspection_endpoint: `${issuer}/oauth/introspect` });
        return;
      }
      if (request.method === 'POST' && request.url === '/oauth/introspect') {
        const expected = `Basic ${Buffer.from(`${resourceClientId}:${resourceClientSecret}`).toString('base64')}`;
        if (request.headers.authorization !== expected) {
          send(401, { error: 'invalid_client' });
          return;
        }
        const token = new URLSearchParams(await body(request)).get('token') ?? '';
        const found = tokens.get(token);
        if (!found) {
          send(200, { active: false });
          return;
        }
        send(200, {
          active: true,
          token_type: 'Bearer',
          gate_approved: true,
          iss: issuer,
          sub: found.subject,
          connection_id: found.connectionId,
          client_id: found.clientId,
          aud: resourceUrl,
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        return;
      }
      send(404, { error: 'not_found' });
    })();
  });
  issuer = `http://127.0.0.1:${await listen(gate)}`;
  appServer = createServer();
  const port = await listen(appServer);
  baseUrl = `http://127.0.0.1:${port}`;
  resourceUrl = `${baseUrl}/mcp`;
  const config = loadConfig({
    NODE_ENV: 'test',
    ALLOW_LOOPBACK_HTTP: '1',
    FIRESTORE_PROJECT_ID: projectId,
    FIRESTORE_DATABASE_ID: memoryDatabase,
    LEDGER_DATABASE_ID: ledgerDatabase,
    GATE_ISSUER: issuer,
    MCP_RESOURCE_URL: resourceUrl,
    GATE_MCP_CLIENT_ID: resourceClientId,
    GATE_MCP_CLIENT_SECRET: resourceClientSecret,
    CURSOR_HMAC_KEYS: `test=${Buffer.alloc(32, 9).toString('base64url')}`,
    CURSOR_HMAC_ACTIVE_KEY: 'test',
    EMBEDDING_PROVIDER: 'deterministic',
  });
  app = createApiApp(config, { log: (event) => logs.push(event) });
  appServer.on('request', app.listener);
}, 30_000);

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await new Promise((resolve) => appServer?.close(resolve));
  await new Promise((resolve) => gate?.close(resolve));
  await app?.close();
});

describe('Lore API over Remote MCP', () => {
  it('serves health, readiness and resource metadata and challenges calls without a token', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(await metadata.json()).toMatchObject({
      resource: resourceUrl,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });

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
    const anonymous = await fetch(resourceUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(initialize),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    const unknown = await fetch(resourceUrl, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer not-a-gate-token' },
      body: JSON.stringify(initialize),
    });
    expect(unknown.status).toBe(401);
    await expect(connect('not-a-gate-token')).rejects.toThrow();
  });

  it('provides concise, current server instructions in MCP initialization', async () => {
    const subject = 'github:404405';
    await admit(subject, 'tenant-instructions', 'personal');
    const token = grant(subject, 'connection-instructions');
    const response = await fetch(resourceUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
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

  it('refuses a verified Gate account without an admission with 403', async () => {
    const token = grant('github:404404', 'connection-unadmitted');
    const response = await fetch(resourceUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
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
    const client = await connect(grant(subject, 'connection-course'));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'forget',
      'get_access',
      'get_changes',
      'get_observation',
      'get_timeline',
      'link',
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
    const recalled = await ok(client, 'recall', { query: 'アクメーロジックの案件の進捗を教えて' });
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
    const first = await connect(grant(subject, 'connection-trust-a'));
    const second = await connect(grant(subject, 'connection-trust-b'));
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

    // A connection starts with General only and cannot write into a compartment.
    expect(
      errorCode(
        await call(first, 'observe', {
          ...status,
          summary: 'A compartment write.',
          value: 'agreed',
          compartment_ids: ['work'],
          idempotency_key: 'trust-6',
        }),
      ),
    ).toBe('forbidden');
  }, 90_000);

  it('resolves names without merging subjects and reads linked subjects and topics together', async () => {
    const subject = 'github:2003';
    await admit(subject, 'tenant-subjects', 'personal');
    const client = await connect(grant(subject, 'connection-subjects'));
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
    const client = await connect(grant(subject, 'connection-forget-obs'));
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
    const access = await app.runtime.access.resolve({
      issuer,
      subject,
      connectionId: 'connection-legacy',
      clientId: 'test-ai-client',
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
    const client = await connect(grant(subject, 'connection-legacy'));
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
    const client = await connect(grant(subject, 'connection-confirm'));
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
    const trusted = await connect(grant(subject, 'connection-suppress-a'));
    const misled = await connect(grant(subject, 'connection-suppress-b'));
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

    const access = await app.runtime.access.resolve({
      issuer,
      subject,
      connectionId: 'connection-suppress-a',
      clientId: 'test-ai-client',
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
