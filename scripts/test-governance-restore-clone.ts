import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { CoreService, CursorCodec } from '@memory/domain';
import { assertNobypassRls, assertWorkerMember, provisionWorkerRole } from '@memory/db';
import { ForgetService, LocalDeletionLedger } from '@memory/governance';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const adminUrl = required('TEST_ADMIN_URL');
const appUrl = required('TEST_APP_URL');
const workerPassword = 'memory_worker_local_test_only_20261014';
const forgetHmacKey = 'local-test-forget-hmac-key-with-32-bytes';
const sourceDatabase = `memory_restore_source_${randomUUID().replaceAll('-', '')}`;
const restoreDatabase = `memory_restore_clone_${randomUUID().replaceAll('-', '')}`;
const templateDatabase = decodeURIComponent(new URL(required('TEST_ADMIN_URL')).pathname.slice(1));
const ledgerDirectory = await mkdtemp(join(tmpdir(), 'memory-restore-clone-ledger-'));
const rootUrl = new URL(adminUrl);
rootUrl.pathname = '/postgres';
const root = new Pool({ connectionString: rootUrl.toString(), max: 2 });
let sourceAdmin: Pool | undefined;
let sourceApp: Pool | undefined;
let sourceWorker: Pool | undefined;
let restoreAdmin: Pool | undefined;
let restoreApp: Pool | undefined;
let restoreWorker: Pool | undefined;

