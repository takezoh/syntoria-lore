import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { MapperNameMapping } from '../scripts/cloud-identity-config.mjs';
import { readCloudDeploymentConfig } from '../scripts/cloud-identity-config.mjs';
import type { MapperNameMaintenancePool } from '../scripts/keycloak-mapper-name-migrate.mjs';
import {
  captureMapperNameBaseline,
  configuredCutoverConfig,
  readMapperNameBaseline,
  runMapperNameCutover,
  writeMapperNameBaseline,
} from '../scripts/keycloak-mapper-name-migrate.mjs';

const identityImage = `registry.example.test/keycloak@sha256:${'a'.repeat(64)}`;
const maintenanceLockKey = '86753091234567';
const configDefinition = {
  database: 'memory_identity_test',
  keycloakVersion: '26.8.1',
  keycloakImage: identityImage,
  sourceRealm: 'legacy-memory',
  targetRealm: 'renamed-memory',
  realmId: '6a05f755-6ccf-486b-9e2b-05b0419f1c11',
  mappings: [
    mapping(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'legacy-memory:resource:api',
      'memory:resource:api',
      'legacy-memory-resource-audience',
      'memory-resource-audience',
      'oidc-audience-mapper',
    ),
    mapping(
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      'legacy-memory:resource:mcp:read',
      'memory:resource:mcp:read',
      'legacy-memory-resource-audience',
      'memory-resource-audience',
      'oidc-audience-mapper',
    ),
    mapping(
      '10000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000003',
      'legacy-memory:resource:mcp:write',
      'memory:resource:mcp:write',
      'legacy-memory-resource-audience',
      'memory-resource-audience',
      'oidc-audience-mapper',
    ),
    mapping(
      '10000000-0000-4000-8000-000000000004',
      '20000000-0000-4000-8000-000000000004',
      'legacy-memory:scope_ids',
      'memory:scope_ids',
      'legacy-memory-scope-ids',
      'memory-scope-ids',
      'oidc-usermodel-attribute-mapper',
    ),
  ],
};
const baseline = makeBaseline();
const config = { ...configDefinition, baseline };

describe('pinned Keycloak Liquibase lock state', () => {
  it.each([
    ['canonical single row', [{ id: 1, locked: false }]],
    [
      'pinned two-row state',
      [
        { id: 1, locked: false },
        { id: 1000, locked: false },
      ],
    ],
  ])('accepts the %s', async (_name, lockRows) => {
    const fixture = makeDatabase({ lockRows });
    await expect(
      captureMapperNameBaseline(fixture.targetPool, fixture.controlPool, configDefinition),
    ).rejects.toMatchObject({ code: 'KEYCLOAK_SCHEMA_VERSION_MISMATCH' });
    expect(fixture.calls).toContain('SELECT to_jsonb(r) AS row FROM public.realm r ORDER BY r.id');
  });

  it.each([
    ['an unknown ID', [{ id: 2, locked: false }]],
    [
      'duplicate IDs',
      [
        { id: 1, locked: false },
        { id: 1, locked: false },
      ],
    ],
    ['a held canonical lock', [{ id: 1, locked: true }]],
    [
      'a held pinned lock',
      [
        { id: 1, locked: false },
        { id: 1000, locked: true },
      ],
    ],
    [
      'an extra row',
      [
        { id: 1, locked: false },
        { id: 1000, locked: false },
        { id: 1001, locked: false },
      ],
    ],
    ['an empty table', []],
  ])('rejects %s', async (_name, lockRows) => {
    const fixture = makeDatabase({ lockRows });
    await expect(
      captureMapperNameBaseline(fixture.targetPool, fixture.controlPool, configDefinition),
    ).rejects.toMatchObject({ code: 'KEYCLOAK_SCHEMA_VERSION_MISMATCH' });
    expect(fixture.calls).not.toContain(
      'SELECT to_jsonb(r) AS row FROM public.realm r ORDER BY r.id',
    );
  });
});

