import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApiApp, type ApiApp } from '../apps/api/src/app.js';
import { loadConfig } from '../apps/api/src/config.js';
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

interface StoredRevision {
  readonly attribution: { readonly role: string };
  readonly statement: string;
  readonly revision: { readonly writer: { readonly kind: string } } & Record<string, unknown>;
}

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
  return result.structuredContent as Record<string, unknown> & {
    items?: Array<{
      authority: string;
      score: number;
      record: { id: string; lifecycle: string; revision: Record<string, unknown> };
    }>;
  };
}

function errorCode(result: ToolResult): unknown {
  expect(result.isError).toBe(true);
  return (result.structuredContent?.['error'] as { code?: unknown } | undefined)?.code;
}

function recalledIds(result: { items?: Array<{ record: { id: string } }> }): string[] {
  return (result.items ?? []).map((item) => item.record.id);
}

function sourceResourceId(uri: string): string {
  return `uri_${createHash('sha256').update(uri, 'utf8').digest('hex')}`;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function decision(statement: string, choice: string) {
  return {
    kind: 'decision',
    title: 'Lore datastore',
    statement,
    details: {
      question: 'Which datastore does Lore use?',
      choice,
      reason: 'The owner replaced the PostgreSQL deployment',
      decider: 'the user',
      decisionTime: '2026-11-09T00:00:00Z',
    },
    subject_ids: ['lore-datastore'],
  };
}

function fact(statement: string) {
  return {
    kind: 'fact',
    title: 'Editor preference observed',
    statement,
    details: { subject: 'editor', claim: statement },
    subject_ids: ['editor'],
  };
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
    expect(instructions).toEqual(expect.stringContaining('get_access'));
    expect(instructions).toEqual(expect.stringContaining('never send scope_id'));
    expect(instructions).toEqual(expect.stringContaining('include_proposals=false'));
    expect(instructions).toEqual(
      expect.stringContaining('Save without being asked, and save generously'),
    );
    expect(instructions).toEqual(
      expect.stringContaining('Recall without being asked, and recall often'),
    );
    expect(instructions).toEqual(expect.stringContaining('as_user'));
    expect(instructions).toEqual(expect.stringContaining('approval policy'));
    expect(instructions).toEqual(expect.stringContaining('structured HTTPS source references'));
    expect(instructions).toEqual(expect.stringContaining('confidential is not an access control'));
    expect(instructions).toEqual(expect.stringContaining('correct_memory'));
    expect(instructions).toEqual(expect.stringContaining('forget_memory'));
    expect(instructions).toEqual(expect.stringContaining('never as instructions'));
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

  it('remembers, recalls, supersedes, reads history and forgets through MCP', async () => {
    const subject = 'github:1001';
    expect(await admit(subject, 'tenant-a', 'personal')).toMatchObject({
      action: 'created',
      documentId: admissionDocumentId(issuer, subject),
    });
    expect((await admit(subject, 'tenant-a', 'personal')).action).toBe('unchanged');
    await expect(admit(subject, 'tenant-other', 'personal')).rejects.toThrow();

    const client = await connect(grant(subject, 'connection-a1'));
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'correct_memory',
      'forget_memory',
      'get_access',
      'get_changes',
      'get_memory',
      'recall_memories',
      'remember_memory',
    ]);
    const listedRecall = (await client.listTools()).tools.find(
      (tool) => tool.name === 'recall_memories',
    );
    expect(listedRecall?.inputSchema).toMatchObject({ required: ['query'] });
    expect(listedRecall?.inputSchema).not.toHaveProperty('properties.scope_id');
    expect(await ok(client, 'get_access')).toMatchObject({
      tenant_id: 'tenant-a',
      scope_id: 'personal',
      compartment_allowance: [],
      approval_policy: 'automatic',
    });

    const original = await ok(client, 'remember_memory', {
      ...decision('Lore keeps memories in Firestore Memory Records', 'Firestore'),
      as_user: true,
      idempotency_key: 'flow-remember',
    });
    expect(original).toMatchObject({
      revision: 1,
      lifecycle: 'active',
      authority: 'user',
      approval_provenance: 'policy',
      replayed: false,
    });
    const originalId = String(original['record_id']);

    const recalled = await ok(client, 'recall_memories', {
      query: 'Which datastore does Lore use?',
    });
    expect(recalledIds(recalled)).toContain(originalId);
    expect(recalled.items?.find((item) => item.record.id === originalId)?.authority).toBe('user');
    const callerScope = await call(client, 'recall_memories', {
      query: 'Which datastore does Lore use?',
      scope_id: 'caller-selected-scope',
    });
    expect(callerScope.isError).toBe(true);
    expect(callerScope.content.map((entry) => entry.text ?? '').join(' ')).toContain('scope_id');

    const read = await ok(client, 'get_memory', { record_id: originalId });
    expect(read).toMatchObject({ latest_revision: 1, lifecycle: 'active', authority: 'user' });
    const firstRevision = (read['revisions'] as StoredRevision[])[0]!;
    expect(firstRevision.attribution).toMatchObject({ role: 'user' });
    expect(firstRevision.revision).toMatchObject({
      writer: { kind: 'person' },
      approval: { status: 'approved', provenance: 'policy' },
      requestingConnectionId: 'connection-a1',
      gateClientId: 'test-ai-client',
      sourceReferences: [
        { provider: 'lore-mcp', accountOrTenant: 'test-ai-client', resourceId: 'flow-remember' },
      ],
    });

    await pause(25);
    const knownBefore = new Date().toISOString();
    await pause(25);
    const superseded = await ok(client, 'correct_memory', {
      record_id: originalId,
      action: 'supersede',
      expected_revision: 1,
      reason: 'The ledger moved to its own database',
      as_user: true,
      idempotency_key: 'flow-supersede',
      replacement: {
        statement:
          'Lore keeps memories in Firestore and the deletion ledger in a separate database',
        details: {
          question: 'Which datastore does Lore use?',
          choice: 'Firestore with a separate ledger database',
          reason: 'Forget needs an independent ledger',
          decider: 'the user',
          decisionTime: '2026-11-09T01:00:00Z',
        },
      },
    });
    expect(superseded).toMatchObject({ revision: 2, lifecycle: 'superseded', authority: 'user' });
    const replacementId = String(superseded['replacement_id']);

    const stale = await call(client, 'correct_memory', {
      record_id: originalId,
      action: 'refine',
      expected_revision: 1,
      reason: 'A stale edit',
      as_user: true,
      idempotency_key: 'flow-stale',
      replacement: { title: 'Stale' },
    });
    expect(errorCode(stale)).toBe('conflict');

    const current = await ok(client, 'recall_memories', {
      query: 'Which datastore does Lore use?',
      mode: 'contextual',
    });
    expect(recalledIds(current)).toContain(replacementId);
    expect(recalledIds(current)).not.toContain(originalId);

    const historical = await ok(client, 'recall_memories', {
      query: 'Which datastore does Lore use?',
      mode: 'historical',
      known_at: knownBefore,
    });
    expect(recalledIds(historical)).toContain(originalId);
    expect(recalledIds(historical)).not.toContain(replacementId);

    expect(await ok(client, 'get_memory', { record_id: originalId })).toMatchObject({
      lifecycle: 'superseded',
      superseded_by: replacementId,
      latest_revision: 2,
      current: null,
    });

    const headBefore = await app.runtime.ledger.head();
    const forgotten = await ok(client, 'forget_memory', {
      record_id: replacementId,
      idempotency_key: 'flow-forget',
    });
    expect(forgotten).toEqual({ record_id: replacementId, status: 'stopped', use_stopped: true });
    expect(await app.runtime.ledger.head()).toBe(headBefore + 1);
    expect(
      await ok(client, 'forget_memory', {
        record_id: replacementId,
        idempotency_key: 'flow-forget',
      }),
    ).toEqual(forgotten);
    expect(await app.runtime.ledger.head()).toBe(headBefore + 1);

    const afterForget = await ok(client, 'recall_memories', {
      query: 'Which datastore does Lore use?',
      mode: 'contextual',
    });
    expect(recalledIds(afterForget)).not.toContain(replacementId);
    expect(afterForget['insufficiencies']).not.toContain('index-lag');
    expect(errorCode(await call(client, 'get_memory', { record_id: replacementId }))).toBe(
      'not_found',
    );
    expect(
      errorCode(
        await call(client, 'forget_memory', {
          record_id: 'mem_doesnotexist',
          idempotency_key: 'flow-forget-missing',
        }),
      ),
    ).toBe('not_found');

    const changes = await ok(client, 'get_changes');
    const entries = changes['entries'] as Array<{ operation: string; recordIds: string[] }>;
    expect(entries.map((entry) => entry.operation)).toContain('deletion');
    expect(entries.some((entry) => entry.recordIds.includes(replacementId))).toBe(false);
    const next = await ok(client, 'get_changes', { cursor: changes['cursor'] });
    expect(next['entries']).toEqual([]);
    expect(
      errorCode(await call(client, 'get_changes', { cursor: `${String(changes['cursor'])}x` })),
    ).toBe('resync_required');

    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('Lore keeps memories');
    expect(logged).not.toContain('Which datastore');
  }, 60_000);

  it('replays an idempotent request and rejects a reused key with different input', async () => {
    const subject = 'github:1002';
    await admit(subject, 'tenant-replay', 'personal');
    const client = await connect(grant(subject, 'connection-replay'));
    const input = { ...fact('The user edits in Helix'), idempotency_key: 'replay-proposal' };
    const first = await ok(client, 'remember_memory', input);
    const second = await ok(client, 'remember_memory', input);
    expect(second).toEqual({ ...first, replayed: true });
    expect(first).toMatchObject({ authority: 'proposal', lifecycle: 'candidate' });

    const user = {
      ...decision('Lore runs on Cloud Run', 'Cloud Run'),
      as_user: true,
      idempotency_key: 'replay-user',
    };
    const firstUser = await ok(client, 'remember_memory', user);
    expect(await ok(client, 'remember_memory', user)).toEqual({ ...firstUser, replayed: true });

    expect(
      errorCode(
        await call(client, 'remember_memory', { ...input, statement: 'The user edits in Vim' }),
      ),
    ).toBe('idempotency_conflict');
    expect(
      errorCode(await call(client, 'remember_memory', { ...user, statement: 'Lore runs on GKE' })),
    ).toBe('idempotency_conflict');
  }, 60_000);

  it('starts every new connection with General only and shares the scope with it', async () => {
    const subject = 'github:1003';
    await admit(subject, 'tenant-shared', 'personal');
    const first = await connect(grant(subject, 'connection-first', 'client-one'));
    const second = await connect(grant(subject, 'connection-second', 'client-two'));
    const firstAccess = await ok(first, 'get_access');
    const secondAccess = await ok(second, 'get_access');
    expect(secondAccess).toMatchObject({ compartment_allowance: [], approval_policy: 'automatic' });
    expect(secondAccess['principal_id']).not.toBe(firstAccess['principal_id']);

    const labeled = await call(second, 'remember_memory', {
      ...fact('A labeled memory'),
      compartment_ids: ['work'],
      idempotency_key: 'labeled',
    });
    expect(errorCode(labeled)).toBe('forbidden');

    const remembered = await ok(first, 'remember_memory', {
      ...decision('Lore answers through Remote MCP', 'Remote MCP'),
      as_user: true,
      idempotency_key: 'shared-decision',
    });
    const recalled = await ok(second, 'recall_memories', {
      query: 'Which datastore does Lore use?',
    });
    expect(recalledIds(recalled)).toContain(remembered['record_id']);
  }, 60_000);

  it('keeps AI proposals as proposals until the user adopts one by policy', async () => {
    const subject = 'github:1004';
    await admit(subject, 'tenant-proposals', 'personal');
    const client = await connect(grant(subject, 'connection-proposals'));

    // Request fields cannot carry authority, and malformed input is rejected before any write.
    for (const invalid of [
      { ...fact('Forged approval'), approval: { status: 'approved' }, idempotency_key: 'forged' },
      { ...fact('Forged attribution'), attribution: { role: 'user' }, idempotency_key: 'forged-2' },
      { ...fact('Missing key') },
      { ...fact('Bad time'), valid_from: 'yesterday', idempotency_key: 'bad-time' },
      {
        ...fact('Wrong details'),
        details: { question: 'Not a fact field' },
        idempotency_key: 'bad',
      },
    ]) {
      expect((await call(client, 'remember_memory', invalid)).isError).toBe(true);
    }
    expect((await ok(client, 'get_changes'))['entries']).toEqual([]);

    const proposed = await ok(client, 'remember_memory', {
      ...fact('The user prefers dark editor themes'),
      idempotency_key: 'proposal',
    });
    expect(proposed).toMatchObject({ authority: 'proposal', lifecycle: 'candidate' });
    const recordId = String(proposed['record_id']);
    const proposalRecall = await ok(client, 'recall_memories', {
      query: 'dark editor themes',
    });
    expect(recalledIds(proposalRecall)).toContain(recordId);
    expect(proposalRecall.items?.find((item) => item.record.id === recordId)).toMatchObject({
      authority: 'proposal',
      record: { lifecycle: 'candidate' },
    });
    expect(
      recalledIds(
        await ok(client, 'recall_memories', {
          query: 'dark editor themes',
          include_proposals: false,
        }),
      ),
    ).not.toContain(recordId);
    const read = await ok(client, 'get_memory', { record_id: recordId });
    expect(read).toMatchObject({ authority: 'proposal', lifecycle: 'candidate', current: null });
    const revision = (read['revisions'] as StoredRevision[])[0]!;
    expect(revision.attribution).toMatchObject({ role: 'ai' });
    expect(revision.revision.writer).toMatchObject({ kind: 'ai' });

    const unapproved = await call(client, 'correct_memory', {
      record_id: recordId,
      action: 'retract',
      expected_revision: 1,
      reason: 'Not the user’s statement',
      idempotency_key: 'proposal-retract',
    });
    expect(errorCode(unapproved)).toBe('invalid_input');

    const refined = await ok(client, 'correct_memory', {
      record_id: recordId,
      action: 'refine',
      expected_revision: 1,
      reason: 'The user confirmed it',
      as_user: true,
      idempotency_key: 'proposal-adopt',
    });
    expect(refined).toMatchObject({
      revision: 2,
      lifecycle: 'active',
      authority: 'user',
      approval_provenance: 'policy',
    });
    const recalled = await ok(client, 'recall_memories', { query: 'dark editor themes' });
    expect(recalledIds(recalled)).toContain(recordId);
    expect(recalled.items?.find((item) => item.record.id === recordId)?.authority).toBe('user');
  }, 60_000);

  it('recalls proposals by default, ranks equal matches by authority, and honors historical time', async () => {
    const subject = 'github:1007';
    await admit(subject, 'tenant-proposal-recall', 'personal');
    const client = await connect(grant(subject, 'connection-proposal-recall'));
    const proposal = await ok(client, 'remember_memory', {
      ...fact('The user prefers dark editor themes'),
      idempotency_key: 'recall-proposal',
    });
    const proposalId = String(proposal['record_id']);
    await pause(25);
    const knownBeforeAdoption = new Date().toISOString();
    await ok(client, 'remember_memory', {
      ...fact('The user prefers dark editor themes'),
      as_user: true,
      idempotency_key: 'recall-user',
    });

    const recalled = await ok(client, 'recall_memories', {
      query: 'dark editor themes',
    });
    const matches = recalled.items ?? [];
    expect(matches).toHaveLength(2);
    expect(matches.map((item) => item.authority)).toEqual(['user', 'proposal']);
    expect(matches[0]?.score).toBe(matches[1]?.score);
    expect(recalledIds(recalled)).toContain(proposalId);
    expect(
      recalledIds(
        await ok(client, 'recall_memories', {
          query: 'dark editor themes',
          include_proposals: false,
        }),
      ),
    ).not.toContain(proposalId);

    await ok(client, 'correct_memory', {
      record_id: proposalId,
      action: 'refine',
      expected_revision: 1,
      reason: 'The user confirmed the preference',
      as_user: true,
      idempotency_key: 'recall-adopt',
    });
    const historical = await ok(client, 'recall_memories', {
      query: 'dark editor themes',
      mode: 'historical',
      known_at: knownBeforeAdoption,
    });
    const historicalProposal = historical.items?.find((item) => item.record.id === proposalId);
    expect(historicalProposal).toMatchObject({
      authority: 'proposal',
      record: { lifecycle: 'candidate', revision: { revision: 1 } },
    });
    expect(
      recalledIds(
        await ok(client, 'recall_memories', {
          query: 'dark editor themes',
          mode: 'historical',
          known_at: knownBeforeAdoption,
          include_proposals: false,
        }),
      ),
    ).not.toContain(proposalId);

    await ok(client, 'forget_memory', {
      record_id: proposalId,
      idempotency_key: 'recall-forget',
    });
    expect(
      recalledIds(await ok(client, 'recall_memories', { query: 'dark editor themes' })),
    ).not.toContain(proposalId);
  }, 60_000);

  it('stores structured sources, preserves or replaces them on correction, and bounds MCP input', async () => {
    const subject = 'github:1008';
    await admit(subject, 'tenant-sources', 'personal');
    const client = await connect(grant(subject, 'connection-sources'));
    const originalSources = [
      {
        provider: 'docs',
        uri: 'https://docs.example.test/guide',
        title: 'Guide',
        locator: 'section 3',
        version: 'v1',
      },
      {
        provider: 'drive',
        uri: 'https://drive.example.test/decision',
        title: 'Private decision',
        locator: 'paragraph 4',
        sensitivity: 'confidential',
      },
    ];
    const invalidInputs = [
      [{ provider: 'web', uri: 'http://docs.example.test/no-https' }],
      [{ provider: 'x'.repeat(101), uri: 'https://docs.example.test/provider' }],
      [{ provider: 'web', uri: 'https://docs.example.test/unknown', accountOrTenant: 'forged' }],
      [{ provider: 'web', uri: 'https://docs.example.test/title', title: 't'.repeat(201) }],
      Array.from({ length: 11 }, (_, index) => ({
        provider: 'web',
        uri: `https://docs.example.test/${index}`,
      })),
    ];
    for (const [index, invalidSources] of invalidInputs.entries()) {
      expect(
        (
          await call(client, 'remember_memory', {
            ...fact('A source validation probe'),
            sources: invalidSources,
            idempotency_key: `invalid-source-${index}`,
          })
        ).isError,
      ).toBe(true);
    }
    expect((await ok(client, 'get_changes'))['entries']).toEqual([]);

    const remembered = await ok(client, 'remember_memory', {
      ...fact('The editor guide recommends a dark theme'),
      as_user: true,
      sources: originalSources,
      idempotency_key: 'source-create',
    });
    expect(
      errorCode(
        await call(client, 'remember_memory', {
          ...fact('The editor guide recommends a dark theme'),
          as_user: true,
          sources: [{ ...originalSources[0], uri: 'https://docs.example.test/changed' }],
          idempotency_key: 'source-create',
        }),
      ),
    ).toBe('idempotency_conflict');
    const recordId = String(remembered['record_id']);
    const initial = await ok(client, 'get_memory', { record_id: recordId });
    const firstRevision = (initial['revisions'] as StoredRevision[])[0]!;
    expect(firstRevision.revision['sourceReferences']).toEqual([
      {
        provider: 'docs',
        accountOrTenant: 'docs.example.test',
        resourceId: sourceResourceId('https://docs.example.test/guide'),
        uri: 'https://docs.example.test/guide',
        title: 'Guide',
        locator: 'section 3',
        version: 'v1',
      },
      {
        provider: 'drive',
        accountOrTenant: 'drive.example.test',
        resourceId: sourceResourceId('https://drive.example.test/decision'),
        uri: 'https://drive.example.test/decision',
        title: 'Private decision',
        locator: 'paragraph 4',
        rights: ['confidential'],
      },
      {
        provider: 'lore-mcp',
        accountOrTenant: 'test-ai-client',
        resourceId: 'source-create',
      },
    ]);
    const recalled = await ok(client, 'recall_memories', {
      query: 'editor guide dark theme',
    });
    expect(
      recalled.items?.find((item) => item.record.id === recordId)?.record.revision.sourceReferences,
    ).toEqual(firstRevision.revision['sourceReferences']);

    await ok(client, 'correct_memory', {
      record_id: recordId,
      action: 'refine',
      expected_revision: 1,
      reason: 'Clarify the note',
      replacement: { title: 'Updated editor guide' },
      as_user: true,
      idempotency_key: 'source-preserve',
    });
    const afterPreserve = await ok(client, 'get_memory', { record_id: recordId });
    const revisionsAfterPreserve = afterPreserve['revisions'] as StoredRevision[];
    expect(revisionsAfterPreserve[1]?.revision['sourceReferences']).toEqual([
      ...(firstRevision.revision['sourceReferences'] as unknown[]),
      {
        provider: 'lore-mcp',
        accountOrTenant: 'test-ai-client',
        resourceId: 'source-preserve',
      },
    ]);

    const superseded = await ok(client, 'correct_memory', {
      record_id: recordId,
      action: 'supersede',
      expected_revision: 2,
      reason: 'The guide was replaced',
      as_user: true,
      replacement: {
        title: 'Updated editor guidance',
        statement: 'The editor guide recommends a dark theme after review',
      },
      idempotency_key: 'source-supersede',
    });
    const replacementId = String(superseded['replacement_id']);
    const afterSupersede = await ok(client, 'get_memory', { record_id: replacementId });
    const supersedeRefs = (afterSupersede['revisions'] as StoredRevision[])[0]?.revision[
      'sourceReferences'
    ] as Array<Record<string, unknown>>;
    expect(supersedeRefs).toEqual([
      ...(revisionsAfterPreserve[1]?.revision['sourceReferences'] as Array<
        Record<string, unknown>
      >),
      {
        provider: 'lore-mcp',
        accountOrTenant: 'test-ai-client',
        resourceId: 'source-supersede',
      },
    ]);

    const replacementSource = {
      provider: 'wiki',
      uri: 'https://wiki.example.test/dark-theme',
      title: 'Theme guidance',
      version: 'rev-2',
      sensitivity: 'normal',
    };
    const sourceOnly = {
      record_id: replacementId,
      action: 'refine',
      expected_revision: 1,
      reason: 'Replace the cited reference',
      as_user: true,
      replacement: { sources: [replacementSource] },
      idempotency_key: 'source-only-replace',
    };
    await ok(client, 'correct_memory', sourceOnly);
    expect(
      errorCode(
        await call(client, 'correct_memory', {
          ...sourceOnly,
          replacement: {
            sources: [{ ...replacementSource, uri: 'https://wiki.example.test/changed' }],
          },
        }),
      ),
    ).toBe('idempotency_conflict');
    const afterReplace = await ok(client, 'get_memory', { record_id: replacementId });
    const sourceOnlyRefs = (afterReplace['revisions'] as StoredRevision[])[1]?.revision[
      'sourceReferences'
    ] as Array<Record<string, unknown>>;
    expect(sourceOnlyRefs).toEqual([
      {
        provider: 'wiki',
        accountOrTenant: 'wiki.example.test',
        resourceId: sourceResourceId('https://wiki.example.test/dark-theme'),
        uri: 'https://wiki.example.test/dark-theme',
        title: 'Theme guidance',
        version: 'rev-2',
      },
      {
        provider: 'lore-mcp',
        accountOrTenant: 'test-ai-client',
        resourceId: 'source-only-replace',
      },
    ]);

    await ok(client, 'correct_memory', {
      record_id: replacementId,
      action: 'refine',
      expected_revision: 2,
      reason: 'Clear declared references',
      as_user: true,
      replacement: { sources: [] },
      idempotency_key: 'source-only-clear',
    });
    const afterClear = await ok(client, 'get_memory', { record_id: replacementId });
    expect((afterClear['revisions'] as StoredRevision[])[2]?.revision['sourceReferences']).toEqual([
      {
        provider: 'lore-mcp',
        accountOrTenant: 'test-ai-client',
        resourceId: 'source-only-clear',
      },
    ]);
    expect((afterClear['revisions'] as StoredRevision[])[2]?.statement).toBe(
      'The editor guide recommends a dark theme after review',
    );
  }, 60_000);

  it('returns user_required for protected changes under a policy other than automatic', async () => {
    const forgetting = 'github:1005';
    await admit(forgetting, 'tenant-forget', 'personal');
    const writer = await connect(grant(forgetting, 'connection-forget'));
    const remembered = await ok(writer, 'remember_memory', {
      ...decision('Lore deletes forgotten memories', 'Delete them'),
      as_user: true,
      idempotency_key: 'policy-forget-target',
    });
    await ok(writer, 'forget_memory', {
      record_id: remembered['record_id'],
      idempotency_key: 'policy-forget',
    });

    // The ledger head moved, so this new scope is reconciled before its first operation.
    const subject = 'github:1006';
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
    const proposal = await ok(client, 'remember_memory', {
      ...fact('A proposal needs no approval'),
      idempotency_key: 'confirm-proposal',
    });
    expect(proposal).toMatchObject({ authority: 'proposal' });
    expect(
      errorCode(
        await call(client, 'remember_memory', {
          ...decision('Lore needs confirmation', 'Confirm'),
          as_user: true,
          idempotency_key: 'confirm-user',
        }),
      ),
    ).toBe('user_required');
    expect(
      errorCode(
        await call(client, 'forget_memory', {
          record_id: proposal['record_id'],
          idempotency_key: 'confirm-forget',
        }),
      ),
    ).toBe('user_required');
    expect(logs.some((event) => event['event'] === 'memory.restore.reconciled')).toBe(true);
  }, 60_000);
});
