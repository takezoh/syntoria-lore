import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCloudIdentityConfig } from './cloud-identity-config.mjs';

const REDIRECT_URI = 'http://127.0.0.1:18971/callback';
const SMOKE_MODES = new Set(['identity', 'full']);
const cloudIdentity = await readCloudIdentityConfig();

class OAuthProtocolError extends Error {
  constructor(errorCode) {
    const safeCode =
      typeof errorCode === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(errorCode)
        ? errorCode
        : 'unknown';
    super(`Keycloak returned OAuth error ${safeCode}`);
    this.name = 'OAuthProtocolError';
    this.oauthErrorCode = safeCode;
  }
}

export async function runCloudOAuthSmoke(env = process.env, mode = 'identity') {
  if (!SMOKE_MODES.has(mode)) throw new Error('Cloud OAuth smoke mode must be identity or full');
  const identityUrl = readHttpsOrigin(env, 'IDENTITY_PUBLIC_URL');
  const readUrl = readResourceUrl(env, 'OAUTH_SMOKE_READ_URL', '/mcp/read');
  const writeUrl = readResourceUrl(env, 'OAUTH_SMOKE_WRITE_URL', '/mcp/write');
  const clientId = env['OAUTH_SMOKE_CLIENT_ID'] ?? cloudIdentity.smokeClientId;
  const username = required(env, 'OAUTH_SMOKE_USERNAME');
  const password = required(env, 'OAUTH_SMOKE_PASSWORD');
  const subjectId = required(env, 'OAUTH_SMOKE_USER_ID');
  const expectedScopeId = required(env, 'OAUTH_SMOKE_SCOPE_ID');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      expectedScopeId,
    )
  ) {
    throw new Error('The configured smoke scope ID is invalid');
  }
  const issuer = `${identityUrl}/realms/${cloudIdentity.realm}`;
  const authUrl = `${issuer}/protocol/openid-connect/auth`;
  const tokenUrl = `${issuer}/protocol/openid-connect/token`;
  const results = {};
  const identity = await runIdentitySmoke({
    authUrl,
    tokenUrl,
    issuer,
    clientId,
    readUrl,
    writeUrl,
    username,
    password,
    subjectId,
    expectedScopeId,
  });
  Object.assign(results, identity.results);

  if (mode === 'full') {
    const apiUrl = readHttpsOrigin(env, 'OAUTH_SMOKE_API_URL');
    const apiInvokerToken = await readOptionalBearerTokenFile(
      env['CLOUD_API_IAM_TOKEN_FILE'],
      'CLOUD_API_IAM_TOKEN_FILE',
    );
    Object.assign(
      results,
      await runRestSmoke({
        authUrl,
        tokenUrl,
        issuer,
        jwks: identity.jwks,
        clientId,
        apiUrl,
        username,
        password,
        subjectId,
        expectedScopeId,
        readToken: identity.readToken,
        apiInvokerToken,
      }),
    );
    Object.assign(
      results,
      await runMcpSmoke({
        authUrl,
        tokenUrl,
        issuer,
        jwks: identity.jwks,
        clientId,
        readUrl,
        writeUrl,
        username,
        password,
        subjectId,
        expectedScopeId,
        readToken: identity.readToken,
        apiInvokerToken,
      }),
    );
  }
  results.status = mode === 'identity' ? 'identity-passed' : 'full-passed';
  return results;
}