describe('offline Keycloak mapper name maintenance', () => {
  it('requires the exact Keycloak version, an immutable image, and the configured mapper set', () => {
    const deployment = makeDeployment();
    expect(configuredCutoverConfig(deployment)).toEqual(configDefinition);

    deployment.identity.existing.keycloakVersion = '26.8.2';
    expect(() => configuredCutoverConfig(deployment)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CUTOVER_CONFIG' }),
    );
  });

  it('closes database admission before checking the locked schema and reopens after a failed precondition', async () => {
    const fixture = makeDatabase();
    await expect(
      runMapperNameCutover(fixture.targetPool, fixture.controlPool, config),
    ).rejects.toMatchObject({
      code: 'KEYCLOAK_SCHEMA_VERSION_MISMATCH',
    });

    expect(fixture.admissionChanges).toEqual([false, true]);
    expect(fixture.updates).toEqual([]);
    expect(fixture.calls).toContain('ROLLBACK');
    expect(fixture.calls).toContain(
      'SELECT id, locked FROM public.databasechangeloglock ORDER BY id',
    );
    expect(fixture.admitted).toBe(true);
    const closeIndex = fixture.calls.indexOf(
      'ALTER DATABASE "memory_identity_test" WITH ALLOW_CONNECTIONS false',
    );
    expect(
      fixture.calls
        .slice(0, closeIndex)
        .filter((call) => call === 'SELECT pg_backend_pid()::int AS pid'),
    ).toHaveLength(2);
  });

  it('refuses to start maintenance when another client remains connected', async () => {
    const fixture = makeDatabase({ otherSessions: 1 });
    await expect(
      runMapperNameCutover(fixture.targetPool, fixture.controlPool, config),
    ).rejects.toMatchObject({
      code: 'DATABASE_NOT_OFFLINE',
    });

    expect(fixture.admissionChanges).toEqual([false, true]);
    expect(fixture.updates).toEqual([]);
    expect(fixture.calls).not.toContain('BEGIN ISOLATION LEVEL SERIALIZABLE');
  });

  it('refuses a concurrent maintenance user before changing database admission', async () => {
    const fixture = makeDatabase({ lockUnavailable: true });
    await expect(
      runMapperNameCutover(fixture.targetPool, fixture.controlPool, config),
    ).rejects.toMatchObject({
      code: 'CUTOVER_ALREADY_RUNNING',
    });

    expect(fixture.admissionChanges).toEqual([]);
    expect(fixture.calls).not.toContain(
      'ALTER DATABASE "memory_identity_test" WITH ALLOW_CONNECTIONS false',
    );
  });

  it('requires deployment scope and mapper names to agree with the cutover mappings', () => {
    const deployment = makeDeployment();
    expect(configuredCutoverConfig(deployment, baseline)).toEqual(config);
    deployment.identity.migration.mapperNameCutover.mappings[0]!.targetMapperName = 'wrong-name';
    expect(() => configuredCutoverConfig(deployment, baseline)).toThrowError(
      expect.objectContaining({ code: 'CUTOVER_CONFIG_MISMATCH' }),
    );
  });

  it('reads PostgreSQL snake_case admission fields before validating the pinned baseline schema', async () => {
    const fixture = makeDatabase();
    await expect(
      captureMapperNameBaseline(fixture.targetPool, fixture.controlPool, configDefinition),
    ).rejects.toMatchObject({ code: 'KEYCLOAK_SCHEMA_VERSION_MISMATCH' });
    expect(fixture.calls).toContain('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
    expect(fixture.calls).toContain('ROLLBACK');
  });

  it('creates a private immutable baseline file and rejects permissive mode bits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-mapper-baseline-'));
    const path = join(directory, 'baseline.json');
    try {
      await writeMapperNameBaseline(path, baseline);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(readMapperNameBaseline(path)).resolves.toEqual(baseline);
      await chmod(path, 0o640);
      await expect(readMapperNameBaseline(path)).rejects.toMatchObject({
        code: 'BASELINE_FILE_PERMISSIONS',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unknown CLI options before opening a database connection', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/keycloak-mapper-name-migrate.mjs', '--typo'],
      {
        encoding: 'utf8',
        env: {},
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"error_code":"INVALID_COMMAND"');
  });
});

const pg18AdminUrl = process.env['IDENTITY_MAPPER_TEST_ADMIN_URL'];
const pg18SourceDatabase = process.env['IDENTITY_MAPPER_TEST_SOURCE_DATABASE'];

describe('PostgreSQL 18 mapper maintenance isolation', () => {
  it.skipIf(pg18AdminUrl === undefined)(
    'leaves a new unsupported disposable database unchanged and restores connection admission',
    async () => {
      if (pg18AdminUrl === undefined) throw new Error('Test database URL is required');
      const database = 'memory_mapper_cutover_test_20261018';
      const admin = new Pool({ connectionString: pg18AdminUrl, max: 1 });
      const controlPool = new Pool({ connectionString: pg18AdminUrl, max: 1 });
      const targetUrl = new URL(pg18AdminUrl);
      targetUrl.pathname = `/${database}`;
      let targetPool: Pool | undefined;
      let lockHolder;
      let created = false;
      try {
        const exists = await admin.query(
          'SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1',
          [database],
        );
        expect(exists.rowCount).toBe(0);
        await admin.query(`CREATE DATABASE "${database}"`);
        created = true;

        const schemaSetup = new Pool({ connectionString: targetUrl.toString(), max: 1 });
        await schemaSetup.query(
          'CREATE TABLE public.realm (id text PRIMARY KEY, name text NOT NULL)',
        );
        await schemaSetup.query('CREATE TABLE public.client (id text PRIMARY KEY)');
        await schemaSetup.query(
          'CREATE TABLE public.client_scope (id text PRIMARY KEY, name text NOT NULL, realm_id text NOT NULL)',
        );
        await schemaSetup.query(
          'CREATE TABLE public.protocol_mapper (id text PRIMARY KEY, client_scope_id text NOT NULL, name text NOT NULL, protocol text NOT NULL, protocol_mapper_name text NOT NULL)',
        );
        await schemaSetup.query(
          'CREATE TABLE public.protocol_mapper_config (protocol_mapper_id text NOT NULL, name text NOT NULL, value text NOT NULL)',
        );
        await schemaSetup.query(
          'CREATE TABLE public.databasechangelog (id text, author text, filename text, md5sum text, orderexecuted integer)',
        );
        await schemaSetup.query(
          'CREATE TABLE public.databasechangeloglock (id integer PRIMARY KEY, locked boolean NOT NULL)',
        );
        await schemaSetup.query(
          'INSERT INTO public.databasechangeloglock (id, locked) VALUES (1, false)',
        );
        await schemaSetup.end();
        targetPool = new Pool({ connectionString: targetUrl.toString(), max: 2 });

        lockHolder = await targetPool.connect();
        const lock = await lockHolder.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
          maintenanceLockKey,
        ]);
        expect(lock.rows[0]?.acquired).toBe(true);
        await expect(
          runMapperNameCutover(targetPool, controlPool, {
            ...configDefinition,
            database,
            baseline: makeBaseline({
              database,
              databaseOid: '0',
              serverVersionNum: 180000,
              systemIdentifier: '1',
            }),
          }),
        ).rejects.toMatchObject({ code: 'CUTOVER_ALREADY_RUNNING' });
        const stillAdmitted = await admin.query(
          'SELECT datallowconn FROM pg_catalog.pg_database WHERE datname = $1',
          [database],
        );
        expect(stillAdmitted.rows[0]?.datallowconn).toBe(true);
        await lockHolder.query('SELECT pg_advisory_unlock($1::bigint)', [maintenanceLockKey]);
        lockHolder.release();
        lockHolder = undefined;

        const identity = await admin.query(
          'SELECT d.datname AS database, d.oid::text AS database_oid, ' +
            "current_setting('server_version_num')::int AS server_version_num, " +
            '(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier ' +
            'FROM pg_catalog.pg_database d WHERE d.datname = $1',
          [database],
        );
        const identityRow = identity.rows[0];
        const fixtureConfig = {
          ...configDefinition,
          database,
          baseline: makeBaseline({
            database: identityRow?.database,
            databaseOid: identityRow?.database_oid,
            serverVersionNum: identityRow?.server_version_num,
            systemIdentifier: identityRow?.system_identifier,
          }),
        };

        await expect(
          runMapperNameCutover(targetPool, controlPool, fixtureConfig),
        ).rejects.toMatchObject({
          code: 'KEYCLOAK_SCHEMA_VERSION_MISMATCH',
        });

        const admission = await admin.query(
          'SELECT datallowconn FROM pg_catalog.pg_database WHERE datname = $1',
          [database],
        );
        expect(admission.rows[0]?.datallowconn).toBe(true);
        const canConnect = await targetPool.query('SELECT current_database() AS database');
        expect(canConnect.rows[0]?.database).toBe(database);
        const mapperRows = await targetPool.query(
          'SELECT count(*)::int AS count FROM public.protocol_mapper',
        );
        expect(mapperRows.rows[0]?.count).toBe(0);
      } finally {
        lockHolder?.release();
        if (targetPool !== undefined) await targetPool.end();
        await controlPool.end();
        if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        await admin.end();
      }
    },
  );

  it.skipIf(pg18AdminUrl === undefined || pg18SourceDatabase === undefined)(
    'captures the pinned Keycloak baseline, applies and retries all mapper names, reverses them, and stays closed after failed readback',
    async () => {
      if (pg18AdminUrl === undefined || pg18SourceDatabase === undefined) {
        throw new Error('Disposable Keycloak test database settings are required');
      }
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(pg18SourceDatabase)) {
        throw new Error('Disposable Keycloak source database name is invalid');
      }

      const database = `memory_mapper_positive_test_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: pg18AdminUrl, max: 1 });
      const targetUrl = new URL(pg18AdminUrl);
      targetUrl.pathname = `/${database}`;
      const targetPool = new Pool({ connectionString: targetUrl.toString(), max: 2 });
      const controlPool = new Pool({ connectionString: pg18AdminUrl, max: 1 });
      const baselineDirectory = await mkdtemp(join(tmpdir(), 'memory-mapper-positive-'));
      const baselinePath = join(baselineDirectory, 'baseline.json');
      let created = false;

      try {
        const existing = await admin.query(
          'SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1',
          [database],
        );
        expect(existing.rowCount).toBe(0);
        await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${pg18SourceDatabase}"`);
        created = true;

        const inheritedLockRows = await targetPool.query<{ id: number; locked: boolean }>(
          'SELECT id, locked FROM public.databasechangeloglock ORDER BY id',
        );
        expect(inheritedLockRows.rows).toEqual([
          { id: 1, locked: false },
          { id: 1000, locked: false },
        ]);

        const deployment = await readCloudDeploymentConfig();
        const existingIdentity = deployment.identity.existing as
          { keycloakVersion: string; keycloakImage: string } | undefined;
        if (existingIdentity === undefined) {
          throw new Error('Pinned Keycloak test image is missing');
        }
        const realmResult = await targetPool.query<{ id: string; name: string }>(
          'SELECT id, name FROM public.realm WHERE name = $1',
          ['renamed-memory'],
        );
        expect(realmResult.rowCount).toBe(1);
        const realm = realmResult.rows[0];
        if (realm === undefined) throw new Error('Disposable Keycloak realm is missing');

        const mapperResult = await targetPool.query<{
          scope_id: string;
          scope_name: string;
          realm_id: string;
          mapper_id: string;
          mapper_name: string;
          protocol: string;
          mapper_type: MapperNameMapping['mapperType'];
        }>(
          'SELECT s.id AS scope_id, s.name AS scope_name, s.realm_id, ' +
            'm.id AS mapper_id, m.name AS mapper_name, m.protocol, ' +
            'm.protocol_mapper_name AS mapper_type ' +
            'FROM public.client_scope s JOIN public.protocol_mapper m ' +
            'ON m.client_scope_id = s.id WHERE s.realm_id = $1 ' +
            'AND s.name LIKE $2 ORDER BY s.name',
          [realm.id, 'memory:%'],
        );
        expect(mapperResult.rows).toHaveLength(4);
        const mappings: MapperNameMapping[] = mapperResult.rows.map((row) => {
          const audienceMapper = row.mapper_type === 'oidc-audience-mapper';
          expect(row.protocol).toBe('openid-connect');
          expect(['oidc-audience-mapper', 'oidc-usermodel-attribute-mapper']).toContain(
            row.mapper_type,
          );
          expect(row.mapper_name).toBe(
            audienceMapper ? 'memory-resource-audience' : 'memory-scope-ids',
          );
          return {
            mapperId: row.mapper_id,
            scopeId: row.scope_id,
            sourceScopeName: row.scope_name.replace(/^memory:/, 'thymesis:'),
            targetScopeName: row.scope_name,
            sourceMapperName: audienceMapper ? 'thymesis-resource-audience' : 'thymesis-scope-ids',
            targetMapperName: row.mapper_name,
            mapperType: row.mapper_type,
          };
        });
        expect(
          mappings.filter((entry) => entry.mapperType === 'oidc-audience-mapper'),
        ).toHaveLength(3);
        expect(
          mappings.filter((entry) => entry.mapperType === 'oidc-usermodel-attribute-mapper'),
        ).toHaveLength(1);

        const definition = {
          database,
          keycloakVersion: existingIdentity.keycloakVersion,
          keycloakImage: existingIdentity.keycloakImage,
          sourceRealm: 'legacy-memory',
          targetRealm: realm.name,
          realmId: realm.id,
          mappings,
        };

        for (const mapping of mappings) {
          const updated = await targetPool.query(
            'UPDATE public.protocol_mapper SET name = $2 WHERE id = $1 AND name = $3',
            [mapping.mapperId, mapping.sourceMapperName, mapping.targetMapperName],
          );
          expect(updated.rowCount).toBe(1);
        }

        const captured = await captureMapperNameBaseline(targetPool, controlPool, definition);
        expect(captured.profile).toMatchObject({ keycloakVersion: '26.8.1', changelogCount: 237 });
        await expectPinnedLiquibaseLockRows(targetPool);
        await writeMapperNameBaseline(baselinePath, captured);
        expect((await stat(baselinePath)).mode & 0o777).toBe(0o600);
        const privateBaseline = await readMapperNameBaseline(baselinePath);
        expect(privateBaseline).toEqual(captured);
        const configWithBaseline = { ...definition, baseline: privateBaseline };

        const applied = await runMapperNameCutover(targetPool, controlPool, configWithBaseline);
        expect(applied).toMatchObject({ status: 'applied', updatedCount: 4, mapperCount: 4 });
        await expectIdentityRowsMatchBaseline(
          targetPool,
          privateBaseline,
          mappings,
          'targetMapperName',
        );

        const forwardRetry = await runMapperNameCutover(
          targetPool,
          controlPool,
          configWithBaseline,
        );
        expect(forwardRetry).toMatchObject({
          status: 'already-applied',
          updatedCount: 0,
          databaseAdmissionRestored: true,
        });

        const reversed = await runMapperNameCutover(
          targetPool,
          controlPool,
          configWithBaseline,
          'reverse',
        );
        expect(reversed).toMatchObject({
          status: 'applied',
          direction: 'reverse',
          updatedCount: 4,
        });
        await expectIdentityRowsMatchBaseline(
          targetPool,
          privateBaseline,
          mappings,
          'sourceMapperName',
        );

        const reverseRetry = await runMapperNameCutover(
          targetPool,
          controlPool,
          configWithBaseline,
          'reverse',
        );
        expect(reverseRetry).toMatchObject({ status: 'already-applied', updatedCount: 0 });
        await expectPinnedLiquibaseLockRows(targetPool);

        const unknownCommitResult = await runMapperNameCutover(
          commitAckLossPool(targetPool),
          controlPool,
          configWithBaseline,
        );
        expect(unknownCommitResult).toMatchObject({
          status: 'applied',
          updatedCount: 4,
          databaseAdmissionRestored: true,
        });
        await expectIdentityRowsMatchBaseline(
          targetPool,
          privateBaseline,
          mappings,
          'targetMapperName',
        );

        const unknownCommitRetry = await runMapperNameCutover(
          targetPool,
          controlPool,
          configWithBaseline,
        );
        expect(unknownCommitRetry).toMatchObject({ status: 'already-applied', updatedCount: 0 });

        const resetAfterUnknownCommit = await runMapperNameCutover(
          targetPool,
          controlPool,
          configWithBaseline,
          'reverse',
        );
        expect(resetAfterUnknownCommit).toMatchObject({ status: 'applied', updatedCount: 4 });
        await expectIdentityRowsMatchBaseline(
          targetPool,
          privateBaseline,
          mappings,
          'sourceMapperName',
        );

        await targetPool.query(
          'CREATE FUNCTION public.break_realm_after_mapper_commit() RETURNS trigger ' +
            'LANGUAGE plpgsql AS $$ BEGIN ' +
            "UPDATE public.realm r SET name = 'broken-memory' " +
            'FROM public.client_scope s WHERE s.id = NEW.client_scope_id AND r.id = s.realm_id; ' +
            'RETURN NEW; END $$',
        );
        await targetPool.query(
          'CREATE CONSTRAINT TRIGGER break_realm_after_mapper_commit ' +
            'AFTER UPDATE ON public.protocol_mapper DEFERRABLE INITIALLY DEFERRED ' +
            'FOR EACH ROW EXECUTE FUNCTION public.break_realm_after_mapper_commit()',
        );

        await expect(
          runMapperNameCutover(targetPool, controlPool, configWithBaseline),
        ).rejects.toMatchObject({ code: 'POST_COMMIT_READBACK_MISMATCH' });
        const closedAdmission = await admin.query(
          'SELECT datallowconn FROM pg_catalog.pg_database WHERE datname = $1',
          [database],
        );
        expect(closedAdmission.rows[0]?.datallowconn).toBe(false);
      } finally {
        await targetPool.end();
        await controlPool.end();
        if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        await admin.end();
        await rm(baselineDirectory, { recursive: true, force: true });
      }
    },
  );
});

