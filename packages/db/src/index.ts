import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type { PoolClient, QueryResultRow };
export type Database = Pool;
export { withTemporarySuperuserAuthorization } from './local-session-authorization.js';
export function createDatabase(connectionString = process.env['DATABASE_URL'], max = 10): Pool {
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function withTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let discardConnection: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await options.beforeCommit?.(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      discardConnection =
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(discardConnection);
  }
}

export interface TransactionOptions {
  readonly beforeCommit?: (client: PoolClient) => Promise<void>;
}

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationLockId = '701023241';
const roleSuffixes = [
  'admin',
  'app',
  'auth_lookup',
  'authority_executor',
  'purge_executor',
  'worker',
  'worker_login',
  'identity',
] as const;

export interface MigrationOptions {
  readonly roleSourcePrefix?: string;
}

export async function migrate(pool: Pool, options: MigrationOptions = {}): Promise<void> {
  const client = await pool.connect();
  try {
    await migrateWithClient(client, options);
  } finally {
    client.release();
  }
}

export async function migrateWithClient(
  client: PoolClient,
  options: MigrationOptions = {},
): Promise<void> {
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [migrationLockId]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const names = (await readdir(migrationDirectory))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const roleMigration = '0040_generic_role_names.sql';
    const roleMigrationState = await client.query<{ applied: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS applied',
      [roleMigration],
    );
    if (roleMigrationState.rows[0]?.applied !== true) {
      const sourcePrefix = options.roleSourcePrefix;
      if (sourcePrefix === undefined || !/^[a-z][a-z0-9_]{0,20}$/.test(sourcePrefix)) {
        throw new Error('DB_ROLE_SOURCE_PREFIX is required to apply migration 0040');
      }
    }
    const historicalRoleTranslation = await historicalRoleTranslationForFreshDatabase(
      client,
      options.roleSourcePrefix,
    );
    for (const name of names) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [name],
      );
      if (existing.rowCount !== 0) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration ${name} has a different checksum`);
        }
        continue;
      }
      const sqlToApply =
        name < roleMigration ? translateHistoricalRoleNames(sql, historicalRoleTranslation) : sql;
      await client.query('BEGIN');
      try {
        if (name.startsWith('0040_')) {
          const roleSourcePrefix = options.roleSourcePrefix;
          if (roleSourcePrefix === undefined || !/^[a-z][a-z0-9_]{0,20}$/.test(roleSourcePrefix)) {
            throw new Error('DB_ROLE_SOURCE_PREFIX is required to apply migration 0040');
          }
          await client.query("SELECT set_config('memory.role_source_prefix', $1, true)", [
            roleSourcePrefix,
          ]);
        }
        await client.query(sqlToApply);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [migrationLockId]);
    }
  }
}

async function historicalRoleTranslationForFreshDatabase(
  client: PoolClient,
  sourcePrefix: string | undefined,
): Promise<ReadonlyMap<string, string>> {
  if (sourcePrefix === undefined || !/^[a-z][a-z0-9_]{0,20}$/.test(sourcePrefix)) return new Map();
  const migrationCount = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM schema_migrations',
  );
  const otherPublicTables = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_catalog.pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  const pristine =
    migrationCount.rows[0]?.count === '0' && otherPublicTables.rows[0]?.count === '0';
  const translation = new Map<string, string>();
  for (const suffix of roleSuffixes) {
    const sourceName = `${sourcePrefix}_${suffix}`;
    const targetName = `memory_${suffix}`;
    const roles = await client.query<{ rolname: string }>(
      'SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])',
      [[sourceName, targetName]],
    );
    const names = new Set(roles.rows.map((role) => role.rolname));
    const sourcePresent = names.has(sourceName);
    const targetPresent = names.has(targetName);
    if (sourcePresent && targetPresent) {
      throw new Error('Source and target database roles both exist before role migration');
    }
    // Roles are cluster-wide. Another database may already have applied 0040,
    // leaving this database's historical SQL behind while only target roles exist.
    // Existing migration rows make historical SQL replay unnecessary; 0040 will
    // translate this database's routine and policy text in place.
    if (pristine && targetPresent) translation.set(sourceName, targetName);
  }
  return translation;
}

function translateHistoricalRoleNames(
  sql: string,
  translation: ReadonlyMap<string, string>,
): string {
  let translated = sql;
  for (const [sourceName, targetName] of translation) {
    translated = translated.replaceAll(sourceName, targetName);
  }
  return translated;
}

export async function provisionApplicationRole(pool: Pool, password: string): Promise<void> {
  if (password.length < 24) throw new Error('APP_DB_PASSWORD must contain at least 24 characters');
  const result = await pool.query<{ statement: string }>(
    `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOINHERIT', $1::text, $2::text) AS statement`,
    ['memory_app', password],
  );
  const statement = result.rows[0]?.statement;
  if (statement === undefined) throw new Error('Unable to prepare application role statement');
  await pool.query(statement);
}