async function runIdentitySmoke({
  authUrl,
  tokenUrl,
  issuer,
  clientId,
  readUrl,
  writeUrl,
  username,
  password,
  subjectId,
  expectedScopeId,
}) {
  const results = {};
  const metadataResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!metadataResponse.ok) throw new Error('The identity discovery endpoint is unavailable');
  const metadata = await metadataResponse.json();
  const expectedJwksUrl = `${issuer}/protocol/openid-connect/certs`;
  if (metadata.issuer !== issuer || metadata.jwks_uri !== expectedJwksUrl) {
    throw new Error('The identity discovery metadata has an unexpected issuer or JWKS URL');
  }
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  results.discovery_verified = true;

  const readFlow = await authorize({
    authUrl,
    clientId,
    resource: readUrl,
    redirectUri: REDIRECT_URI,
    scope: `openid memory:read ${cloudIdentity.scopes.read} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
  });
  const readToken = await exchangeCode({
    tokenUrl,
    clientId,
    code: readFlow.code,
    redirectUri: REDIRECT_URI,
    resource: readUrl,
    verifier: readFlow.verifier,
  });
  if (!readToken.response.ok || typeof readToken.body.access_token !== 'string') {
    throw new Error('The read PKCE flow did not return an access token');
  }
  await verifyAccessToken(
    readToken.body.access_token,
    jwks,
    issuer,
    readUrl,
    subjectId,
    expectedScopeId,
    'memory:read',
  );
  results.pkce_s256_verified = true;
  results.signature_issuer_expiry_audience_and_subject_verified = true;
  results.jwks_verified = true;
  results.scope_ids_and_read_capability_verified = true;

  const invalidResource = 'https://invalid.example/mcp/read';
  const invalidResourceFlow = await authorize({
    authUrl,
    clientId,
    resource: invalidResource,
    redirectUri: REDIRECT_URI,
    scope: `openid memory:read ${cloudIdentity.scopes.read} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
    expectedError: 'invalid_target',
  });
  if (invalidResourceFlow.error !== 'invalid_target') {
    const invalidResourceToken = await exchangeCode({
      tokenUrl,
      clientId,
      code: invalidResourceFlow.code,
      redirectUri: REDIRECT_URI,
      resource: invalidResource,
      verifier: invalidResourceFlow.verifier,
    });
    if (
      invalidResourceToken.response.status !== 400 ||
      invalidResourceToken.body.error !== 'invalid_target'
    ) {
      throw new Error('An unknown resource was not rejected after the authenticated PKCE flow');
    }
  }
  results.resource_rejected = true;

  const invalidVerifierFlow = await authorize({
    authUrl,
    clientId,
    resource: readUrl,
    redirectUri: REDIRECT_URI,
    scope: `openid memory:read ${cloudIdentity.scopes.read} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
  });
  const invalidVerifier = await exchangeCode({
    tokenUrl,
    clientId,
    code: invalidVerifierFlow.code,
    redirectUri: REDIRECT_URI,
    resource: readUrl,
    verifier: 'wrong-verifier-value-that-does-not-match-the-challenge',
  });
  if (invalidVerifier.response.ok || invalidVerifier.body.error !== 'invalid_grant') {
    throw new Error('A mismatched PKCE verifier was not rejected');
  }
  results.verifier_rejected = true;

  const mismatchFlow = await authorize({
    authUrl,
    clientId,
    resource: readUrl,
    redirectUri: REDIRECT_URI,
    scope: `openid memory:read ${cloudIdentity.scopes.read} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
  });
  const mismatchedResourceToken = await exchangeCode({
    tokenUrl,
    clientId,
    code: mismatchFlow.code,
    redirectUri: REDIRECT_URI,
    resource: writeUrl,
    verifier: mismatchFlow.verifier,
  });
  if (
    mismatchedResourceToken.response.status !== 400 ||
    !['invalid_target', 'invalid_grant'].includes(mismatchedResourceToken.body.error)
  ) {
    throw new Error('A code issued for the read resource was exchanged for another resource');
  }
  results.token_resource_mismatch_rejected = true;

  results.redirect_rejected = await assertAuthorizationRejected({
    authUrl,
    clientId,
    resource: readUrl,
    redirectUri: 'http://127.0.0.1:18971/not-registered',
    scope: `openid memory:read ${cloudIdentity.scopes.read} ${cloudIdentity.scopes.scopeIds}`,
  });
  return { results, readToken: readToken.body.access_token, jwks };
}

async function verifyAccessToken(
  token,
  jwks,
  issuer,
  audience,
  subjectId,
  expectedScopeId,
  expectedPermission,
) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: ['RS256', 'ES256', 'EdDSA'],
      requiredClaims: ['sub', 'exp', 'iat'],
    }));
  } catch {
    throw new Error('The access token failed signature or standard claim verification');
  }
  if (!hasExactAudience(payload.aud, audience) || payload.sub !== subjectId) {
    throw new Error('The access token has an unexpected resource audience or subject');
  }
  const { hasExactOAuthScopeClaims } = await import('@memory/auth');
  if (!hasExactOAuthScopeClaims(payload, expectedScopeId, expectedPermission)) {
    throw new Error('The access token has unexpected scope claims');
  }
  return payload;
}