async function expectIdentityRowsMatchBaseline(
  pool: Pool,
  baseline: Awaited<ReturnType<typeof captureMapperNameBaseline>>,
  mappings: MapperNameMapping[],
  expectedName: 'sourceMapperName' | 'targetMapperName',
) {
  const [realmRows, clientIds, clientScopeRows, protocolMapperRows, protocolMapperConfigRows] =
    await Promise.all([
      pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(r) AS row FROM public.realm r ORDER BY r.id',
      ),
      pool.query<{ id: string }>('SELECT id FROM public.client ORDER BY id'),
      pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(s) AS row FROM public.client_scope s ORDER BY s.id',
      ),
      pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(m) AS row FROM public.protocol_mapper m ORDER BY m.id',
      ),
      pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(c) AS row FROM public.protocol_mapper_config c ' +
          'ORDER BY c.protocol_mapper_id, c.name',
      ),
    ]);
  const mappingsById = new Map(mappings.map((mapping) => [mapping.mapperId, mapping]));
  const baselineNames = new Map(
    baseline.protocolMapperRows.map((row) => [String(row['id']), String(row['name'])]),
  );
  const normalizedMappers = protocolMapperRows.rows.map(({ row }) => {
    const id = String(row['id']);
    const mapping = mappingsById.get(id);
    if (mapping !== undefined) expect(row['name']).toBe(mapping[expectedName]);
    const baselineName = baselineNames.get(id);
    return baselineName === undefined ? row : { ...row, name: baselineName };
  });
  expect(realmRows.rows.map((entry) => entry.row)).toEqual(baseline.realmRows);
  expect(clientIds.rows.map((entry) => entry.id)).toEqual(baseline.clientIds);
  expect(clientScopeRows.rows.map((entry) => entry.row)).toEqual(baseline.clientScopeRows);
  expect(normalizedMappers).toEqual(baseline.protocolMapperRows);
  expect(protocolMapperConfigRows.rows.map((entry) => entry.row)).toEqual(
    baseline.protocolMapperConfigRows,
  );
}

