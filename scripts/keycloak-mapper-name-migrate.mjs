#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { readCloudDeploymentConfig } from './cloud-identity-config.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE = /^[a-z][a-z0-9_]{0,62}$/;
const KEYCLOAK_VERSION = '26.8.1';
const KEYCLOAK_SCHEMA_SHA256 = 'e6110f2958759111e8713fc7cda5e06189aac160348edf41262a81f8c108e36e';
const KEYCLOAK_CHANGELOG_SHA256 =
  'c764ebca5b71992497066957e9edc700a7d3ab6dcbb0d6fe0823c74869f513f8';
const KEYCLOAK_CHANGELOG_COUNT = 237;
const SCHEMA_TABLES = ['client_scope', 'protocol_mapper', 'protocol_mapper_config', 'realm'];
const LOCK_TABLES =
  'public.realm, public.client, public.client_scope, public.protocol_mapper, ' +
  'public.protocol_mapper_config, public.databasechangelog, public.databasechangeloglock';
const STATEMENT_TIMEOUT_MS = 15000;
const LOCK_TIMEOUT_MS = 5000;
const IDLE_TRANSACTION_TIMEOUT_MS = 20000;
const MAINTENANCE_LOCK_KEY = '86753091234567';

export async function runMapperNameCutover(pool, controlPool, config, direction = 'forward') {
  validateConfig(config);
  validateDirection(direction);

  let target;
  const readbackReserve = [];
  let control;
  const maintenancePids = new Set();
  const clientPids = new Map();
  let maintenanceLockHeld = false;
  let admissionClosed = false;
  let leaveAdmissionClosed = false;
  try {
    target = await pool.connect();
    await setSessionTimeouts(target);
    await acquireMaintenanceLock(target);
    maintenanceLockHeld = true;
    readbackReserve.push(await pool.connect());
    for (const reserved of readbackReserve) await setSessionTimeouts(reserved);
    control = await controlPool.connect();
    await setSessionTimeouts(control);
    await assertDatabaseIdentity(target, control, config);
    clientPids.set(target, await readBackendPid(target));
    maintenancePids.add(clientPids.get(target));
    for (const reserved of readbackReserve) {
      const pid = await readBackendPid(reserved);
      clientPids.set(reserved, pid);
      maintenancePids.add(pid);
    }

    await setDatabaseAdmission(control, config.database, false);
    admissionClosed = true;
    await assertAdmissionClosed(target, config, [...maintenancePids]);

    let updateCount = 0;
    try {
      updateCount = await applyTransaction(target, config, direction, [...maintenancePids]);
    } catch (error) {
      if (error?.outcomeUnknown !== true) throw error;
      leaveAdmissionClosed = true;

      // COMMIT may have reached PostgreSQL even though its acknowledgement
      // did not reach us. Discard it and use the pre-admitted readback session;
      // admission stays closed throughout recovery.
      maintenancePids.delete(clientPids.get(target));
      clientPids.delete(target);
      target.release(failure('COMMIT_RESULT_UNKNOWN'));
      target = null;
      maintenanceLockHeld = false;
      let readback;
      try {
        target = readbackReserve.shift();
        if (target === undefined) fail('UNKNOWN_COMMIT_READBACK_FAILED');
        await acquireMaintenanceLock(target);
        maintenanceLockHeld = true;
        readback = await inspectReadback(target, config, direction, [...maintenancePids]);
      } catch {
        leaveAdmissionClosed = true;
        fail('UNKNOWN_COMMIT_READBACK_FAILED');
      }

      if (readback.sourceCount !== 0) {
        leaveAdmissionClosed = true;
        fail('UNKNOWN_COMMIT_UNRESOLVED');
      }
      updateCount = error.updateCount ?? 0;
    }

    leaveAdmissionClosed = true;
    await verifyReadback(target, config, direction, [...maintenancePids]);
    await setDatabaseAdmission(control, config.database, true);
    admissionClosed = false;
    leaveAdmissionClosed = false;
    return {
      status: updateCount === 0 ? 'already-applied' : 'applied',
      direction,
      mapperCount: config.mappings.length,
      updatedCount: updateCount,
      mapperIdsPreserved: true,
      mapperConfigsPreserved: true,
      databaseAdmissionRestored: true,
    };
  } catch (error) {
    if (admissionClosed && !leaveAdmissionClosed && control !== undefined) {
      try {
        await setDatabaseAdmission(control, config.database, true);
        admissionClosed = false;
      } catch {
        fail('DATABASE_ADMISSION_REOPEN_FAILED');
      }
    }
    throw error;
  } finally {
    if (target !== undefined && maintenanceLockHeld) {
      try {
        await releaseMaintenanceLock(target);
        maintenanceLockHeld = false;
      } catch {
        target.release(failure('CUTOVER_LOCK_RELEASE_FAILED'));
        target = null;
        if (!leaveAdmissionClosed) fail('CUTOVER_LOCK_RELEASE_FAILED');
      }
    }
    target?.release();
    for (const reserved of readbackReserve) reserved.release();
    control?.release();
  }
}

