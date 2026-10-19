import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreError, type ActorContext } from '@memory/contracts';
import type { Authenticator } from '@memory/auth';
import type { CoreService } from '@memory/domain';
import { createApiServer } from '../apps/api/src/server.js';

const servers: Server[] = [];
const actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  principalId: '00000000-0000-4000-8000-000000000002',
  actorKind: 'user',
  scopeIds: [],
  tokenScopeIds: [],
  capabilities: ['read', 'write'],
  authEpochs: {},
} as unknown as ActorContext;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('API-only Gate authentication', () => {
  it('removes the Lore callback and browser session routes', async () => {
    const server = startServer();
    const origin = await serverOrigin(server);

    expect((await fetch(`${origin}/auth-return.html`)).status).toBe(404);
    expect((await fetch(`${origin}/v1/session`)).status).toBe(404);

    const response = await fetch(`${origin}/openapi.json`);
    const document = (await response.json()) as {
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(document.paths).not.toHaveProperty('/v1/session');
    expect(document.components.securitySchemes).not.toHaveProperty('browserSessionCookie');
  });

  it('rejects cookie-only REST and MCP requests while preserving bearer API access', async () => {
    const acceptedHeaders: Array<string | undefined> = [];
    const auth = {
      authenticateBearer: vi.fn(async (authorization?: string) => {
        acceptedHeaders.push(authorization);
        if (authorization !== 'Bearer valid-gate-token') {
          throw new CoreError(401, 'unauthorized', 'A single Gate Bearer token is required');
        }
        return actor;
      }),
    } as unknown as Authenticator;
    const remember = vi.fn(async () => ({ committed: true }));
    const server = startServer(auth, { remember } as unknown as CoreService);
    const origin = await serverOrigin(server);
    const body = JSON.stringify({ scope_id: actor.scopeIds[0], memory: {} });

    const restCookieOnly = await fetch(`${origin}/v1/memories:remember`, {
      method: 'POST',
      headers: {
        cookie: '__Secure-gate_session=opaque-session',
        'content-type': 'application/json',
        'idempotency-key': 'cookie-only',
      },
      body,
    });
    expect(restCookieOnly.status).toBe(401);

    const mcpCookieOnly = await fetch(`${origin}/mcp/read`, {
      method: 'POST',
      headers: {
        cookie: '__Secure-gate_session=opaque-session',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(mcpCookieOnly.status).toBe(401);
    expect((await fetch(`${origin}/mcp/read`, { method: 'GET' })).status).toBe(405);

    const bearer = await fetch(`${origin}/v1/memories:remember`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-gate-token',
        cookie: '__Secure-gate_session=ignored-with-bearer',
        origin: 'https://client.example.test',
        'content-type': 'application/json',
        'idempotency-key': 'bearer-with-cookie',
      },
      body,
    });
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get('access-control-allow-origin')).toBe('https://client.example.test');
    expect(bearer.headers.get('access-control-allow-credentials')).toBeNull();
    expect(acceptedHeaders).toEqual([undefined, undefined, 'Bearer valid-gate-token']);
    expect(remember).toHaveBeenCalledOnce();
  });
});

function startServer(
  auth: Authenticator = { authenticateBearer: async () => actor } as unknown as Authenticator,
  core: CoreService = { remember: async () => ({ committed: true }) } as unknown as CoreService,
): Server {
  const server = createApiServer({
    auth,
    mcpReadAuth: auth,
    mcpWriteAuth: auth,
    mcpAuthorizationServerUrl: 'https://gate.example.test',
    mcpResourceBaseUrl: 'http://127.0.0.1',
    mcpAllowedHosts: ['127.0.0.1'],
    apiAllowedOrigins: ['https://client.example.test'],
    core,
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  return server;
}

async function serverOrigin(server: Server): Promise<string> {
  if (server.listening) {
    const address = server.address();
    if (address && typeof address !== 'string') return `http://127.0.0.1:${address.port}`;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return serverOrigin(server);
}
