#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Authenticator } from '@memory/auth';
import { CursorCodec, CoreService } from '@memory/domain';
import { LocalDeterministicEmbeddingProvider } from '@memory/curator';
import { RecallService } from '@memory/recall';
import { createApiServer } from '../../apps/api/dist/server.js';

const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'] ?? '';
if (
  process.env['NODE_ENV'] === 'production' ||
  !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(emulatorHost)
) {
  throw new Error(
    'Gate integration requires an explicit loopback FIRESTORE_EMULATOR_HOST; refusing to skip.',
  );
}
const gateRoot = resolve(required('GATE_TEST_ROOT'));
const gateServicePath = join(gateRoot, 'dist/service.js');
const gateStoragePath = join(gateRoot, 'dist/storage.js');
for (const path of [gateServicePath, gateStoragePath]) {
  try {
    await access(path);
  } catch {
    throw new Error(`Gate integration prerequisite missing: ${path}`);
  }
}
const adminUrl = requireLoopbackDatabase('TEST_ADMIN_URL');
const appUrl = requireLoopbackDatabase('TEST_APP_URL');
const { createService } = await import(pathToFileURL(gateServicePath));
const { Storage, firestore } = await import(pathToFileURL(gateStoragePath));
const temp = await mkdtemp(join(tmpdir(), 'memory-gate-integration-'));
const certPath = join(temp, 'cert.pem');
const keyPath = join(temp, 'key.pem');
const certResult = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=gate.example.test',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:gate.example.test',
  ],
  { stdio: 'ignore' },
);
if (certResult.status !== 0)
  throw new Error('Gate integration could not generate its isolated local TLS certificate.');
const cert = await readFile(certPath);
const key = await readFile(keyPath);
const gatePort = await reservePort();
const issuer = `https://gate.example.test:${gatePort}`;
const apiOrigin = 'https://memory.example.test';
const callbackPort = await reservePort();
const callback = `http://127.0.0.1:${callbackPort}/callback`;
const mcpClientId = 'memory-mcp-client';
const resourceIds = {
  api: 'memory-api-resource',
  read: 'memory-mcp-read-resource',
  write: 'memory-mcp-write-resource',
};
const resourceSecrets = {
  api: `synthetic-api-resource-${'a'.repeat(32)}`,
  read: `synthetic-read-resource-${'r'.repeat(32)}`,
  write: `synthetic-write-resource-${'w'.repeat(32)}`,
};
const audiences = {
  api: apiOrigin,
  read: `${apiOrigin}/mcp/read`,
  write: `${apiOrigin}/mcp/write`,
};
const allowedClientIds = Object.freeze([mcpClientId]);
const subject = 'github:12345';
const legacyIssuer = 'https://legacy-issuer.example.test';
const legacySubject = `gate-integration-${subject}`;
const apiWriteStatement = `Gate API bearer memory ${randomUUID()}`;
const namespace = `memory_gate_${randomBytes(12).toString('hex')}`;
const firestoreDb = firestore('demo-memory-gate-test', '(default)');
const storage = new Storage(firestoreDb, namespace);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...privateKey.export({ format: 'jwk' }),
  kid: 'memory-gate-integration',
  use: 'sig',
  alg: 'RS256',
};
const gateConfig = {
  issuer,
  firestoreProjectId: 'demo-memory-gate-test',
  firestoreDatabaseId: '(default)',
  githubClientId: 'synthetic-github-client',
  githubClientSecret: 'synthetic-github-secret',
  githubUserId: '12345',
  cookieKeys: ['a'.repeat(64)],
  jwks: { keys: [jwk] },
  port: gatePort,
  sessionCookieDomain: 'example.test',
  browserSessionTtlSeconds: 3600,
  browserApps: [],
  browserOrigins: [],
  clients: [
    { client_id: mcpClientId, client_name: 'Memory MCP client', redirect_uris: [callback] },
  ],
  resources: Object.entries(resourceIds).map(([name, client_id]) => ({
    audience: audiences[name],
    client_id,
    client_secret: resourceSecrets[name],
    browser_client_id: `inactive-schema-${name}-browser-client`,
  })),
};
const cookieJar = new Map();
let gateServer;
let apiServer;
let admin;
let app;
let mcpReadClient;
const created = { user: randomUUID(), scope: randomUUID(), principal: randomUUID() };
let trustedGateAvailable = true;