async function expectPinnedLiquibaseLockRows(pool: Pool) {
  const lockRows = await pool.query<{ id: number; locked: boolean }>(
    'SELECT id, locked FROM public.databasechangeloglock ORDER BY id',
  );
  expect(lockRows.rows).toEqual([
    { id: 1, locked: false },
    { id: 1000, locked: false },
  ]);
}

function commitAckLossPool(pool: Pool): MapperNameMaintenancePool {
  let acknowledgementLost = false;
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params = []) {
          const result = await client.query(sql, params as never[]);
          if (sql.trim().toUpperCase() === 'COMMIT' && !acknowledgementLost) {
            acknowledgementLost = true;
            throw new Error('Simulated lost COMMIT acknowledgement');
          }
          return {
            rows: result.rows as Array<Record<string, unknown>>,
            rowCount: result.rowCount,
          };
        },
        release(error) {
          client.release(error);
        },
      };
    },
  };
}

function mapping(
  mapperId: string,
  scopeId: string,
  sourceScopeName: string,
  targetScopeName: string,
  sourceMapperName: string,
  targetMapperName: string,
  mapperType: MapperNameMapping['mapperType'],
) {
  return {
    mapperId,
    scopeId,
    sourceScopeName,
    targetScopeName,
    sourceMapperName,
    targetMapperName,
    mapperType,
  };
}

