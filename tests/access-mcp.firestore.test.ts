import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApiApp, type ApiApp } from '../apps/api/src/app.js';
import { loadConfig } from '../apps/api/src/config.js';

const issuer = 'https://access.example.com';
const admissionIssuer = 'https://previous-identity.example.com';
const audience = 'synthetic-access-app';
const ownerEmail = 'owner@example.com';
const project = `demo-access-${randomUUID().slice(0, 8)}`;
const clients: Client[] = [];
let app: ApiApp;
let server: Server;
let resource: URL;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let gateCalls = 0;
async function assertion(subject: string, email = ownerEmail) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);
}
async function connect(jwt: string, name: string) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(resource, {
      requestInit: { headers: { 'Cf-Access-Jwt-Assertion': jwt } },
    }),
  );
  clients.push(client);
  return client;
}
beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('Loopback emulator required');
  pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  resource = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  await promisify(execFile)(process.execPath, [
    'scripts/admit-subject.mjs',
    '--project',
    project,
    '--database',
    'lore-records',
    '--issuer',
    admissionIssuer,
    '--subject',
    'existing-owner',
    '--tenant',
    'existing-tenant',
    '--scope',
    'existing-scope',
  ]);
  const config = loadConfig({
    NODE_ENV: 'test',
    ALLOW_LOOPBACK_HTTP: '1',
    FIRESTORE_PROJECT_ID: project,
    FIRESTORE_DATABASE_ID: 'lore-records',
    LEDGER_DATABASE_ID: 'lore-ledger',
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    ACCESS_OWNER_EMAIL: ownerEmail,
    OWNER_ADMISSION_ISSUER: admissionIssuer,
    OWNER_ADMISSION_SUBJECT: 'existing-owner',
    MCP_RESOURCE_URL: resource.href,
    CURSOR_HMAC_KEYS: `test=${Buffer.alloc(32, 1).toString('base64url')}`,
    CURSOR_HMAC_ACTIVE_KEY: 'test',
    EMBEDDING_PROVIDER: 'deterministic',
  });
  app = createApiApp(config, {
    accessKeys: createLocalJWKSet({ keys: [{ ...jwk, kid: 'local' }] }),
    fetch: async () => {
      gateCalls++;
      throw new Error('No identity introspection allowed');
    },
    log: () => undefined,
  });
  server.on('request', app.listener);
});
afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise((resolve) => server?.close(resolve));
  await app?.close();
});
it('uses the existing admission and shared AI actor across independent Access subjects and client names', async () => {
  const first = await connect(await assertion('first-subject'), 'first-ai');
  const second = await connect(await assertion('second-subject'), 'second-ai');
  const access = await first.callTool({ name: 'get_access', arguments: {} });
  expect(access.structuredContent).toMatchObject({
    tenant_id: 'existing-tenant',
    scope_id: 'existing-scope',
    compartment_allowance: [],
    approval_policy: 'automatic',
  });
  expect((await second.callTool({ name: 'get_access', arguments: {} })).structuredContent).toEqual(
    access.structuredContent,
  );
  const write = await first.callTool({
    name: 'observe',
    arguments: {
      title: 'Migration fixture',
      summary: 'The synthetic migration preserves existing ownership.',
      nature: 'event',
      subjects: ['migration'],
      idempotency_key: 'shared-ai-write',
    },
  });
  expect(write.isError).not.toBe(true);
  const content = write.structuredContent as Record<string, unknown> | undefined;
  const id = String(content?.['observation_id']);
  const read = await second.callTool({
    name: 'get_observation',
    arguments: { observation_id: id },
  });
  expect(read.isError).not.toBe(true);
  expect(gateCalls).toBe(0);
}, 30000);
it('rejects legacy bearers, forged gateway claims and another owner', async () => {
  for (const headers of [
    { authorization: 'Bearer opaque-legacy-token' },
    {
      'x-apigateway-api-userinfo': Buffer.from(JSON.stringify({ email: ownerEmail })).toString(
        'base64url',
      ),
    },
    { 'cf-access-jwt-assertion': await assertion('wrong-owner', 'other@example.com') },
  ]) {
    const response = await fetch(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    });
    expect([401, 403]).toContain(response.status);
  }
});
