import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { CoreService, CursorCodec } from '@memory/domain';
import { assertNobypassRls, assertWorkerMember, createDatabase } from '@memory/db';
import { CloudDeletionLedger, ForgetService, GoogleCloudObjectBucket } from '@memory/governance';
import { Storage } from '@google-cloud/storage';
import { OAuth2Client } from 'google-auth-library';
import { isExpectedRestoreCheckpointMismatch } from './cloud-restore-clone-contract.js';

type Phase = 'prepare' | 'forget' | 'verify';
type Marker = {
  schema_version: 'memory.cloud-restore-smoke.v1';
  smoke_id: string;
  ledger_bucket: string;
  ledger_prefix: string;
  user_id: string;
  scope_id: string;
  principal_id: string;
  memory_id: string;
  status: 'prepared' | 'forgetting' | 'forgotten' | 'restored';
  forget_request_id?: string;
};

const phase = readPhase(process.argv[2]);
const smokeId = requiredUuid('CLOUD_RESTORE_SMOKE_ID').toLowerCase();
const markerArgument = required('CLOUD_RESTORE_SMOKE_MARKER');
if (!isAbsolute(markerArgument))
  throw new Error('CLOUD_RESTORE_SMOKE_MARKER must be an absolute /tmp path');
const markerPath = resolve(markerArgument);
const markerRelativeToTmp = relative(tmpdir(), markerPath);
if (
  markerRelativeToTmp === '..' ||
  markerRelativeToTmp.startsWith(`..${sep}`) ||
  markerRelativeToTmp === ''
) {
  throw new Error('CLOUD_RESTORE_SMOKE_MARKER must be an isolated file below /tmp');
}
const ledgerBucket = required('GCS_LEDGER_BUCKET');
const ledgerPrefix = `ledger/verification/${smokeId}/`;
const marker = phase === 'prepare' ? undefined : await readMarker(markerPath);
if (marker !== undefined) assertMarker(marker);

const sourceAdminUrl = required('CLOUD_RESTORE_SOURCE_ADMIN_URL');
const sourceAppUrl = required('CLOUD_RESTORE_SOURCE_APP_URL');
const sourceWorkerUrl = required('CLOUD_RESTORE_SOURCE_WORKER_URL');
const cloneAdminUrl = phase === 'prepare' ? undefined : required('CLOUD_RESTORE_CLONE_ADMIN_URL');
const cloneAppUrl = phase === 'prepare' ? undefined : required('CLOUD_RESTORE_CLONE_APP_URL');
const cloneWorkerUrl = phase === 'prepare' ? undefined : required('CLOUD_RESTORE_CLONE_WORKER_URL');
assertSameDatabase(sourceAdminUrl, sourceAppUrl);
assertSameDatabase(sourceAdminUrl, sourceWorkerUrl);
if (cloneAdminUrl !== undefined) {
  assertSameDatabase(cloneAdminUrl, cloneAppUrl!);
  assertSameDatabase(cloneAdminUrl, cloneWorkerUrl!);
  assertDistinctDatabase(sourceAdminUrl, cloneAdminUrl);
  assertDistinctDatabase(sourceAppUrl, cloneAppUrl!);
  assertDistinctDatabase(sourceWorkerUrl, cloneWorkerUrl!);
}

const sourceAdmin = new Pool({ connectionString: sourceAdminUrl, max: 2 });
const sourceApp = createDatabase(sourceAppUrl, 3);
const sourceWorker = createDatabase(sourceWorkerUrl, 3);
const cloneAdmin =
  cloneAdminUrl === undefined ? undefined : new Pool({ connectionString: cloneAdminUrl, max: 2 });
const cloneApp = cloneAppUrl === undefined ? undefined : createDatabase(cloneAppUrl, 3);
const cloneWorker = cloneWorkerUrl === undefined ? undefined : createDatabase(cloneWorkerUrl, 3);
const forgetHmacKey = required('FORGET_HMAC_KEY');
const storageClient = await createStorageClient();
const ledger = new CloudDeletionLedger(
  GoogleCloudObjectBucket.forBucket(storageClient, ledgerBucket),
  { prefix: ledgerPrefix },
);
const results: Record<string, unknown> = { phase, smoke_id: smokeId };
let stage = 'configuration';
const startedAt = Date.now();

