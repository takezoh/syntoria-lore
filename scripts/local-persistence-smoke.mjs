import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.argv[2];
const api = (process.env['LOCAL_API_URL'] ?? 'http://localhost:18080').replace(/\/$/, '');
const scopeId = process.env['LOCAL_SCOPE_ID'] ?? '22222222-2222-4222-8222-222222222222';
const proofPath = join('var', 'local-persistence-proof.secret.json');

if (mode === 'prepare') {
  const token = required('LOCAL_API_BEARER_TOKEN');
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
  await writeFile(proofPath, `${JSON.stringify({ memory_id: memoryId, scope_id: scopeId })}\n`, {
    mode: 0o600,
  });
  await chmod(proofPath, 0o600);
  process.stdout.write(
    JSON.stringify({ status: 'prepared', gate_authorized_before_restart: true }) + '\n',
  );
} else if (mode === 'verify') {
  const proof = JSON.parse(await readFile(proofPath, 'utf8'));
  try {
    const token = required('LOCAL_API_BEARER_TOKEN');
    const ready = await fetch(`${api}/readyz`, { signal: AbortSignal.timeout(5_000) });
    if (!ready.ok) throw new Error('API did not become ready after stack restart');
    const memory = await request(
      `${api}/v1/memories/${proof.memory_id}?scope_id=${encodeURIComponent(proof.scope_id)}`,
      token,
    );
    if (memory.status !== 200 || memory.body?.id !== proof.memory_id)
      throw new Error(
        'Previously stored memory was not accessible through current Gate authorization after restart',
      );
    const recall = await request(`${api}/v1/recall`, token, {
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
        current_gate_authorization_verified: true,
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

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} must be supplied by Gate; this script does not issue credentials`);
  return value;
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