async function acquireMaintenanceLock(client) {
  let acquired;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
      MAINTENANCE_LOCK_KEY,
    ]);
    acquired = result.rows[0]?.acquired;
  } catch {
    fail('CUTOVER_LOCK_UNAVAILABLE');
  }
  if (acquired !== true) fail('CUTOVER_ALREADY_RUNNING');
}

async function releaseMaintenanceLock(client) {
  let released;
  try {
    const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [
      MAINTENANCE_LOCK_KEY,
    ]);
    released = result.rows[0]?.released;
  } catch {
    fail('CUTOVER_LOCK_RELEASE_FAILED');
  }
  if (released !== true) fail('CUTOVER_LOCK_RELEASE_FAILED');
}

export async function captureMapperNameBaseline(pool, controlPool, config) {
  validateCutoverDefinition(config);
  let target;
  let control;
  let transactionOpen = false;
  try {
    target = await pool.connect();
    control = await controlPool.connect();
    await setSessionTimeouts(target);
    await setSessionTimeouts(control);
    const databaseIdentity = await assertDatabaseIdentity(target, control, config);
    const admission = await readAdmissionState(target);
    if (admission.allow_connections !== true || admission.other_sessions !== 0) {
      fail('DATABASE_NOT_OFFLINE');
    }

    await target.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
    transactionOpen = true;
    await target.query('SET LOCAL statement_timeout = ' + STATEMENT_TIMEOUT_MS);
    await target.query('SET LOCAL lock_timeout = ' + LOCK_TIMEOUT_MS);
    await target.query(
      'SET LOCAL idle_in_transaction_session_timeout = ' + IDLE_TRANSACTION_TIMEOUT_MS,
    );
    await target.query('LOCK TABLE ' + LOCK_TABLES + ' IN SHARE MODE');
    const snapshot = await readSnapshot(target, config);
    validateCapturedIdentityRows(snapshot, config);
    await target.query('COMMIT');
    transactionOpen = false;
    return {
      formatVersion: 1,
      profile: {
        keycloakVersion: config.keycloakVersion,
        keycloakImage: config.keycloakImage,
        schemaSha256: KEYCLOAK_SCHEMA_SHA256,
        changelogSha256: KEYCLOAK_CHANGELOG_SHA256,
        changelogCount: KEYCLOAK_CHANGELOG_COUNT,
      },
      databaseIdentity,
      realmRows: snapshot.realmRows,
      clientIds: snapshot.clientIds,
      clientScopeRows: snapshot.clientScopeRows,
      protocolMapperRows: snapshot.protocolMapperRows,
      protocolMapperConfigRows: snapshot.protocolMapperConfigRows,
    };
  } catch (error) {
    if (transactionOpen && target !== undefined) {
      try {
        await target.query('ROLLBACK');
      } catch {
        // A read-only baseline transaction cannot have changed identity data.
      }
    }
    throw error;
  } finally {
    target?.release();
    control?.release();
  }
}

