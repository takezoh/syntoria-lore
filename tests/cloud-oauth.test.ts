import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { hasExactAudience, hasExactOAuthScopeClaims } from '../packages/auth/src/index.js';
import { createIdentityProxy, isPublicIdentityPathAllowed } from '../infra/keycloak/proxy.mjs';

const PUBLIC_URL = 'https://identity.example.test';
const IDENTITY_REALM = 'configured-realm';
const ACCOUNT_ROOT = `/realms/${IDENTITY_REALM}/account`;
const isAllowed = (pathname: string, method: string, realm = IDENTITY_REALM) =>
  isPublicIdentityPathAllowed(pathname, method, realm);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('Keycloak public proxy contract', () => {
  it('allows only the configured realm OAuth endpoints and static assets', () => {
    for (const [path, method] of [
      ['/realms/configured-realm/.well-known/openid-configuration', 'GET'],
      ['/realms/configured-realm/protocol/openid-connect/auth', 'GET'],
      ['/realms/configured-realm/protocol/openid-connect/token', 'POST'],
      ['/realms/configured-realm/protocol/openid-connect/certs', 'GET'],
      ['/realms/configured-realm/login-actions/authenticate', 'POST'],
      ['/realms/configured-realm/login-actions/required-action', 'GET'],
      ['/realms/configured-realm/login-actions/consent', 'POST'],
      ['/resources/hash/login/keycloak.v2/css/login.css', 'GET'],
    ] as const) {
      expect(isAllowed(path, method), `${method} ${path}`).toBe(true);
    }

    for (const [path, method] of [
      ['/admin/', 'GET'],
      ['/health/ready', 'GET'],
      ['/realms/master/protocol/openid-connect/auth', 'GET'],
      ['/realms/configured-realm/admin/', 'GET'],
      ['/realms/configured-realm/clients-registrations/openid-connect', 'POST'],
      ['/realms/configured-realm/login-actions/registration', 'GET'],
      ['/realms/configured-realm/login-actions/consent', 'GET'],
      ['/realms/configured-realm/protocol/openid-connect/token', 'GET'],
      ['/realms/configured-realm/protocol/openid-connect/auth', 'POST'],
      ['/resources', 'GET'],
      ['/realms/configured-realm/%2e%2e/master', 'GET'],
    ] as const) {
      expect(isAllowed(path, method), `${method} ${path}`).toBe(false);
    }
  });

  it('validates the configured realm as a single path segment', () => {
    for (const realm of [
      '',
      '.',
      '..',
      'master',
      'MASTER',
      'two/segments',
      'encoded%2fslash',
      'back\\slash',
    ]) {
      expect(isAllowed('/realms/configured-realm/protocol/openid-connect/auth', 'GET', realm)).toBe(
        false,
      );
      expect(() =>
        createIdentityProxy({ publicUrl: PUBLIC_URL, backendUrl: 'http://127.0.0.1:8080', realm }),
      ).toThrow(/IDENTITY_REALM/);
    }
    expect(isAllowed('/realms/configured-realm/protocol/openid-connect/auth', 'GET')).toBe(true);
    expect(isAllowed('/realms/other/protocol/openid-connect/auth', 'GET')).toBe(false);
  });

  it('applies the exact personal account read, profile, and deletion route matrix', () => {
    const roots = [ACCOUNT_ROOT, `${ACCOUNT_ROOT}/`];
    const readPaths = [
      ...roots,
      `${ACCOUNT_ROOT}/index.html`,
      `${ACCOUNT_ROOT}/account-security/signing-in`,
      `${ACCOUNT_ROOT}/account-security/device-activity`,
      `${ACCOUNT_ROOT}/account-security/linked-accounts`,
      `${ACCOUNT_ROOT}/applications`,
      `${ACCOUNT_ROOT}/groups`,
      `${ACCOUNT_ROOT}/supportedLocales`,
      `${ACCOUNT_ROOT}/sessions`,
      `${ACCOUNT_ROOT}/sessions/devices`,
      `${ACCOUNT_ROOT}/credentials`,
      `${ACCOUNT_ROOT}/linked-accounts`,
    ];

    for (const path of readPaths) {
      expect(isAllowed(path, 'GET'), `GET ${path}`).toBe(true);
      expect(isAllowed(path, 'HEAD'), `HEAD ${path}`).toBe(true);
      expect(isAllowed(path, 'PUT'), `PUT ${path}`).toBe(false);
      expect(isAllowed(path, 'OPTIONS'), `OPTIONS ${path}`).toBe(false);
    }
    for (const path of roots) {
      expect(isAllowed(path, 'POST'), `POST ${path}`).toBe(true);
      expect(isAllowed(path, 'DELETE'), `DELETE ${path}`).toBe(false);
    }

    const deletePaths = [
      `${ACCOUNT_ROOT}/sessions`,
      `${ACCOUNT_ROOT}/sessions/session_1-abc`,
      `${ACCOUNT_ROOT}/applications/client_1/sessions`,
      `${ACCOUNT_ROOT}/applications/client_1/consent`,
    ];
    for (const path of deletePaths) {
      expect(isAllowed(path, 'DELETE'), `DELETE ${path}`).toBe(true);
    }

    for (const id of ['a', 'A0_-', 'devices', 'x'.repeat(255)]) {
      for (const path of [
        `${ACCOUNT_ROOT}/sessions/${id}`,
        `${ACCOUNT_ROOT}/applications/${id}/sessions`,
        `${ACCOUNT_ROOT}/applications/${id}/consent`,
      ]) {
        expect(isAllowed(path, 'DELETE'), `DELETE ${path}`).toBe(true);
      }
    }

    const unexpectedPaths = [
      ...readPaths
        .filter((path) => !roots.includes(path))
        .flatMap((path) => [
          `${path}/`,
          ...(path === `${ACCOUNT_ROOT}/sessions` ? [] : [`${path}/extra`]),
        ]),
      `${ACCOUNT_ROOT}//`,
      `${ACCOUNT_ROOT}/sessions/`,
      `${ACCOUNT_ROOT}/sessions/session_1/extra`,
      `${ACCOUNT_ROOT}/sessions/${'x'.repeat(256)}`,
      `${ACCOUNT_ROOT}/sessions/%2F`,
      `${ACCOUNT_ROOT}/sessions/a/b`,
      `${ACCOUNT_ROOT}/sessions/.`,
      `${ACCOUNT_ROOT}/sessions/..`,
      `${ACCOUNT_ROOT}/applications/%2F/sessions`,
      `${ACCOUNT_ROOT}/applications/a/b/consent`,
      `${ACCOUNT_ROOT}/applications/client_1/sessions/extra`,
      `${ACCOUNT_ROOT}/applications/client_1/consent/extra`,
      `${ACCOUNT_ROOT}/credentials/credential_1/label`,
      `${ACCOUNT_ROOT}/linked-accounts/provider_1`,
      `${ACCOUNT_ROOT}/applications/client_1/consent/grant`,
      `${ACCOUNT_ROOT}/organizations`,
      `${ACCOUNT_ROOT}/resources`,
      `${ACCOUNT_ROOT}/verifiable-credentials`,
      `${ACCOUNT_ROOT}/issued-verifiable-credentials`,
      `${ACCOUNT_ROOT}/content`,
    ];
    for (const path of unexpectedPaths) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
        expect(isAllowed(path, method), `${method} ${path}`).toBe(false);
      }
    }

    for (const path of [
      `${ACCOUNT_ROOT}/index.html`,
      `${ACCOUNT_ROOT}/credentials`,
      `${ACCOUNT_ROOT}/credentials/credential_1/label`,
    ]) {
      expect(isAllowed(path, 'POST'), `POST ${path}`).toBe(false);
      expect(isAllowed(path, 'DELETE'), `DELETE ${path}`).toBe(false);
    }
    expect(isAllowed(`${ACCOUNT_ROOT}/credentials/credential_1/label`, 'PUT')).toBe(false);
    expect(isAllowed(`${ACCOUNT_ROOT}/applications/client_1/consent`, 'POST')).toBe(false);
    expect(isAllowed('/realms/configured-realm', 'DELETE')).toBe(false);
    expect(isAllowed('/', 'GET')).toBe(false);
  });

  it('redirects only public root GET and HEAD to the fixed account entry without forwarding a query', async () => {
    let backendRequests = 0;
    const pair = await startProxy((_request, response) => {
      backendRequests += 1;
      response.end('upstream data');
    });

    const response = await request(pair.proxyPort, '/?code=synthetic&next=/admin/');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${PUBLIC_URL}${ACCOUNT_ROOT}/`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body.length).toBe(0);

    const head = await request(pair.proxyPort, '/?code=synthetic', { method: 'HEAD' });
    expect(head.status).toBe(302);
    expect(head.headers.location).toBe(`${PUBLIC_URL}${ACCOUNT_ROOT}/`);
    expect(head.body.length).toBe(0);

    const post = await request(pair.proxyPort, '/', { method: 'POST' });
    expect(post.status).toBe(404);
    expect(post.body.toString('utf8')).toBe('Not Found');
    const deletion = await request(pair.proxyPort, '/', { method: 'DELETE' });
    expect(deletion.status).toBe(404);
    expect(deletion.body.toString('utf8')).toBe('Not Found');
    const spoofedHost = await request(pair.proxyPort, '/', {
      headers: { host: 'attacker.example' },
    });
    expect(spoofedHost.status).toBe(404);
    expect(spoofedHost.headers.location).toBeUndefined();
    expect(backendRequests).toBe(0);
  });

  it('forwards exact account routes and query strings while denying paths the query cannot widen', async () => {
    const forwardedPaths: string[] = [];
    const pair = await startProxy((incoming, response) => {
      forwardedPaths.push(incoming.url ?? '');
      response.end('account response');
    });

    const allowed = await request(
      pair.proxyPort,
      `${ACCOUNT_ROOT}/sessions?view=devices&next=%2Frealms%2Fmaster&code=synthetic%2Fvalue`,
      { headers: { accept: 'application/json' } },
    );
    expect(allowed.status).toBe(200);
    expect(forwardedPaths).toEqual([
      `${ACCOUNT_ROOT}/sessions?view=devices&next=%2Frealms%2Fmaster&code=synthetic%2Fvalue`,
    ]);

    const denied = await request(
      pair.proxyPort,
      `${ACCOUNT_ROOT}/organizations?path=${encodeURIComponent(`${ACCOUNT_ROOT}/sessions`)}`,
    );
    expect(denied.status).toBe(404);
    expect(denied.body.toString('utf8')).toBe('Not Found');
    expect(denied.headers.location).toBeUndefined();
    expect(forwardedPaths).toHaveLength(1);
  });

  it('rejects raw encoded and backslash paths before URL normalization but preserves encoded queries', async () => {
    const forwardedPaths: string[] = [];
    const pair = await startProxy((incoming, response) => {
      forwardedPaths.push(incoming.url ?? '');
      response.end('account response');
    });

    for (const rawPath of [
      '/%2e%2e/realms/configured-realm/account/',
      '/realms\\memory\\account/',
    ]) {
      const denied = await request(pair.proxyPort, rawPath);
      expect(denied.status, rawPath).toBe(404);
      expect(denied.body.toString('utf8'), rawPath).toBe('Not Found');
    }
    expect(forwardedPaths).toHaveLength(0);

    const allowed = await request(
      pair.proxyPort,
      `${ACCOUNT_ROOT}/sessions?code=synthetic%2Fvalue&state=opaque`,
    );
    expect(allowed.status).toBe(200);
    expect(forwardedPaths).toEqual([
      `${ACCOUNT_ROOT}/sessions?code=synthetic%2Fvalue&state=opaque`,
    ]);
  });

  it('blocks administrative paths and spoofed public hosts before reaching Keycloak', async () => {
    let backendRequests = 0;
    const pair = await startProxy((_request, response) => {
      backendRequests += 1;
      response.end('unexpected backend request');
    });

    const admin = await request(pair.proxyPort, '/admin/');
    expect(admin.status).toBe(404);
    const spoofedHost = await request(
      pair.proxyPort,
      '/realms/configured-realm/protocol/openid-connect/auth',
      {
        headers: { host: 'attacker.example' },
      },
    );
    expect(spoofedHost.status).toBe(404);
    expect(backendRequests).toBe(0);
  });

  it('replaces client-supplied forwarding headers with the fixed identity origin', async () => {
    let upstreamHeaders: IncomingMessage['headers'] | undefined;
    const pair = await startProxy((incoming, response) => {
      upstreamHeaders = incoming.headers;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });

    const response = await request(
      pair.proxyPort,
      '/realms/configured-realm/.well-known/openid-configuration',
      {
        headers: {
          forwarded: 'for=attacker;host=attacker.example;proto=http',
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'http',
          'x-forwarded-port': '80',
          'x-forwarded-for': '203.0.113.99',
        },
      },
    );
    expect(response.status).toBe(200);
    expect(upstreamHeaders?.host).toBe('identity.example.test');
    expect(upstreamHeaders?.['x-forwarded-host']).toBe('identity.example.test');
    expect(upstreamHeaders?.['x-forwarded-proto']).toBe('https');
    expect(upstreamHeaders?.['x-forwarded-port']).toBe('443');
    expect(upstreamHeaders?.forwarded).toBeUndefined();
    expect(upstreamHeaders?.['x-forwarded-for']).toBeUndefined();
  });

  it('preserves native loopback OAuth callbacks and rewrites only the backend origin', async () => {
    const pair = await startProxy((_incoming, response) => {
      response.writeHead(302, {
        location: 'http://127.0.0.1:18971/callback?code=smoke-code&state=smoke-state',
      });
      response.end();
    });
    const callback = await request(
      pair.proxyPort,
      '/realms/configured-realm/protocol/openid-connect/auth',
    );
    expect(callback.headers.location).toBe(
      'http://127.0.0.1:18971/callback?code=smoke-code&state=smoke-state',
    );
    await closePair(pair);

    let internalBackendPort = 0;
    const internal = await startProxy((_incoming, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${internalBackendPort}/realms/configured-realm/login`,
      });
      response.end();
    });
    internalBackendPort = portOf(internal.backend);
    const publicRedirect = await request(
      internal.proxyPort,
      '/realms/configured-realm/protocol/openid-connect/auth',
    );
    expect(publicRedirect.headers.location).toBe(`${PUBLIC_URL}/realms/configured-realm/login`);
    await closePair(internal);
  });

  it('keeps compressed response bytes and their content headers consistent', async () => {
    const compressed = gzipSync(Buffer.from('compressed Keycloak static content'));
    const pair = await startProxy((_incoming, response) => {
      response.writeHead(200, {
        'content-type': 'application/javascript',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
      });
      response.end(compressed);
    });
    const response = await request(pair.proxyPort, '/resources/hash/login/js/app.js', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-length']).toBe(String(response.body.length));
    expect(gunzipSync(response.body).toString('utf8')).toBe('compressed Keycloak static content');
  });
});