export async function provisionWorkerRole(pool: Pool, password: string): Promise<void> {
  if (password.length < 24)
    throw new Error('WORKER_DB_PASSWORD must contain at least 24 characters');
  const exists = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_worker_login') AS present`,
  );
  const formatted = await pool.query<{ statement: string }>(
    exists.rows[0]?.present === true
      ? `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS INHERIT', $1::text, $2::text) AS statement`
      : `SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS INHERIT', $1::text, $2::text) AS statement`,
    ['memory_worker_login', password],
  );
  const statement = formatted.rows[0]?.statement;
  if (statement === undefined) throw new Error('Unable to prepare worker role statement');
  await pool.query(statement);
  await pool.query('GRANT memory_worker TO memory_worker_login');
}

export async function assertWorkerMember(pool: Pool): Promise<void> {
  const result = await pool.query<{ worker: boolean; rolbypassrls: boolean; rolsuper: boolean }>(
    `SELECT pg_has_role(current_user, 'memory_worker', 'member') AS worker,
       r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const role = result.rows[0];
  if (role === undefined || !role.worker || role.rolbypassrls || role.rolsuper) {
    throw new Error(
      'Worker database role must inherit memory_worker without superuser or bypass-RLS privileges',
    );
  }
}

export async function assertNobypassRls(pool: Pool): Promise<void> {
  const result = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  const role = result.rows[0];
  if (role === undefined || role.rolbypassrls || role.rolsuper) {
    throw new Error('Database API role must be NOSUPERUSER and NOBYPASSRLS');
  }
}

export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}

export function readEpochs(
  rows: readonly { scope_id: string; auth_epoch: string | number }[],
): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.scope_id, Number(row.auth_epoch)]));
}

export function uuidArray(values: readonly string[]): string {
  return `{${values.join(',')}}`;
}

export interface DatabaseContext {
  readonly userId: string;
  readonly scopeIds: readonly string[];
  readonly principalId?: string;
  /** The compartments the transaction may read, or every compartment of the user. */
  readonly compartments: readonly string[] | 'all';
}

/**
 * Sets the transaction-local user, scope, principal and compartment context that row-level
 * security reads. Every transaction that sets this context goes through here. `'all'` is
 * resolved to the user's explicit compartment list, so the database never receives an
 * unrestricted value. Returns the compartment list that was set.
 */
export async function setDatabaseContext(
  client: PoolClient,
  context: DatabaseContext,
): Promise<readonly string[]> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
  await client.query("SELECT set_config('app.scope_ids', $1, true)", [
    uuidArray([...new Set(context.scopeIds)].sort()),
  ]);
  if (context.principalId !== undefined) {
    await client.query("SELECT set_config('app.principal_id', $1, true)", [context.principalId]);
  }
  const compartmentIds =
    context.compartments === 'all'
      ? ((
          await client.query<{ ids: string[] }>(
            'SELECT app.user_compartment_ids($1)::text[] AS ids',
            [context.userId],
          )
        ).rows[0]?.ids ?? [])
      : [...new Set(context.compartments)].sort();
  await client.query("SELECT set_config('app.compartment_ids', $1, true)", [
    uuidArray(compartmentIds),
  ]);
  return compartmentIds;
}

export function rowValue<T extends QueryResultRow, K extends keyof T>(
  row: T | undefined,
  key: K,
): T[K] | undefined {
  return row?.[key];
}
