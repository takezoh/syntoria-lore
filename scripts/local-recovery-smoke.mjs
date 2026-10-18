import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

const api = (process.env['LOCAL_API_URL'] ?? 'http://localhost:18080').replace(/\/$/, '');
const issuer = (process.env['LOCAL_ISSUER_URL'] ?? 'http://localhost:19090').replace(/\/$/, '');
const baseScopeId = process.env['LOCAL_SCOPE_ID'] ?? '22222222-2222-4222-8222-222222222222';
const scopeId = randomUUID();
const localEnv = {
  ...parse(await readFile('infra/local/deployment.env', 'utf8')),
  ...parse(await readFile('.env.local', 'utf8')),
  ...process.env,
};
const controlToken = localEnv['LOCAL_CONTROL_TOKEN'];
if (!controlToken) throw new Error('Local recovery fixture control is unavailable');

const databaseUrl = await migrationDatabaseUrl(localEnv);
const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
const started = performance.now();
const runId = randomUUID();
const externalId = `local-recovery-${runId}`;
const statement = `The zephyr kiln ${runId} stores cobalt gaskets inside vault ${randomUUID()}.`;
let report;

try {
  await provisionIsolatedScope(pool, baseScopeId, scopeId, runId);
  const token = await issueOwnerToken(api, issuer, scopeId);
  await control('task-fail');
  await control('provider-fail-curator');
  await request(`${api}/v1/connectors`, token, {
    method: 'POST',
    body: {
      scope_id: scopeId,
      source_kind: 'chat',
      external_id: externalId,
      enabled: true,
      consent: true,
      metadata: { fixture: 'local-recovery-smoke-v1' },
    },
  });
  const capture = await request(`${api}/v1/captures`, token, {
    method: 'POST',
    idempotencyKey: `local-recovery-${runId}`,
    body: {
      scope_id: scopeId,
      operation_id: `local-recovery-${runId}`,
      source: { kind: 'chat', external_id: externalId, revision: '1' },
      observations: [{ locator: `messages/${runId}`, content: statement, speaker: 'owner' }],
    },
  });
  const jobId = capture.body?.job_id;
  if (capture.status !== 202 || typeof jobId !== 'string')
    throw new Error('Capture was not accepted by the local API');

  let job;
  const deadline = Date.now() + 90_000;
  do {
    job = await request(`${api}/v1/captures/${jobId}`, token);
    if (job.body?.status === 'committed') break;
    if (job.body?.status === 'held')
      throw new Error('Unique retry fixture was held instead of following the auto-commit path');
    if (job.body?.status === 'failed' && Number(job.body?.attempt ?? 0) >= 5)
      throw new Error('Local recovery exhausted capture retries');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  if (job?.body?.status !== 'committed')
    throw new Error('Local queue/provider retry did not reach committed state in 90 seconds');

  const duplicateSweep = await control('scheduler-duplicate');
  if (duplicateSweep.first === undefined || duplicateSweep.duplicate === undefined)
    throw new Error('Duplicate Scheduler invocation did not run both bounded sweeps');

  const recalled = await request(`${api}/v1/recall`, token, {
    method: 'POST',
    body: { query: statement, scope_ids: [scopeId], mode: 'precise', limit: 5 },
  });
  const matches = (recalled.body?.matches ?? []).filter((item) => item.statement === statement);
  if (recalled.status !== 200 || matches.length !== 1)
    throw new Error('Recovery fixture did not produce exactly one recallable memory');
  const memoryId = matches[0]?.id;
  if (typeof memoryId !== 'string') throw new Error('Recovered memory ID is missing');

  const changed = await request(
    `${api}/v1/changes?scope_ids=${encodeURIComponent(scopeId)}&limit=100`,
    token,
  );
  const matchingChanges = (changed.body?.changes ?? []).filter(
    (entry) => entry.memory_id === memoryId,
  );
  const counts = await pool.query(
    `SELECT j.attempt AS capture_attempt, o.attempts AS dispatch_attempts,
       (SELECT count(*)::integer FROM memory_evidence e WHERE e.memory_id = $1) AS evidence_rows
     FROM capture_jobs j JOIN outbox o ON o.aggregate_id = j.id
     WHERE j.id = $2`,
    [memoryId, jobId],
  );
  const counters = counts.rows[0];
  if (
    changed.status !== 200 ||
    matchingChanges.length !== 1 ||
    counters === undefined ||
    counters.dispatch_attempts < 2 ||
    counters.capture_attempt < 2 ||
    counters.evidence_rows !== 1
  ) {
    throw new Error(
      `Recovery assertion mismatch: ${JSON.stringify({
        status: changed.status,
        matching_changes: matchingChanges.length,
        counters: counters ?? null,
      })}`,
    );
  }

  const forgotten = await request(`${api}/v1/forget`, token, {
    method: 'POST',
    idempotencyKey: `local-recovery-forget-${runId}`,
    body: {
      scope_id: scopeId,
      selector: { memory_ids: [memoryId] },
      reason_code: 'user_requested',
    },
  });
  const forgetRequestId = forgotten.body?.forget_request_id;
  if (
    forgotten.status !== 202 ||
    typeof forgetRequestId !== 'string' ||
    forgotten.body?.ledger_durable !== true ||
    forgotten.body?.content_available !== false
  ) {
    throw new Error('Recovery fixture Forget did not durably suppress the recovered memory');
  }
  let forgetStatus;
  const purgeDeadline = Date.now() + 30_000;
  do {
    forgetStatus = await request(
      `${api}/v1/forget/${forgetRequestId}?scope_id=${encodeURIComponent(scopeId)}`,
      token,
    );
    if (forgetStatus.body?.status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < purgeDeadline);
  if (forgetStatus?.body?.status !== 'complete')
    throw new Error('Recovery fixture Forget did not reach completed physical purge');
  const forgottenGet = await fetch(
    `${api}/v1/memories/${memoryId}?scope_id=${encodeURIComponent(scopeId)}`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (forgottenGet.status !== 404) throw new Error('Forgotten recovery memory remained readable');
  const purgedRows = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM memories WHERE id = $1) AS memories,
       (SELECT count(*)::integer FROM memory_versions WHERE memory_id = $1) AS versions,
       (SELECT count(*)::integer FROM memory_evidence WHERE memory_id = $1) AS evidence_links,
       (SELECT count(*)::integer FROM memory_version_evidence WHERE memory_id = $1) AS version_evidence_links`,
    [memoryId],
  );
  const purge = purgedRows.rows[0];
  if (
    purge?.memories !== 0 ||
    purge.versions !== 0 ||
    purge.evidence_links !== 0 ||
    purge.version_evidence_links !== 0
  ) {
    throw new Error(`Forget completed while fixture content remained: ${JSON.stringify(purge)}`);
  }

  report = {
    schema_version: 'memory.local-recovery-smoke.v1',
    status: 'passed',
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
    checks: {
      task_delivery_failed_then_retried: counters.dispatch_attempts >= 2,
      curator_provider_failed_then_retried: counters.capture_attempt >= 2,
      duplicate_scheduler_sweep: true,
      committed_capture: job.body.status,
      exact_recall_rows: matches.length,
      change_feed_create_events: matchingChanges.length,
      evidence_rows_after_replay: counters.evidence_rows,
      forget_ledger_durable: forgotten.body.ledger_durable,
      forget_completed: forgetStatus.body.status,
      forgotten_get_http_status: forgottenGet.status,
      purged_memory_versions_and_evidence: true,
    },
  };
} finally {
  await pool.end();
}

await mkdir('var', { recursive: true });
const output = join('var', `recovery-${new Date().toISOString().replaceAll(':', '-')}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...report, report_file: output }, null, 2)}\n`);

async function issueOwnerToken(resourceBase, issuerUrl, scope) {
  const authorization = Buffer.from('demo-owner-client:owner-local-fixture-only').toString(
    'base64',
  );
  const response = await fetch(`${issuerUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authorization}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: resourceBase,
      scope: 'memory:read memory:write memory:admin',
      scope_ids: scope,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== 'string')
    throw new Error('Local Owner token acquisition failed');
  const claims = JSON.parse(
    Buffer.from(body.access_token.split('.')[1] ?? '', 'base64').toString(),
  );
  if (!Array.isArray(claims.scope_ids) || !claims.scope_ids.includes(scope))
    throw new Error('Local Owner token does not include the configured test scope');
  return body.access_token;
}

