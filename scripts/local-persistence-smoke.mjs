import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.argv[2];
const api = (process.env['LOCAL_API_URL'] ?? 'http://localhost:18080').replace(/\/$/, '');
const issuer = (process.env['LOCAL_ISSUER_URL'] ?? 'http://localhost:19090').replace(/\/$/, '');
const scopeId = process.env['LOCAL_SCOPE_ID'] ?? '22222222-2222-4222-8222-222222222222';
const proofPath = join('var', 'local-persistence-proof.secret.json');

if (mode === 'prepare') {
  const token = await issueUserToken(api, issuer);
  const statement = `Local persistence smoke ${randomUUID()}`;
  const remembered = await request(`${api}/v1/memories:remember`, token, {
    method: 'POST',
    idempotencyKey: `persistence-${randomUUID()}`,
    body: {
      scope_id: scopeId,
      memory: {
        kind: 'fact',
        statement,
        context: {},
        subjects: [],
        evidence: [
          {
            source: {
              kind: 'explicit_remember',
              external_id: `persistence-${randomUUID()}`,
              revision: '1',
              locator: 'local/persistence-smoke',
            },
            snippet: statement,
            snippet_allowed: true,
          },
        ],
      },
    },
  });
  const memoryId = remembered.body?.operations?.[0]?.memory_ids?.[0];
  if (remembered.status !== 200 || typeof memoryId !== 'string')
    throw new Error('Persistence fixture Remember failed');
  await mkdir('var', { recursive: true });
  await writeFile(
    proofPath,
    `${JSON.stringify({ token, memory_id: memoryId, scope_id: scopeId })}\n`,
    { mode: 0o600 },
  );
  await chmod(proofPath, 0o600);
  process.stdout.write(JSON.stringify({ status: 'prepared', signed_before_restart: true }) + '\n');
} else if (mode === 'verify') {
  const proof = JSON.parse(await readFile(proofPath, 'utf8'));
  try {
    const [issuerHealth, ready] = await Promise.all([
      fetch(`${issuer}/healthz`, { signal: AbortSignal.timeout(5_000) }),
      fetch(`${api}/readyz`, { signal: AbortSignal.timeout(5_000) }),
    ]);
    if (!issuerHealth.ok || !ready.ok)
      throw new Error('Issuer/API did not become ready after stack restart');
    const memory = await request(
      `${api}/v1/memories/${proof.memory_id}?scope_id=${encodeURIComponent(proof.scope_id)}`,
      proof.token,
    );
    if (memory.status !== 200 || memory.body?.id !== proof.memory_id)
      throw new Error('A pre-restart JWT or its remembered data did not survive restart');
    const recall = await request(`${api}/v1/recall`, proof.token, {
      method: 'POST',
      body: {
        query: memory.body.statement,
        scope_ids: [proof.scope_id],
        mode: 'precise',
        limit: 5,
      },
    });
    if (
      recall.status !== 200 ||
      !Array.isArray(recall.body?.matches) ||
      !recall.body.matches.some((item) => item?.id === proof.memory_id)
    ) {
      throw new Error('Pre-restart memory was not recallable after stack restart');
    }
    process.stdout.write(
      JSON.stringify({
        status: 'passed',
        pre_restart_jwt_still_valid: true,
        issuer_signing_key_persisted: true,
        api_and_worker_ready: true,
        remember_persisted: true,
        recall_persisted: true,
      }) + '\n',
    );
  } finally {
    await rm(proofPath, { force: true });
  }
} else {
  throw new Error('Usage: node scripts/local-persistence-smoke.mjs prepare|verify');
}

async function issueUserToken(resource, localIssuer) {
  const authorization = Buffer.from('demo-owner-client:owner-local-fixture-only').toString(
    'base64',
  );
  const response = await fetch(`${localIssuer}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authorization}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource,
      scope: 'memory:read memory:write memory:admin',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== 'string')
    throw new Error('Local pre-restart OAuth token acquisition failed');
  return body.access_token;
}

async function request(url, token, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Persistence request failed with HTTP ${response.status}`);
  return { status: response.status, body };
}
