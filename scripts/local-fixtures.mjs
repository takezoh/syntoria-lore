import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { LEGACY_LOCAL_ISSUER_KEY_ID } from '@memory/contracts';

const mode = process.argv[2];
if (mode === 'issuer') await runIssuer();
else if (mode === 'tasks') await runTasks();
else if (mode === 'scheduler') await runScheduler();
else throw new Error('Choose issuer, tasks, or scheduler fixture mode');

async function runIssuer() {
  const stateDirectory = required('LOCAL_ISSUER_STATE_DIR');
  const issuer = required('LOCAL_ISSUER');
  const resourceBaseUrl = required('LOCAL_RESOURCE_BASE_URL');
  const key = await loadSigningKey(stateDirectory);
  const publicJwk = createPublicKey(key.privateKey).export({ format: 'jwk' });
  publicJwk.kid = LEGACY_LOCAL_ISSUER_KEY_ID;
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
  const resources = new Set([
    resourceBaseUrl,
    new URL('/mcp/read', resourceBaseUrl).toString(),
    new URL('/mcp/write', resourceBaseUrl).toString(),
  ]);
  const defaultScope = process.env['LOCAL_SCOPE_ID'] ?? '22222222-2222-4222-8222-222222222222';
  const clients = new Map([
    [
      'demo-owner-client',
      {
        secret: 'owner-local-fixture-only',
        subject: 'demo-owner',
        scopes: ['memory:read', 'memory:write', 'memory:admin'],
      },
    ],
    [
      'demo-reader-client',
      { secret: 'reader-local-fixture-only', subject: 'demo-reader', scopes: ['memory:read'] },
    ],
  ]);
  const port = Number(process.env['LOCAL_ISSUER_PORT'] ?? '9090');
  const server = createServer((request, response) => {
    void handleIssuerRequest(request, response, {
      issuer,
      resources,
      clients,
      publicJwk,
      key,
      defaultScope,
    });
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'local.issuer.started', port, signing_alg: 'RS256' }));
  });
  closeOnSignal([server]);
}

async function handleIssuerRequest(request, response, options) {
  const pathname = new URL(request.url ?? '/', options.issuer).pathname;
  if (request.method === 'GET' && pathname === '/healthz')
    return json(response, 200, { status: 'ok' });
  if (request.method === 'GET' && pathname === '/.well-known/openid-configuration') {
    return json(response, 200, {
      issuer: options.issuer,
      jwks_uri: new URL('/.well-known/jwks.json', options.issuer).toString(),
      token_endpoint: new URL('/oauth/token', options.issuer).toString(),
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      scopes_supported: ['memory:read', 'memory:write', 'memory:admin'],
    });
  }
  if (request.method === 'GET' && pathname === '/.well-known/jwks.json') {
    return json(response, 200, { keys: [options.publicJwk] });
  }
  if (request.method !== 'POST' || pathname !== '/oauth/token')
    return json(response, 404, { error: 'not_found' });
  let form;
  try {
    form = new URLSearchParams(await readBody(request, 16_384));
  } catch {
    return json(response, 400, { error: 'invalid_request' });
  }
  const [clientId, clientSecret] = readBasic(request.headers.authorization);
  const client = options.clients.get(clientId);
  if (
    client === undefined ||
    !safeEqual(client.secret, clientSecret) ||
    form.get('grant_type') !== 'client_credentials'
  ) {
    return json(response, 401, { error: 'invalid_client' });
  }
  const resource = form.get('resource');
  if (resource === null || !options.resources.has(resource)) {
    return json(response, 400, { error: 'invalid_target' });
  }
  const requested = (form.get('scope') ?? client.scopes.join(' ')).split(/\s+/).filter(Boolean);
  if (requested.length === 0 || requested.some((scope) => !client.scopes.includes(scope))) {
    return json(response, 400, { error: 'invalid_scope' });
  }
  const scopeIds = (form.get('scope_ids') ?? options.defaultScope).split(/\s+/).filter(Boolean);
  if (
    scopeIds.length === 0 ||
    scopeIds.length > 16 ||
    scopeIds.some(
      (scopeId) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scopeId),
    )
  ) {
    return json(response, 400, { error: 'invalid_scope_ids' });
  }
  const now = Math.floor(Date.now() / 1_000);
  const token = signJwt(
    {
      iss: options.issuer,
      sub: client.subject,
      aud: resource,
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
      scope: requested.join(' '),
      scope_ids: scopeIds,
    },
    options.key.privateKey,
  );
  return json(response, 200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: 600,
    scope: requested.join(' '),
    resource,
  });
}