try {
  const bootstrapAdmin = new Pool({ connectionString: adminUrl, max: 1 });
  await provisionWorkerRole(bootstrapAdmin, workerPassword);
  await bootstrapAdmin.end();

  await root.query(`CREATE DATABASE "${sourceDatabase}" TEMPLATE "${templateDatabase}"`);
  sourceAdmin = new Pool({ connectionString: databaseUrl(adminUrl, sourceDatabase), max: 2 });
  sourceApp = new Pool({ connectionString: databaseUrl(appUrl, sourceDatabase), max: 3 });
  sourceWorker = new Pool({ connectionString: workerUrl(adminUrl, sourceDatabase), max: 3 });
  await assertNobypassRls(sourceApp);
  await assertWorkerMember(sourceWorker);

  const ownerId = randomUUID();
  const scopeId = randomUUID();
  const subject = `restore-clone-${randomUUID()}`;
  const issuer = 'https://memory.local.test/';
  const owner = await sourceAdmin.query<{ id: string }>(
    'INSERT INTO owners(id) VALUES ($1) RETURNING id',
    [ownerId],
  );
  if (owner.rows[0]?.id !== ownerId) throw new Error('restore fixture Owner was not created');
  const principal = await sourceAdmin.query<{ id: string }>(
    `INSERT INTO principals(owner_id, issuer, subject, actor_kind)
     VALUES ($1, $2, $3, 'owner') RETURNING id`,
    [ownerId, issuer, subject],
  );
  const principalId = principal.rows[0]?.id;
  if (principalId === undefined) throw new Error('restore fixture principal was not created');
  await sourceAdmin.query('INSERT INTO scopes(owner_id, id, name) VALUES ($1, $2, $3)', [
    ownerId,
    scopeId,
    'pre-forget database snapshot fixture',
  ]);
  await sourceAdmin.query(
    `INSERT INTO grants(owner_id, scope_id, principal_id, capabilities)
     VALUES ($1, $2, $3, ARRAY['read', 'write', 'admin'])`,
    [ownerId, scopeId, principalId],
  );
  const grant = await sourceAdmin.query<{ auth_epoch: string | number }>(
    'SELECT auth_epoch FROM scopes WHERE owner_id=$1 AND id=$2',
    [ownerId, scopeId],
  );
  const authEpoch = grant.rows[0]?.auth_epoch;
  if (authEpoch === undefined) throw new Error('restore fixture grant was not created');

  const actor = {
    ownerId,
    principalId,
    actorKind: 'owner' as const,
    scopeIds: [scopeId],
    tokenScopeIds: [scopeId],
    capabilities: ['read', 'write', 'admin'] as const,
    authEpochs: { [scopeId]: Number(authEpoch) },
  };
  const core = new CoreService(
    sourceApp,
    new CursorCodec('restore-clone', new Map([['restore-clone', Buffer.alloc(32, 9)]])),
    { forgetHmacKey },
  );
  const statement = `private statement before snapshot restore ${randomUUID()}`;
  const remembered = await core.remember(
    actor,
    {
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
              external_id: `restore-source-${randomUUID()}`,
              revision: '1',
              locator: 'local/restore-fixture',
            },
            snippet: 'fixture evidence to remove during restore reconciliation',
            snippet_allowed: true,
          },
        ],
      },
    },
    randomUUID(),
    `restore-fixture-${randomUUID()}`,
  );
  const memoryId = (remembered['operations'] as Array<{ memory_ids: string[] }>)[0]?.memory_ids[0];
  if (memoryId === undefined) throw new Error('restore fixture memory was not created');
  const beforeSnapshot = await sourceAdmin.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memories WHERE owner_id=$1 AND scope_id=$2 AND id=$3',
    [ownerId, scopeId, memoryId],
  );
  if (beforeSnapshot.rows[0]?.count !== '1')
    throw new Error('pre-forget snapshot fixture is missing');

  await closeSourceConnections();
  await root.query(`CREATE DATABASE "${restoreDatabase}" TEMPLATE "${sourceDatabase}"`);

  const ledger = new LocalDeletionLedger(ledgerDirectory);
  await LocalDeletionLedger.createEmpty(ledgerDirectory);
  sourceAdmin = new Pool({ connectionString: databaseUrl(adminUrl, sourceDatabase), max: 2 });
  sourceApp = new Pool({ connectionString: databaseUrl(appUrl, sourceDatabase), max: 3 });
  sourceWorker = new Pool({ connectionString: workerUrl(adminUrl, sourceDatabase), max: 3 });
  await resetLocalLedgerCheckpoint(sourceAdmin, ledger);
  const restoreBootstrap = new Pool({
    connectionString: databaseUrl(adminUrl, restoreDatabase),
    max: 1,
  });
  await resetLocalLedgerCheckpoint(restoreBootstrap, ledger);
  await restoreBootstrap.end();
  const sourceGovernance = new ForgetService(sourceApp, ledger, { hmacKey: forgetHmacKey });
  const forgotten = await sourceGovernance.forget(
    actor,
    { scope_id: scopeId, selector: { memory_ids: [memoryId] }, reason_code: 'user_requested' },
    `restore-source-forget-${randomUUID()}`,
  );
  if (forgotten['ledger_durable'] !== true) throw new Error('Forget ledger append was not durable');
  await sourceGovernance.processPendingWorker(sourceWorker);
  await sourceGovernance.verifyLedgerReadiness();
  const sourceAfterForget = await sourceAdmin.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memories WHERE owner_id=$1 AND scope_id=$2 AND id=$3',
    [ownerId, scopeId, memoryId],
  );
  if (sourceAfterForget.rows[0]?.count !== '0')
    throw new Error('source database Forget did not purge the memory');
  await closeSourceConnections();
  restoreAdmin = new Pool({ connectionString: databaseUrl(adminUrl, restoreDatabase), max: 2 });
  restoreApp = new Pool({ connectionString: databaseUrl(appUrl, restoreDatabase), max: 2 });
  restoreWorker = new Pool({ connectionString: workerUrl(adminUrl, restoreDatabase), max: 3 });
  await assertNobypassRls(restoreApp);
  await assertWorkerMember(restoreWorker);
  const preReconcile = await restoreAdmin.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memories WHERE owner_id=$1 AND scope_id=$2 AND id=$3',
    [ownerId, scopeId, memoryId],
  );
  if (preReconcile.rows[0]?.count !== '1')
    throw new Error('the independent PostgreSQL clone did not preserve its pre-Forget snapshot');

  const restoreGovernance = new ForgetService(restoreApp, ledger, { hmacKey: forgetHmacKey });
  let readinessWasBlocked = false;
  try {
    await restoreGovernance.verifyLedgerReadiness();
  } catch {
    readinessWasBlocked = true;
  }
  if (!readinessWasBlocked)
    throw new Error('restore readiness opened before applying the newer ledger');
  const cliOutput = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./reconcile-restore.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl(appUrl, restoreDatabase),
        WORKER_DATABASE_URL: workerUrl(adminUrl, restoreDatabase),
        DELETION_LEDGER_DIR: ledgerDirectory,
        FORGET_HMAC_KEY: forgetHmacKey,
      },
    },
  );
  const replay = JSON.parse(cliOutput.trim()) as {
    status: string;
    replayed: number;
    purged: number;
    readiness: string;
  };
  if (replay.status !== 'reconciled' || replay.readiness !== 'ready')
    throw new Error('explicit restore reconciliation command did not report a ready clone');
  if (replay.replayed < 1 || replay.purged < 1)
    throw new Error('restore ledger reconciliation did not replay and purge the forgotten memory');
  await restoreGovernance.verifyLedgerReadiness();
  const afterReconcile = await restoreAdmin.query<{
    memories: string;
    versions: string;
    sources: string;
    evidence: string;
    observations: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM memories WHERE owner_id=$1 AND scope_id=$2 AND id=$3) AS memories,
       (SELECT count(*)::text FROM memory_versions WHERE owner_id=$1 AND scope_id=$2 AND memory_id=$3) AS versions,
       (SELECT count(*)::text FROM sources WHERE owner_id=$1 AND scope_id=$2) AS sources,
       (SELECT count(*)::text FROM evidence WHERE owner_id=$1 AND scope_id=$2) AS evidence,
       (SELECT count(*)::text FROM observations WHERE owner_id=$1 AND scope_id=$2) AS observations`,
    [ownerId, scopeId, memoryId],
  );
  if (
    afterReconcile.rows[0]?.memories !== '0' ||
    afterReconcile.rows[0]?.versions !== '0' ||
    afterReconcile.rows[0]?.sources !== '0' ||
    afterReconcile.rows[0]?.evidence !== '0' ||
    afterReconcile.rows[0]?.observations !== '0'
  ) {
    throw new Error(
      `restore reconciliation released readiness while forgotten database content remained: ${JSON.stringify(afterReconcile.rows[0])}`,
    );
  }
  console.log(
    'Distinct PostgreSQL snapshot restore and deletion-ledger reconciliation passed',
    replay,
  );
} finally {
  await closeSourceConnections();
  await closeRestoreConnections();
  for (const database of [restoreDatabase, sourceDatabase]) {
    await root.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [
      database,
    ]);
    await root.query(`DROP DATABASE IF EXISTS "${database}"`);
  }
  await root.end();
  await rm(ledgerDirectory, { recursive: true, force: true });
}

async function closeSourceConnections(): Promise<void> {
  await Promise.all([sourceAdmin?.end(), sourceApp?.end(), sourceWorker?.end()]);
  sourceAdmin = undefined;
  sourceApp = undefined;
  sourceWorker = undefined;
}

async function closeRestoreConnections(): Promise<void> {
  await Promise.all([restoreAdmin?.end(), restoreApp?.end(), restoreWorker?.end()]);
  restoreAdmin = undefined;
  restoreApp = undefined;
  restoreWorker = undefined;
}

async function resetLocalLedgerCheckpoint(pool: Pool, ledger: LocalDeletionLedger): Promise<void> {
  await pool.query('DELETE FROM deletion_ledger_visibility_items');
  const head = await ledger.currentHead();
  await pool.query(
    `UPDATE deletion_ledger_checkpoint SET sequence=0, entry_hash=repeat('0',64),
      head_generation=$1, visible_sequence=0, visible_entry_hash=repeat('0',64),
      visible_head_generation=$1, updated_at=clock_timestamp() WHERE singleton`,
    [head.head_generation],
  );
}

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function workerUrl(base: string, database: string): string {
  const url = new URL(databaseUrl(base, database));
  url.username = 'memory_worker_login';
  url.password = workerPassword;
  return url.toString();
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