async function provisionIsolatedScope(databasePool, templateScopeId, newScopeId, run) {
  const template = await databasePool.query(
    `SELECT s.owner_id, p.id AS principal_id
     FROM scopes s
     JOIN grants g ON g.owner_id = s.owner_id AND g.scope_id = s.id
     JOIN principals p ON p.owner_id = g.owner_id AND p.id = g.principal_id
     WHERE s.id = $1 AND p.actor_kind = 'owner' AND p.active
       AND 'admin' = ANY(g.capabilities)
     LIMIT 1`,
    [templateScopeId],
  );
  const principal = template.rows[0];
  if (principal === undefined) throw new Error('Local recovery owner fixture is unavailable');
  await databasePool.query('INSERT INTO scopes(owner_id, id, name) VALUES ($1, $2, $3)', [
    principal.owner_id,
    newScopeId,
    `local recovery ${run}`,
  ]);
  await databasePool.query(
    `INSERT INTO grants(owner_id, scope_id, principal_id, capabilities)
     VALUES ($1, $2, $3, ARRAY['read', 'write', 'admin'])`,
    [principal.owner_id, newScopeId, principal.principal_id],
  );
}

async function control(name) {
  const routes = {
    'task-fail': 'http://localhost:19091/__fixture/fail-next',
    'provider-fail-curator': 'http://localhost:19091/__fixture/provider-fail-next/curator',
    'scheduler-duplicate': 'http://localhost:19092/__fixture/trigger?duplicate=true',
  };
  const url = routes[name];
  if (!url) throw new Error('Unknown local recovery fixture action');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'x-local-control-token': controlToken },
    signal: AbortSignal.timeout(35_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Local recovery control ${name} failed`);
  return body;
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
  if (!response.ok) throw new Error(`Local recovery request failed with HTTP ${response.status}`);
  return { status: response.status, body };
}

async function migrationDatabaseUrl(env) {
  if (process.env['MIGRATION_DATABASE_URL']) return process.env['MIGRATION_DATABASE_URL'];
  if (env['MIGRATION_DATABASE_URL']) return env['MIGRATION_DATABASE_URL'];
  if (env['LOCAL_DB_PASSWORD'] && env['DATABASE_NAME'] && env['DB_ADMIN_ROLE']) {
    const url = new URL('postgresql://127.0.0.1:55433');
    url.username = env['DB_ADMIN_ROLE'];
    url.password = env['LOCAL_DB_PASSWORD'];
    url.pathname = `/${env['DATABASE_NAME']}`;
    return url.href;
  }
  throw new Error('Local database connection configuration is unavailable');
}

function parse(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