export function configuredCutoverConfig(deployment, baseline) {
  const identity = deployment?.identity;
  const migration = identity?.migration;
  const cutover = migration?.mapperNameCutover;
  if (
    !identity ||
    !migration ||
    !cutover ||
    !Array.isArray(cutover.mappings) ||
    !identity.existing
  ) {
    fail('CUTOVER_CONFIG_REQUIRED');
  }
  const config = {
    database: identity.database,
    keycloakVersion: identity.existing.keycloakVersion,
    keycloakImage: identity.existing.keycloakImage,
    sourceRealm: migration.sourceRealm,
    targetRealm: migration.targetRealm,
    realmId: cutover.realmId,
    mappings: cutover.mappings,
  };
  if (baseline !== undefined) config.baseline = baseline;
  validateCutoverDefinition(config);
  if (baseline !== undefined) validateConfig(config);

  for (const mapping of config.mappings) {
    const scopeMapping = migration.scopeRenames?.find(
      ([sourceName, targetName]) =>
        sourceName === mapping.sourceScopeName && targetName === mapping.targetScopeName,
    );
    if (scopeMapping === undefined) fail('CUTOVER_CONFIG_MISMATCH');
    const expectedNames =
      mapping.mapperType === 'oidc-audience-mapper'
        ? [migration.sourceAudienceMapperName, migration.targetAudienceMapperName]
        : [migration.sourceScopeIdsMapperName, migration.targetScopeIdsMapperName];
    if (
      mapping.sourceMapperName !== expectedNames[0] ||
      mapping.targetMapperName !== expectedNames[1]
    ) {
      fail('CUTOVER_CONFIG_MISMATCH');
    }
  }
  return config;
}

export async function readMapperNameBaseline(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) fail('BASELINE_FILE_REQUIRED');
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    fail('BASELINE_FILE_UNAVAILABLE');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    fail('BASELINE_FILE_PERMISSIONS');
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    fail('BASELINE_FILE_INVALID');
  }
}

export async function writeMapperNameBaseline(filePath, baseline) {
  if (typeof filePath !== 'string' || filePath.length === 0) fail('BASELINE_FILE_REQUIRED');
  try {
    await writeFile(filePath, JSON.stringify(baseline, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    fail('BASELINE_FILE_WRITE_FAILED');
  }
}

function isSupportedKeycloakLiquibaseLockState(rows) {
  if (!Array.isArray(rows)) return false;
  const canonicalRow = rows.length === 1 && rows[0]?.id === 1 && rows[0]?.locked === false;
  const pinnedKeycloakRows =
    rows.length === 2 &&
    rows[0]?.id === 1 &&
    rows[0]?.locked === false &&
    rows[1]?.id === 1000 &&
    rows[1]?.locked === false;
  return canonicalRow || pinnedKeycloakRows;
}

async function applyTransaction(client, config, direction, maintenancePids) {
  let transactionOpen = false;
  let writeAttempted = false;
  let updateCount = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    transactionOpen = true;
    await client.query('SET LOCAL statement_timeout = ' + STATEMENT_TIMEOUT_MS);
    await client.query('SET LOCAL lock_timeout = ' + LOCK_TIMEOUT_MS);
    await client.query(
      'SET LOCAL idle_in_transaction_session_timeout = ' + IDLE_TRANSACTION_TIMEOUT_MS,
    );
    await client.query('LOCK TABLE ' + LOCK_TABLES + ' IN ACCESS EXCLUSIVE MODE');
    await assertAdmissionClosed(client, config, maintenancePids);

    const before = await readSnapshot(client, config);
    updateCount = validateIdentityRows(before, config, direction);
    assertTargetNamesAvailable(before, config, direction);

    for (const mapping of effectiveMappings(config, direction)) {
      const current = before.protocolMapperRows.find((row) => row.id === mapping.mapperId);
      if (current?.name === mapping.targetMapperName) continue;
      writeAttempted = true;
      const updated = await client.query(
        'UPDATE public.protocol_mapper SET name = $2 ' +
          'WHERE id = $1 AND client_scope_id = $3 AND name = $4 ' +
          'AND protocol = $5 AND protocol_mapper_name = $6 RETURNING id',
        [
          mapping.mapperId,
          mapping.targetMapperName,
          mapping.scopeId,
          mapping.sourceMapperName,
          'openid-connect',
          mapping.mapperType,
        ],
      );
      if (updated.rowCount !== 1 || updated.rows[0]?.id !== mapping.mapperId) {
        fail('MAPPER_UPDATE_MISMATCH');
      }
    }

    const after = await readSnapshot(client, config);
    validateIdentityRows(after, config, direction, { requireTargets: true });
    assertTargetNamesAvailable(after, config, direction);
    try {
      await client.query('COMMIT');
      transactionOpen = false;
    } catch {
      const error = failure('COMMIT_RESULT_UNKNOWN');
      error.outcomeUnknown = true;
      error.updateCount = updateCount;
      throw error;
    }
    return updateCount;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        if (writeAttempted) {
          error.outcomeUnknown = true;
          error.updateCount = updateCount;
        }
      }
    }
    throw error;
  }
}

