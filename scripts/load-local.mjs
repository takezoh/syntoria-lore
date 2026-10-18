import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';

const count = positiveInteger(
  process.argv[2] ?? process.env['LOAD_COUNT'] ?? '10',
  'count',
  1_000_000,
);
const concurrency = positiveInteger(
  process.argv[3] ?? process.env['LOAD_CONCURRENCY'] ?? '4',
  'concurrency',
  128,
);
const evidencePerMemory = positiveInteger(
  process.env['LOAD_EVIDENCE_PER_MEMORY'] ?? '2',
  'evidence per memory',
  5,
);
const recallPercent = boundedPercent(process.env['LOAD_RECALL_PERCENT'] ?? '30', 'Recall percent');
const changesPercent = boundedPercent(
  process.env['LOAD_CHANGES_PERCENT'] ?? '15',
  'Changes percent',
);
const apiUrl = (process.env['LOCAL_API_URL'] ?? 'http://localhost:18080').replace(/\/$/, '');
const issuerUrl = (process.env['LOCAL_ISSUER_URL'] ?? 'http://localhost:19090').replace(/\/$/, '');
const scopeId = process.env['LOCAL_SCOPE_ID'] ?? '22222222-2222-4222-8222-222222222222';
const dbUrl = await migrationDatabaseUrl();
const operations = {
  remember: newAccumulator(),
  recall: newAccumulator(),
  changes: newAccumulator(),
};
const networkExceptions = [];
const startedAt = new Date().toISOString();
const started = performance.now();
let token;
let beforeDb;
let afterDb;
let next = 0;
let remembered = 0;
let scheduledRecall = 0;
let scheduledChanges = 0;
const pool = new Pool({
  connectionString: dbUrl,
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 1_000,
});

try {
  beforeDb = await databaseSnapshot(pool);
  token = await issueToken(issuerUrl, apiUrl);
} catch (error) {
  networkExceptions.push({
    operation: 'setup',
    type: error?.name ?? 'Error',
    message: safeMessage(error),
  });
  operations.remember.errors += count;
}

if (token !== undefined) {
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const index = next++;
      const statement = `Local load sample ${index} ${randomUUID()}`;
      const evidence = Array.from({ length: evidencePerMemory }, (_, evidenceIndex) => ({
        source: {
          kind: 'explicit_remember',
          external_id: `load-${randomUUID()}`,
          revision: '1',
          locator: `load/${index}/evidence/${evidenceIndex}`,
        },
        snippet: statement,
        snippet_allowed: true,
      }));
      const remember = await requestJson(
        operations.remember,
        networkExceptions,
        'remember',
        `${apiUrl}/v1/memories:remember`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': `local-load-${randomUUID()}`,
          },
          body: JSON.stringify({
            scope_id: scopeId,
            memory: { kind: 'fact', statement, context: {}, subjects: [], evidence },
          }),
        },
      );
      const memoryId = remember.body?.operations?.flatMap(
        (operation) => operation.memory_ids ?? [],
      )[0];
      if (remember.ok && memoryId) remembered += 1;

      const slot = index % 100;
      if (slot < recallPercent) {
        scheduledRecall += 1;
        const query = memoryId ? statement : `Local load sample ${index}`;
        await requestJson(operations.recall, networkExceptions, 'recall', `${apiUrl}/v1/recall`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query, scope_ids: [scopeId], mode: 'precise' }),
        });
      }
      if (slot < changesPercent) {
        scheduledChanges += 1;
        const url = new URL(`${apiUrl}/v1/changes`);
        url.searchParams.append('scope_ids', scopeId);
        url.searchParams.set('limit', '20');
        await requestJson(operations.changes, networkExceptions, 'changes', url, {
          headers: { authorization: `Bearer ${token}` },
        });
      }
    }
  });
  await Promise.all(workers);
}

try {
  afterDb = await databaseSnapshot(pool);
} catch (error) {
  networkExceptions.push({
    operation: 'database_snapshot_after',
    type: error?.name ?? 'Error',
    message: safeMessage(error),
  });
}
await pool.end().catch((error) => {
  networkExceptions.push({
    operation: 'database_disconnect',
    type: error?.name ?? 'Error',
    message: safeMessage(error),
  });
});

for (const operation of Object.values(operations)) operation.latencies_ms.sort((a, b) => a - b);
const totalErrors =
  Object.values(operations).reduce((sum, operation) => sum + operation.errors, 0) +
  networkExceptions.length;
