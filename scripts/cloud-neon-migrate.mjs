#!/usr/bin/env node
import {
  assertNobypassRls,
  assertWorkerMember,
  createDatabase,
  cutoverPrincipalIssuer,
  migrate,
} from '@memory/db';

const migrationUrl = requiredUrl('MIGRATION_DATABASE_URL');
const databaseName = requiredValue('DATABASE_NAME');
const roleSourcePrefix = requiredValue('DB_ROLE_SOURCE_PREFIX');
if (!/^[a-z][a-z0-9_]{0,20}$/.test(roleSourcePrefix)) {
  throw new Error('DB_ROLE_SOURCE_PREFIX is invalid');
}
const appDatabase = requiredRoleUrl('APP_DATABASE_URL', 'memory_app');
const workerDatabase = requiredRoleUrl('WORKER_DATABASE_URL', 'memory_worker_login');
const pool = createDatabase(migrationUrl.href, 2);
const migrationLockId = '701023242';
const helperRoleDefinitions = [
  { suffix: 'auth_lookup', bypassRls: true },
  { suffix: 'purge_executor', bypassRls: false },
  { suffix: 'authority_executor', bypassRls: false },
];
const targetHelperRoles = helperRoleDefinitions.map((role) => ({
  name: `memory_${role.suffix}`,
  bypassRls: role.bypassRls,
}));
let preparedHelperRoles = targetHelperRoles;
let lockClient;
let temporaryHelperSetup = false;
let issuerCutover;