async function verifyReadback(client, config, direction, maintenancePids) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  try {
    await client.query('SET LOCAL statement_timeout = ' + STATEMENT_TIMEOUT_MS);
    await client.query('SET LOCAL lock_timeout = ' + LOCK_TIMEOUT_MS);
    await client.query(
      'SET LOCAL idle_in_transaction_session_timeout = ' + IDLE_TRANSACTION_TIMEOUT_MS,
    );
    await assertAdmissionClosed(client, config, maintenancePids);
    const snapshot = await readSnapshot(client, config);
    validateIdentityRows(snapshot, config, direction, { requireTargets: true });
    assertTargetNamesAvailable(snapshot, config, direction);
    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the sanitized readback failure.
    }
    fail('POST_COMMIT_READBACK_MISMATCH');
  }
}

async function inspectReadback(client, config, direction, maintenancePids) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  try {
    await client.query('SET LOCAL statement_timeout = ' + STATEMENT_TIMEOUT_MS);
    await client.query('SET LOCAL lock_timeout = ' + LOCK_TIMEOUT_MS);
    await client.query(
      'SET LOCAL idle_in_transaction_session_timeout = ' + IDLE_TRANSACTION_TIMEOUT_MS,
    );
    await assertAdmissionClosed(client, config, maintenancePids);
    const snapshot = await readSnapshot(client, config);
    const sourceCount = validateIdentityRows(snapshot, config, direction);
    assertTargetNamesAvailable(snapshot, config, direction);
    await client.query('COMMIT');
    return { sourceCount };
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the sanitized readback failure.
    }
    fail('UNKNOWN_COMMIT_READBACK_MISMATCH');
  }
}

async function assertDatabaseIdentity(target, control, config) {
  let targetIdentity;
  let controlIdentity;
  try {
    const targetResult = await target.query(
      'SELECT current_database() AS database, d.oid::text AS database_oid, ' +
        "current_setting('server_version_num')::int AS server_version_num, " +
        '(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier ' +
        'FROM pg_catalog.pg_database d WHERE d.datname = current_database()',
    );
    const controlResult = await control.query(
      'SELECT current_database() AS database, ' +
        '(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier',
    );
    targetIdentity = targetResult.rows[0];
    controlIdentity = controlResult.rows[0];
  } catch {
    fail('DATABASE_IDENTITY_UNAVAILABLE');
  }
  if (
    targetIdentity?.database !== config.database ||
    controlIdentity?.database === config.database ||
    targetIdentity?.system_identifier !== controlIdentity?.system_identifier
  ) {
    fail('DATABASE_IDENTITY_MISMATCH');
  }
  const actual = {
    database: targetIdentity.database,
    databaseOid: targetIdentity.database_oid,
    serverVersionNum: targetIdentity.server_version_num,
    systemIdentifier: targetIdentity.system_identifier,
  };
  if (
    config.baseline?.databaseIdentity !== undefined &&
    !equal(actual, config.baseline.databaseIdentity)
  ) {
    fail('DATABASE_IDENTITY_MISMATCH');
  }
  return actual;
}

async function readAdmissionState(client, maintenancePids = []) {
  try {
    const result = await client.query(
      'SELECT d.datallowconn AS allow_connections, ' +
        '(SELECT count(*)::int FROM pg_catalog.pg_stat_activity ' +
        'WHERE datname = current_database() AND pid <> pg_backend_pid() ' +
        "AND backend_type = 'client backend' AND NOT (pid = ANY($1::int[]))) AS other_sessions " +
        'FROM pg_catalog.pg_database d WHERE d.datname = current_database()',
      [maintenancePids],
    );
    if (result.rowCount !== 1) fail('DATABASE_ADMISSION_UNAVAILABLE');
    return result.rows[0];
  } catch {
    fail('DATABASE_ADMISSION_UNAVAILABLE');
  }
}

async function assertAdmissionClosed(client, config, maintenancePids = []) {
  const result = await readAdmissionState(client, maintenancePids);
  if (result.allow_connections !== false) fail('DATABASE_ADMISSION_NOT_CLOSED');
  if (result.other_sessions !== 0) fail('DATABASE_NOT_OFFLINE');
  const database = await client.query('SELECT current_database() AS database');
  if (database.rows[0]?.database !== config.database) fail('WRONG_DATABASE');
}

