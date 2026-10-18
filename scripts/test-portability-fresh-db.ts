import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  assertNobypassRls,
  assertWorkerMember,
  migrate,
  provisionApplicationRole,
  provisionWorkerRole,
} from '@memory/db';
import { CoreService, CursorCodec } from '@memory/domain';
import { LocalDeterministicEmbeddingProvider } from '@memory/curator';
import { RecallService } from '@memory/recall';
import { LocalPortabilityStore, PortabilityService } from '@memory/governance';
import { LEGACY_LOCAL_PORTABILITY_SIGNER_ID } from '@memory/contracts';
import type { ActorContext } from '@memory/contracts';

const adminTemplateUrl = required('TEST_ADMIN_URL');
const appTemplateUrl = required('TEST_APP_URL');
const roleSourcePrefix = required('DB_ROLE_SOURCE_PREFIX');
const adminTemplate = new URL(adminTemplateUrl);
const rootUrl = new URL(adminTemplateUrl);
rootUrl.pathname = '/postgres';
rootUrl.search = '';
const root = new Pool({ connectionString: rootUrl.toString(), max: 2 });
const sourceDatabase = `memory_service_portable_source_${randomUUID().replaceAll('-', '')}`;
const destinationDatabase = `memory_service_portable_target_${randomUUID().replaceAll('-', '')}`;
const portabilityDirectory = await mkdtemp(join(tmpdir(), 'memory-service-portability-fresh-'));
const masterKey = required('PORTABILITY_MASTER_KEY');
const hmacKey = required('FORGET_HMAC_KEY');
const workerPassword = 'memory_worker_local_test_only_20261014';
const appPassword = decodeURIComponent(new URL(appTemplateUrl).password);
const sourceOwnerId = randomUUID();
const sourceScopeId = randomUUID();
const destinationOwnerId = randomUUID();
const destinationScopeId = randomUUID();
const sourceSubject = `portability-source-${randomUUID()}`;
const destinationSubject = `portability-destination-${randomUUID()}`;
const issuer = 'https://memory-service.local.test/';
const sourceStatement = `Portable source history ${randomUUID()}`;
const destinationStatement = `${sourceStatement} revised`;
const externalIds = [`portable-fresh-${randomUUID()}-r1`, `portable-fresh-${randomUUID()}-r2`];
const openPools: Pool[] = [];
let sourceAdmin: Pool | undefined;
let sourceApp: Pool | undefined;
let sourceWorker: Pool | undefined;
let destinationAdmin: Pool | undefined;
let destinationApp: Pool | undefined;