describe('resource audience validation', () => {
  it('accepts a single exact read or write audience while rejecting audience expansion', () => {
    expect(
      hasExactAudience('https://api.example.test/mcp/read', 'https://api.example.test/mcp/read'),
    ).toBe(true);
    expect(
      hasExactAudience(['https://api.example.test/mcp/read'], 'https://api.example.test/mcp/read'),
    ).toBe(true);
    expect(
      hasExactAudience(
        ['https://api.example.test/mcp/read', 'https://api.example.test/mcp/write'],
        'https://api.example.test/mcp/read',
      ),
    ).toBe(false);
    expect(hasExactAudience(undefined, 'https://api.example.test/mcp/read')).toBe(false);
  });
});

describe('OAuth scope claim validation', () => {
  const scopeId = 'd7f3ceaa-21a4-4afb-bc99-7f3ec01e449c';

  it('requires exactly the expected scope ID and only the requested memory capability', () => {
    expect(
      hasExactOAuthScopeClaims(
        {
          scope_ids: [scopeId],
          scope: 'openid memory:read memory:resource:api memory:scope_ids',
        },
        scopeId,
        'memory:read',
      ),
    ).toBe(true);

    for (const claims of [
      { scope_ids: [scopeId, 'f329ad54-5321-43f7-928e-b1d4fc8855bc'], scope: 'memory:read' },
      { scope_ids: ['f329ad54-5321-43f7-928e-b1d4fc8855bc'], scope: 'memory:read' },
      { scope_ids: scopeId, scope: 'memory:read' },
      { scope_ids: [scopeId], scope: 'openid memory:scope_ids' },
      { scope_ids: [scopeId], scope: 'memory:read memory:write' },
      { scope_ids: [scopeId], scope: 'memory:read memory:admin' },
      { scope_ids: [scopeId], scope: 'memory:read memory:unrecognized' },
    ]) {
      expect(hasExactOAuthScopeClaims(claims, scopeId, 'memory:read')).toBe(false);
    }
  });
});