async function readBackendPid(client) {
  try {
    const result = await client.query('SELECT pg_backend_pid()::int AS pid');
    const pid = result.rows[0]?.pid;
    if (!Number.isInteger(pid)) fail('DATABASE_IDENTITY_UNAVAILABLE');
    return pid;
  } catch {
    fail('DATABASE_IDENTITY_UNAVAILABLE');
  }
}

async function setDatabaseAdmission(control, database, allowConnections) {
  if (!DATABASE.test(database)) fail('INVALID_CUTOVER_CONFIG');
  try {
    await control.query(
      'ALTER DATABASE "' + database + '" WITH ALLOW_CONNECTIONS ' + String(allowConnections),
    );
  } catch {
    fail(
      allowConnections ? 'DATABASE_ADMISSION_REOPEN_FAILED' : 'DATABASE_ADMISSION_ISOLATION_FAILED',
    );
  }
}

async function setSessionTimeouts(client) {
  try {
    await client.query('SET statement_timeout = ' + STATEMENT_TIMEOUT_MS);
    await client.query('SET lock_timeout = ' + LOCK_TIMEOUT_MS);
    await client.query('SET idle_in_transaction_session_timeout = ' + IDLE_TRANSACTION_TIMEOUT_MS);
  } catch {
    fail('TIMEOUT_CONFIGURATION_FAILED');
  }
}

async function readSnapshot(client, config) {
  let schema;
  let changelog;
  let lock;
  let realmRows;
  let clientIds;
  let clientScopeRows;
  let protocolMapperRows;
  let protocolMapperConfigRows;
  let databaseIdentity;
  try {
    const info = await client.query(
      'SELECT current_database() AS database, d.oid::text AS database_oid, ' +
        "current_setting('server_version_num')::int AS server_version_num, " +
        '(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier ' +
        'FROM pg_catalog.pg_database d WHERE d.datname = current_database()',
    );
    databaseIdentity = info.rows[0];
    const columns = await client.query(
      'SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, ordinal_position ' +
        "FROM information_schema.columns WHERE table_schema = 'public' " +
        'AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position',
      [SCHEMA_TABLES],
    );
    schema = columns.rows;
    const changes = await client.query(
      'SELECT id, author, filename, md5sum FROM public.databasechangelog ORDER BY orderexecuted',
    );
    changelog = changes.rows;
    const lockResult = await client.query(
      'SELECT id, locked FROM public.databasechangeloglock ORDER BY id',
    );
    lock = lockResult.rows;
  } catch {
    fail('KEYCLOAK_SCHEMA_UNAVAILABLE');
  }

  if (!isSupportedKeycloakLiquibaseLockState(lock)) {
    fail('KEYCLOAK_SCHEMA_VERSION_MISMATCH');
  }

  try {
    const realms = await client.query(
      'SELECT to_jsonb(r) AS row FROM public.realm r ORDER BY r.id',
    );
    realmRows = realms.rows.map((entry) => entry.row);
    const clients = await client.query('SELECT id FROM public.client ORDER BY id');
    clientIds = clients.rows.map((entry) => entry.id);
    const scopes = await client.query(
      'SELECT to_jsonb(s) AS row FROM public.client_scope s ORDER BY s.id',
    );
    clientScopeRows = scopes.rows.map((entry) => entry.row);
    const mappers = await client.query(
      'SELECT to_jsonb(m) AS row FROM public.protocol_mapper m ORDER BY m.id',
    );
    protocolMapperRows = mappers.rows.map((entry) => entry.row);
    const mapperConfig = await client.query(
      'SELECT to_jsonb(c) AS row FROM public.protocol_mapper_config c ' +
        'ORDER BY c.protocol_mapper_id, c.name',
    );
    protocolMapperConfigRows = mapperConfig.rows.map((entry) => entry.row);
  } catch {
    fail('KEYCLOAK_SCHEMA_UNAVAILABLE');
  }

  if (databaseIdentity?.database !== config.database) fail('WRONG_DATABASE');
  if (
    digest(schema) !== KEYCLOAK_SCHEMA_SHA256 ||
    digest(changelog) !== KEYCLOAK_CHANGELOG_SHA256 ||
    changelog.length !== KEYCLOAK_CHANGELOG_COUNT
  ) {
    fail('KEYCLOAK_SCHEMA_VERSION_MISMATCH');
  }
  return {
    databaseIdentity: {
      database: databaseIdentity.database,
      databaseOid: databaseIdentity.database_oid,
      serverVersionNum: databaseIdentity.server_version_num,
      systemIdentifier: databaseIdentity.system_identifier,
    },
    realmRows: sortRows(realmRows, 'id'),
    clientIds: [...clientIds].sort(),
    clientScopeRows: sortRows(clientScopeRows, 'id'),
    protocolMapperRows: sortRows(protocolMapperRows, 'id'),
    protocolMapperConfigRows: protocolMapperConfigRows,
  };
}