async function runTasks() {
  const workerUrl = required('LOCAL_WORKER_URL');
  const workerToken = required('WORKER_TASK_TOKEN');
  const controlToken = required('LOCAL_CONTROL_TOKEN');
  const artifactDirectory = required('LOCAL_ARTIFACTS_DIR');
  const port = Number(process.env['LOCAL_TASKS_PORT'] ?? '9091');
  let failNext = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', `http://localhost:${port}`).pathname;
    if (request.method === 'GET' && pathname === '/healthz')
      return json(response, 200, { status: 'ok' });
    if (request.method === 'POST' && pathname === '/__fixture/fail-next') {
      if (!authorizedControl(request, controlToken))
        return json(response, 403, { error: 'forbidden' });
      failNext += 1;
      return json(response, 202, { armed: true, pending_failures: failNext });
    }
    if (request.method === 'POST' && pathname.startsWith('/__fixture/provider-fail-next/')) {
      if (!authorizedControl(request, controlToken))
        return json(response, 403, { error: 'forbidden' });
      const provider = pathname.slice('/__fixture/provider-fail-next/'.length);
      if (!['curator', 'embedding'].includes(provider))
        return json(response, 400, { error: 'invalid_provider' });
      const directory = join(artifactDirectory, 'provider-failures');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${provider}.fail`), 'one-shot\n', { mode: 0o600 });
      return json(response, 202, { armed: true, provider });
    }
    if (request.method !== 'POST' || pathname !== '/internal/jobs/run')
      return json(response, 404, { error: 'not_found' });
    if (!safeEqual(request.headers.authorization?.replace(/^Bearer /, '') ?? '', workerToken)) {
      return json(response, 401, { error: 'unauthorized' });
    }
    if (failNext > 0) {
      failNext -= 1;
      return json(response, 503, { error: 'local_task_delivery_failed', retryable: true });
    }
    await proxy(request, response, new URL('/internal/jobs/run', workerUrl), workerToken);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        event: 'local.tasks.started',
        port,
        delivery: 'postgres-outbox-http-adapter',
      }),
    );
  });
  closeOnSignal([server]);
}

async function runScheduler() {
  const workerUrl = required('LOCAL_WORKER_URL');
  const workerToken = required('WORKER_TASK_TOKEN');
  const controlToken = required('LOCAL_CONTROL_TOKEN');
  const port = Number(process.env['LOCAL_SCHEDULER_PORT'] ?? '9092');
  const interval = Number(process.env['LOCAL_SCHEDULER_INTERVAL_MS'] ?? '30000');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', `http://localhost:${port}`).pathname;
    if (request.method === 'GET' && pathname === '/healthz')
      return json(response, 200, { status: 'ok' });
    if (request.method !== 'POST' || pathname !== '/__fixture/trigger')
      return json(response, 404, { error: 'not_found' });
    if (!authorizedControl(request, controlToken))
      return json(response, 403, { error: 'forbidden' });
    try {
      const first = await callWorkerSweep(workerUrl, workerToken);
      const duplicate =
        new URL(request.url ?? '/', `http://localhost:${port}`).searchParams.get('duplicate') ===
        'true';
      const second = duplicate ? await callWorkerSweep(workerUrl, workerToken) : undefined;
      return json(response, 200, {
        status: 'ok',
        first,
        ...(second === undefined ? {} : { duplicate: second }),
      });
    } catch {
      return json(response, 503, { error: 'worker_sweep_unavailable', retryable: true });
    }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'local.scheduler.started', port, interval_ms: interval }));
  });
  const timer = setInterval(
    () => void callWorkerSweep(workerUrl, workerToken).catch(() => undefined),
    interval,
  );
  timer.unref();
  closeOnSignal([server], () => clearInterval(timer));
}

async function callWorkerSweep(workerUrl, token) {
  const response = await fetch(new URL('/internal/governance/sweep', workerUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-request-id': randomUUID() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('worker sweep unavailable');
  return await response.json();
}

async function proxy(request, response, target, workerToken) {
  let body;
  try {
    body = await readBody(request, 16_384);
  } catch {
    return json(response, 413, { error: 'invalid_task_body' });
  }
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerToken}`,
        'content-type': request.headers['content-type'] ?? 'application/json',
        'x-request-id': validTraceId(request.headers['x-request-id']) ?? randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(300_000),
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    response.end(text);
  } catch {
    json(response, 503, { error: 'worker_unavailable', retryable: true });
  }
}

async function loadSigningKey(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privatePath = join(directory, 'issuer-private.pem');
  const publicPath = join(directory, 'issuer-public.pem');
  try {
    return {
      privateKey: createPrivateKey(await readFile(privatePath)),
      publicKey: createPublicKey(await readFile(publicPath)),
    };
  } catch (error) {
    if (error?.code !== 'ENOENT')
      throw new Error('Local issuer signing key files are invalid', { cause: error });
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    await writeFile(privatePath, pair.privateKey, { mode: 0o600, flag: 'wx' });
    await chmod(privatePath, 0o600);
    await writeFile(publicPath, pair.publicKey, { mode: 0o644, flag: 'wx' });
    return {
      privateKey: createPrivateKey(pair.privateKey),
      publicKey: createPublicKey(pair.publicKey),
    };
  }
}

function signJwt(payload, privateKey) {
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: LEGACY_LOCAL_ISSUER_KEY_ID });
  const body = encode(payload);
  const input = `${header}.${body}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function readBasic(header) {
  const encoded = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '')?.[1];
  if (encoded === undefined) return ['', ''];
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return separator < 0 ? ['', ''] : [decoded.slice(0, separator), decoded.slice(separator + 1)];
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function authorizedControl(request, token) {
  const value = request.headers['x-local-control-token'];
  return safeEqual(Array.isArray(value) ? (value[0] ?? '') : (value ?? ''), token);
}

function validTraceId(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== undefined && /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : undefined;
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > limit) {
        reject(new Error('request too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function closeOnSignal(servers, beforeClose = () => {}) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      beforeClose();
      for (const server of servers) server.close();
    });
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