try {
  await Promise.all([
    assertNobypassRls(sourceApp),
    assertWorkerMember(sourceWorker),
    ...(cloneApp === undefined || cloneWorker === undefined
      ? []
      : [assertNobypassRls(cloneApp), assertWorkerMember(cloneWorker)]),
  ]);
  if (phase === 'prepare') await prepare();
  else if (phase === 'forget') await forgetSource();
  else await verifyClone();
  results['status'] = 'passed';
  results['elapsed_ms'] = Date.now() - startedAt;
  process.stdout.write(`${JSON.stringify(results)}\n`);
} catch (error) {
  results['status'] = 'failed';
  results['failed_stage'] = stage;
  results['error_code'] = safeErrorCode(error);
  results['elapsed_ms'] = Date.now() - startedAt;
  process.stderr.write(`${JSON.stringify(results)}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all([
    sourceApp.end(),
    sourceWorker.end(),
    sourceAdmin.end(),
    ...(cloneApp === undefined ? [] : [cloneApp.end()]),
    ...(cloneWorker === undefined ? [] : [cloneWorker.end()]),
    ...(cloneAdmin === undefined ? [] : [cloneAdmin.end()]),
  ]);
}

async function prepare(): Promise<void> {
  stage = 'empty-isolated-source-check';
  await assertEmptySource();
  stage = 'isolated-ledger-bootstrap';
  const head = await ledger.bootstrapEmpty(false);
  const sourceGovernance = new ForgetService(sourceApp, ledger, { hmacKey: forgetHmacKey });
  const initialized = await sourceGovernance.applyLedgerForRestore(sourceWorker);
  await sourceGovernance.verifyLedgerReadiness();
  if (initialized.replayed !== 0 || initialized.purged !== 0 || head.sequence !== 0) {
    throw new Error('isolated ledger did not initialize at an empty checkpoint');
  }

  stage = 'synthetic-source-seed';
  const userId = randomUUID();
  const scopeId = randomUUID();
  const principalId = randomUUID();
  const subject = `cloud-restore-smoke-${smokeId}`;
  const statement = `Memory isolated restore verification ${smokeId}`;
  await sourceAdmin.query('INSERT INTO users(id) VALUES ($1)', [userId]);
  await sourceAdmin.query(
    `INSERT INTO principals(id, user_id, issuer, subject, actor_kind)
     VALUES ($1, $2, 'https://memory.invalid/restore-smoke', $3, 'user')`,
    [principalId, userId, subject],
  );
  await sourceAdmin.query('INSERT INTO scopes(user_id, id, name) VALUES ($1, $2, $3)', [
    userId,
    scopeId,
    'disposable cloud restore smoke scope',
  ]);
  await sourceAdmin.query(
    `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
     VALUES ($1, $2, $3, ARRAY['read', 'write', 'admin'])`,
    [userId, scopeId, principalId],
  );
  const epochResult = await sourceAdmin.query<{ auth_epoch: string | number }>(
    'SELECT auth_epoch FROM scopes WHERE user_id=$1 AND id=$2',
    [userId, scopeId],
  );
  const authEpoch = epochResult.rows[0]?.auth_epoch;
  if (authEpoch === undefined) throw new Error('synthetic scope grant was not created');
  const actor = {
    userId,
    principalId,
    actorKind: 'user' as const,
    scopeIds: [scopeId],
    tokenScopeIds: [scopeId],
    capabilities: ['read', 'write', 'admin'] as const,
    authEpochs: { [scopeId]: Number(authEpoch) },
  };
  const core = new CoreService(
    sourceApp,
    new CursorCodec(
      'cloud-restore-smoke',
      new Map([['cloud-restore-smoke', Buffer.alloc(32, 17)]]),
    ),
    { forgetHmacKey },
  );
  const remembered = await core.remember(
    actor,
    {
      scope_id: scopeId,
      memory: {
        kind: 'fact',
        statement,
        context: { smoke_id: smokeId },
        subjects: [],
        evidence: [
          {
            source: {
              kind: 'explicit_remember',
              external_id: `cloud-restore-${smokeId}`,
              revision: '1',
              locator: 'cloud-restore-smoke/synthetic',
            },
            snippet: 'synthetic disposable restore fixture',
            snippet_allowed: true,
          },
        ],
      },
    },
    randomUUID(),
    `cloud-restore-remember-${smokeId}`,
  );
  const memoryId = (remembered['operations'] as Array<{ memory_ids: string[] }>)[0]?.memory_ids[0];
  if (memoryId === undefined) throw new Error('synthetic restore memory was not created');
  const persisted = await sourceAdmin.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$3',
    [userId, scopeId, memoryId],
  );
  if (persisted.rows[0]?.count !== '1')
    throw new Error('synthetic restore memory was not persisted');
  const nextMarker: Marker = {
    schema_version: 'memory.cloud-restore-smoke.v1',
    smoke_id: smokeId,
    ledger_bucket: ledgerBucket,
    ledger_prefix: ledgerPrefix,
    user_id: userId,
    scope_id: scopeId,
    principal_id: principalId,
    memory_id: memoryId,
    status: 'prepared',
  };
  await writeMarker(nextMarker, false);
  Object.assign(results, {
    isolated_ledger_bootstrapped: true,
    source_snapshot_ready: true,
    clone_required_before_forget: true,
  });
}

async function forgetSource(): Promise<void> {
  if (marker?.status !== 'prepared' && marker?.status !== 'forgetting') {
    throw new Error('restore marker is not in prepared state');
  }
  stage = 'source-fixture-check';
  const currentHead = await ledger.currentHead();
  if (marker.status === 'prepared' && currentHead.sequence !== 0) {
    throw new Error('isolated ledger has unexpected pre-Forget entries');
  }
  if (marker.status === 'prepared') await assertMemoryExists(sourceAdmin, marker);
  stage = 'source-forget';
  await writeMarker({ ...marker, status: 'forgetting' }, true);
  const sourceGovernance = new ForgetService(sourceApp, ledger, { hmacKey: forgetHmacKey });
  const actor = await userActor(sourceAdmin, marker);
  const previous = await sourceAdmin.query<{ id: string }>(
    `SELECT id FROM deletion_requests WHERE user_id=$1 AND scope_id=$2 AND principal_id=$3
       AND idempotency_key=$4 AND selector=$5::jsonb AND reason_code='user_requested'`,
    [
      marker.user_id,
      marker.scope_id,
      marker.principal_id,
      `cloud-restore-forget-${smokeId}`,
      JSON.stringify({ memory_ids: [marker.memory_id] }),
    ],
  );
  let requestId = previous.rows[0]?.id;
  if (requestId === undefined) {
    await assertMemoryExists(sourceAdmin, marker);
    const forgotten = await sourceGovernance.forget(
      actor,
      {
        scope_id: marker.scope_id,
        selector: { memory_ids: [marker.memory_id] },
        reason_code: 'user_requested',
      },
      `cloud-restore-forget-${smokeId}`,
    );
    if (forgotten['ledger_durable'] !== true || forgotten['content_available'] !== false) {
      throw new Error('Forget did not durably suppress the restore fixture');
    }
    const createdRequestId = forgotten['forget_request_id'];
    if (typeof createdRequestId !== 'string')
      throw new Error('Forget response omitted its request ID');
    requestId = createdRequestId;
  }
  stage = 'source-ledger-purge';
  const drained = await sourceGovernance.processPendingWorker(sourceWorker);
  await sourceGovernance.verifyLedgerReadiness();
  const sourceCount = await countFixtureContent(sourceAdmin, marker);
  const completedRequest = await sourceAdmin.query<{ status: string }>(
    'SELECT status FROM deletion_requests WHERE id=$1 AND user_id=$2 AND scope_id=$3',
    [requestId, marker.user_id, marker.scope_id],
  );
  if (
    drained.pending !== 0 ||
    completedRequest.rows[0]?.status !== 'complete' ||
    Object.values(sourceCount).some((count) => count !== '0')
  ) {
    throw new Error('source Forget did not finish the isolated ledger purge');
  }
  await writeMarker({ ...marker, status: 'forgotten', forget_request_id: requestId }, true);
  Object.assign(results, {
    source_ledger_sequence: (await ledger.currentHead()).sequence,
    source_purge_count: drained.purged,
    source_forget_completed: true,
  });
}

async function verifyClone(): Promise<void> {
  if (
    marker?.status !== 'forgotten' ||
    cloneAdmin === undefined ||
    cloneApp === undefined ||
    cloneWorker === undefined
  ) {
    throw new Error('restore marker or clone database is not ready for verification');
  }
  stage = 'pre-restore-snapshot-check';
  await assertMemoryExists(cloneAdmin, marker);
  const preRestoreCount = await countFixtureContent(cloneAdmin, marker);
  if (preRestoreCount['memories'] !== '1') {
    throw new Error('clone is not the expected pre-Forget database snapshot');
  }
  const cloneGovernance = new ForgetService(cloneApp, ledger, { hmacKey: forgetHmacKey });
  let failedClosed = false;
  try {
    await cloneGovernance.verifyLedgerReadiness();
  } catch (error) {
    if (!isExpectedRestoreCheckpointMismatch(error)) throw error;
    failedClosed = true;
  }
  if (!failedClosed)
    throw new Error('restore clone became ready before replaying the newer ledger');
  stage = 'restore-ledger-replay';
  const reconciled = await cloneGovernance.applyLedgerForRestore(cloneWorker);
  await cloneGovernance.verifyLedgerReadiness();
  if (reconciled.replayed < 1 || reconciled.purged < 1) {
    throw new Error('restore replay did not replay and purge the forgotten fixture');
  }
  const afterRestore = await countFixtureContent(cloneAdmin, marker);
  if (Object.values(afterRestore).some((count) => count !== '0')) {
    throw new Error('restore reconciliation left forgotten rows in the clone');
  }
  await writeMarker({ ...marker, status: 'restored' }, true);
  Object.assign(results, {
    clone_failed_closed_before_replay: true,
    clone_readiness_rejection: 'ledger_checkpoint_mismatch',
    ledger_entries_replayed: reconciled.replayed,
    forgotten_content_purged: reconciled.purged,
    clone_readiness_after_replay: 'ready',
  });
}

async function assertEmptySource(): Promise<void> {
  const result = await sourceAdmin.query<Record<string, string>>(
    `SELECT
       (SELECT count(*)::text FROM users) AS users,
       (SELECT count(*)::text FROM scopes) AS scopes,
       (SELECT count(*)::text FROM memories) AS memories,
       (SELECT count(*)::text FROM deletion_requests) AS deletion_requests,
       (SELECT count(*)::text FROM export_jobs) AS export_jobs,
       (SELECT count(*)::text FROM deletion_ledger_visibility_items) AS visibility_items,
       (SELECT count(*)::text FROM deletion_ledger_checkpoint
         WHERE sequence <> 0 OR entry_hash <> repeat('0', 64)
           OR head_generation <> 'uninitialized-local-ledger'
           OR visible_sequence <> 0 OR visible_entry_hash <> repeat('0', 64)
           OR visible_head_generation <> 'uninitialized-local-ledger') AS checkpoint_history`,
  );
  const row = result.rows[0];
  if (row === undefined || Object.values(row).some((value) => value !== '0')) {
    throw new Error('restore smoke requires an isolated empty source database');
  }
}

async function assertMemoryExists(pool: Pool, value: Marker): Promise<void> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$3',
    [value.user_id, value.scope_id, value.memory_id],
  );
  if (result.rows[0]?.count !== '1') throw new Error('restore fixture memory is absent');
}

async function countFixtureContent(pool: Pool, value: Marker): Promise<Record<string, string>> {
  const result = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*)::text FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$3) AS memories,
       (SELECT count(*)::text FROM memory_versions WHERE user_id=$1 AND scope_id=$2 AND memory_id=$3) AS versions,
       (SELECT count(*)::text FROM sources WHERE user_id=$1 AND scope_id=$2) AS sources,
       (SELECT count(*)::text FROM evidence WHERE user_id=$1 AND scope_id=$2) AS evidence,
       (SELECT count(*)::text FROM observations WHERE user_id=$1 AND scope_id=$2) AS observations`,
    [value.user_id, value.scope_id, value.memory_id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('restore content count query returned no result');
  return row;
}

async function userActor(pool: Pool, value: Marker) {
  const result = await pool.query<{ auth_epoch: string | number }>(
    'SELECT auth_epoch FROM scopes WHERE user_id=$1 AND id=$2',
    [value.user_id, value.scope_id],
  );
  const authEpoch = result.rows[0]?.auth_epoch;
  if (authEpoch === undefined) throw new Error('restore fixture grant is absent');
  return {
    userId: value.user_id,
    principalId: value.principal_id,
    actorKind: 'user' as const,
    scopeIds: [value.scope_id],
    tokenScopeIds: [value.scope_id],
    capabilities: ['read', 'write', 'admin'] as const,
    authEpochs: { [value.scope_id]: Number(authEpoch) },
  };
}

async function readMarker(path: string): Promise<Marker> {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('restore marker file is missing or not private');
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error('restore marker file is missing or unreadable');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('restore marker file is invalid');
  }
  if (value === null || typeof value !== 'object')
    throw new Error('restore marker file is invalid');
  const candidate = value as Partial<Marker>;
  for (const key of ['user_id', 'scope_id', 'principal_id', 'memory_id'] as const) {
    if (typeof candidate[key] !== 'string' || !isUuid(candidate[key])) {
      throw new Error('restore marker file is invalid');
    }
  }
  if (
    candidate.schema_version !== 'memory.cloud-restore-smoke.v1' ||
    typeof candidate.smoke_id !== 'string' ||
    typeof candidate.ledger_bucket !== 'string' ||
    typeof candidate.ledger_prefix !== 'string' ||
    !['prepared', 'forgetting', 'forgotten', 'restored'].includes(candidate.status ?? '')
  ) {
    throw new Error('restore marker file is invalid');
  }
  return candidate as Marker;
}

async function createStorageClient(): Promise<Storage> {
  const tokenPath = process.env['CLOUD_RESTORE_SMOKE_TOKEN_FILE'];
  if (tokenPath === undefined || tokenPath.length === 0) return new Storage();
  const metadata = await stat(tokenPath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('CLOUD_RESTORE_SMOKE_TOKEN_FILE must be a private regular file');
  }
  const accessToken = (await readFile(tokenPath, 'utf8')).trim();
  if (accessToken.length < 32 || /\s/.test(accessToken)) {
    throw new Error('CLOUD_RESTORE_SMOKE_TOKEN_FILE does not contain a valid access token');
  }
  const authClient = new OAuth2Client();
  authClient.setCredentials({
    access_token: accessToken,
    expiry_date: Date.now() + 50 * 60 * 1000,
  });
  return new Storage({ authClient });
}

function assertMarker(value: Marker): void {
  if (
    value.smoke_id !== smokeId ||
    value.ledger_bucket !== ledgerBucket ||
    value.ledger_prefix !== ledgerPrefix
  ) {
    throw new Error('restore marker does not match the selected isolated ledger namespace');
  }
}

async function writeMarker(value: Marker, replace: boolean): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const directory = await stat(dirname(markerPath));
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) {
    throw new Error('restore marker directory must be private');
  }
  if (replace) {
    const existing = await stat(markerPath).catch(() => undefined);
    if (existing !== undefined && (!existing.isFile() || (existing.mode & 0o077) !== 0)) {
      throw new Error('restore marker file must be private');
    }
  }
  const flags = replace ? 'w' : 'wx';
  await writeFile(markerPath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: flags,
  });
}