function validateIdentityRows(snapshot, config, direction, options = {}) {
  const baseline = config.baseline;
  if (
    !equal(snapshot.databaseIdentity, baseline.databaseIdentity) ||
    !equal(snapshot.realmRows, baseline.realmRows) ||
    !equal(snapshot.clientIds, baseline.clientIds) ||
    !equal(snapshot.clientScopeRows, baseline.clientScopeRows) ||
    !equal(snapshot.protocolMapperConfigRows, baseline.protocolMapperConfigRows) ||
    snapshot.protocolMapperRows.length !== baseline.protocolMapperRows.length
  ) {
    fail('IDENTITY_BASELINE_MISMATCH');
  }
  const mappings = effectiveMappings(config, direction);
  const mappingById = new Map(mappings.map((mapping) => [mapping.mapperId, mapping]));
  const baselineMappers = new Map(baseline.protocolMapperRows.map((row) => [row.id, row]));
  let sourceCount = 0;
  for (const current of snapshot.protocolMapperRows) {
    const expected = baselineMappers.get(current.id);
    if (expected === undefined) fail('MAPPER_BASELINE_MISMATCH');
    const mapping = mappingById.get(current.id);
    if (mapping === undefined) {
      if (!equal(current, expected)) fail('MAPPER_BASELINE_MISMATCH');
      continue;
    }
    const scope = snapshot.clientScopeRows.find((row) => row.id === mapping.scopeId);
    if (
      ![mapping.sourceMapperName, mapping.targetMapperName].includes(current.name) ||
      current.client_scope_id !== mapping.scopeId ||
      current.protocol !== 'openid-connect' ||
      current.protocol_mapper_name !== mapping.mapperType ||
      scope?.realm_id !== config.realmId ||
      scope?.name !== mapping.targetScopeName
    ) {
      fail('MAPPER_BASELINE_MISMATCH');
    }
    if (![mapping.sourceMapperName, mapping.targetMapperName].includes(expected.name)) {
      fail('MAPPER_BASELINE_MISMATCH');
    }
    const normalized = { ...current, name: expected.name };
    if (!equal(normalized, expected)) fail('MAPPER_BASELINE_MISMATCH');
    if (current.name === mapping.sourceMapperName) sourceCount += 1;
    if (options.requireTargets === true && current.name !== mapping.targetMapperName) {
      fail('MAPPER_READBACK_MISMATCH');
    }
  }
  const realm = snapshot.realmRows.find((row) => row.id === config.realmId);
  if (realm?.name !== config.targetRealm) fail('REALM_BASELINE_MISMATCH');
  if (
    sourceCount +
      mappings.filter((mapping) => {
        const current = snapshot.protocolMapperRows.find((row) => row.id === mapping.mapperId);
        return current?.name === mapping.targetMapperName;
      }).length !==
    mappings.length
  ) {
    fail('MAPPER_BASELINE_MISMATCH');
  }
  return sourceCount;
}

function validateCapturedIdentityRows(snapshot, config) {
  const realm = snapshot.realmRows.find((row) => row.id === config.realmId);
  if (realm?.name !== config.targetRealm) fail('REALM_BASELINE_MISMATCH');
  if (
    !hasUniqueIds(snapshot.realmRows) ||
    !hasUniqueIds(snapshot.clientIds) ||
    !hasUniqueIds(snapshot.clientScopeRows) ||
    !hasUniqueIds(snapshot.protocolMapperRows)
  ) {
    fail('INVALID_MAPPER_BASELINE');
  }
  for (const mapping of config.mappings) {
    const row = snapshot.protocolMapperRows.find((candidate) => candidate.id === mapping.mapperId);
    const scope = snapshot.clientScopeRows.find((candidate) => candidate.id === mapping.scopeId);
    if (
      row === undefined ||
      scope === undefined ||
      row.client_scope_id !== mapping.scopeId ||
      row.protocol !== 'openid-connect' ||
      row.protocol_mapper_name !== mapping.mapperType ||
      ![mapping.sourceMapperName, mapping.targetMapperName].includes(row.name) ||
      scope.realm_id !== config.realmId ||
      scope.name !== mapping.targetScopeName
    ) {
      fail('MAPPER_BASELINE_MISMATCH');
    }
  }
  assertTargetNamesAvailable(snapshot, config, 'forward');
}