function makeBaseline(databaseIdentity = configIdentity()) {
  return {
    formatVersion: 1 as const,
    profile: {
      keycloakVersion: '26.8.1',
      keycloakImage: identityImage,
      schemaSha256: 'e6110f2958759111e8713fc7cda5e06189aac160348edf41262a81f8c108e36e',
      changelogSha256: 'c764ebca5b71992497066957e9edc700a7d3ab6dcbb0d6fe0823c74869f513f8',
      changelogCount: 237,
    },
    databaseIdentity,
    realmRows: [{ id: configDefinition.realmId, name: configDefinition.targetRealm }],
    clientIds: ['30000000-0000-4000-8000-000000000001'],
    clientScopeRows: configDefinition.mappings.map((entry) => ({
      id: entry.scopeId,
      name: entry.targetScopeName,
      realm_id: configDefinition.realmId,
    })),
    protocolMapperRows: configDefinition.mappings.map((entry) => ({
      id: entry.mapperId,
      name: entry.sourceMapperName,
      client_scope_id: entry.scopeId,
      protocol: 'openid-connect',
      protocol_mapper_name: entry.mapperType,
    })),
    protocolMapperConfigRows: [
      {
        protocol_mapper_id: configDefinition.mappings[0]!.mapperId,
        name: 'claim.name',
        value: 'sub',
      },
    ],
  };
}