export async function runRestSmoke(
  {
    authUrl,
    tokenUrl,
    issuer,
    jwks,
    clientId,
    apiUrl,
    username,
    password,
    subjectId,
    expectedScopeId,
    readToken,
    apiInvokerToken,
  },
  adapters = {},
) {
  const authorizeCode = adapters.authorize ?? authorize;
  const exchangeAuthorizationCode = adapters.exchangeCode ?? exchangeCode;
  const verifyToken = adapters.verifyAccessToken ?? verifyAccessToken;
  const requestApi = adapters.requestApi ?? postRecall;
  const results = {};
  const apiFlow = await authorizeCode({
    authUrl,
    clientId,
    resource: apiUrl,
    redirectUri: REDIRECT_URI,
    scope: `openid memory:read ${cloudIdentity.scopes.api} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
  });
  const apiToken = await exchangeAuthorizationCode({
    tokenUrl,
    clientId,
    code: apiFlow.code,
    redirectUri: REDIRECT_URI,
    resource: apiUrl,
    verifier: apiFlow.verifier,
  });
  if (!apiToken.response.ok || typeof apiToken.body.access_token !== 'string') {
    throw new Error('The API read PKCE flow did not return an access token');
  }
  await verifyToken(
    apiToken.body.access_token,
    jwks,
    issuer,
    apiUrl,
    subjectId,
    expectedScopeId,
    'memory:read',
  );

  const recall = await requestApi({
    apiUrl,
    token: apiToken.body.access_token,
    scopeId: expectedScopeId,
    apiInvokerToken,
    query: `cloud-oauth-smoke-${randomBytes(12).toString('hex')}`,
  });
  if (recall.status !== 200 || !Array.isArray(recall.body?.matches)) {
    throw new Error(`The REST API recall request returned HTTP ${recall.status}`);
  }
  results.rest_api_resource_verified = true;
  results.rest_recall_verified = true;

  const mcpReadAtRest = await requestApi({
    apiUrl,
    token: readToken,
    scopeId: expectedScopeId,
    apiInvokerToken,
    query: `cloud-oauth-wrong-resource-${randomBytes(12).toString('hex')}`,
  });
  if (mcpReadAtRest.status !== 401) {
    throw new Error(`The REST API accepted a wrong-audience token (HTTP ${mcpReadAtRest.status})`);
  }
  results.rest_wrong_audience_rejected = true;

  const writeFlow = await authorizeCode({
    authUrl,
    clientId,
    resource: apiUrl,
    redirectUri: REDIRECT_URI,
    scope: `openid memory:write ${cloudIdentity.scopes.api} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
  });
  const writeToken = await exchangeAuthorizationCode({
    tokenUrl,
    clientId,
    code: writeFlow.code,
    redirectUri: REDIRECT_URI,
    resource: apiUrl,
    verifier: writeFlow.verifier,
  });
  if (!writeToken.response.ok || typeof writeToken.body.access_token !== 'string') {
    throw new Error('The API write PKCE flow did not return an access token');
  }
  await verifyToken(
    writeToken.body.access_token,
    jwks,
    issuer,
    apiUrl,
    subjectId,
    expectedScopeId,
    'memory:write',
  );
  const writeRecall = await requestApi({
    apiUrl,
    token: writeToken.body.access_token,
    scopeId: expectedScopeId,
    apiInvokerToken,
    query: `cloud-oauth-wrong-scope-${randomBytes(12).toString('hex')}`,
  });
  if (writeRecall.status !== 403) {
    throw new Error(
      `The REST API accepted a read request without memory:read (HTTP ${writeRecall.status})`,
    );
  }
  results.rest_wrong_scope_rejected = true;
  return results;
}