const report = {
  schema_version: 'memory.local-load.v2',
  fixture: 'local-rest-mixed-workload-v2',
  started_at: startedAt,
  duration_ms: Math.round(performance.now() - started),
  configuration: {
    requested_memories: count,
    concurrency: Math.min(concurrency, count),
    evidence_per_memory: evidencePerMemory,
    requested_evidence_rows: count * evidencePerMemory,
    recall_percent_by_deterministic_slot: recallPercent,
    changes_percent_by_deterministic_slot: changesPercent,
    scope_id: scopeId,
    api_origin: new URL(apiUrl).origin,
    issuer_origin: new URL(issuerUrl).origin,
  },
  completed: {
    remembered_memories: remembered,
    scheduled_recall_requests: scheduledRecall,
    scheduled_changes_requests: scheduledChanges,
  },
  operations: Object.fromEntries(
    Object.entries(operations).map(([name, value]) => [name, summarize(value)]),
  ),
  database: {
    before: beforeDb ?? null,
    after: afterDb ?? null,
    delta:
      beforeDb !== undefined && afterDb !== undefined
        ? {
            memories: afterDb.memories - beforeDb.memories,
            evidence: afterDb.evidence - beforeDb.evidence,
            memory_evidence_links: afterDb.memory_evidence_links - beforeDb.memory_evidence_links,
            bytes: afterDb.database_bytes - beforeDb.database_bytes,
          }
        : null,
  },
  errors: {
    total: totalErrors,
    network_exception_count: networkExceptions.length,
    network_exceptions: networkExceptions.slice(0, 100),
    network_exceptions_truncated: Math.max(0, networkExceptions.length - 100),
  },
  limitations: [
    'One local Compose stack, one owner scope, one issuer and a deterministic client workload; not a cloud-capacity or production-SLO measurement.',
    'Counts and database bytes are exact PostgreSQL snapshots taken before and after the run; concurrent external writes may affect deltas.',
    'Evidence is an independently identified explicit-remember fixture row. This does not model large source artifacts or real-provider latency.',
  ],
};

await mkdir('var', { recursive: true });
const output = join('var', `load-${new Date().toISOString().replaceAll(':', '-')}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...report, report_file: output }, null, 2)}\n`);
if (totalErrors > 0 || remembered !== count) process.exitCode = 1;

async function issueToken(issuer, resourceBase) {
  const authorization = Buffer.from('demo-owner-client:owner-local-fixture-only').toString(
    'base64',
  );
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authorization}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: resourceBase,
      scope: 'memory:read memory:write memory:admin',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Local issuer returned HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result.access_token !== 'string')
    throw new Error('Local issuer response had no access token');
  return result.access_token;
}

async function requestJson(accumulator, exceptions, operation, input, init) {
  const start = performance.now();
  try {
    const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let body;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const elapsed = performance.now() - start;
    accumulator.latencies_ms.push(elapsed);
    accumulator.requests += 1;
    accumulator.statuses[response.status] = (accumulator.statuses[response.status] ?? 0) + 1;
    if (!response.ok) accumulator.errors += 1;
    else accumulator.successes += 1;
    return { ok: response.ok, body, status: response.status };
  } catch (error) {
    accumulator.latencies_ms.push(performance.now() - start);
    accumulator.requests += 1;
    accumulator.errors += 1;
    exceptions.push({ operation, type: error?.name ?? 'Error', message: safeMessage(error) });
    return { ok: false, body: null, status: null };
  }
}

async function databaseSnapshot(databasePool) {
  const result = await databasePool.query(`
    SELECT
      current_database() AS database_name,
      (SELECT count(*)::text FROM public.memories) AS memories,
      (SELECT count(*)::text FROM public.evidence) AS evidence,
      (SELECT count(*)::text FROM public.memory_evidence) AS memory_evidence_links,
      pg_database_size(current_database())::text AS database_bytes
  `);
  const row = result.rows[0];
  return {
    database_name: row.database_name,
    memories: Number(row.memories),
    evidence: Number(row.evidence),
    memory_evidence_links: Number(row.memory_evidence_links),
    database_bytes: Number(row.database_bytes),
  };
}

async function migrationDatabaseUrl() {
  if (process.env['MIGRATION_DATABASE_URL']) return process.env['MIGRATION_DATABASE_URL'];
  const deployment = await readFile('infra/local/deployment.env', 'utf8');
  const local = await readFile('.env.local', 'utf8');
  const values = { ...parseEnv(deployment), ...parseEnv(local), ...process.env };
  const password = values['LOCAL_DB_PASSWORD'];
  if (!password) throw new Error('LOCAL_DB_PASSWORD is missing from .env.local');
  const url = new URL('postgresql://127.0.0.1:55433');
  url.pathname = `/${requiredEnvironmentValue(values, 'DATABASE_NAME')}`;
  url.username = requiredEnvironmentValue(values, 'DB_ADMIN_ROLE');
  url.password = password;
  return url.toString();
}

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .flatMap((line) => {
        const separator = line.indexOf('=');
        if (separator <= 0) return [];
        return [[line.slice(0, separator), line.slice(separator + 1)]];
      }),
  );
}

function requiredEnvironmentValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is missing from local deployment configuration`);
  }
  return value;
}

function summarize(value) {
  return {
    requests: value.requests,
    successes: value.successes,
    errors: value.errors,
    status_counts: value.statuses,
    latency_ms: {
      p50: percentile(value.latencies_ms, 0.5),
      p95: percentile(value.latencies_ms, 0.95),
      p99: percentile(value.latencies_ms, 0.99),
      max: Math.round(value.latencies_ms.at(-1) ?? 0),
    },
  };
}

function newAccumulator() {
  return { requests: 0, successes: 0, errors: 0, statuses: {}, latencies_ms: [] };
}

function percentile(values, fraction) {
  return Math.round(
    values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0,
  );
}

function positiveInteger(value, name, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error(`${name} must be between 1 and ${max}`);
  return parsed;
}

function boundedPercent(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100)
    throw new Error(`${name} must be between 0 and 100`);
  return parsed;
}

function safeMessage(error) {
  return typeof error?.message === 'string'
    ? error.message.slice(0, 240)
    : 'Unexpected local load failure';
}
