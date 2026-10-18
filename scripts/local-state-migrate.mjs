#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  assertNobypassRls,
  assertWorkerMember,
  createDatabase,
  migrateWithClient,
  migrate,
  provisionApplicationRole,
  provisionWorkerRole,
  withTemporarySuperuserAuthorization,
} from '@memory/db';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(new URL('..', import.meta.url).pathname);
const config = JSON.parse(
  await readFile(new URL('../infra/local/state-migration.json', import.meta.url), 'utf8'),
);
const envFile = parseEnv(await readFile(new URL('../.env.local', import.meta.url), 'utf8'));
const source = config.source;
const target = config.target;
let databaseStarted = false;

try {
  requireConfirmation(process.argv.slice(2));
  requireSecret('LOCAL_DB_PASSWORD');
  requireSecret('APP_DB_PASSWORD');
  requireSecret('WORKER_DB_PASSWORD');
  await assertNoRunningVolumeUsers([
    ...Object.values(source.volumes),
    ...Object.values(target.volumes),
  ]);
  await copyVolumes();
  startCopiedDatabase();
  databaseStarted = true;
  await migrateCopiedDatabases();
  process.stdout.write(
    `${JSON.stringify({ status: 'migrated', databases: target.databases, volumes: target.volumes, sourcePreserved: true })}\n`,
  );
} finally {
  if (databaseStarted) stopCopiedDatabase();
}

async function copyVolumes() {
  for (const key of Object.keys(source.volumes)) {
    const sourceVolume = source.volumes[key];
    const targetVolume = target.volumes[key];
    ensureDockerVolumeExists(sourceVolume);
    if (dockerVolumeExists(targetVolume))
      throw new Error(`Target volume already exists: ${targetVolume}`);
    runDocker(['volume', 'create', '--name', targetVolume]);
    const argumentsForRun = [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '--mount',
      `type=volume,src=${sourceVolume},dst=/source,readonly`,
      '--mount',
      `type=volume,src=${targetVolume},dst=/target`,
      config.postgresImage,
    ];
    const sourceDigest = dockerOutput([
      ...argumentsForRun,
      '-ec',
      'tar --sort=name -C /source -cf - . | sha256sum | cut -d " " -f 1',
    ]);
    dockerOutput([
      ...argumentsForRun,
      '-ec',
      'tar --sort=name -C /source -cf - . | tar -C /target -xf -',
    ]);
    const targetDigest = dockerOutput([
      ...argumentsForRun,
      '-ec',
      'tar --sort=name -C /target -cf - . | sha256sum | cut -d " " -f 1',
    ]);
    if (!/^[a-f0-9]{64}$/.test(sourceDigest) || sourceDigest !== targetDigest) {
      throw new Error(`Volume verification failed for ${key}`);
    }
  }
}

function startCopiedDatabase() {
  compose(['up', '-d', 'db'], true);
}

function stopCopiedDatabase() {
  compose(['stop', 'db'], true);
}

async function migrateCopiedDatabases() {
  const password = requireSecret('LOCAL_DB_PASSWORD');
  const prefix = config.migrationPrefix;
  const sourceAdminUrl = databaseUrl(source.adminRole, password, source.databases.primary);
  const initial = createDatabase(sourceAdminUrl, 1);
  let roleOids;
  try {
    await waitForDatabase(initial);
    roleOids = await migrateSourceAdminWithoutRenamingSession(initial, prefix);
  } finally {
    await initial.end();
  }

  const adminUrl = databaseUrl(target.adminRole, password, source.databases.primary);
  const testDb = createDatabase(databaseUrl(target.adminRole, password, source.databases.test), 1);
  try {
    await migrate(testDb, { roleSourcePrefix: prefix });
    await migrate(testDb, { roleSourcePrefix: prefix });
  } finally {
    await testDb.end();
  }

  let primary = createDatabase(adminUrl, 1);
  try {
    await provisionApplicationRole(primary, requireSecret('APP_DB_PASSWORD'));
    await provisionWorkerRole(primary, requireSecret('WORKER_DB_PASSWORD'));
    await migrate(primary, { roleSourcePrefix: prefix });
    await verifyMigrationCount(primary, 40);
    await verifyRoleOids(primary, roleOids, prefix);
  } finally {
    await primary.end();
  }

  const maintenance = createDatabase(databaseUrl(target.adminRole, password, 'postgres'), 1);
  try {
    await renameDatabaseIfNeeded(maintenance, source.databases.test, target.databases.test);
    await renameDatabaseIfNeeded(maintenance, source.databases.primary, target.databases.primary);
  } finally {
    await maintenance.end();
  }

  primary = createDatabase(databaseUrl(target.adminRole, password, target.databases.primary), 1);
  const test = createDatabase(databaseUrl(target.adminRole, password, target.databases.test), 1);
  const app = createDatabase(
    databaseUrl('memory_app', requireSecret('APP_DB_PASSWORD'), target.databases.primary),
    1,
  );
  const worker = createDatabase(
    databaseUrl(
      'memory_worker_login',
      requireSecret('WORKER_DB_PASSWORD'),
      target.databases.primary,
    ),
    1,
  );
  try {
    await migrate(primary, { roleSourcePrefix: prefix });
    await migrate(test, { roleSourcePrefix: prefix });
    await verifyMigrationCount(primary, 40);
    await verifyMigrationCount(test, 40);
    await assertNobypassRls(app);
    await assertNobypassRls(worker);
    await assertWorkerMember(worker);
    await verifyRoleOids(primary, roleOids, prefix);
  } finally {
    await Promise.all([primary.end(), test.end(), app.end(), worker.end()]);
  }
}