export async function runMcpSmoke(
  {
    authUrl,
    tokenUrl,
    issuer,
    jwks,
    clientId,
    readUrl,
    writeUrl,
    username,
    password,
    subjectId,
    expectedScopeId,
    readToken,
    apiInvokerToken,
  },
  adapters = {},
) {
  const authorizeCode = adapters.authorize ?? authorize;
  const exchangeAuthorizationCode = adapters.exchangeCode ?? exchangeCode;
  const verifyToken = adapters.verifyAccessToken ?? verifyAccessToken;
  const getTools = adapters.listTools ?? listTools;
  const requestMcp = adapters.callMcp ?? callMcp;
  const callTool = adapters.callTool ?? callMcpTool;
  const results = {};
  const tools = await getTools(readUrl, readToken, apiInvokerToken);
  const readToolNames = tools.map((tool) => tool.name);
  if (
    !['recall_memories', 'get_memory', 'get_changes'].every((name) => readToolNames.includes(name))
  ) {
    throw new Error('The MCP read resource returned an incomplete read tool list');
  }
  results.read_tools = readToolNames;

  const readResult = await callTool(
    readUrl,
    readToken,
    'recall_memories',
    {
      query: `cloud-mcp-smoke-${randomBytes(12).toString('hex')}`,
      scope_id: expectedScopeId,
      mode: 'contextual',
    },
    apiInvokerToken,
  );
  assertMcpRecallResult(readResult);
  results.read_recall_tool_verified = true;

  const readTokenAtWrite = await requestMcp(writeUrl, readToken, apiInvokerToken);
  if (readTokenAtWrite.status !== 401)
    throw new Error('The read token was accepted by the MCP write resource');

  const writeFlow = await authorizeCode({
    authUrl,
    clientId,
    resource: writeUrl,
    redirectUri: REDIRECT_URI,
    scope: `openid memory:write ${cloudIdentity.scopes.write} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
  });
  const writeToken = await exchangeAuthorizationCode({
    tokenUrl,
    clientId,
    code: writeFlow.code,
    redirectUri: REDIRECT_URI,
    resource: writeUrl,
    verifier: writeFlow.verifier,
  });
  if (!writeToken.response.ok || typeof writeToken.body.access_token !== 'string') {
    throw new Error('The write PKCE flow did not return an access token');
  }
  await verifyToken(
    writeToken.body.access_token,
    jwks,
    issuer,
    writeUrl,
    subjectId,
    expectedScopeId,
    'memory:write',
  );
  const writeTools = await getTools(writeUrl, writeToken.body.access_token, apiInvokerToken);
  const writeToolNames = writeTools.map((tool) => tool.name);
  if (!writeToolNames.includes('remember_memory')) {
    throw new Error('The MCP write resource did not return its expected write tool');
  }
  results.write_tools = writeToolNames;
  results.write_resource_verified = true;

  const writeTokenAtRead = await requestMcp(readUrl, writeToken.body.access_token, apiInvokerToken);
  if (writeTokenAtRead.status !== 401)
    throw new Error('The write token was accepted by the MCP read resource');
  results.audience_isolation = true;
  return results;
}

function assertMcpRecallResult(result) {
  if (result?.isError === true) throw new Error('The MCP read recall tool returned an error');
  const structured = readMcpRecallPayload(result?.structuredContent);
  const textItems = Array.isArray(result?.content)
    ? result.content.filter((item) => item?.type === 'text')
    : [];
  if (textItems.length !== 1 || typeof textItems[0]?.text !== 'string') {
    throw new Error('The MCP read recall tool returned an invalid response envelope');
  }

  let textPayload;
  try {
    textPayload = JSON.parse(textItems[0].text);
  } catch {
    throw new Error('The MCP read recall tool returned invalid JSON content');
  }
  const textual = readMcpRecallPayload(textPayload);
  if (
    structured.unknown !== textual.unknown ||
    structured.ids.length !== textual.ids.length ||
    structured.ids.some((id, index) => id !== textual.ids[index])
  ) {
    throw new Error('The MCP read recall tool returned inconsistent structured and text results');
  }
}

function readMcpRecallPayload(payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Array.isArray(payload.matches) ||
    typeof payload.unknown !== 'boolean'
  ) {
    throw new Error('The MCP read recall tool omitted its Recall result fields');
  }
  const ids = payload.matches.map((match) => {
    if (
      match === null ||
      typeof match !== 'object' ||
      Array.isArray(match) ||
      typeof match.id !== 'string'
    ) {
      throw new Error('The MCP read recall tool returned a match without an ID');
    }
    return match.id;
  });
  if (payload.unknown !== (ids.length === 0)) {
    throw new Error('The MCP read recall tool returned inconsistent Recall match status');
  }
  return { ids, unknown: payload.unknown };
}

export async function acquireOAuthResourceToken({
  issuer,
  clientId,
  resource,
  scope,
  username,
  password,
  redirectUri = REDIRECT_URI,
}) {
  const normalizedIssuer = issuer.replace(/\/$/, '');
  const authUrl = `${normalizedIssuer}/protocol/openid-connect/auth`;
  const tokenUrl = `${normalizedIssuer}/protocol/openid-connect/token`;
  const flow = await authorize({
    authUrl,
    clientId,
    resource,
    redirectUri,
    scope,
    username,
    password,
  });
  const token = await exchangeCode({
    tokenUrl,
    clientId,
    code: flow.code,
    redirectUri,
    resource,
    verifier: flow.verifier,
  });
  if (!token.response.ok || typeof token.body.access_token !== 'string') {
    throw new Error('The authorization-code PKCE flow did not return an access token');
  }
  return token.body.access_token;
}

async function assertAuthorizationRejected(options) {
  const verifier = randomBase64Url(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const response = await fetch(buildAuthorizationUrl({ ...options, challenge }), {
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  if (location !== null) {
    const target = new URL(location, options.authUrl);
    if (
      target.origin === new URL(options.redirectUri).origin &&
      target.pathname === new URL(options.redirectUri).pathname
    ) {
      const error = target.searchParams.get('error');
      if (error !== null && options.expectedError !== undefined && error === options.expectedError)
        return true;
      throw new Error('Keycloak redirected an invalid authorization request to its callback');
    }
  }
  if (response.status === 400 || response.status === 422) {
    const body = await response.text();
    if (options.expectedError !== undefined && body.includes(options.expectedError)) return true;
    if (
      options.expectedError === undefined &&
      /invalid parameter[:\s]+redirect(?:_uri| uri)|invalid redirect(?:_uri| uri)?|(?:redirect_uri|redirect uri).{0,80}(?:invalid|not allowed|does not match)/i.test(
        body,
      )
    ) {
      return true;
    }
  }
  throw new Error('Keycloak accepted an invalid OAuth authorization request');
}

function buildAuthorizationUrl({
  authUrl,
  clientId,
  resource,
  redirectUri,
  scope,
  challenge,
  state,
}) {
  const url = new URL(authUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('resource', resource);
  url.searchParams.set('state', state ?? randomBase64Url(24));
  if (challenge !== undefined) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url;
}

async function authorize({
  authUrl,
  clientId,
  resource,
  redirectUri,
  scope,
  username,
  password,
  expectedError,
}) {
  const verifier = randomBase64Url(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callbackState = randomBase64Url(24);
  const authRequest = buildAuthorizationUrl({
    authUrl,
    clientId,
    resource,
    redirectUri,
    scope,
    challenge,
    state: callbackState,
  });
  const identityOrigin = new URL(authUrl).origin;
  const callbackOrigin = new URL(redirectUri).origin;
  const cookies = new Map();
  let response = await requestWithCookies(authRequest, cookies);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) throw new Error('Keycloak returned a redirect without a location');
      const target = new URL(location, authRequest);
      if (target.origin === callbackOrigin && target.pathname === new URL(redirectUri).pathname) {
        if (target.searchParams.get('state') !== callbackState)
          throw new Error('OAuth state did not match');
        const code = target.searchParams.get('code');
        const error = target.searchParams.get('error');
        if (code === null && expectedError !== undefined && error === expectedError) {
          return { error, verifier };
        }
        if (code === null) {
          throw new OAuthProtocolError(error);
        }
        return { code, verifier };
      }
      if (target.origin !== identityOrigin)
        throw new Error('Keycloak redirected outside the configured identity host');
      response = await requestWithCookies(target, cookies);
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html'))
      throw new Error('Keycloak returned an unexpected authorization response');
    const html = await response.text();
    const form = parseForms(html)[0];
    if (form === undefined) throw new Error('Keycloak authorization page did not contain a form');
    const action = new URL(form.action, response.url || authRequest);
    if (action.origin !== identityOrigin)
      throw new Error('Keycloak form action escaped the identity host');
    let fields = new URLSearchParams(form.fields);
    if (fields.has('username') || fields.has('password')) {
      fields.set('username', username);
      fields.set('password', password);
    } else {
      fields = buildConsentFormData(form);
    }
    response = await requestWithCookies(action, cookies, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields,
    });
  }
  throw new Error('Keycloak authorization did not complete within the redirect limit');
}

async function exchangeCode({ tokenUrl, clientId, code, redirectUri, resource, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    resource,
    code_verifier: verifier,
  });
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error('Keycloak token endpoint returned an invalid response');
  }
  return { response, body: json };
}

async function listTools(readUrl, accessToken, apiInvokerToken) {
  const client = new Client({ name: cloudIdentity.smokeClientId, version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(readUrl), {
        authProvider: { token: async () => accessToken },
        ...(apiInvokerToken === undefined
          ? {}
          : {
              requestInit: {
                headers: { 'X-Serverless-Authorization': `Bearer ${apiInvokerToken}` },
              },
            }),
      }),
    );
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callMcp(resourceUrl, accessToken, apiInvokerToken) {
  return fetch(resourceUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(apiInvokerToken === undefined
        ? {}
        : { 'X-Serverless-Authorization': `Bearer ${apiInvokerToken}` }),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

async function callMcpTool(resourceUrl, accessToken, name, args, apiInvokerToken) {
  const client = new Client({ name: cloudIdentity.smokeClientId, version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resourceUrl), {
        authProvider: { token: async () => accessToken },
        ...(apiInvokerToken === undefined
          ? {}
          : {
              requestInit: {
                headers: { 'X-Serverless-Authorization': `Bearer ${apiInvokerToken}` },
              },
            }),
      }),
    );
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function postRecall({ apiUrl, token, scopeId, query, apiInvokerToken }) {
  const response = await fetch(new URL('/v1/recall', apiUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(apiInvokerToken === undefined
        ? {}
        : { 'X-Serverless-Authorization': `Bearer ${apiInvokerToken}` }),
    },
    body: JSON.stringify({
      query,
      scope_ids: [scopeId],
      mode: 'contextual',
      token_budget: 8_000,
    }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

export async function readOptionalBearerTokenFile(path, name) {
  if (path === undefined || path.length === 0) return undefined;
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must refer to a private regular file`);
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 32 || /\s/.test(token)) {
    throw new Error(`${name} does not contain a valid bearer token`);
  }
  return token;
}