function assertTargetNamesAvailable(snapshot, config, direction) {
  for (const mapping of effectiveMappings(config, direction)) {
    const conflict = snapshot.protocolMapperRows.find(
      (row) =>
        row.client_scope_id === mapping.scopeId &&
        row.name === mapping.targetMapperName &&
        row.id !== mapping.mapperId,
    );
    if (conflict !== undefined) fail('MAPPER_NAME_CONFLICT');
  }
}

function validateConfig(config) {
  validateCutoverDefinition(config);
  const baseline = config.baseline;
  if (
    !baseline ||
    baseline.formatVersion !== 1 ||
    baseline.profile?.keycloakVersion !== config.keycloakVersion ||
    baseline.profile?.keycloakImage !== config.keycloakImage ||
    baseline.profile?.schemaSha256 !== KEYCLOAK_SCHEMA_SHA256 ||
    baseline.profile?.changelogSha256 !== KEYCLOAK_CHANGELOG_SHA256 ||
    baseline.profile?.changelogCount !== KEYCLOAK_CHANGELOG_COUNT ||
    !baseline.databaseIdentity ||
    baseline.databaseIdentity.database !== config.database ||
    !/^\d+$/.test(baseline.databaseIdentity.databaseOid) ||
    !Number.isInteger(baseline.databaseIdentity.serverVersionNum) ||
    !/^\d+$/.test(baseline.databaseIdentity.systemIdentifier) ||
    !Array.isArray(baseline.realmRows) ||
    !Array.isArray(baseline.clientIds) ||
    !Array.isArray(baseline.clientScopeRows) ||
    !Array.isArray(baseline.protocolMapperRows) ||
    !Array.isArray(baseline.protocolMapperConfigRows)
  ) {
    fail('INVALID_MAPPER_BASELINE');
  }
  if (
    !hasUniqueIds(baseline.realmRows) ||
    !hasUniqueIds(baseline.clientIds) ||
    !hasUniqueIds(baseline.clientScopeRows) ||
    !hasUniqueIds(baseline.protocolMapperRows)
  ) {
    fail('INVALID_MAPPER_BASELINE');
  }
  const expectedMapperIds = new Set(config.mappings.map((mapping) => mapping.mapperId));
  if (
    !config.mappings.every((mapping) =>
      baseline.protocolMapperRows.some((row) => row.id === mapping.mapperId),
    )
  ) {
    fail('INVALID_MAPPER_BASELINE');
  }
  if (
    baseline.protocolMapperConfigRows.some(
      (row) => !baseline.protocolMapperRows.some((mapper) => mapper.id === row.protocol_mapper_id),
    ) ||
    [...expectedMapperIds].some((id) => !baseline.protocolMapperRows.some((row) => row.id === id))
  ) {
    fail('INVALID_MAPPER_BASELINE');
  }
}