try {
  lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1::bigint)', [migrationLockId]);
  await assertDatabaseTarget(lockClient);
  await assertExistingSchemaIsRecognized(lockClient);
  const alreadyRenamed = await hasGenericRoleMigration(lockClient);
  preparedHelperRoles = await chooseHelperRoles(lockClient, roleSourcePrefix, alreadyRenamed);
  await ensureHelperRoles(lockClient, preparedHelperRoles);
  await lockClient.query('CREATE SCHEMA IF NOT EXISTS app');
  temporaryHelperSetup = true;
  for (const role of preparedHelperRoles) {
    await lockClient.query(`GRANT ${role.name} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
    await lockClient.query(`GRANT USAGE, CREATE ON SCHEMA app TO ${role.name}`);
  }

  try {
    await migrate(pool, { roleSourcePrefix });
    await migrate(pool, { roleSourcePrefix });
  } finally {
    const currentHelperRoles = (await hasGenericRoleMigration(lockClient))
      ? targetHelperRoles
      : preparedHelperRoles;
    await removeTemporaryHelperPrivileges(lockClient, currentHelperRoles);
    temporaryHelperSetup = false;
  }

  const issuerCutoverAction = process.env['IDENTITY_ISSUER_CUTOVER_ACTION'];
  if (issuerCutoverAction !== undefined) {
    if (issuerCutoverAction !== 'rename-existing') {
      throw new Error('IDENTITY_ISSUER_CUTOVER_ACTION is invalid');
    }
    issuerCutover = await cutoverPrincipalIssuer(pool, {
      sourceIssuer: requiredValue('IDENTITY_ISSUER_SOURCE'),
      targetIssuer: requiredValue('IDENTITY_ISSUER_TARGET'),
      userPrincipalId: requiredValue('IDENTITY_USER_PRINCIPAL_ID'),
      userId: requiredValue('IDENTITY_USER_ID'),
      userSubjectId: requiredValue('IDENTITY_USER_SUBJECT_ID'),
      databaseAdminRole: requiredValue('IDENTITY_DATABASE_ADMIN_ROLE'),
    });
  }

  await assertHelperCleanup(lockClient, targetHelperRoles);
  await provisionLoginRole(lockClient, appDatabase, 'memory_app', false);
  await provisionLoginRole(lockClient, workerDatabase, 'memory_worker_login', true);
  await lockClient.query('GRANT memory_worker TO memory_worker_login');

  const appPool = createDatabase(appDatabase.url.href, 1);
  const workerPool = createDatabase(workerDatabase.url.href, 1);
  try {
    await assertNobypassRls(appPool);
    await assertNobypassRls(workerPool);
    await assertWorkerMember(workerPool);
  } finally {
    await appPool.end();
    await workerPool.end();
  }

  const versions = await lockClient.query('SELECT count(*)::int AS count FROM schema_migrations');
  process.stdout.write(
    `${JSON.stringify({
      status: 'migrated',
      migration_count: versions.rows[0]?.count ?? 0,
      reapply: 'passed',
      app_nonbypass: true,
      worker_nonbypass: true,
      worker_membership: true,
      helper_schema_create_revoked: true,
      helper_membership: 'inherit=false,set=true',
      ...(issuerCutover === undefined
        ? {}
        : {
            principal_issuer_cutover: {
              status: issuerCutover.status,
              principal_count: issuerCutover.principalCount,
              user_principal_id: issuerCutover.userPrincipalId,
              principal_ids_preserved: issuerCutover.principalIdsPreserved,
              grants_preserved: issuerCutover.grantsPreserved,
            },
          }),
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: 'cloud.neon.migration.failed',
      error_code: safeErrorCode(error),
      error_type: error instanceof Error ? error.name : 'unknown',
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  if (lockClient !== undefined) {
    try {
      if (temporaryHelperSetup) {
        const currentHelperRoles = (await hasGenericRoleMigration(lockClient))
          ? targetHelperRoles
          : preparedHelperRoles;
        await removeTemporaryHelperPrivileges(lockClient, currentHelperRoles);
      }
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [migrationLockId]);
    } catch {
      process.stderr.write(
        `${JSON.stringify({ event: 'cloud.neon.migration.cleanup.failed', error_code: 'cleanup_failed' })}\n`,
      );
      process.exitCode = 1;
    }
    lockClient.release();
  }
  await pool.end();
}

async function assertDatabaseTarget(client) {
  const result = await client.query('SELECT current_database() AS database');
  if (result.rows[0]?.database !== databaseName) {
    throw Object.assign(new Error('Unexpected migration database'), { code: 'WRONG_DATABASE' });
  }
}

async function assertExistingSchemaIsRecognized(client) {
  const result = await client.query(
    `SELECT tablename AS table_name FROM pg_catalog.pg_tables WHERE schemaname = 'public'`,
  );
  if (result.rowCount !== 0 && !result.rows.some((row) => row.table_name === 'schema_migrations')) {
    throw Object.assign(new Error('Nonempty database has no migration history'), {
      code: 'UNRECOGNIZED_SCHEMA',
    });
  }
}

async function hasGenericRoleMigration(client) {
  const table = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (table.rows[0]?.present !== true) return false;
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0040_generic_role_names.sql') AS applied",
  );
  return result.rows[0]?.applied === true;
}

async function ensureHelperRoles(client, roles) {
  for (const role of roles) {
    const existing = await client.query(
      `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole
       FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [role.name],
    );
    if (existing.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${role.name} NOLOGIN NOSUPERUSER ${role.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'} NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      continue;
    }
    const current = existing.rows[0];
    if (
      current === undefined ||
      current.rolsuper ||
      current.rolbypassrls !== role.bypassRls ||
      current.rolcanlogin ||
      current.rolcreatedb ||
      current.rolcreaterole
    ) {
      throw Object.assign(new Error('Existing helper role has unexpected attributes'), {
        code: 'UNSAFE_HELPER_ROLE',
      });
    }
  }
}

async function chooseHelperRoles(client, sourcePrefix, alreadyRenamed) {
  if (alreadyRenamed) return targetHelperRoles;
  const selected = [];
  for (const role of helperRoleDefinitions) {
    const sourceName = `${sourcePrefix}_${role.suffix}`;
    const targetName = `memory_${role.suffix}`;
    const result = await client.query(
      'SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])',
      [[sourceName, targetName]],
    );
    const names = new Set(result.rows.map((row) => row.rolname));
    if (names.has(sourceName) && names.has(targetName)) {
      throw Object.assign(new Error('Both source and target helper roles exist'), {
        code: 'ROLE_NAME_CONFLICT',
      });
    }
    selected.push({
      name: names.has(sourceName) ? sourceName : targetName,
      bypassRls: role.bypassRls,
    });
  }
  return selected;
}

async function removeTemporaryHelperPrivileges(client, roles) {
  let cleanupError;
  for (const role of roles) {
    try {
      await client.query(`REVOKE CREATE ON SCHEMA app FROM ${role.name}`);
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await client.query(`GRANT ${role.name} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
}

async function assertHelperCleanup(client, roles) {
  for (const role of roles) {
    const result = await client.query(
      `SELECT has_schema_privilege($1, 'app', 'CREATE') AS can_create,
         (SELECT count(*)::text
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
          JOIN pg_catalog.pg_roles member ON member.oid = m.member
          WHERE r.rolname = $1 AND member.rolname = current_user) AS membership_count,
         (SELECT bool_or(m.inherit_option)
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
          JOIN pg_catalog.pg_roles member ON member.oid = m.member
          WHERE r.rolname = $1 AND member.rolname = current_user) AS any_inherit,
         (SELECT bool_or(m.set_option)
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
          JOIN pg_catalog.pg_roles member ON member.oid = m.member
          WHERE r.rolname = $1 AND member.rolname = current_user) AS any_set`,
      [role.name],
    );
    if (
      result.rows[0]?.can_create !== false ||
      result.rows[0]?.membership_count === '0' ||
      result.rows[0]?.any_inherit !== false ||
      result.rows[0]?.any_set !== true
    ) {
      throw Object.assign(new Error('Temporary helper privileges remain'), {
        code: 'HELPER_PRIVILEGE_CLEANUP_FAILED',
      });
    }
  }
}

async function provisionLoginRole(client, connectionUrl, role, inherit) {
  const existing = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [role],
  );
  if (role === 'memory_app' && existing.rowCount === 0) {
    throw Object.assign(new Error('Application role was not created by the migrations'), {
      code: 'MISSING_APPLICATION_ROLE',
    });
  }
  if (role === 'memory_worker_login' && existing.rowCount === 0) {
    const statement = await client.query(
      `SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT', $1::text, $2::text) AS sql`,
      [role, connectionUrl.password],
    );
    await client.query(statement.rows[0].sql);
  } else {
    const current = existing.rows[0];
    if (current === undefined || current.rolsuper || current.rolbypassrls) {
      throw Object.assign(new Error('Existing runtime role is privileged'), {
        code: 'UNSAFE_RUNTIME_ROLE',
      });
    }
    const statement = await client.query(
      `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L ${inherit ? 'INHERIT' : 'NOINHERIT'}', $1::text, $2::text) AS sql`,
      [role, connectionUrl.password],
    );
    await client.query(statement.rows[0].sql);
  }
  const attributes = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit
     FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [role],
  );
  const created = attributes.rows[0];
  if (
    created === undefined ||
    created.rolsuper ||
    created.rolbypassrls ||
    !created.rolcanlogin ||
    created.rolcreatedb ||
    created.rolcreaterole ||
    created.rolinherit !== inherit
  ) {
    throw Object.assign(new Error('Runtime role attributes are unsafe'), {
      code: 'UNSAFE_RUNTIME_ROLE',
    });
  }
}

function requiredUrl(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.password.length === 0) {
    throw new Error(`${name} must be a PostgreSQL URL with a password`);
  }
  return parsed;
}

function requiredValue(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredRoleUrl(name, expectedUser) {
  const parsed = requiredUrl(name);
  if (decodeURIComponent(parsed.username) !== expectedUser) {
    throw Object.assign(new Error(`${name} has an unexpected database role`), {
      code: 'WRONG_RUNTIME_ROLE',
    });
  }
  const password = decodeURIComponent(parsed.password);
  if (password.length < 24) {
    throw Object.assign(new Error(`${name} password is too short`), {
      code: 'INVALID_RUNTIME_PASSWORD',
    });
  }
  return { url: parsed, password };
}

function safeErrorCode(error) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = error.code;
    if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  }
  return error instanceof Error ? error.name : 'unknown';
}