function hasExactAudience(audience, expected) {
  if (!(
    audience === expected ||
    (Array.isArray(audience) && audience.length === 1 && audience[0] === expected)
  )) {
    return false;
  }
  return true;
}

async function requestWithCookies(url, cookies, init = {}) {
  const headers = { ...init.headers };
  if (cookies.size > 0) {
    headers.cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const response = await fetch(url, { ...init, headers, redirect: 'manual' });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const setCookie of setCookies) {
    const separator = setCookie.indexOf('=');
    if (separator < 1) continue;
    const name = setCookie.slice(0, separator).trim();
    const value = setCookie.slice(separator + 1).split(';', 1)[0] ?? '';
    if (value.length === 0) cookies.delete(name);
    else cookies.set(name, value);
  }
  return response;
}

export function buildConsentFormData(form) {
  const fields = new URLSearchParams(form.fields);
  const acceptControl = form.submitControls.find((control) => control.name === 'accept');
  if (acceptControl === undefined) {
    throw new Error('Keycloak returned an unsupported form during PKCE smoke');
  }
  fields.set(acceptControl.name, acceptControl.value);
  return fields;
}

export function parseForms(html) {
  const forms = [];
  for (const formMatch of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attributes = parseAttributes(formMatch[1] ?? '');
    const action = attributes.get('action');
    if (action === undefined) continue;
    const fields = {};
    const submitControls = [];
    const body = formMatch[2] ?? '';
    for (const inputMatch of body.matchAll(/<input\b([^>]*)>/gi)) {
      const input = parseAttributes(inputMatch[1] ?? '');
      const name = input.get('name');
      if (name === undefined) continue;
      const type = (input.get('type') ?? 'text').toLowerCase();
      if (type === 'submit') {
        submitControls.push({ name, value: input.get('value') ?? '' });
      } else if (!['button', 'image', 'reset'].includes(type)) {
        fields[name] = input.get('value') ?? '';
      }
    }
    for (const buttonMatch of body.matchAll(/<button\b([^>]*)>/gi)) {
      const button = parseAttributes(buttonMatch[1] ?? '');
      const name = button.get('name');
      const type = (button.get('type') ?? 'submit').toLowerCase();
      if (name !== undefined && type === 'submit') {
        submitControls.push({ name, value: button.get('value') ?? '' });
      }
    }
    forms.push({ action: decodeHtml(action), fields, submitControls });
  }
  return forms;
}

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (name !== undefined) attributes.set(name, decodeHtml(value));
  }
  return attributes;
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function randomBase64Url(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function readHttpsOrigin(env, name) {
  const raw = required(env, name);
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return url.origin;
}

function readResourceUrl(env, name, path) {
  const raw = required(env, name);
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== path ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be the canonical HTTPS ${path} resource`);
  }
  return url.toString();
}

function required(env, name) {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const mode = process.argv[2] ?? 'identity';
    const result = await runCloudOAuthSmoke(process.env, mode);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const oauthDiagnostic = error instanceof OAuthProtocolError ? ` (${error.message})` : '';
    process.stderr.write(
      `Cloud OAuth smoke failed${oauthDiagnostic}; inspect the identity service and applicable MCP service logs.\n`,
    );
    process.exitCode = 1;
  }
}