try {
  admin = new Pool({ connectionString: adminUrl, max: 2 });
  app = new Pool({ connectionString: appUrl, max: 2 });
  await cleanupSyntheticUser(admin, legacyIssuer, legacySubject);
  const gateService = await createService(gateConfig, storage, {
    exchange: async (code) => {
      assert.equal(code, 'synthetic-github-code');
      return '12345';
    },
  });
  gateServer = https.createServer({ cert, key }, (request, response) =>
    gateService.server.emit('request', request, response),
  );
  await new Promise((resolveListen, reject) => {
    gateServer.once('error', reject);
    gateServer.listen(gatePort, '127.0.0.1', resolveListen);
  });

  await admin.query('INSERT INTO users(id) VALUES ($1)', [created.user]);
  await admin.query('INSERT INTO scopes(user_id,id,name) VALUES ($1,$2,$3)', [
    created.user,
    created.scope,
    'Gate integration',
  ]);
  await admin.query(
    `INSERT INTO principals(id,user_id,issuer,subject,actor_kind) VALUES ($1,$2,$3,$4,'user')`,
    [created.principal, created.user, legacyIssuer, legacySubject],
  );
  await admin.query(
    "INSERT INTO grants(user_id,scope_id,principal_id,capabilities) VALUES ($1,$2,$3,ARRAY['read','write','admin'])",
    [created.user, created.scope, created.principal],
  );
  for (const clientId of allowedClientIds) {
    await admin.query(
      `INSERT INTO external_identity_bindings(external_issuer,external_subject,external_client_id,user_id,principal_id,scope_ids,capability_ceiling)
       VALUES ($1,$2,$3,$4,$5,$6::uuid[],ARRAY['read','write','admin'])`,
      [issuer, subject, clientId, created.user, created.principal, [created.scope]],
    );
  }

  const trustedFetch = async (input, init = {}) => {
    if (!trustedGateAvailable) throw new Error('synthetic Gate outage');
    const target = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    assert.equal(
      target.origin,
      issuer,
      'integration authorization must remain on its isolated local Gate server',
    );
    const reply = await gateRequest(target, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(
        new globalThis.Headers(
          init.headers ?? (input instanceof globalThis.Request ? input.headers : undefined),
        ),
      ),
      body: init.body ?? (input instanceof globalThis.Request ? input.body : undefined),
    });
    const response = new globalThis.Response(reply.data, {
      status: reply.status,
      headers: reply.headers,
    });
    Object.defineProperty(response, 'url', { value: target.href });
    return response;
  };
  const authFor = (kind) =>
    new Authenticator({
      pool: app,
      issuer,
      audience: audiences[kind],
      clientId: resourceIds[kind],
      clientSecret: resourceSecrets[kind],
      allowedClientIds,
      fetch: trustedFetch,
    });
  const apiAuth = authFor('api');
  const readAuth = authFor('read');
  const writeAuth = authFor('write');
  const cursorKey = Buffer.alloc(32, 17);
  const cursorCodec = new CursorCodec(
    'gate-integration',
    new Map([['gate-integration', cursorKey]]),
  );
  const core = new CoreService(app, cursorCodec, {
    forgetHmacKey: 'gate-integration-forget-hmac-key-with-32-bytes',
  });
  const recall = new RecallService(app, core, new LocalDeterministicEmbeddingProvider());
  apiServer = createApiServer({
    auth: apiAuth,
    mcpReadAuth: readAuth,
    mcpWriteAuth: writeAuth,
    mcpAuthorizationServerUrl: issuer,
    mcpResourceBaseUrl: apiOrigin,
    mcpAllowedHosts: ['memory.example.test', '127.0.0.1'],
    core,
    recall,
  });
  await new Promise((resolveListen, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(0, '127.0.0.1', resolveListen);
  });
  const apiPort = apiServer.address().port;

  const callbackResponse = await apiRequest(apiPort, '/auth-return.html?code=must-not-be-served');
  assert.equal(callbackResponse.status, 404, callbackResponse.text);
  const session = await apiRequest(apiPort, '/v1/session');
  assert.equal(session.status, 404, session.text);
  const cookieOnlyApi = await apiRequest(apiPort, '/v1/memories:remember', {
    method: 'POST',
    headers: {
      cookie: '__Secure-gate_session=synthetic-session',
      'content-type': 'application/json',
      'idempotency-key': `cookie-only-${randomUUID()}`,
    },
    body: JSON.stringify({
      scope_id: created.scope,
      memory: {
        kind: 'fact',
        statement: apiWriteStatement,
        context: { source: 'gate-api-only-integration' },
        subjects: [{ name: 'Gate integration user', aliases: [] }],
        evidence: [
          {
            source: {
              kind: 'explicit_remember',
              external_id: `gate-api-${randomUUID()}`,
              revision: '1',
              locator: 'test/memory',
            },
            snippet: 'Synthetic Gate API integration evidence',
            snippet_allowed: true,
          },
        ],
      },
    }),
  });
  assert.equal(cookieOnlyApi.status, 401, cookieOnlyApi.text);
  const cookieOnlyMcp = await apiRequest(apiPort, '/mcp/read', {
    method: 'POST',
    headers: {
      cookie: '__Secure-gate_session=synthetic-session',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(cookieOnlyMcp.status, 401, cookieOnlyMcp.text);
  assert.equal((await apiRequest(apiPort, '/mcp/read', { method: 'GET' })).status, 405);

  const apiToken = await acquireMcpToken(audiences.api);
  const apiActor = await apiAuth.authenticateBearer(`Bearer ${apiToken}`);
  assert.equal(
    apiActor.userId,
    created.user,
    'Gate API resource token maps to the same existing user',
  );
  await apiAuth.assertCurrent(apiActor);
  const accessToken = await acquireMcpToken(audiences.read);
  await assert.rejects(apiAuth.authenticateBearer(`Bearer ${accessToken}`), { status: 401 });

  const writeResponse = await apiRequest(apiPort, '/v1/memories:remember', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      cookie: '__Secure-gate_session=ignored-with-bearer',
      'content-type': 'application/json',
      'idempotency-key': `gate-api-${randomUUID()}`,
    },
    body: JSON.stringify({
      scope_id: created.scope,
      memory: {
        kind: 'fact',
        statement: apiWriteStatement,
        context: { source: 'gate-api-only-integration' },
        subjects: [{ name: 'Gate integration user', aliases: [] }],
        evidence: [
          {
            source: {
              kind: 'explicit_remember',
              external_id: `gate-api-${randomUUID()}`,
              revision: '1',
              locator: 'test/memory',
            },
            snippet: 'Synthetic Gate API integration evidence',
            snippet_allowed: true,
          },
        ],
      },
    }),
  });
  assert.equal(writeResponse.status, 200, writeResponse.text);
  const createdMemory = JSON.parse(writeResponse.text);
  const memoryId = createdMemory.operations?.[0]?.memory_ids?.[0];
  assert.ok(typeof memoryId === 'string', writeResponse.text);
  const apiRead = await apiRequest(apiPort, `/v1/memories/${memoryId}?scope_id=${created.scope}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert.equal(apiRead.status, 200, apiRead.text);
  assert.equal(JSON.parse(apiRead.text).statement, apiWriteStatement);

  assert.ok(
    accessToken.length > 16 && !accessToken.startsWith('eyJ'),
    'Gate access token is opaque, not a signed JWT',
  );
  const actor = await readAuth.authenticateBearer(`Bearer ${accessToken}`);
  assert.equal(actor.userId, created.user);
  assert.equal(actor.principalId, created.principal);
  assert.equal(actor.scopeIds[0], created.scope);
  await readAuth.assertCurrent(actor);
  await assert.rejects(writeAuth.authenticateBearer(`Bearer ${accessToken}`), { status: 401 });

  mcpReadClient = new McpClient({ name: 'memory-gate-integration', version: '1.0.0' });
  await mcpReadClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${apiPort}/mcp/read`), {
      authProvider: { token: async () => accessToken },
    }),
  );
  const tools = await mcpReadClient.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'recall_memories'));
  assert.ok(!tools.tools.some((tool) => tool.name === 'remember_memory'));
  const mcpRead = await mcpReadClient.callTool({
    name: 'recall_memories',
    arguments: { query: apiWriteStatement, scope_id: created.scope, mode: 'precise' },
  });
  assert.ok(
    !mcpRead.isError && JSON.stringify(mcpRead).includes(apiWriteStatement),
    'real Gate MCP token must read the memory written through the bearer API',
  );

  trustedGateAvailable = false;
  const outage = await apiRequest(apiPort, `/v1/memories/${memoryId}?scope_id=${created.scope}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert.equal(outage.status, 503, outage.text);
  trustedGateAvailable = true;

  const connections = await gateRequest(`${issuer}/connections`, {}, true);
  assert.equal(connections.status, 200, connections.text);
  const oauthGrant =
    /<p>Memory MCP client — [^<]+<\/p><form method="post" action="\/connections\/revoke"><input type="hidden" name="csrf" value="([^"]+)"><input type="hidden" name="id" value="([^"]+)">/.exec(
      connections.text,
    );
  assert.ok(oauthGrant, 'Gate connection management must expose the approved MCP OAuth grant');
  const revokeGrant = await gateRequest(
    `${issuer}/connections/revoke`,
    {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: oauthGrant[1], id: oauthGrant[2] }).toString(),
    },
    true,
  );
  assert.equal(revokeGrant.status, 303, revokeGrant.text);
  await assert.rejects(readAuth.authenticateBearer(`Bearer ${accessToken}`), { status: 401 });
  const revokedMcpRequest = await apiRequest(apiPort, '/mcp/read', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'revoked-gate-client', version: '1' },
      },
    }),
  });
  assert.equal(revokedMcpRequest.status, 401, revokedMcpRequest.text);

  await cleanupSyntheticUser(admin, legacyIssuer, legacySubject);
  console.log(
    JSON.stringify({
      actual_gate_firestore_postgres: 'passed',
      lore_callback_and_session_routes_absent: true,
      api_cookie_only_rejected: true,
      mcp_cookie_only_rejected: true,
      api_bearer_write_read_same_user: true,
      mcp_sdk_read_of_api_written_memory: true,
      opaque_mcp_token_online_introspection: true,
      final_gate_outage_fails_closed: true,
      actual_mcp_oauth_grant_revocation: true,
      external_github_exchange: 'synthetic-boundary',
      hosted_firestore_dns_tls_and_cloud_run: false,
    }),
  );
} finally {
  if (admin && created.user) {
    await cleanupSyntheticUser(admin, legacyIssuer, legacySubject).catch(() => undefined);
  }
  await app?.end();
  await admin?.end();
  await mcpReadClient?.close().catch(() => undefined);
  if (apiServer?.listening) await new Promise((resolveClose) => apiServer.close(resolveClose));
  if (gateServer?.listening) await new Promise((resolveClose) => gateServer.close(resolveClose));
  await clearFirestoreNamespace(firestoreDb, namespace).catch(() => undefined);
  await firestoreDb.terminate?.();
  await rm(temp, { recursive: true, force: true });
}

async function acquireMcpToken(resource = audiences.read) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizationUrl = `${issuer}/auth?${new URLSearchParams({
    client_id: mcpClientId,
    redirect_uri: callback,
    response_type: 'code',
    scope: 'openid',
    resource,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomUUID(),
  })}`;
  let reply = await gateRequest(authorizationUrl, {}, true);
  let redirect;
  for (let count = 0; count < 30; count += 1) {
    assert.ok([302, 303].includes(reply.status), reply.text);
    const next = new URL(reply.location, issuer);
    if (next.origin === new URL(callback).origin) {
      redirect = next;
      break;
    }
    if (next.origin === 'https://github.com') {
      const state = next.searchParams.get('state');
      assert.ok(state);
      reply = await gateRequest(
        `${issuer}/github/callback?${new URLSearchParams({ state, code: 'synthetic-github-code' })}`,
        {},
        true,
      );
      continue;
    }
    assert.equal(
      next.origin,
      issuer,
      'OAuth redirects must stay on isolated Gate or the registered local callback',
    );
    reply = await gateRequest(next.href, {}, true);
    if (reply.status === 200 && next.pathname.startsWith('/interaction/')) {
      const csrf = /name="csrf" value="([^"]+)"/.exec(reply.text)?.[1];
      assert.ok(csrf, reply.text);
      reply = await gateRequest(
        next.href,
        {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, decision: 'approve' }).toString(),
        },
        true,
      );
    }
  }
  assert.ok(redirect, 'Gate PKCE flow must reach the registered local callback');
  assert.equal(redirect.pathname, new URL(callback).pathname);
  const exchanged = await gateRequest(`${issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: mcpClientId,
      redirect_uri: callback,
      code: redirect.searchParams.get('code') ?? '',
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(exchanged.status, 200, exchanged.text);
  return JSON.parse(exchanged.text).access_token;
}

function gateRequest(input, options = {}, withCookies = false) {
  const target = new URL(input, issuer);
  assert.equal(target.origin, issuer, 'Gate test requests must stay on the isolated issuer');
  const headers = { ...options.headers, host: target.host };
  if (withCookies) {
    const active = [...cookieJar].filter(([, value]) => target.pathname.startsWith(value.path));
    if (active.length)
      headers.cookie = active.map(([name, value]) => `${name}=${value.value}`).join('; ');
  }
  return new Promise((resolveReply, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port: gatePort,
        servername: 'gate.example.test',
        ca: cert,
        path: target.pathname + target.search,
        method: options.method ?? 'GET',
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const data = Buffer.concat(chunks);
          const setCookies = response.headers['set-cookie'] ?? [];
          if (withCookies)
            for (const entry of setCookies) {
              const [pair, ...attrs] = entry.split(';');
              const index = pair.indexOf('=');
              const name = pair.slice(0, index);
              const value = pair.slice(index + 1);
              const maxAge = attrs.find((attr) => /^\s*max-age=/i.test(attr))?.split('=', 2)[1];
              if (maxAge === '0' || value === '') cookieJar.delete(name);
              else
                cookieJar.set(name, {
                  value,
                  path: /(?:^|;)\s*path=([^;]+)/i.exec(entry)?.[1] ?? '/',
                });
            }
          resolveReply({
            status: response.statusCode ?? 0,
            headers: response.headers,
            data,
            text: data.toString(),
            location: response.headers.location,
          });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(10_000, () =>
      request.destroy(new Error('Gate integration request timed out')),
    );
    if (options.body !== undefined)
      request.write(typeof options.body === 'string' ? options.body : String(options.body));
    request.end();
  });
}

function apiRequest(port, path, options = {}) {
  const headers = { host: 'memory.example.test', ...options.headers };
  return new Promise((resolveReply, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolveReply({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on('error', reject);
    request.setTimeout(5_000, () =>
      request.destroy(new Error('API integration request timed out')),
    );
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Could not reserve a local port');
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function requireLoopbackDatabase(name) {
  const value = required(name);
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(
      `${name} must point to a loopback PostgreSQL fixture; refusing remote databases.`,
    );
  }
  return value;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required; Gate integration does not skip missing prerequisites.`);
  return value;
}

async function clearFirestoreNamespace(db, prefix) {
  const collections = await db.listCollections();
  for (const collection of collections) {
    if (!collection.id.startsWith(`${prefix}_`)) continue;
    const snapshot = await collection.get();
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    if (snapshot.docs.length) await batch.commit();
  }
}

async function cleanupSyntheticUser(pool, identityIssuer, identitySubject) {
  const users = await pool.query(
    `SELECT DISTINCT user_id FROM principals WHERE issuer=$1 AND subject=$2`,
    [identityIssuer, identitySubject],
  );
  const userIds = users.rows.map((row) => row.user_id);
  if (userIds.length === 0) return;
  await pool.query('BEGIN');
  try {
    await pool.query(
      'ALTER TABLE public.memory_versions DISABLE TRIGGER memory_versions_append_only',
    );
    await pool.query('DELETE FROM memories WHERE user_id=ANY($1::uuid[])', [userIds]);
    await pool.query(
      'ALTER TABLE public.memory_versions ENABLE TRIGGER memory_versions_append_only',
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
  await pool.query('DELETE FROM changesets WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM idempotency_keys WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM external_identity_bindings WHERE user_id=ANY($1::uuid[])', [
    userIds,
  ]);
  await pool.query('DELETE FROM grants WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM principals WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM scopes WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
}