describe('deployed OAuth smoke modes', () => {
  it('uses API-resource PKCE tokens for REST recall and checks wrong audience and scope', async () => {
    const result = await runRestSmokeForTest('positive');
    if (!result.ok) throw new Error(result.error);
    expect(result.result['rest_api_resource_verified']).toBe(true);
    expect(result.result['rest_recall_verified']).toBe(true);
    expect(result.result['rest_wrong_audience_rejected']).toBe(true);
    expect(result.result['rest_wrong_scope_rejected']).toBe(true);
    expect(result.calls).toEqual([
      'openid memory:read memory:resource:api memory:scope_ids',
      'openid memory:write memory:resource:api memory:scope_ids',
    ]);
  });

  it('fails REST smoke if the API accepts a wrong audience or insufficient scope', async () => {
    const wrongAudience = await runRestSmokeForTest('wrong-audience-accepted');
    expect(wrongAudience.ok).toBe(false);
    if (wrongAudience.ok) throw new Error('REST smoke accepted a wrong-audience token');
    expect(wrongAudience.error).toContain('wrong-audience token');

    const wrongScope = await runRestSmokeForTest('wrong-scope-accepted');
    expect(wrongScope.ok).toBe(false);
    if (wrongScope.ok) throw new Error('REST smoke accepted a token without memory:read');
    expect(wrongScope.error).toContain('without memory:read');
  });

  it('requires the authorized write token to list the write resource tool', async () => {
    const result = await runMcpSmokeForTest('positive');
    if (!result.ok) throw new Error(result.error);
    expect(result.result.write_resource_verified).toBe(true);
    expect(result.result.write_tools).toContain('remember_memory');
  });

  it('fails full smoke when the write resource rejects or omits its expected tool', async () => {
    const rejected = await runMcpSmokeForTest('write-401');
    if (rejected.ok) throw new Error('Full smoke accepted a write-resource 401');
    expect(rejected.error).toContain('MCP write resource returned HTTP 401');

    const missingTool = await runMcpSmokeForTest('missing-write-tool');
    if (missingTool.ok)
      throw new Error('Full smoke accepted a write resource without its write tool');
    expect(missingTool.error).toContain(
      'The MCP write resource did not return its expected write tool',
    );
  });

  it('requires the MCP Recall tool to return a valid result envelope', async () => {
    const emptyResult = await runMcpSmokeForTest('empty-read-result');
    expect(emptyResult.ok).toBe(false);
    if (emptyResult.ok) throw new Error('Full smoke accepted an empty MCP tool result');
    expect(emptyResult.error).toContain('omitted its Recall result fields');

    const malformedResult = await runMcpSmokeForTest('malformed-read-result');
    expect(malformedResult.ok).toBe(false);
    if (malformedResult.ok) throw new Error('Full smoke accepted a non-Recall MCP result');
    expect(malformedResult.error).toContain('omitted its Recall result fields');
  });

  it('submits the consent accept control without also submitting cancel', () => {
    const html =
      '<form action="/login-actions/required-action"><input type="hidden" name="code" value="opaque-code"><button type="submit" name="accept" value="Yes">Accept</button><button type="submit" name="cancel" value="Cancel">Cancel</button></form>';
    const script = `import { buildConsentFormData, parseForms } from './scripts/cloud-oauth-smoke.mjs'; const form = parseForms(${JSON.stringify(html)})[0]; if (form === undefined) throw new Error('form missing'); process.stdout.write(buildConsentFormData(form).toString());`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('code=opaque-code&accept=Yes');
    expect(result.stderr).toBe('');
  });

  it('rejects unknown modes before reading credentials or making network requests', async () => {
    const result = spawnSync(process.execPath, ['scripts/cloud-oauth-smoke.mjs', 'provision'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Cloud OAuth smoke failed');
  });
});

function runMcpSmokeForTest(
  mode:
    'positive' | 'write-401' | 'missing-write-tool' | 'empty-read-result' | 'malformed-read-result',
) {
  const script = `import { runMcpSmoke } from './scripts/cloud-oauth-smoke.mjs';
const readUrl = 'https://api.example.test/mcp/read';
const writeUrl = 'https://api.example.test/mcp/write';
const mode = ${JSON.stringify(mode)};
const readTools = [{ name: 'recall_memories' }, { name: 'get_memory' }, { name: 'get_changes' }];
const options = {
  authUrl: 'https://identity.example.test/realms/configured-realm/protocol/openid-connect/auth',
  tokenUrl: 'https://identity.example.test/realms/configured-realm/protocol/openid-connect/token',
  issuer: 'https://identity.example.test/realms/configured-realm', jwks: {}, clientId: 'smoke-client',
  readUrl, writeUrl, username: 'smoke-user', password: 'test-only-placeholder',
  subjectId: '559fa46a-ffa4-4b13-9181-404ec992698c',
  expectedScopeId: 'd7f3ceaa-21a4-4afb-bc99-7f3ec01e449c', readToken: 'read-token',
};
const adapters = {
  listTools: async (url, token) => {
    if (url === readUrl && token === 'read-token') return readTools;
    if (url !== writeUrl || token !== 'write-token') throw new Error('unexpected MCP resource token');
    if (mode === 'write-401') throw new Error('MCP write resource returned HTTP 401');
    if (mode === 'missing-write-tool') return [{ name: 'propose_changeset' }];
    return [{ name: 'remember_memory' }, { name: 'propose_changeset' }];
  },
  callMcp: async () => ({ status: 401 }),
  callTool: async (url, token, name, args) => {
    if (url !== readUrl || token !== 'read-token' || name !== 'recall_memories') throw new Error('unexpected MCP tool call');
    if (args.scope_id !== options.expectedScopeId || typeof args.query !== 'string') throw new Error('unexpected MCP recall input');
    if (mode === 'empty-read-result') return { isError: false };
    if (mode === 'malformed-read-result') {
      const malformed = { diagnostic: 'destination-memory-id' };
      return { isError: false, structuredContent: malformed, content: [{ type: 'text', text: JSON.stringify(malformed) }] };
    }
    const recall = { matches: [], unknown: true };
    return { isError: false, structuredContent: recall, content: [{ type: 'text', text: JSON.stringify(recall) }] };
  },
  authorize: async () => ({ code: 'write-code', verifier: 'write-verifier' }),
  exchangeCode: async () => ({ response: { ok: true }, body: { access_token: 'write-token' } }),
  verifyAccessToken: async () => undefined,
};
try {
  const result = await runMcpSmoke(options, adapters);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'OAuth smoke fixture process failed');
  return JSON.parse(result.stdout) as
    | { ok: true; result: { write_resource_verified: boolean; write_tools: string[] } }
    | { ok: false; error: string };
}

function runRestSmokeForTest(
  mode: 'positive' | 'wrong-audience-accepted' | 'wrong-scope-accepted',
) {
  const script = `import { runRestSmoke } from './scripts/cloud-oauth-smoke.mjs';
const mode = ${JSON.stringify(mode)};
const calls = [];
const options = {
  authUrl: 'https://identity.example.test/realms/configured-realm/protocol/openid-connect/auth',
  tokenUrl: 'https://identity.example.test/realms/configured-realm/protocol/openid-connect/token',
  issuer: 'https://identity.example.test/realms/configured-realm', jwks: {},
  clientId: 'smoke-client', apiUrl: 'https://api.example.test',
  username: 'smoke-user', password: 'test-only-placeholder',
  subjectId: '559fa46a-ffa4-4b13-9181-404ec992698c',
  expectedScopeId: 'd7f3ceaa-21a4-4afb-bc99-7f3ec01e449c',
  readToken: 'mcp-read-token',
};
const adapters = {
  authorize: async ({ scope }) => { calls.push(scope); return { code: scope.includes('memory:write') ? 'write-code' : 'read-code', verifier: 'verifier' }; },
  exchangeCode: async ({ code }) => ({ response: { ok: true }, body: { access_token: code === 'write-code' ? 'api-write-token' : 'api-read-token' } }),
  verifyAccessToken: async (token, _jwks, _issuer, audience, subjectId, scopeId, permission) => {
    if (audience !== 'https://api.example.test' || subjectId !== options.subjectId || scopeId !== options.expectedScopeId) throw new Error('unexpected token verification contract');
    if ((token === 'api-read-token' && permission !== 'memory:read') || (token === 'api-write-token' && permission !== 'memory:write')) throw new Error('unexpected API permission verification');
  },
  requestApi: async ({ token }) => {
    if (token === 'api-read-token') return { status: 200, body: { matches: [] } };
    if (token === 'mcp-read-token') return { status: mode === 'wrong-audience-accepted' ? 200 : 401, body: { matches: [] } };
    if (token === 'api-write-token') return { status: mode === 'wrong-scope-accepted' ? 200 : 403, body: { matches: [] } };
    throw new Error('unexpected REST token');
  },
};
try {
  const result = await runRestSmoke(options, adapters);
  process.stdout.write(JSON.stringify({ ok: true, result, calls }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, calls }));
}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'OAuth REST fixture process failed');
  return JSON.parse(result.stdout) as
    | { ok: true; result: Record<string, unknown>; calls: string[] }
    | { ok: false; error: string; calls: string[] };
}

async function startProxy(
  handler: (request: IncomingMessage, response: import('node:http').ServerResponse) => void,
) {
  const backend = createServer(handler);
  servers.push(backend);
  await listen(backend);
  const backendPort = portOf(backend);
  const proxy = createIdentityProxy({
    publicUrl: PUBLIC_URL,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    realm: IDENTITY_REALM,
  });
  servers.push(proxy);
  await listen(proxy);
  return { proxyPort: portOf(proxy), backend, proxy };
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    body: Buffer;
  }>((resolvePromise, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: 'identity.example.test', ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on('error', reject);
    if (options.body === undefined) request.end();
    else request.end(options.body);
  });
}

async function listen(server: Server) {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Test server has no TCP port');
  return address.port;
}

function closeServer(server: Server) {
  return new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

async function closePair(pair: { backend: Server; proxy: Server }) {
  await Promise.all([pair.proxy, pair.backend].map(closeServer));
  servers.splice(servers.indexOf(pair.proxy), 1);
  servers.splice(servers.indexOf(pair.backend), 1);
}