try {
  await createDatabase(sourceDatabase);
  await createDatabase(destinationDatabase);
  sourceAdmin = openPool(databaseUrl(adminTemplate, sourceDatabase));
  destinationAdmin = openPool(databaseUrl(adminTemplate, destinationDatabase));
  await migrate(sourceAdmin, { roleSourcePrefix });
  await migrate(destinationAdmin, { roleSourcePrefix });
  for (const admin of [sourceAdmin, destinationAdmin]) {
    // PostgreSQL roles are cluster-wide. Provision serially while connecting to each
    // database so its migration grants and the shared login stay deterministic.
    await provisionApplicationRole(admin, appPassword);
    await provisionWorkerRole(admin, workerPassword);
  }

  sourceApp = openPool(databaseUrl(new URL(appTemplateUrl), sourceDatabase));
  destinationApp = openPool(databaseUrl(new URL(appTemplateUrl), destinationDatabase));
  sourceWorker = openPool(workerUrl(adminTemplate, sourceDatabase));
  await assertNobypassRls(sourceApp);
  await assertWorkerMember(sourceWorker);
  await assertNobypassRls(destinationApp);

  const sourcePrincipalId = await provisionOwner(
    sourceAdmin,
    sourceOwnerId,
    sourceScopeId,
    sourceSubject,
  );
  const destinationPrincipalId = await provisionOwner(
    destinationAdmin,
    destinationOwnerId,
    destinationScopeId,
    destinationSubject,
  );
  const sourceActor = await actorFor(sourceAdmin, sourceOwnerId, sourcePrincipalId, sourceScopeId);
  const destinationActor = await actorFor(
    destinationAdmin,
    destinationOwnerId,
    destinationPrincipalId,
    destinationScopeId,
  );
  const cursorCodec = new CursorCodec(
    'portability-fresh-db',
    new Map([['portability-fresh-db', Buffer.alloc(32, 41)]]),
  );
  const sourceCore = new CoreService(sourceApp, cursorCodec, { forgetHmacKey: hmacKey });
  const destinationCore = new CoreService(destinationApp, cursorCodec, {
    forgetHmacKey: hmacKey,
  });
  const sourceStore = new LocalPortabilityStore(
    join(portabilityDirectory, 'source'),
    masterKey,
    LEGACY_LOCAL_PORTABILITY_SIGNER_ID,
  );
  const destinationStore = new LocalPortabilityStore(
    join(portabilityDirectory, 'destination'),
    masterKey,
    LEGACY_LOCAL_PORTABILITY_SIGNER_ID,
  );
  const sourcePortability = new PortabilityService(sourceApp, sourceStore, { hmacKey });
  const destinationPortability = new PortabilityService(destinationApp, destinationStore, {
    hmacKey,
  });

  const created = await sourceCore.remember(
    sourceActor,
    {
      scope_id: sourceScopeId,
      memory: portableMemory(sourceStatement, externalIds[0]!),
    },
    randomUUID(),
    `portable-fresh-create-${randomUUID()}`,
  );
  const sourceMemoryId = firstMemoryId(created);
  const proposed = await sourceCore.proposeChangeSet(
    sourceActor,
    {
      scope_id: sourceScopeId,
      operations: [
        {
          op: 'REFINE',
          memory_id: sourceMemoryId,
          expected_revision: 1,
          statement: destinationStatement,
          evidence: [portableEvidence(externalIds[1]!)],
        },
      ],
    },
    randomUUID(),
    `portable-fresh-refine-${randomUUID()}`,
  );
  await sourceCore.commitProposedChangeSet(
    sourceActor,
    stringField(proposed, 'change_set_id'),
    randomUUID(),
    `portable-fresh-commit-${randomUUID()}`,
  );

  const sourceHistory = await sourceAdmin.query<{
    revision: number;
    recorded_at: string;
    source_id: string;
    evidence_id: string;
  }>(
    `SELECT v.revision, v.recorded_at::text AS recorded_at, s.id AS source_id, e.id AS evidence_id
     FROM memory_versions v
     JOIN memory_version_evidence mve ON mve.owner_id=v.owner_id AND mve.scope_id=v.scope_id
       AND mve.memory_id=v.memory_id AND mve.revision=v.revision
     JOIN evidence e ON e.owner_id=mve.owner_id AND e.scope_id=mve.scope_id AND e.id=mve.evidence_id
     JOIN sources s ON s.owner_id=e.owner_id AND s.scope_id=e.scope_id AND s.id=e.source_id
     WHERE v.owner_id=$1 AND v.scope_id=$2 AND v.memory_id=$3
     ORDER BY v.revision`,
    [sourceOwnerId, sourceScopeId, sourceMemoryId],
  );
  if (
    sourceHistory.rows.length !== 3 ||
    new Set(sourceHistory.rows.map((row) => row.revision)).size !== 2
  ) {
    throw new Error('Source fixture did not contain two revisions with preserved evidence links');
  }

  const exportRequest = await sourcePortability.requestExport(
    sourceActor,
    { scope_id: sourceScopeId },
    `portable-fresh-export-${randomUUID()}`,
  );
  const exportId = stringField(exportRequest, 'export_id');
  const exportWork = await sourcePortability.processPendingWorker(sourceWorker);
  if (exportWork.exports !== 1 || exportWork.failed !== 0)
    throw new Error('Fresh-database source export job did not complete');
  const exported = await sourcePortability.download(sourceActor, sourceScopeId, exportId);
  const imported = await destinationPortability.importBundle(
    destinationActor,
    {
      scope_id: destinationScopeId,
      encrypted_bundle: exported.bundle,
      grant_imported_sources: true,
    },
    `portable-fresh-import-${randomUUID()}`,
  );
  if (imported['state'] !== 'complete' || imported['imported_memories'] !== 1)
    throw new Error(`Fresh-database bundle import failed: ${JSON.stringify(imported)}`);
  const idMap = imported['id_map'];
  if (typeof idMap !== 'object' || idMap === null || Array.isArray(idMap))
    throw new Error('Fresh-database import returned no ID mapping');
  const mapped = idMap as Record<string, string>;
  const destinationMemoryId = mapped[`memories:${sourceMemoryId}`];
  if (typeof destinationMemoryId !== 'string' || destinationMemoryId === sourceMemoryId)
    throw new Error('Import did not map the source memory to a destination identity');

  const current = await destinationCore.getMemory(
    destinationActor,
    destinationScopeId,
    destinationMemoryId,
    {},
  );
  const attribution = current['attribution'] as Record<string, unknown> | undefined;
  if (
    current['statement'] !== destinationStatement ||
    current['revision'] !== 2 ||
    attribution?.['authority'] !== 'third_party_claim' ||
    attribution['actor_kind'] !== 'connector' ||
    !Array.isArray(current['evidence']) ||
    current['evidence'].length !== 2
  ) {
    throw new Error('Imported Get did not preserve history/evidence while downgrading authority');
  }
  const oldestRecordedAt = sourceHistory.rows[0]!.recorded_at;
  const historical = await destinationCore.getMemory(
    destinationActor,
    destinationScopeId,
    destinationMemoryId,
    { known_at: oldestRecordedAt },
  );
  if (historical['revision'] !== 1 || historical['statement'] !== sourceStatement)
    throw new Error('Fresh-database import did not preserve the first recorded history version');

  const destinationRecall = new RecallService(
    destinationApp,
    destinationCore,
    new LocalDeterministicEmbeddingProvider(),
  );
  const recalled = await destinationRecall.recall(destinationActor, {
    query: destinationStatement,
    scope_ids: [destinationScopeId],
    mode: 'precise',
    limit: 5,
  });
  const recallMatches = recalled['matches'];
  if (
    !Array.isArray(recallMatches) ||
    !recallMatches.some(
      (match) => typeof match === 'object' && match !== null && match['id'] === destinationMemoryId,
    )
  ) {
    throw new Error('Fresh-database Recall did not find the imported memory');
  }

  const targetMappings = await destinationAdmin.query<{
    version_count: string;
    source_count: string;
    evidence_count: string;
    provenance_owner: string;
    provenance_scope: string;
    first_revision_time: string;
    origin_authority: string;
    created_by: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM memory_versions v WHERE v.owner_id=$1 AND v.scope_id=$2 AND v.memory_id=$3) AS version_count,
       (SELECT count(DISTINCT s.id)::text FROM memory_version_evidence mve
         JOIN evidence e ON e.owner_id=mve.owner_id AND e.scope_id=mve.scope_id AND e.id=mve.evidence_id
         JOIN sources s ON s.owner_id=e.owner_id AND s.scope_id=e.scope_id AND s.id=e.source_id
         WHERE mve.owner_id=$1 AND mve.scope_id=$2 AND mve.memory_id=$3) AS source_count,
       (SELECT count(DISTINCT e.id)::text FROM memory_version_evidence mve
         JOIN evidence e ON e.owner_id=mve.owner_id AND e.scope_id=mve.scope_id AND e.id=mve.evidence_id
         WHERE mve.owner_id=$1 AND mve.scope_id=$2 AND mve.memory_id=$3) AS evidence_count,
       m.import_provenance->>'origin_owner_id' AS provenance_owner,
       m.import_provenance->>'origin_scope_id' AS provenance_scope,
       (SELECT v.recorded_at::text FROM memory_versions v WHERE v.owner_id=$1 AND v.scope_id=$2
         AND v.memory_id=$3 AND v.revision=1) AS first_revision_time,
       (SELECT v.origin_provenance->>'origin_authority' FROM memory_versions v
         WHERE v.owner_id=$1 AND v.scope_id=$2 AND v.memory_id=$3 AND v.revision=2) AS origin_authority,
       m.created_by::text AS created_by
     FROM memories m WHERE m.owner_id=$1 AND m.scope_id=$2 AND m.id=$3`,
    [destinationOwnerId, destinationScopeId, destinationMemoryId],
  );
  const mapping = targetMappings.rows[0];
  if (
    mapping?.version_count !== '2' ||
    mapping.source_count !== '2' ||
    mapping.evidence_count !== '2' ||
    mapping.provenance_owner !== sourceOwnerId ||
    mapping.provenance_scope !== sourceScopeId ||
    mapping.first_revision_time !== oldestRecordedAt ||
    mapping.created_by !== destinationPrincipalId
  ) {
    throw new Error(
      `Fresh-database import provenance/evidence mismatch: ${JSON.stringify(mapping)}`,
    );
  }
  const sourceMappingRows = await sourceAdmin.query<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM sources WHERE owner_id=$1 AND scope_id=$2 AND external_id=ANY($3::text[])
     ORDER BY external_id`,
    [sourceOwnerId, sourceScopeId, externalIds],
  );
  for (const row of sourceMappingRows.rows) {
    const targetId = mapped[`sources:${row.id}`];
    if (targetId === undefined || targetId === row.id)
      throw new Error('Import source mapping is missing or reuses the source identity');
    const destinationSource = await destinationAdmin.query<{ id: string; external_id: string }>(
      'SELECT id, external_id FROM sources WHERE owner_id=$1 AND scope_id=$2 AND id=$3',
      [destinationOwnerId, destinationScopeId, targetId],
    );
    if (destinationSource.rows[0]?.external_id !== row.external_id)
      throw new Error('Fresh-database source mapping does not preserve source identity metadata');
  }
  const targetChange = await destinationAdmin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM change_log
     WHERE owner_id=$1 AND scope_id=$2 AND memory_id=$3 AND op='IMPORT' AND memory_revision=2`,
    [destinationOwnerId, destinationScopeId, destinationMemoryId],
  );
  if (targetChange.rows[0]?.count !== '1')
    throw new Error('Fresh-database import did not record a destination import change event');
  const unrelatedSourceIds = await destinationAdmin.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM memories WHERE id=$1',
    [sourceMemoryId],
  );
  if (unrelatedSourceIds.rows[0]?.count !== '0')
    throw new Error('Fresh target database contained the source memory before ID mapping');

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        source_database: 'ephemeral_migrated_postgres_database',
        destination_database: 'independent_ephemeral_database_migrated_from_empty',
        api_role_nobypassrls: true,
        worker_role_nobypassrls: true,
        source_memory_id_mapped: sourceMemoryId !== destinationMemoryId,
        migrated: true,
        get_revision: current['revision'],
        get_evidence_rows: current['evidence'].length,
        recall_found: true,
        history_versions: mapping.version_count,
        source_mappings: sourceMappingRows.rowCount,
        evidence_mappings: mapping.evidence_count,
        provenance_preserved: mapping.provenance_owner === sourceOwnerId,
        authority_downgraded: attribution['authority'] === 'third_party_claim',
        origin_authority: mapping.origin_authority,
        source_recorded_at_preserved: true,
        import_change_event: true,
        paid_provider_calls: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(openPools.map((pool) => pool.end()));
  await root.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=ANY($1::text[])',
    [[sourceDatabase, destinationDatabase]],
  );
  await root.query(`DROP DATABASE IF EXISTS "${sourceDatabase}"`);
  await root.query(`DROP DATABASE IF EXISTS "${destinationDatabase}"`);
  await root.end();
  await rm(portabilityDirectory, { recursive: true, force: true });
}

async function createDatabase(name: string): Promise<void> {
  await root.query(`CREATE DATABASE "${name}"`);
}

function openPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 });
  openPools.push(pool);
  return pool;
}

function databaseUrl(template: URL, name: string): string {
  const url = new URL(template);
  url.pathname = `/${name}`;
  return url.toString();
}

function workerUrl(template: URL, name: string): string {
  const url = new URL(databaseUrl(template, name));
  url.username = 'memory_worker_login';
  url.password = workerPassword;
  return url.toString();
}

async function provisionOwner(
  admin: Pool,
  ownerId: string,
  scopeId: string,
  subject: string,
): Promise<string> {
  const principalId = randomUUID();
  await admin.query('INSERT INTO owners(id) VALUES ($1)', [ownerId]);
  await admin.query('INSERT INTO scopes(owner_id,id,name) VALUES ($1,$2,$3)', [
    ownerId,
    scopeId,
    `portable ${subject}`,
  ]);
  await admin.query(
    `INSERT INTO principals(id,owner_id,issuer,subject,actor_kind)
     VALUES ($1,$2,$3,$4,'owner')`,
    [principalId, ownerId, issuer, subject],
  );
  await admin.query(
    `INSERT INTO grants(owner_id,scope_id,principal_id,capabilities)
     VALUES ($1,$2,$3,ARRAY['read','write','admin'])`,
    [ownerId, scopeId, principalId],
  );
  return principalId;
}

async function actorFor(
  admin: Pool,
  ownerId: string,
  principalId: string,
  scopeId: string,
): Promise<ActorContext> {
  const result = await admin.query<{ auth_epoch: number | string }>(
    'SELECT auth_epoch FROM scopes WHERE owner_id=$1 AND id=$2',
    [ownerId, scopeId],
  );
  const epoch = result.rows[0]?.auth_epoch;
  if (epoch === undefined) throw new Error('Portable fixture owner scope was not provisioned');
  return {
    ownerId,
    principalId,
    actorKind: 'owner',
    scopeIds: [scopeId],
    tokenScopeIds: [scopeId],
    capabilities: ['read', 'write', 'admin'],
    authEpochs: { [scopeId]: Number(epoch) },
  };
}

function portableMemory(statement: string, externalId: string) {
  return {
    kind: 'fact',
    statement,
    context: { episode: { condition: { place: 'lab' }, action: 'stored', outcome: 'verified' } },
    subjects: [{ name: 'Portable Owner', aliases: [{ name: 'Source Maintainer' }] }],
    evidence: [portableEvidence(externalId)],
  };
}

function portableEvidence(externalId: string) {
  return {
    source: {
      kind: 'explicit_remember',
      external_id: externalId,
      revision: '1',
      locator: `notes/${externalId}`,
    },
    snippet: `Direct source evidence for ${externalId}`,
    snippet_allowed: true,
  };
}

function firstMemoryId(response: Record<string, unknown>): string {
  const operations = response['operations'];
  if (!Array.isArray(operations)) throw new Error('Source fixture Remember returned no operations');
  const ids = (operations[0] as Record<string, unknown> | undefined)?.['memory_ids'];
  if (!Array.isArray(ids) || typeof ids[0] !== 'string')
    throw new Error('Source fixture Remember returned no memory ID');
  return ids[0];
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') throw new Error(`Portable operation omitted ${field}`);
  return result;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