function validateCutoverDefinition(config) {
  if (
    !config ||
    typeof config.database !== 'string' ||
    !DATABASE.test(config.database) ||
    config.keycloakVersion !== KEYCLOAK_VERSION ||
    typeof config.keycloakImage !== 'string' ||
    !/@sha256:[a-f0-9]{64}$/i.test(config.keycloakImage) ||
    !UUID.test(config.realmId) ||
    !isRealmSegment(config.sourceRealm) ||
    !isRealmSegment(config.targetRealm) ||
    config.sourceRealm === config.targetRealm ||
    config.targetRealm.toLowerCase() === 'master' ||
    !Array.isArray(config.mappings) ||
    config.mappings.length !== 4
  ) {
    fail('INVALID_CUTOVER_CONFIG');
  }
  const mapperIds = new Set();
  const scopeIds = new Set();
  for (const mapping of config.mappings) {
    if (
      !mapping ||
      !UUID.test(mapping.mapperId) ||
      !UUID.test(mapping.scopeId) ||
      mapperIds.has(mapping.mapperId) ||
      scopeIds.has(mapping.scopeId) ||
      !isResourceName(mapping.sourceScopeName) ||
      !isResourceName(mapping.targetScopeName) ||
      !isResourceName(mapping.sourceMapperName) ||
      !isResourceName(mapping.targetMapperName) ||
      mapping.sourceScopeName === mapping.targetScopeName ||
      mapping.sourceMapperName === mapping.targetMapperName ||
      !['oidc-audience-mapper', 'oidc-usermodel-attribute-mapper'].includes(mapping.mapperType)
    ) {
      fail('INVALID_CUTOVER_CONFIG');
    }
    mapperIds.add(mapping.mapperId);
    scopeIds.add(mapping.scopeId);
  }
  if (
    config.mappings.filter((mapping) => mapping.mapperType === 'oidc-audience-mapper').length !==
      3 ||
    config.mappings.filter((mapping) => mapping.mapperType === 'oidc-usermodel-attribute-mapper')
      .length !== 1
  ) {
    fail('INVALID_CUTOVER_CONFIG');
  }
}

function effectiveMappings(config, direction) {
  return config.mappings.map((mapping) =>
    direction === 'reverse'
      ? {
          ...mapping,
          sourceMapperName: mapping.targetMapperName,
          targetMapperName: mapping.sourceMapperName,
        }
      : mapping,
  );
}

function validateDirection(direction) {
  if (direction !== 'forward' && direction !== 'reverse') fail('INVALID_CUTOVER_CONFIG');
}

function hasUniqueIds(rows) {
  const ids = rows.map((row) => (typeof row === 'string' ? row : row?.id));
  return (
    ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length
  );
}

function sortRows(rows, key) {
  return [...rows].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function isRealmSegment(value) {
  return (
    typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
  );
}

function isResourceName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:._-]+$/.test(value);
}

function failure(code) {
  return Object.assign(new Error('Identity mapper name maintenance failed'), { code });
}

function fail(code) {
  throw failure(code);
}

async function runConfiguredCutover() {
  const args = process.argv.slice(2);
  const captureIndex = args.indexOf('--capture-baseline');
  const reverse = args.length === 1 && args[0] === '--reverse';
  const validCapture = args.length === 2 && args[0] === '--capture-baseline' && args[1].length > 0;
  if (
    (captureIndex === -1 && args.length !== 0 && !reverse) ||
    (captureIndex !== -1 && !validCapture)
  ) {
    fail('INVALID_COMMAND');
  }
  const databaseUrl = process.env['IDENTITY_DATABASE_URL'];
  const controlDatabaseUrl = process.env['IDENTITY_CONTROL_DATABASE_URL'];
  if (!databaseUrl || !controlDatabaseUrl) fail('DATABASE_URL_REQUIRED');
  const deployment = await readCloudDeploymentConfig();
  const baselineFile = captureIndex === -1 ? process.env['IDENTITY_MAPPER_BASELINE_FILE'] : args[1];
  if (captureIndex === -1 && !baselineFile) fail('BASELINE_FILE_REQUIRED');

  const pool = new Pool({ max: 2, connectionTimeoutMillis: 5000, connectionString: databaseUrl });
  const controlPool = new Pool({
    max: 1,
    connectionTimeoutMillis: 5000,
    connectionString: controlDatabaseUrl,
  });
  try {
    if (captureIndex !== -1) {
      const config = configuredCutoverConfig(deployment);
      const baseline = await captureMapperNameBaseline(pool, controlPool, config);
      await writeMapperNameBaseline(baselineFile, baseline);
      process.stdout.write('Mapper maintenance baseline captured.\n');
      return;
    }
    const baseline = await readMapperNameBaseline(baselineFile);
    const config = configuredCutoverConfig(deployment, baseline);
    const result = await runMapperNameCutover(
      pool,
      controlPool,
      config,
      reverse ? 'reverse' : 'forward',
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await Promise.all([pool.end(), controlPool.end()]);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await runConfiguredCutover();
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : 'UNKNOWN';
    process.stderr.write(JSON.stringify({ status: 'failed', error_code: code }) + '\n');
    process.exitCode = 1;
  }
}