function assertDistinctDatabase(source: string, clone: string): void {
  let sourceUrl: URL;
  let cloneUrl: URL;
  try {
    sourceUrl = new URL(source);
    cloneUrl = new URL(clone);
  } catch {
    throw new Error('restore source and clone database URLs are invalid');
  }
  if (
    !['postgres:', 'postgresql:'].includes(sourceUrl.protocol) ||
    !['postgres:', 'postgresql:'].includes(cloneUrl.protocol) ||
    (sourceUrl.host === cloneUrl.host && sourceUrl.pathname === cloneUrl.pathname)
  ) {
    throw new Error('restore source and clone must be distinct disposable PostgreSQL databases');
  }
}

function assertSameDatabase(expected: string, actual: string): void {
  let expectedUrl: URL;
  let actualUrl: URL;
  try {
    expectedUrl = new URL(expected);
    actualUrl = new URL(actual);
  } catch {
    throw new Error('restore database URL is invalid');
  }
  if (expectedUrl.host !== actualUrl.host || expectedUrl.pathname !== actualUrl.pathname) {
    throw new Error('restore admin, app, and worker URLs must point to the same database');
  }
}

function readPhase(raw: string | undefined): Phase {
  if (raw === 'prepare' || raw === 'forget' || raw === 'verify') return raw;
  throw new Error('Usage: cloud-restore-clone-smoke.ts prepare|forget|verify');
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredUuid(name: string): string {
  const value = required(name);
  if (!isUuid(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = String(error.code);
    if (/^[A-Za-z0-9._-]{1,64}$/.test(value)) return value;
  }
  return error instanceof Error ? error.name : 'unknown';
}