function configIdentity() {
  return {
    database: configDefinition.database,
    databaseOid: '16384',
    serverVersionNum: 170000,
    systemIdentifier: '7423509298529633381',
  };
}

function makeDeployment() {
  return {
    identity: {
      database: configDefinition.database,
      existing: {
        keycloakVersion: configDefinition.keycloakVersion,
        keycloakImage: configDefinition.keycloakImage,
      },
      migration: {
        sourceRealm: configDefinition.sourceRealm,
        targetRealm: configDefinition.targetRealm,
        scopeRenames: configDefinition.mappings.map((entry) => [
          entry.sourceScopeName,
          entry.targetScopeName,
        ]),
        sourceAudienceMapperName: 'legacy-memory-resource-audience',
        targetAudienceMapperName: 'memory-resource-audience',
        sourceScopeIdsMapperName: 'legacy-memory-scope-ids',
        targetScopeIdsMapperName: 'memory-scope-ids',
        mapperNameCutover: {
          realmId: configDefinition.realmId,
          mappings: configDefinition.mappings.map((entry) => ({ ...entry })),
        },
      },
    },
  };
}

function makeDatabase(
  options: {
    otherSessions?: number;
    lockUnavailable?: boolean;
    lockRows?: Array<{ id: number; locked: boolean }>;
  } = {},
) {
  const calls: string[] = [];
  const updates: string[] = [];
  const admissionChanges: boolean[] = [];
  let admitted = true;
  let nextPid = 500;
  const databaseIdentity = configIdentity();
  const databaseIdentityRow = {
    database: databaseIdentity.database,
    database_oid: databaseIdentity.databaseOid,
    server_version_num: databaseIdentity.serverVersionNum,
    system_identifier: databaseIdentity.systemIdentifier,
  };

  function pool(kind: 'target' | 'control') {
    return {
      async connect() {
        return {
          async query(sql: string, params: unknown[] = []) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            calls.push(normalized);
            if (normalized === 'SELECT pg_backend_pid()::int AS pid') {
              return result([{ pid: nextPid++ }]);
            }
            if (normalized.startsWith('SELECT pg_try_advisory_lock')) {
              return result([{ acquired: options.lockUnavailable !== true }]);
            }
            if (normalized.startsWith('SELECT pg_advisory_unlock')) {
              return result([{ released: true }]);
            }
            if (normalized.startsWith('ALTER DATABASE')) {
              admitted = normalized.endsWith('true');
              admissionChanges.push(admitted);
              return result([]);
            }
            if (normalized.includes('pg_control_system()')) {
              return result([
                kind === 'target'
                  ? databaseIdentityRow
                  : { database: 'postgres', system_identifier: databaseIdentity.systemIdentifier },
              ]);
            }
            if (normalized.startsWith('SELECT d.datallowconn AS allow_connections')) {
              return result([
                { allow_connections: admitted, other_sessions: options.otherSessions ?? 0 },
              ]);
            }
            if (normalized === 'SELECT current_database() AS database') {
              return result([{ database: config.database }]);
            }
            if (
              normalized.startsWith('BEGIN') ||
              normalized === 'COMMIT' ||
              normalized === 'ROLLBACK' ||
              normalized.startsWith('SET ') ||
              normalized.startsWith('SET LOCAL ') ||
              normalized.startsWith('LOCK TABLE')
            ) {
              return result([]);
            }
            if (normalized.startsWith('SELECT table_name, column_name')) return result([]);
            if (normalized.startsWith('SELECT id, author, filename, md5sum')) return result([]);
            if (normalized.startsWith('SELECT id, locked FROM public.databasechangeloglock')) {
              return result(
                options.lockRows ?? [
                  { id: 1, locked: false },
                  { id: 1000, locked: false },
                ],
              );
            }
            if (normalized.startsWith('SELECT to_jsonb(r)')) return result(baseline.realmRows);
            if (normalized.startsWith('SELECT id FROM public.client')) return result([]);
            if (normalized.startsWith('SELECT to_jsonb(s)'))
              return result(baseline.clientScopeRows);
            if (normalized.startsWith('SELECT to_jsonb(m)'))
              return result(baseline.protocolMapperRows);
            if (normalized.startsWith('SELECT to_jsonb(c)')) {
              return result(baseline.protocolMapperConfigRows);
            }
            if (normalized.startsWith('UPDATE public.protocol_mapper')) {
              updates.push(String(params[0]));
              return result([{ id: params[0] }]);
            }
            throw new Error(`Unexpected query in test: ${normalized}`);
          },
          release() {},
        };
      },
    };
  }

  return {
    calls,
    updates,
    admissionChanges,
    get admitted() {
      return admitted;
    },
    targetPool: pool('target'),
    controlPool: pool('control'),
  };
}

function result<Row extends Record<string, unknown>>(rows: Row[]) {
  return { rows, rowCount: rows.length };
}