async function migrateSourceAdminWithoutRenamingSession(pool, prefix) {
  const client = await pool.connect();
  try {
    const migrationCount = await client.query(
      'SELECT count(*)::int AS count FROM public.schema_migrations',
    );
    if (migrationCount.rows[0]?.count !== 39) {
      throw new Error('The copied local database must have exactly 39 verified source migrations');
    }
    return await withTemporarySuperuserAuthorization(client, async () => {
      const roleOids = await captureRoleOids(client, prefix);
      await migrateWithClient(client, { roleSourcePrefix: prefix });
      return roleOids;
    });
  } finally {
    client.release();
  }
}

async function captureRoleOids(pool, prefix) {
  const result = await pool.query(
    `SELECT rolname, oid::text AS oid FROM pg_catalog.pg_roles WHERE left(rolname, $1) = $2`,
    [prefix.length + 1, `${prefix}_`],
  );
  return new Map(result.rows.map((row) => [row.rolname.slice(prefix.length + 1), row.oid]));
}

async function verifyRoleOids(pool, sourceOids, prefix) {
  for (const [suffix, oid] of sourceOids) {
    const result = await pool.query(
      'SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname = $1',
      [`memory_${suffix}`],
    );
    if (result.rows[0]?.oid !== oid)
      throw new Error(`Database role identity changed for ${suffix}`);
  }
  for (const suffix of [
    'admin',
    'app',
    'auth_lookup',
    'authority_executor',
    'purge_executor',
    'worker',
    'worker_login',
    'identity',
  ]) {
    const stale = await pool.query(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS found',
      [`${prefix}_${suffix}`],
    );
    if (stale.rows[0]?.found === true)
      throw new Error(`Source database role remains for ${suffix}`);
  }
}

async function verifyMigrationCount(pool, expected) {
  const result = await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
  if (result.rows[0]?.count !== expected)
    throw new Error('Unexpected schema migration count after local state migration');
}

async function renameDatabaseIfNeeded(pool, sourceName, targetName) {
  validateIdentifier(sourceName);
  validateIdentifier(targetName);
  const result = await pool.query(
    'SELECT datname FROM pg_catalog.pg_database WHERE datname = ANY($1::text[])',
    [[sourceName, targetName]],
  );
  const names = new Set(result.rows.map((row) => row.datname));
  if (!names.has(sourceName) && names.has(targetName)) return;
  if (!names.has(sourceName) || names.has(targetName))
    throw new Error('Database rename precondition failed');
  const sessions = await pool.query(
    'SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE datname = $1',
    [sourceName],
  );
  if (sessions.rows[0]?.count !== 0) throw new Error('A source database still has active sessions');
  const statement = await pool.query(
    "SELECT format('ALTER DATABASE %I RENAME TO %I', $1::text, $2::text) AS sql",
    [sourceName, targetName],
  );
  await pool.query(statement.rows[0].sql);
}

async function waitForDatabase(pool) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }
  throw new Error('The copied local database did not become ready', { cause: lastError });
}

async function assertNoRunningVolumeUsers(volumes) {
  const sourceVolumeNames = new Set(Object.values(source.volumes));
  for (const volume of volumes) {
    if (!dockerVolumeExists(volume)) {
      if (sourceVolumeNames.has(volume))
        throw new Error(`Configured source volume is missing: ${volume}`);
      continue;
    }
    const running = spawnSync(
      'docker',
      ['ps', '--quiet', '--filter', 'status=running', '--filter', `volume=${volume}`],
      { encoding: 'utf8' },
    );
    if (running.error !== undefined) throw running.error;
    if (running.status !== 0) throw new Error('Unable to inspect active containers');
    if (running.stdout.trim().length > 0)
      throw new Error(`A running container uses volume ${volume}`);
  }
}

function ensureDockerVolumeExists(name) {
  if (!dockerVolumeExists(name)) throw new Error(`Configured source volume is missing: ${name}`);
}

function dockerVolumeExists(name) {
  const result = spawnSync('docker', ['volume', 'inspect', name], { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) return true;
  if (result.stderr.includes('no such volume')) return false;
  throw new Error('Unable to inspect Docker volumes');
}

function dockerOutput(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error('Docker volume copy or verification failed');
  return result.stdout.trim();
}

function runDocker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error('Docker volume preparation failed');
}

function compose(args, sourceConfig) {
  const files = ['--env-file', 'infra/local/deployment.env'];
  if (sourceConfig) files.push('--env-file', 'infra/local/migration-source.env');
  files.push('--env-file', '.env.local', '-f', 'compose.yaml');
  const result = spawnSync('docker', ['compose', ...files, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`Compose operation failed: ${args[0]}`);
}

function databaseUrl(user, password, database) {
  validateIdentifier(user);
  validateIdentifier(database);
  const url = new URL(`postgresql://127.0.0.1:55433/${database}`);
  url.username = user;
  url.password = password;
  return url.href;
}

function validateIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('A configured database identifier is invalid');
}

function parseEnv(content) {
  return Object.fromEntries(
    content.split(/\r?\n/).flatMap((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
}

function requireSecret(name) {
  const value = envFile[name];
  if (value === undefined || value.length < 24)
    throw new Error(`.env.local must contain a valid ${name}`);
  return value;
}

function requireConfirmation(args) {
  if (args.length !== 1 || args[0] !== '--confirm-stopped') {
    throw new Error('Usage: local-state-migrate.mjs --confirm-stopped');
  }
}
