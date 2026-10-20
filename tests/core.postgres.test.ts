import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Authenticator } from '@memory/auth';
import { LEGACY_PORTABILITY_MIME_TYPE } from '@memory/contracts';
import {
  assertNobypassRls,
  assertWorkerMember,
  provisionWorkerRole,
  withTemporarySuperuserAuthorization,
  withTransaction,
} from '@memory/db';
import { CoreService, CursorCodec } from '@memory/domain';
import { ConnectorService } from '@memory/connectors';
import {
  LocalDeterministicCuratorProvider,
  LocalDeterministicEmbeddingProvider,
  type CuratorProvider,
} from '@memory/curator';
import { RecallService } from '@memory/recall';
import {
  CaptureJobProcessor,
  CurationReviewService,
  HttpTaskDispatcher,
  OutboxDispatcher,
} from '@memory/jobs';
import { createApiServer } from '../apps/api/src/server.js';
import { createWorkerServer } from '../apps/worker/src/server.js';
import {
  ForgetService,
  LocalDeletionLedger,
  LocalPortabilityStore,
  PortabilityService,
} from '@memory/governance';

const adminUrl = process.env['TEST_ADMIN_URL'];
const appUrl = process.env['TEST_APP_URL'];
const runPostgresTests = adminUrl !== undefined && appUrl !== undefined;
const forgetHmacKey = 'local-test-forget-hmac-key-with-32-bytes';

describe.skipIf(!runPostgresTests)('PostgreSQL local role migration handoff', () => {
  it('renames the connected superuser through a temporary authorization and preserves its OID', async () => {
    if (adminUrl === undefined) throw new Error('TEST_ADMIN_URL is required');
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    const suffix = randomUUID().replaceAll('-', '');
    const sourceRole = `memory_handoff_source_${suffix}`;
    const targetRole = `memory_handoff_target_${suffix}`;
    const password = `synthetic-${randomUUID()}`;
    let source: Pool | undefined;
    try {
      const current = await admin.query<{ is_superuser: boolean }>(
        `SELECT role.rolsuper AS is_superuser
         FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user`,
      );
      expect(current.rows[0]?.is_superuser).toBe(true);
      const createRole = await admin.query<{ sql: string }>(
        `SELECT format('CREATE ROLE %I WITH LOGIN SUPERUSER PASSWORD %L', $1::text, $2::text) AS sql`,
        [sourceRole, password],
      );
      await admin.query(createRole.rows[0]!.sql);
      source = new Pool({
        connectionString: connectionUrlForRole(adminUrl, sourceRole, password),
        max: 1,
      });
      const client = await source.connect();
      try {
        const before = await admin.query<{ oid: string }>(
          'SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname = $1',
          [sourceRole],
        );
        await withTemporarySuperuserAuthorization(client, async () => {
          const rename = await client.query<{ sql: string }>(
            `SELECT format('ALTER ROLE %I RENAME TO %I', $1::text, $2::text) AS sql`,
            [sourceRole, targetRole],
          );
          await client.query(rename.rows[0]!.sql);
        });
        const session = await client.query<{ session_user: string; current_user: string }>(
          'SELECT session_user, current_user',
        );
        expect(session.rows[0]).toEqual({ session_user: targetRole, current_user: targetRole });
        const after = await admin.query<{ oid: string; rolsuper: boolean; rolcanlogin: boolean }>(
          'SELECT oid::text AS oid, rolsuper, rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $1',
          [targetRole],
        );
        expect(after.rows[0]).toEqual({
          oid: before.rows[0]?.oid,
          rolsuper: true,
          rolcanlogin: true,
        });
      } finally {
        client.release();
      }
      const leakedRoles = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_catalog.pg_roles
         WHERE rolname LIKE 'memory_migrate_%'`,
      );
      expect(leakedRoles.rows[0]?.count).toBe('0');
    } finally {
      await source?.end();
      const cleanup = await admin.query<{ sql: string }>(
        `SELECT format('DROP ROLE IF EXISTS %I', role_name) AS sql
         FROM unnest($1::text[]) AS role_name`,
        [[sourceRole, targetRole]],
      );
      for (const row of cleanup.rows) await admin.query(row.sql);
      await admin.end();
    }
  });
});

describe.skipIf(!runPostgresTests)('PostgreSQL contract core', () => {
  const userId = randomUUID();
  const importedUserId = randomUUID();
  const scopeA = randomUUID();
  const scopeB = randomUUID();
  const importedScopeId = randomUUID();
  const issuer = 'http://127.0.0.1:9090/';
  const subject = `integration-${randomUUID()}`;
  const clientSubject = `integration-client-${randomUUID()}`;
  const recoveryUserSubject = `integration-recovery-owner-${randomUUID()}`;
  const importedUserSubject = `integration-import-owner-${randomUUID()}`;
  const importedReaderSubject = `integration-import-reader-${randomUUID()}`;
  const gateIssuer = 'https://gate.integration.test';
  const audience = 'memory-local-test';
  const mcpBaseUrl = 'http://127.0.0.1:8080';
  const mcpReadAudience = `${mcpBaseUrl}/mcp/read`;
  const mcpWriteAudience = `${mcpBaseUrl}/mcp/write`;
  let admin: Pool;
  let app: Pool;
  let workerDb: Pool;
  let server: ReturnType<typeof createApiServer>;
  let workerServer: ReturnType<typeof createWorkerServer>;
  let outboxDispatcher: OutboxDispatcher;
  let baseUrl: string;
  let principalId: string;
  let clientPrincipalId: string;
  let importedPrincipalId: string;
  let authenticator: Authenticator;
  let coreService: CoreService;
  let workerCore: CoreService;
  let workerRecall: RecallService;
  let governance: ForgetService;
  let portability: PortabilityService;
  let portabilityStore: LocalPortabilityStore;
  let deletionLedger: LocalDeletionLedger;
  let deletionLedgerDirectory: string;
  let portabilityDirectory: string;
  let workerTaskToken: string;
  let workerBaseUrl: string;
  const gateTokens = new Map<string, Record<string, unknown>>();
  const introspectionCount = new Map<string, number>();
  const gateFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${gateIssuer}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: gateIssuer,
        introspection_endpoint: `${gateIssuer}/oauth/introspect`,
      });
    }
    if (url === `${gateIssuer}/oauth/introspect`) {
      const body = new URLSearchParams(init?.body?.toString() ?? '');
      const tokenValue = body.get('token') ?? '';
      const data = gateTokens.get(tokenValue);
      const count = (introspectionCount.get(tokenValue) ?? 0) + 1;
      introspectionCount.set(tokenValue, count);
      if (data === undefined) return jsonResponse({ active: false });
      if (data['fail_on_call'] === count) throw new Error('synthetic Gate outage');
      return jsonResponse({
        ...data,
        active: data['active'] !== false && count < Number(data['revoke_on_call'] ?? Infinity),
      });
    }
    throw new Error(`Unexpected Gate verification URL ${url}`);
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 3 });
    app = new Pool({ connectionString: appUrl, max: 5 });
    if (adminUrl === undefined) throw new Error('TEST_ADMIN_URL is required');
    const workerPassword = 'memory_worker_local_test_only_20261014';
    await provisionWorkerRole(admin, workerPassword);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'memory_worker_login';
    workerUrl.password = workerPassword;
    workerDb = new Pool({ connectionString: workerUrl.toString(), max: 5 });
    await assertNobypassRls(app);
    await assertWorkerMember(workerDb);
    const hiddenWithoutContext = await app.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memories',
    );
    expect(hiddenWithoutContext.rows[0]!.count).toBe('0');
    const user = await admin.query<{ id: string }>(
      'INSERT INTO users(id) VALUES ($1), ($2) RETURNING id',
      [userId, importedUserId],
    );
    expect(user.rows[0]).toBeDefined();
    await admin.query('INSERT INTO scopes(user_id, id, name) VALUES ($1, $2, $3), ($1, $4, $5)', [
      userId,
      scopeA,
      'read-only',
      scopeB,
      'read-write',
    ]);
    await admin.query('INSERT INTO scopes(user_id, id, name) VALUES ($1, $2, $3)', [
      importedUserId,
      importedScopeId,
      'portable-import-destination',
    ]);
    const principal = await admin.query<{ id: string }>(
      `INSERT INTO principals(user_id, issuer, subject, actor_kind)
       VALUES ($1, $2, $3, 'user') RETURNING id`,
      [userId, issuer, subject],
    );
    principalId = principal.rows[0]!.id;
    const importedPrincipal = await admin.query<{ id: string }>(
      `INSERT INTO principals(user_id, issuer, subject, actor_kind)
       VALUES ($1, $2, $3, 'user') RETURNING id`,
      [importedUserId, issuer, importedUserSubject],
    );
    importedPrincipalId = importedPrincipal.rows[0]!.id;
    const importedReader = await admin.query<{ id: string }>(
      `INSERT INTO principals(user_id, issuer, subject, actor_kind)
       VALUES ($1, $2, $3, 'client') RETURNING id`,
      [importedUserId, issuer, importedReaderSubject],
    );
    await admin.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES ($1, $2, $3, ARRAY['read', 'write', 'admin'])`,
      [importedUserId, importedScopeId, importedPrincipalId],
    );
    await admin.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES ($1, $2, $3, ARRAY['read'])`,
      [importedUserId, importedScopeId, importedReader.rows[0]!.id],
    );
    const clientPrincipal = await admin.query<{ id: string }>(
      `INSERT INTO principals(user_id, issuer, subject, actor_kind)
       VALUES ($1, $2, $3, 'client') RETURNING id`,
      [userId, issuer, clientSubject],
    );
    clientPrincipalId = clientPrincipal.rows[0]!.id;
    const recoveryOwner = await admin.query<{ id: string }>(
      `INSERT INTO principals(user_id, issuer, subject, actor_kind)
       VALUES ($1, $2, $3, 'user') RETURNING id`,
      [userId, issuer, recoveryUserSubject],
    );
    await admin.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES ($1, $2, $3, ARRAY['read', 'write'])`,
      [userId, scopeB, recoveryOwner.rows[0]!.id],
    );
    await admin.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES ($1, $2, $3, ARRAY['read']), ($1, $4, $3, ARRAY['read', 'write', 'admin']),
              ($1, $4, $5, ARRAY['read', 'write'])`,
      [userId, scopeA, principalId, scopeB, clientPrincipalId],
    );

    const authConfig = {
      pool: app,
      issuer: gateIssuer,
      clientId: 'integration-api-resource',
      clientSecret: 'synthetic-api-resource-secret',
      fetch: gateFetch,
    } as const;
    authenticator = new Authenticator({
      ...authConfig,
      audience,
    });
    const mcpReadAuth = new Authenticator({
      ...authConfig,
      audience: mcpReadAudience,
      clientId: 'integration-mcp-read-resource',
      clientSecret: 'synthetic-mcp-read-secret',
    });
    const mcpWriteAuth = new Authenticator({
      ...authConfig,
      audience: mcpWriteAudience,
      clientId: 'integration-mcp-write-resource',
      clientSecret: 'synthetic-mcp-write-secret',
    });
    const cursorKey = Buffer.alloc(32, 7);
    const cursorCodec = new CursorCodec('test', new Map([['test', cursorKey]]));
    coreService = new CoreService(app, cursorCodec, { forgetHmacKey });
    workerCore = new CoreService(workerDb, cursorCodec);
    const embeddings = new LocalDeterministicEmbeddingProvider();
    const apiRecall = new RecallService(app, coreService, embeddings);
    const connectorService = new ConnectorService(app, { modelId: 'local-fake-v1', forgetHmacKey });
    const reviewService = new CurationReviewService(app, coreService);
    deletionLedgerDirectory = await mkdtemp(join(tmpdir(), 'memory-governance-it-'));
    await LocalDeletionLedger.createEmpty(deletionLedgerDirectory);
    deletionLedger = new LocalDeletionLedger(deletionLedgerDirectory);
    const unresolvedDeletions = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM deletion_requests
       WHERE status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging')`,
    );
    if (unresolvedDeletions.rows[0]?.count !== '0')
      throw new Error('PostgreSQL integration fixture contains unresolved Forget requests');
    // Each integration run gets a new ephemeral ledger directory. Reset the local fixture
    // checkpoint only after proving no forgotten content is awaiting reconciliation.
    await admin.query('DELETE FROM deletion_ledger_visibility_items');
    const emptyLedgerHead = await deletionLedger.currentHead();
    await admin.query(
      `UPDATE deletion_ledger_checkpoint SET sequence=0, entry_hash=repeat('0',64),
      head_generation=$1, visible_sequence=0, visible_entry_hash=repeat('0',64),
      visible_head_generation=$1, updated_at=clock_timestamp() WHERE singleton`,
      [emptyLedgerHead.head_generation],
    );
    governance = new ForgetService(app, deletionLedger, { hmacKey: forgetHmacKey });
    portabilityDirectory = await mkdtemp(join(tmpdir(), 'memory-portability-it-'));
    portabilityStore = new LocalPortabilityStore(
      portabilityDirectory,
      'local-test-portability-master-key-32-bytes-minimum',
      'integration-test-signer',
    );
    portability = new PortabilityService(app, portabilityStore, { hmacKey: forgetHmacKey });
    await governance.processPendingWorker(workerDb);
    await governance.verifyLedgerReadiness();
    server = createApiServer({
      auth: authenticator,
      mcpReadAuth,
      mcpWriteAuth,
      mcpAuthorizationServerUrl: gateIssuer,
      mcpResourceBaseUrl: mcpBaseUrl,
      apiAllowedOrigins: ['https://app.integration.test'],
      core: coreService,
      connectors: connectorService,
      recall: apiRecall,
      reviews: reviewService,
      governance,
      portability,
      ready: () => governance.verifyLedgerReadiness(),
      rateLimit: 10_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiAddress = server.address();
    if (apiAddress === null || typeof apiAddress === 'string')
      throw new Error('API test server did not bind');
    baseUrl = `http://127.0.0.1:${apiAddress.port}`;

    workerRecall = new RecallService(workerDb, workerCore, embeddings);
    const processor = new CaptureJobProcessor(
      workerDb,
      workerCore,
      workerRecall,
      new LocalDeterministicCuratorProvider(),
      { leaseSeconds: 120 },
    );
    workerTaskToken = 'local-test-worker-task-token-32-bytes-minimum';
    workerServer = createWorkerServer({
      processor,
      taskToken: workerTaskToken,
      allowLocalGovernanceSweep: true,
      runGovernanceSweep: async () => {
        const maintenance = await governance.processMaintenanceWorker(
          workerDb,
          (actor, scopeId, limit) => workerRecall.indexStaleMemories(actor, scopeId, limit),
        );
        return { ...(await governance.processPendingWorker(workerDb)), ...maintenance };
      },
      runPortabilitySweep: async () => {
        const result = await portability.processPendingWorker(workerDb);
        const expired = await portability.expireArtifacts(workerDb);
        const files = await portability.processPendingFileDeletions(workerDb);
        return {
          ...result,
          expired,
          deleted_files: files.deleted,
          file_deletions_pending: files.pending,
        };
      },
    });
    await new Promise<void>((resolve) => workerServer.listen(0, '127.0.0.1', resolve));
    const workerAddress = workerServer.address();
    if (workerAddress === null || typeof workerAddress === 'string')
      throw new Error('Worker test server did not bind');
    workerBaseUrl = `http://127.0.0.1:${workerAddress.port}`;
    outboxDispatcher = new OutboxDispatcher(
      workerDb,
      new HttpTaskDispatcher(workerBaseUrl, workerTaskToken, 20_000),
    );
  }, 20_000);

  it('validates and applies exact Gate identity mappings against a reviewed PostgreSQL baseline', async () => {
    if (adminUrl === undefined) throw new Error('TEST_ADMIN_URL is required');
    const directory = await mkdtemp(join(tmpdir(), 'memory-gate-identity-map-'));
    const mappingPath = join(directory, 'mapping.json');
    const target = {
      subject: `operator-mapping-${randomUUID()}`,
      issuer: 'https://gate.mapping.integration.test',
    };
    const mapping = {
      expected_source: { issuer, subject },
      user_id: userId,
      principal_id: principalId,
      target,
      scope_ids: [scopeA],
      capability_ceiling: ['read'],
    };
    const runMapping = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['scripts/gate-identity-map.mjs', '--file', mappingPath, ...args],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, IDENTITY_MAPPING_DATABASE_URL: adminUrl },
        },
      );
    const bindingKey = [target.issuer, target.subject];

    try {
      await writeFile(mappingPath, `${JSON.stringify(mapping)}\n`, { mode: 0o600 });

      const dryRun = runMapping();
      expect(dryRun.status).toBe(0);
      expect(dryRun.stderr).toBe('');
      const baseline = JSON.parse(dryRun.stdout) as { status: string; baseline_sha256: string };
      expect(baseline.status).toBe('dry_run');
      expect(baseline.baseline_sha256).toMatch(/^[a-f0-9]{64}$/);

      await writeFile(
        mappingPath,
        `${JSON.stringify({ ...mapping, target: { ...target, unexpected: true } })}\n`,
        { mode: 0o600 },
      );
      const malformed = runMapping();
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain('target must contain issuer and subject only');

      await writeFile(mappingPath, `${JSON.stringify(mapping)}\n`, { mode: 0o600 });
      const applied = runMapping('--apply', '--expected-baseline', baseline.baseline_sha256);
      expect(applied.status).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({ status: 'active', target });

      const staleBaseline = runMapping('--apply', '--expected-baseline', baseline.baseline_sha256);
      expect(staleBaseline.status).toBe(1);
      expect(staleBaseline.stderr).toContain('Baseline changed; rerun dry-run');

      const readBinding = () =>
        admin.query<{
          user_id: string;
          principal_id: string;
          scope_ids: string[];
          capability_ceiling: string[];
          active: boolean;
          updated_at: string;
        }>(
          `SELECT user_id::text, principal_id::text, scope_ids::text[], capability_ceiling,
                  active, updated_at::text
           FROM public.external_identity_bindings
           WHERE external_issuer = $1 AND external_subject = $2`,
          bindingKey,
        );
      const firstReadback = await readBinding();
      expect(firstReadback.rows).toHaveLength(1);
      expect(firstReadback.rows[0]).toMatchObject({
        user_id: userId,
        principal_id: principalId,
        scope_ids: [scopeA],
        capability_ceiling: ['read'],
        active: true,
      });

      const activeDryRun = runMapping();
      expect(activeDryRun.status).toBe(0);
      const activeBaseline = JSON.parse(activeDryRun.stdout) as { baseline_sha256: string };
      const idempotentApply = runMapping(
        '--apply',
        '--expected-baseline',
        activeBaseline.baseline_sha256,
      );
      expect(idempotentApply.status).toBe(0);
      expect(JSON.parse(idempotentApply.stdout)).toMatchObject({ status: 'active', target });
      const idempotentReadback = await readBinding();
      expect(idempotentReadback.rows).toEqual(firstReadback.rows);

      const deactivateDryRun = runMapping('--deactivate');
      expect(deactivateDryRun.status).toBe(0);
      const deactivateBaseline = JSON.parse(deactivateDryRun.stdout) as { baseline_sha256: string };
      const deactivated = runMapping(
        '--deactivate',
        '--apply',
        '--expected-baseline',
        deactivateBaseline.baseline_sha256,
      );
      expect(deactivated.status).toBe(0);
      expect(JSON.parse(deactivated.stdout)).toMatchObject({ status: 'inactive', target });
      const inactiveReadback = await readBinding();
      expect(inactiveReadback.rows).toHaveLength(1);
      expect(inactiveReadback.rows[0]?.active).toBe(false);
    } finally {
      await admin.query(
        `DELETE FROM public.external_identity_bindings
         WHERE external_issuer = $1 AND external_subject = $2`,
        bindingKey,
      );
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('bounds pending deletion batches and defers a failed oldest request without starving later work', async () => {
    const requestIds = [randomUUID(), randomUUID()];
    try {
      for (const limit of [null, 0, 101]) {
        await expect(
          workerDb.query('SELECT request_id FROM app.list_pending_deletions($1::integer)', [limit]),
        ).rejects.toMatchObject({ code: '22023' });
      }
      await admin.query(
        `INSERT INTO public.deletion_requests
           (id, user_id, scope_id, principal_id, selector, reason_code, status, created_at)
         VALUES
           ($1, $3, $4, $5, $6::jsonb, 'worker_batch_test', 'ledger_pending', clock_timestamp() - interval '2 minutes'),
           ($2, $3, $4, $5, $6::jsonb, 'worker_batch_test', 'ledger_pending', clock_timestamp() - interval '1 minute')`,
        [
          ...requestIds,
          userId,
          scopeB,
          principalId,
          JSON.stringify({ original_principal_id: principalId, memory_ids: [], source_ids: [] }),
        ],
      );

      const first = await workerDb.query<{ request_id: string }>(
        'SELECT request_id FROM app.list_pending_deletions($1::integer)',
        [1],
      );
      expect(first.rows.map((row) => row.request_id)).toEqual([requestIds[0]]);
      await workerDb.query('SELECT app.defer_pending_deletion($1::uuid)', [requestIds[0]]);

      const afterDeferral = await workerDb.query<{ request_id: string }>(
        'SELECT request_id FROM app.list_pending_deletions($1::integer)',
        [1],
      );
      expect(afterDeferral.rows.map((row) => row.request_id)).toEqual([requestIds[1]]);
      const stillPending = await workerDb.query<{ has_pending_deletions: boolean }>(
        'SELECT app.has_pending_deletions() AS has_pending_deletions',
      );
      expect(stillPending.rows[0]?.has_pending_deletions).toBe(true);
    } finally {
      await admin.query('DELETE FROM public.deletion_requests WHERE id = ANY($1::uuid[])', [
        requestIds,
      ]);
    }
  });

  it('intersects Gate scopes and per-scope grants, commits atomically, preserves evidence history, and pages exact changes', async () => {
    const readonlyToken = await token([scopeB], 'memory:read');
    const readonlyWrite = await post(
      '/v1/memories:remember',
      readonlyToken,
      {
        scope_id: scopeB,
        memory: sampleMemory(),
      },
      'readonly-write',
    );
    expect(readonlyWrite.status).toBe(403);

    const crossScopeToken = await token([scopeA, scopeB], 'memory:read memory:write');
    const scopeAWrite = await post(
      '/v1/memories:remember',
      crossScopeToken,
      {
        scope_id: scopeA,
        memory: sampleMemory(),
      },
      'scope-a-write',
    );
    expect(scopeAWrite.status).toBe(403);

    const writer = await token([scopeB], 'memory:read memory:write');
    const crossedRead = await fetch(`${baseUrl}/v1/memories/${randomUUID()}?scope_id=${scopeA}`, {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(crossedRead.status).toBe(403);
    const first = await post(
      '/v1/memories:remember',
      writer,
      {
        scope_id: scopeB,
        memory: sampleMemory(),
      },
      'create-memory',
    );
    expect(first.status).toBe(200);
    const firstResponse = (await first.json()) as {
      change_set_id: string;
      operations: { memory_ids: string[]; revisions: number[] }[];
    };
    const memoryId = firstResponse.operations[0]!.memory_ids[0]!;
    expect(firstResponse.operations[0]!.revisions).toEqual([1]);

    const duplicate = await post(
      '/v1/memories:remember',
      writer,
      {
        scope_id: scopeB,
        memory: sampleMemory(),
      },
      'create-memory',
    );
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { change_set_id: string }).change_set_id).toBe(
      firstResponse.change_set_id,
    );
    const conflict = await post(
      '/v1/memories:remember',
      writer,
      {
        scope_id: scopeB,
        memory: { ...sampleMemory(), statement: 'different payload' },
      },
      'create-memory',
    );
    expect(conflict.status).toBe(409);

    const initialVersion = await admin.query<{ recorded_at: string }>(
      `SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
       FROM memory_versions WHERE user_id = $1 AND scope_id = $2 AND memory_id = $3 AND revision = 1`,
      [userId, scopeB, memoryId],
    );
    expect(initialVersion.rows[0]).toBeDefined();
    const corroboration = {
      scope_id: scopeB,
      operations: [
        {
          op: 'CORROBORATE',
          memory_id: memoryId,
          expected_revision: 1,
          evidence: [evidence('source-2')],
        },
      ],
    };
    const proposalResponse = await post('/v1/changesets', writer, corroboration, 'proposal-1');
    expect(proposalResponse.status).toBe(200);
    const proposal = (await proposalResponse.json()) as { change_set_id: string; status: string };
    expect(proposal.status).toBe('proposed');
    const beforeCommit = await fetch(`${baseUrl}/v1/memories/${memoryId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(((await beforeCommit.json()) as { revision: number }).revision).toBe(1);
    const corroborated = await post(
      `/v1/changesets/${proposal.change_set_id}:commit`,
      writer,
      {},
      'corroborate-memory',
    );
    expect(corroborated.status).toBe(200);
    expect(
      ((await corroborated.json()) as { operations: { revisions: number[] }[] }).operations[0]!
        .revisions,
    ).toEqual([2]);
    const committedAgain = await post(
      `/v1/changesets/${proposal.change_set_id}:commit`,
      writer,
      {},
      'corroborate-memory',
    );
    expect(committedAgain.status).toBe(200);
    const anotherWriter = await token([scopeB], 'memory:read memory:write', clientSubject);
    const unauthorizedReplay = await post(
      `/v1/changesets/${proposal.change_set_id}:commit`,
      anotherWriter,
      {},
      'unauthorized-committed-replay',
    );
    expect(unauthorizedReplay.status).toBe(403);
    expect(await unauthorizedReplay.json()).toMatchObject({
      error: { code: 'forbidden' },
    });
    const userRecovery = await token([scopeB], 'memory:read memory:write', recoveryUserSubject);
    const recoveredReplay = await post(
      `/v1/changesets/${proposal.change_set_id}:commit`,
      userRecovery,
      {},
      'owner-committed-recovery',
    );
    expect(recoveredReplay.status).toBe(200);
    expect(await recoveredReplay.json()).toMatchObject({
      change_set_id: proposal.change_set_id,
    });
    const replayProposal = await post('/v1/changesets', writer, corroboration, 'proposal-1');
    expect(await replayProposal.json()).toMatchObject({
      change_set_id: proposal.change_set_id,
      status: 'proposed',
    });

    const oldView = await fetch(
      `${baseUrl}/v1/memories/${memoryId}?scope_id=${scopeB}&known_at=${encodeURIComponent(initialVersion.rows[0]!.recorded_at)}`,
      {
        headers: { authorization: `Bearer ${writer}` },
      },
    );
    expect(oldView.status).toBe(200);
    const oldMemory = (await oldView.json()) as { revision: number; evidence: unknown[] };
    expect(oldMemory.revision).toBe(1);
    expect(oldMemory.evidence).toHaveLength(1);

    const currentView = await fetch(`${baseUrl}/v1/memories/${memoryId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(currentView.status).toBe(200);
    const currentMemory = (await currentView.json()) as { revision: number; evidence: unknown[] };
    expect(currentMemory.revision).toBe(2);
    expect(currentMemory.evidence).toHaveLength(2);

    const competingProposalA = await post(
      '/v1/changesets',
      writer,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'CORROBORATE',
            memory_id: memoryId,
            expected_revision: 2,
            evidence: [evidence('source-3')],
          },
        ],
      },
      'proposal-2',
    );
    const competingProposalB = await post(
      '/v1/changesets',
      writer,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'CORROBORATE',
            memory_id: memoryId,
            expected_revision: 2,
            evidence: [evidence('source-4')],
          },
        ],
      },
      'proposal-3',
    );
    expect(competingProposalA.status).toBe(200);
    expect(competingProposalB.status).toBe(200);
    const competingA = (await competingProposalA.json()) as { change_set_id: string };
    const competingB = (await competingProposalB.json()) as { change_set_id: string };
    const winningCommit = await post(
      `/v1/changesets/${competingA.change_set_id}:commit`,
      writer,
      {},
      'competing-commit-a',
    );
    expect(winningCommit.status).toBe(200);
    const staleCommit = await post(
      `/v1/changesets/${competingB.change_set_id}:commit`,
      writer,
      {},
      'competing-commit-b',
    );
    expect(staleCommit.status).toBe(409);

    const stale = await post(
      '/v1/changesets',
      writer,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'CORROBORATE',
            memory_id: memoryId,
            expected_revision: 1,
            evidence: [evidence('source-stale')],
          },
        ],
      },
      'stale-cas',
    );
    expect(stale.status).toBe(409);

    const recall = await post('/v1/recall', writer, {
      query: 'L. Vega',
      scope_ids: [scopeB],
      mode: 'precise',
    });
    expect(recall.status).toBe(200);
    const recalled = (await recall.json()) as {
      matches: {
        id: string;
        context: Record<string, unknown>;
        subjects: {
          aliases: { name: string; valid_from: string | null; valid_to: string | null }[];
        }[];
      }[];
    };
    expect(recalled.matches.map((memory) => memory.id)).toContain(memoryId);
    const recalledMemory = recalled.matches.find((memory) => memory.id === memoryId)!;
    expect(recalledMemory.context).toEqual({
      episode: { action: 'packed', condition: { weather: 'rain' }, outcome: 'dry' },
    });
    expect(recalledMemory.subjects[0]!.aliases).toContainEqual({
      name: 'L. Vega',
      valid_from: null,
      valid_to: null,
    });

    const emptyRecall = await post('/v1/recall', writer, {
      query: 'no exact memory exists',
      scope_ids: [scopeB],
    });
    expect(((await emptyRecall.json()) as { unknown: boolean }).unknown).toBe(true);

    const changes = await fetch(`${baseUrl}/v1/changes?scope_ids=${scopeB}&limit=20`, {
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(changes.status).toBe(200);
    const feed = (await changes.json()) as {
      changes: { operation: string }[];
      next_cursor: string;
    };
    expect(feed.changes.map((change) => change.operation)).toContain('CREATE');
    expect(feed.changes.map((change) => change.operation)).toContain('CORROBORATE');
    expect(feed.next_cursor.split('.')).toHaveLength(2);
    expect(feed).toHaveProperty('request_id');
    expect(feed).toHaveProperty('trace_id');
  });

  it('runs competing proposal commits concurrently and lets exactly one revision win', async () => {
    const writer = await token([scopeB], 'memory:read memory:write');
    const created = await post(
      '/v1/memories:remember',
      writer,
      { scope_id: scopeB, memory: sampleMemory() },
      'parallel-cas-create',
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { operations: { memory_ids: string[] }[] };
    const memoryId = createdBody.operations[0]!.memory_ids[0]!;
    const [proposalAResponse, proposalBResponse] = await Promise.all([
      post(
        '/v1/changesets',
        writer,
        {
          scope_id: scopeB,
          operations: [
            {
              op: 'CORROBORATE',
              memory_id: memoryId,
              expected_revision: 1,
              evidence: [evidence('parallel-a')],
            },
          ],
        },
        'parallel-proposal-a',
      ),
      post(
        '/v1/changesets',
        writer,
        {
          scope_id: scopeB,
          operations: [
            {
              op: 'CORROBORATE',
              memory_id: memoryId,
              expected_revision: 1,
              evidence: [evidence('parallel-b')],
            },
          ],
        },
        'parallel-proposal-b',
      ),
    ]);
    expect([proposalAResponse.status, proposalBResponse.status]).toEqual([200, 200]);
    const [proposalA, proposalB] = await Promise.all([
      proposalAResponse.json() as Promise<{ change_set_id: string }>,
      proposalBResponse.json() as Promise<{ change_set_id: string }>,
    ]);
    const results = await Promise.all([
      post(`/v1/changesets/${proposalA.change_set_id}:commit`, writer, {}, 'parallel-commit-a'),
      post(`/v1/changesets/${proposalB.change_set_id}:commit`, writer, {}, 'parallel-commit-b'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const state = await admin.query<{ revision: number; evidence_count: string }>(
      `SELECT m.revision, count(mve.evidence_id)::text AS evidence_count
       FROM memories AS m JOIN memory_version_evidence AS mve
         ON mve.user_id = m.user_id AND mve.scope_id = m.scope_id AND mve.memory_id = m.id AND mve.revision = m.revision
       WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = $3 GROUP BY m.revision`,
      [userId, scopeB, memoryId],
    );
    expect(state.rows[0]).toMatchObject({ revision: 2, evidence_count: '2' });
  });

  it('does not let the application role grant itself more authority', async () => {
    await expect(
      app.query("UPDATE grants SET capabilities = ARRAY['admin'] WHERE user_id = $1", [userId]),
    ).rejects.toMatchObject({ code: '42501' });

    for (const statement of [
      'UPDATE memory_versions SET statement = statement WHERE user_id = $1',
      'DELETE FROM memory_versions WHERE user_id = $1',
    ]) {
      await expect(
        withTransaction(app, async (client) => {
          await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
          await client.query("SELECT set_config('app.scope_ids', $1, true)", [`{${scopeB}}`]);
          await client.query("SELECT set_config('app.purge_mode', 'on', true)");
          await client.query(statement, [userId]);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }

    const existingVersion = await admin.query<{ memory_id: string; revision: number }>(
      'SELECT memory_id, revision FROM memory_versions WHERE user_id = $1 AND scope_id = $2 LIMIT 1',
      [userId, scopeB],
    );
    expect(existingVersion.rows[0]).toBeDefined();
    await expect(
      withTransaction(admin, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        await client.query("SELECT set_config('app.scope_ids', $1, true)", [`{${scopeB}}`]);
        await client.query("SELECT set_config('app.purge_mode', 'on', true)");
        await client.query(
          `UPDATE memory_versions SET statement = statement
           WHERE user_id = $1 AND scope_id = $2 AND memory_id = $3 AND revision = $4`,
          [userId, scopeB, existingVersion.rows[0]!.memory_id, existingVersion.rows[0]!.revision],
        );
      }),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('expires a grant at authentication and again inside an already-authenticated operation', async () => {
    await admin.query(
      `UPDATE grants SET expires_at = clock_timestamp() + interval '1 hour'
       WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3`,
      [userId, scopeA, principalId],
    );
    const bearer = await token([scopeA], 'memory:read');
    const actor = await authenticator.authenticate(`Bearer ${bearer}`);
    expect(actor.scopeIds).toContain(scopeA);

    try {
      await admin.query(
        `UPDATE grants SET expires_at = clock_timestamp() - interval '1 second'
         WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3`,
        [userId, scopeA, principalId],
      );
      await expect(coreService.getMemory(actor, scopeA, randomUUID(), {})).rejects.toThrow(
        'Current database grants do not cover every requested scope',
      );

      const expiredTokenResponse = await fetch(
        `${baseUrl}/v1/memories/${randomUUID()}?scope_id=${scopeA}`,
        { headers: { authorization: `Bearer ${bearer}` } },
      );
      expect(expiredTokenResponse.status).toBe(403);
      expect(await expiredTokenResponse.json()).toMatchObject({
        error: { code: 'forbidden' },
      });
    } finally {
      await admin.query(
        `UPDATE grants SET expires_at = NULL
         WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3`,
        [userId, scopeA, principalId],
      );
    }
  });

  it('rolls back every commit write when a later source loses permission', async () => {
    const writer = await token([scopeB], 'memory:read memory:write');
    const source = await admin.query<{ id: string }>(
      `INSERT INTO sources(user_id, scope_id, kind, external_id, revision, rights_status, consent)
       VALUES ($1, $2, 'document', $3, '1', 'granted', true) RETURNING id`,
      [userId, scopeB, `rollback-${randomUUID()}`],
    );
    const targetResponse = await post(
      '/v1/memories:remember',
      writer,
      { scope_id: scopeB, memory: sampleMemory() },
      'rollback-target-create',
    );
    expect(targetResponse.status).toBe(200);
    const target = (await targetResponse.json()) as { operations: { memory_ids: string[] }[] };
    const targetId = target.operations[0]!.memory_ids[0]!;
    const documentId = `rollback-${randomUUID()}`;
    const documentSource = await admin.query<{ id: string }>(
      `INSERT INTO sources(user_id, scope_id, kind, external_id, revision, rights_status, consent)
       VALUES ($1, $2, 'document', $3, '1', 'granted', true) RETURNING id`,
      [userId, scopeB, documentId],
    );
    expect(source.rows[0]).toBeDefined();
    expect(documentSource.rows[0]).toBeDefined();
    const body = {
      scope_id: scopeB,
      operations: [
        {
          op: 'CORROBORATE',
          memory_id: targetId,
          expected_revision: 1,
          evidence: [evidence('rollback-first-op')],
        },
        {
          op: 'CREATE',
          memory: {
            ...sampleMemory(),
            statement: 'This later create must roll back.',
            evidence: [
              {
                source: {
                  kind: 'document',
                  external_id: documentId,
                  revision: '1',
                  locator: 'document/rollback',
                },
                snippet: 'Registered source evidence',
                snippet_allowed: true,
              },
            ],
          },
        },
      ],
    };
    const proposalResponse = await post('/v1/changesets', writer, body, 'rollback-proposal');
    expect(proposalResponse.status).toBe(200);
    const proposal = (await proposalResponse.json()) as { change_set_id: string };
    const before = await admin.query<{
      last_seq: string;
      versions: string;
      version_evidence: string;
      logs: string;
      outbox: string;
      memories: string;
      evidence: string;
      memory_evidence: string;
      idempotency: string;
      audit: string;
    }>(
      `SELECT o.last_seq::text AS last_seq,
         (SELECT count(*)::text FROM memory_versions WHERE user_id = $1 AND scope_id = $2) AS versions,
         (SELECT count(*)::text FROM memory_version_evidence WHERE user_id = $1 AND scope_id = $2) AS version_evidence,
         (SELECT count(*)::text FROM change_log WHERE user_id = $1 AND scope_id = $2) AS logs,
         (SELECT count(*)::text FROM outbox WHERE user_id = $1 AND scope_id = $2) AS outbox,
         (SELECT count(*)::text FROM memories WHERE user_id = $1 AND scope_id = $2) AS memories,
         (SELECT count(*)::text FROM evidence WHERE user_id = $1 AND scope_id = $2) AS evidence,
         (SELECT count(*)::text FROM memory_evidence WHERE user_id = $1 AND scope_id = $2) AS memory_evidence,
         (SELECT count(*)::text FROM idempotency_keys WHERE user_id = $1 AND scope_id = $2) AS idempotency,
         (SELECT count(*)::text FROM audit_events WHERE user_id = $1 AND scope_id = $2) AS audit
       FROM scope_offsets AS o WHERE o.user_id = $1 AND o.scope_id = $2`,
      [userId, scopeB],
    );
    await admin.query(
      "UPDATE sources SET rights_status = 'revoked', consent = false WHERE user_id = $1 AND scope_id = $2 AND id = $3",
      [userId, scopeB, documentSource.rows[0]!.id],
    );
    const commit = await post(
      `/v1/changesets/${proposal.change_set_id}:commit`,
      writer,
      {},
      'rollback-commit',
    );
    expect(commit.status).toBe(403);
    expect(await commit.json()).toMatchObject({ error: { code: 'source_forbidden' } });
    const after = await admin.query<{
      last_seq: string;
      versions: string;
      version_evidence: string;
      logs: string;
      outbox: string;
      memories: string;
      evidence: string;
      memory_evidence: string;
      idempotency: string;
      audit: string;
      revision: number;
      status: string;
    }>(
      `SELECT o.last_seq::text AS last_seq,
         (SELECT count(*)::text FROM memory_versions WHERE user_id = $1 AND scope_id = $2) AS versions,
         (SELECT count(*)::text FROM memory_version_evidence WHERE user_id = $1 AND scope_id = $2) AS version_evidence,
         (SELECT count(*)::text FROM change_log WHERE user_id = $1 AND scope_id = $2) AS logs,
         (SELECT count(*)::text FROM outbox WHERE user_id = $1 AND scope_id = $2) AS outbox,
         (SELECT count(*)::text FROM memories WHERE user_id = $1 AND scope_id = $2) AS memories,
         (SELECT count(*)::text FROM evidence WHERE user_id = $1 AND scope_id = $2) AS evidence,
         (SELECT count(*)::text FROM memory_evidence WHERE user_id = $1 AND scope_id = $2) AS memory_evidence,
         (SELECT count(*)::text FROM idempotency_keys WHERE user_id = $1 AND scope_id = $2) AS idempotency,
         (SELECT count(*)::text FROM audit_events WHERE user_id = $1 AND scope_id = $2) AS audit,
         (SELECT revision FROM memories WHERE user_id = $1 AND scope_id = $2 AND id = $3) AS revision,
         (SELECT status FROM changesets WHERE user_id = $1 AND scope_id = $2 AND id = $4) AS status
       FROM scope_offsets AS o WHERE o.user_id = $1 AND o.scope_id = $2`,
      [userId, scopeB, targetId, proposal.change_set_id],
    );
    expect(after.rows[0]).toMatchObject({ ...before.rows[0], revision: 1, status: 'proposed' });
  });

  it('resets tenant GUCs when a pooled application connection is reused', async () => {
    const singleConnection = new Pool({ connectionString: appUrl, max: 1 });
    try {
      await withTransaction(singleConnection, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        await client.query("SELECT set_config('app.scope_ids', $1, true)", [`{${scopeB}}`]);
      });
      const nextTransaction = await withTransaction(singleConnection, async (client) =>
        client.query<{ user: string | null; scopes: string | null; visible: string }>(
          `SELECT nullif(current_setting('app.user_id', true), '') AS user,
           nullif(current_setting('app.scope_ids', true), '') AS scopes,
           count(*)::text AS visible FROM memories`,
        ),
      );
      expect(nextTransaction.rows[0]).toMatchObject({ user: null, scopes: null, visible: '0' });
    } finally {
      await singleConnection.end();
    }
  });

  it('binds signed cursors to their scope vector and current authorization epoch', async () => {
    const reader = await token([scopeA, scopeB], 'memory:read');
    const first = await fetch(
      `${baseUrl}/v1/changes?scope_ids=${scopeA}&scope_ids=${scopeB}&limit=2`,
      {
        headers: { authorization: `Bearer ${reader}` },
      },
    );
    expect(first.status).toBe(200);
    const page = (await first.json()) as { next_cursor: string };
    const signatureIndex = page.next_cursor.lastIndexOf('.') + 1;
    const signatureChar = page.next_cursor[signatureIndex];
    const tampered = `${page.next_cursor.slice(0, signatureIndex)}${signatureChar === 'a' ? 'b' : 'a'}${page.next_cursor.slice(signatureIndex + 1)}`;
    const invalid = await fetch(
      `${baseUrl}/v1/changes?scope_ids=${scopeA}&scope_ids=${scopeB}&cursor=${encodeURIComponent(tampered)}`,
      {
        headers: { authorization: `Bearer ${reader}` },
      },
    );
    expect(invalid.status).toBe(400);
    const wrongVector = await fetch(
      `${baseUrl}/v1/changes?scope_ids=${scopeB}&cursor=${encodeURIComponent(page.next_cursor)}`,
      {
        headers: { authorization: `Bearer ${reader}` },
      },
    );
    expect(wrongVector.status).toBe(403);
    await admin.query(
      "UPDATE grants SET capabilities = ARRAY['read', 'write'] WHERE user_id = $1 AND scope_id = $2 AND principal_id = $3",
      [userId, scopeA, principalId],
    );
    const freshReader = await token([scopeA, scopeB], 'memory:read');
    const expired = await fetch(
      `${baseUrl}/v1/changes?scope_ids=${scopeA}&scope_ids=${scopeB}&cursor=${encodeURIComponent(page.next_cursor)}`,
      {
        headers: { authorization: `Bearer ${freshReader}` },
      },
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({
      error: { code: 'cursor_expired', details: { resync_required: true } },
    });
  });

  it('keeps User authority separate from client proposals and lets User confirm a candidate', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const client = await token([scopeB], 'memory:read memory:write', clientSubject);
    const userCreated = await post(
      '/v1/memories:remember',
      user,
      { scope_id: scopeB, memory: sampleMemory() },
      'owner-authority',
    );
    const userResult = (await userCreated.json()) as { operations: { memory_ids: string[] }[] };
    const userMemoryId = userResult.operations[0]!.memory_ids[0]!;
    const userMemory = await fetch(`${baseUrl}/v1/memories/${userMemoryId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(await userMemory.json()).toMatchObject({
      lifecycle: 'active',
      attribution: { actor_kind: 'user', authority: 'user_assertion' },
    });

    const userRefineAttempt = await post(
      '/v1/changesets',
      client,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'REFINE',
            memory_id: userMemoryId,
            expected_revision: 1,
            statement: 'Unapproved client overwrite',
            evidence: [evidence('client-owner-refine')],
          },
        ],
      },
      'client-owner-refine',
    );
    expect(userRefineAttempt.status).toBe(403);
    expect(await userRefineAttempt.json()).toMatchObject({
      error: { code: 'user_confirmation_required' },
    });

    const clientCreated = await post(
      '/v1/memories:remember',
      client,
      { scope_id: scopeB, memory: { ...sampleMemory(), statement: 'A client suggestion.' } },
      'client-candidate',
    );
    expect(clientCreated.status).toBe(200);
    const clientResult = (await clientCreated.json()) as { operations: { memory_ids: string[] }[] };
    const candidateId = clientResult.operations[0]!.memory_ids[0]!;
    const candidateBefore = await fetch(
      `${baseUrl}/v1/memories/${candidateId}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${client}` } },
    );
    expect(await candidateBefore.json()).toMatchObject({
      lifecycle: 'candidate',
      epistemic: { status: 'asserted' },
      attribution: { actor_kind: 'client', authority: 'ai_proposal' },
    });
    const proposalResponse = await post(
      '/v1/changesets',
      client,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'REFINE',
            memory_id: candidateId,
            expected_revision: 1,
            statement: 'Client revised suggestion.',
            evidence: [evidence('client-own-refine')],
          },
        ],
      },
      'client-own-refine',
    );
    const proposal = (await proposalResponse.json()) as { change_set_id: string };
    expect(
      (
        await post(
          `/v1/changesets/${proposal.change_set_id}:commit`,
          client,
          {},
          'client-own-refine-commit',
        )
      ).status,
    ).toBe(200);
    const candidateAfterClient = await fetch(
      `${baseUrl}/v1/memories/${candidateId}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${client}` } },
    );
    expect(await candidateAfterClient.json()).toMatchObject({
      lifecycle: 'candidate',
      revision: 2,
      attribution: { actor_kind: 'client', authority: 'ai_proposal' },
      epistemic: { status: 'proposed' },
    });

    const userConfirmation = await post(
      '/v1/changesets',
      user,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'REFINE',
            memory_id: candidateId,
            expected_revision: 2,
            epistemic_status: 'asserted',
            statement: 'User confirmed suggestion.',
            evidence: [evidence('owner-confirmation')],
          },
        ],
      },
      'owner-confirmation',
    );
    const confirmationProposal = (await userConfirmation.json()) as { change_set_id: string };
    expect(
      (
        await post(
          `/v1/changesets/${confirmationProposal.change_set_id}:commit`,
          user,
          {},
          'owner-confirmation-commit',
        )
      ).status,
    ).toBe(200);
    const confirmed = await fetch(`${baseUrl}/v1/memories/${candidateId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(await confirmed.json()).toMatchObject({
      lifecycle: 'active',
      revision: 3,
      attribution: { actor_kind: 'user', authority: 'user_assertion' },
      epistemic: { status: 'asserted' },
    });
  });

  it('applies every ChangeOp and retains two-time temporal selection', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const beforeTime = '2024-12-31T23:59:00.000Z';
    const temporalCreate = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: {
          ...sampleMemory(),
          statement: 'A broad dated fact.',
          valid_from: '2020-01-01T00:00:00.000Z',
          valid_to: '2030-01-01T00:00:00.000Z',
        },
      },
      'temporal-create',
    );
    const first = (await temporalCreate.json()) as { operations: { memory_ids: string[] }[] };
    const firstId = first.operations[0]!.memory_ids[0]!;
    const beforeVersion = await admin.query<{ recorded_at: string }>(
      `SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
       FROM memory_versions WHERE user_id = $1 AND scope_id = $2 AND memory_id = $3 AND revision = 1`,
      [userId, scopeB, firstId],
    );
    const refinement = await post(
      '/v1/changesets',
      user,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'REFINE',
            memory_id: firstId,
            expected_revision: 1,
            statement: 'A later narrow dated fact.',
            valid_from: '2025-01-01T00:00:00.000Z',
            valid_to: '2025-06-01T00:00:00.000Z',
            evidence: [evidence('temporal-refine')],
          },
        ],
      },
      'temporal-refine',
    );
    const refineProposal = (await refinement.json()) as { change_set_id: string };
    expect(
      (
        await post(
          `/v1/changesets/${refineProposal.change_set_id}:commit`,
          user,
          {},
          'temporal-refine-commit',
        )
      ).status,
    ).toBe(200);
    const latestVersion = await admin.query<{ recorded_at: string }>(
      `SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
       FROM memory_versions WHERE user_id = $1 AND scope_id = $2 AND memory_id = $3 AND revision = 2`,
      [userId, scopeB, firstId],
    );
    const oldKnow = await fetch(
      `${baseUrl}/v1/memories/${firstId}?scope_id=${scopeB}&valid_at=${encodeURIComponent(beforeTime)}&known_at=${encodeURIComponent(beforeVersion.rows[0]!.recorded_at)}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(oldKnow.status).toBe(200);
    expect(await oldKnow.json()).toMatchObject({ revision: 1, statement: 'A broad dated fact.' });
    const currentKnowOldValid = await fetch(
      `${baseUrl}/v1/memories/${firstId}?scope_id=${scopeB}&valid_at=${encodeURIComponent(beforeTime)}&known_at=${encodeURIComponent(latestVersion.rows[0]!.recorded_at)}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(currentKnowOldValid.status).toBe(404);
    const currentKnowValid = await fetch(
      `${baseUrl}/v1/memories/${firstId}?scope_id=${scopeB}&valid_at=2025-03-01T00%3A00%3A00.000Z&known_at=${encodeURIComponent(latestVersion.rows[0]!.recorded_at)}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(await currentKnowValid.json()).toMatchObject({
      revision: 2,
      statement: 'A later narrow dated fact.',
    });
    const oldRecall = await post('/v1/recall', user, {
      query: 'A broad dated fact.',
      scope_ids: [scopeB],
      known_at: beforeVersion.rows[0]!.recorded_at,
      mode: 'precise',
    });
    expect(await oldRecall.json()).toMatchObject({
      matches: [
        expect.objectContaining({ id: firstId, revision: 1, statement: 'A broad dated fact.' }),
      ],
    });

    const second = await post(
      '/v1/memories:remember',
      user,
      { scope_id: scopeB, memory: { ...sampleMemory(), statement: 'A related fact.' } },
      'all-ops-second-create',
    );
    const secondBody = (await second.json()) as { operations: { memory_ids: string[] }[] };
    const secondId = secondBody.operations[0]!.memory_ids[0]!;
    const operations = [
      {
        op: 'CONTEST',
        memory_id: firstId,
        expected_revision: 2,
        reason: 'A conflicting account exists.',
        evidence: [evidence('all-op-contest')],
      },
      {
        op: 'RELATE',
        from_memory_id: firstId,
        from_expected_revision: 3,
        to_memory_id: secondId,
        to_expected_revision: 1,
        relation: 'supports',
        context: { basis: { type: 'shared_episode' } },
      },
      {
        op: 'SUPERSEDE',
        memory_id: secondId,
        expected_revision: 2,
        replacement: { ...sampleMemory(), statement: 'A replacement related fact.' },
      },
      { op: 'NO_OP', reason: 'No new evidence was found.' },
      {
        op: 'RETRACT',
        memory_id: firstId,
        expected_revision: 4,
        reason: 'User requested removal.',
      },
    ];
    const committedChangeSetIds: string[] = [];
    let supersededReplacementId: string | undefined;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      const proposed = await post(
        '/v1/changesets',
        user,
        { scope_id: scopeB, operations: [operation] },
        `all-ops-${index}`,
      );
      expect(proposed.status).toBe(200);
      const proposedBody = (await proposed.json()) as { change_set_id: string };
      committedChangeSetIds.push(proposedBody.change_set_id);
      const committed = await post(
        `/v1/changesets/${proposedBody.change_set_id}:commit`,
        user,
        {},
        `all-ops-commit-${index}`,
      );
      expect(committed.status).toBe(200);
      const commitResult = (await committed.json()) as {
        sequence_to: string | null;
        operations: { memory_ids: string[]; changed: boolean }[];
      };
      const operationResult = commitResult.operations[0]!;
      expect(operationResult.changed).toBe(index !== 3);
      if (index === 3) expect(commitResult.sequence_to).toBeNull();
      if (index === 2) {
        expect(operationResult.memory_ids).toHaveLength(2);
        supersededReplacementId = operationResult.memory_ids[1];
      }
      if (index === 0) {
        const contested = await admin.query<{
          contested: boolean;
          context: Record<string, unknown>;
        }>(
          'SELECT contested, context FROM memories WHERE user_id = $1 AND scope_id = $2 AND id = $3',
          [userId, scopeB, firstId],
        );
        expect(contested.rows[0]).toMatchObject({
          contested: true,
          context: { contest_reasons: ['A conflicting account exists.'] },
        });
      }
    }
    const finalMemory = await fetch(`${baseUrl}/v1/memories/${firstId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(finalMemory.status).toBe(200);
    expect(await finalMemory.json()).toMatchObject({ lifecycle: 'retracted', revision: 5 });
    const operationRows = await admin.query<{ op: string; metadata: Record<string, unknown> }>(
      `SELECT co.op, co.metadata FROM change_ops AS co JOIN changesets AS cs
         ON cs.user_id = co.user_id AND cs.scope_id = co.scope_id AND cs.id = co.change_set_id
       WHERE co.user_id = $1 AND co.scope_id = $2 AND cs.id = ANY($3::uuid[])
       ORDER BY array_position($3::uuid[], cs.id), co.ordinal`,
      [userId, scopeB, committedChangeSetIds],
    );
    expect(operationRows.rows.map((row) => row.op)).toEqual([
      'CONTEST',
      'RELATE',
      'SUPERSEDE',
      'NO_OP',
      'RETRACT',
    ]);
    expect(operationRows.rows[0]!.metadata).toMatchObject({
      reason: 'A conflicting account exists.',
    });
    expect(operationRows.rows[3]!.metadata).toMatchObject({ reason: 'No new evidence was found.' });
    expect(operationRows.rows[4]!.metadata).toMatchObject({ reason: 'User requested removal.' });
    const lifecycle = await admin.query<{
      lifecycle: string;
      relation: string;
      tombstone: boolean;
      noop_sequence_to: string | null;
    }>(
      `SELECT m.lifecycle,
         (SELECT relation FROM relations WHERE user_id = $1 AND scope_id = $2 AND from_memory_id = $4 AND to_memory_id = $3 AND relation = 'supports') AS relation,
         (SELECT tombstone FROM change_log WHERE user_id = $1 AND scope_id = $2 AND memory_id = $4 AND op = 'RETRACT' ORDER BY seq DESC LIMIT 1) AS tombstone,
         (SELECT response->>'sequence_to' FROM changesets WHERE user_id = $1 AND scope_id = $2 AND id = $5) AS noop_sequence_to
       FROM memories AS m WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = $3`,
      [userId, scopeB, secondId, firstId, committedChangeSetIds[3]],
    );
    expect(lifecycle.rows[0]).toMatchObject({
      lifecycle: 'superseded',
      relation: 'supports',
      tombstone: true,
    });
    expect(lifecycle.rows[0]!.noop_sequence_to).toBeNull();
    expect(supersededReplacementId).toBeDefined();
    const replacement = await admin.query<{ lifecycle: string; supersedes_old: boolean }>(
      `SELECT m.lifecycle,
         EXISTS (SELECT 1 FROM relations AS r WHERE r.user_id = m.user_id AND r.scope_id = m.scope_id
           AND r.from_memory_id = m.id AND r.to_memory_id = $4 AND r.relation = 'supersedes') AS supersedes_old
       FROM memories AS m WHERE m.user_id = $1 AND m.scope_id = $2 AND m.id = $3`,
      [userId, scopeB, supersededReplacementId, secondId],
    );
    expect(replacement.rows[0]).toMatchObject({ lifecycle: 'active', supersedes_old: true });
  });

  it('cuts a superseded memory validity interval at the replacement start', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const created = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: {
          ...sampleMemory(),
          statement: 'The old dated arrangement applies.',
          valid_from: '2020-01-01T00:00:00.000Z',
          valid_to: '2030-01-01T00:00:00.000Z',
        },
      },
      'supersede-interval-create',
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { operations: { memory_ids: string[] }[] };
    const oldMemoryId = createdBody.operations[0]!.memory_ids[0]!;
    const proposed = await post(
      '/v1/changesets',
      user,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'SUPERSEDE',
            memory_id: oldMemoryId,
            expected_revision: 1,
            replacement: {
              ...sampleMemory(),
              statement: 'The new dated arrangement applies.',
              valid_from: '2025-01-01T00:00:00.000Z',
            },
          },
        ],
      },
      'supersede-interval-proposal',
    );
    expect(proposed.status).toBe(200);
    const proposalBody = (await proposed.json()) as { change_set_id: string };
    const committed = await post(
      `/v1/changesets/${proposalBody.change_set_id}:commit`,
      user,
      {},
      'supersede-interval-commit',
    );
    expect(committed.status).toBe(200);
    const commitBody = (await committed.json()) as { operations: { memory_ids: string[] }[] };
    const replacementId = commitBody.operations[0]!.memory_ids[1]!;

    const storedRange = await admin.query<{ valid_from: Date; valid_to: Date }>(
      `SELECT valid_from, valid_to FROM memories
       WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
      [userId, scopeB, oldMemoryId],
    );
    expect(storedRange.rows[0]!.valid_to.toISOString()).toBe('2025-01-01T00:00:00.000Z');

    const priorView = await fetch(
      `${baseUrl}/v1/memories/${oldMemoryId}?scope_id=${scopeB}&valid_at=2024-01-01T00%3A00%3A00.000Z`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(priorView.status).toBe(200);
    const overlapView = await fetch(
      `${baseUrl}/v1/memories/${oldMemoryId}?scope_id=${scopeB}&valid_at=2026-01-01T00%3A00%3A00.000Z`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(overlapView.status).toBe(404);
    const replacementView = await fetch(
      `${baseUrl}/v1/memories/${replacementId}?scope_id=${scopeB}&valid_at=2026-01-01T00%3A00%3A00.000Z`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(replacementView.status).toBe(200);
  });

  it('keeps worker-only job functions private from the application role', async () => {
    const membership = await admin.query<{
      app_is_worker: boolean;
      hnsw: boolean;
      worker_can_delete_observations: boolean;
      worker_can_update_scopes: boolean;
      worker_can_delete_versions: boolean;
      app_can_delete_observations: boolean;
    }>(
      `SELECT pg_has_role('memory_app', 'memory_worker', 'member') AS app_is_worker,
         EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'memory_embeddings_hnsw_cosine_1536_idx') AS hnsw,
         has_table_privilege('memory_worker_login', 'observations', 'DELETE') AS worker_can_delete_observations,
         has_table_privilege('memory_worker_login', 'scopes', 'UPDATE') AS worker_can_update_scopes,
         has_table_privilege('memory_worker_login', 'memory_versions', 'DELETE') AS worker_can_delete_versions,
         has_table_privilege('memory_app', 'observations', 'DELETE') AS app_can_delete_observations`,
    );
    expect(membership.rows[0]).toMatchObject({
      app_is_worker: false,
      hnsw: true,
      worker_can_delete_observations: false,
      worker_can_update_scopes: false,
      worker_can_delete_versions: false,
      app_can_delete_observations: false,
    });
    const jobId = randomUUID();
    const leaseToken = randomUUID();
    await expect(
      app.query('SELECT * FROM app.claim_capture_job($1::uuid, $2::uuid, 120)', [
        jobId,
        leaseToken,
      ]),
    ).rejects.toBeDefined();
    await expect(
      app.query('SELECT * FROM app.capture_job_status($1::uuid)', [jobId]),
    ).rejects.toBeDefined();
  });

  it('runs consented capture through worker auto-commit, hybrid Recall, held review, and explicit reconciliation', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const setupCapture = async (externalId: string, content: string) => {
      const configured = await post('/v1/connectors', user, {
        scope_id: scopeB,
        source_kind: 'chat',
        external_id: externalId,
        enabled: true,
        consent: true,
        metadata: { local_fixture: true },
      });
      expect(configured.status).toBe(200);
      const body = {
        scope_id: scopeB,
        operation_id: `op-${randomUUID()}`,
        source: { kind: 'chat', external_id: externalId, revision: '1' },
        observations: [{ locator: 'message/1', content, speaker: 'user' }],
      };
      const captured = await post('/v1/captures', user, body, `capture-${randomUUID()}`);
      expect(captured.status).toBe(202);
      const captureBody = (await captured.json()) as { job_id: string };
      const dispatched = await outboxDispatcher.dispatchPending();
      expect(dispatched.retrying).toBe(0);
      expect(dispatched.dispatched).toBeGreaterThan(0);
      const status = await fetch(`${baseUrl}/v1/captures/${captureBody.job_id}`, {
        headers: { authorization: `Bearer ${user}` },
      });
      expect(status.status).toBe(200);
      return {
        job_id: captureBody.job_id,
        status: (await status.json()) as Record<string, unknown>,
        source: body.source,
        content,
      };
    };

    const statement = 'Sample water boiled at 100 degrees Celsius during the lab run.';
    const sourceExternalId = `water-${randomUUID()}`;
    const configured = await post('/v1/connectors', user, {
      scope_id: scopeB,
      source_kind: 'chat',
      external_id: sourceExternalId,
      enabled: true,
      consent: true,
      metadata: { local_fixture: true },
    });
    expect(configured.status).toBe(200);
    const captureRequest = {
      scope_id: scopeB,
      operation_id: `water-op-${randomUUID()}`,
      source: { kind: 'chat', external_id: sourceExternalId, revision: '1' },
      observations: [{ locator: 'message/1', content: statement, speaker: 'user' }],
    };
    const captured = await post('/v1/captures', user, captureRequest, 'water-capture');
    expect(captured.status).toBe(202);
    const capturedBody = (await captured.json()) as { job_id: string; replayed: boolean };
    const differentOperation = await post(
      '/v1/capture',
      user,
      {
        ...captureRequest,
        operation_id: `water-retry-${randomUUID()}`,
      },
      'water-capture-new-operation',
    );
    expect(differentOperation.status).toBe(202);
    expect(await differentOperation.json()).toMatchObject({ job_id: capturedBody.job_id });
    const dedupeCounts = await admin.query<{
      observations: string;
      jobs: string;
      job_observations: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM observations o JOIN sources s ON s.user_id = o.user_id AND s.scope_id = o.scope_id AND s.id = o.source_id WHERE o.user_id = $1 AND o.scope_id = $2 AND s.external_id = $3) AS observations,
         (SELECT count(*)::text FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND id = $4) AS jobs,
         (SELECT count(*)::text FROM capture_job_observations WHERE user_id = $1 AND scope_id = $2 AND job_id = $4) AS job_observations`,
      [userId, scopeB, sourceExternalId, capturedBody.job_id],
    );
    expect(dedupeCounts.rows[0]).toEqual({ observations: '1', jobs: '1', job_observations: '1' });
    const replay = await post('/v1/captures', user, captureRequest, 'water-capture');
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ job_id: capturedBody.job_id, replayed: true });
    const dispatched = await outboxDispatcher.dispatchPending();
    expect(dispatched.retrying).toBe(0);
    expect(dispatched.dispatched).toBeGreaterThan(0);
    const jobStatusResponse = await fetch(`${baseUrl}/v1/captures/${capturedBody.job_id}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(await jobStatusResponse.json()).toMatchObject({ status: 'committed' });

    const recallRequests = [
      { query: statement, mode: 'precise' },
      { query: 'boiled at 100 degrees Celsius', mode: 'contextual' },
      {
        query: statement,
        mode: 'historical',
        known_at: new Date(Date.now() + 1_000).toISOString(),
      },
      { query: 'boiled at 100 degrees Celsius', mode: 'exploratory' },
      { query: statement, mode: 'changes' },
    ] as const;
    let autoMemory: Record<string, unknown> | undefined;
    for (const request of recallRequests) {
      const response = await post('/v1/recall', user, {
        ...request,
        scope_ids: [scopeB],
        token_budget: 8_000,
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        matches: Record<string, unknown>[];
        context_pack: Record<string, unknown>;
        token_budget: number;
        estimated_tokens: number;
      };
      const found = payload.matches.find((memory) => memory['statement'] === statement);
      expect(found, `mode ${request.mode} should find the captured fact`).toBeDefined();
      if (request.mode === 'historical') expect(payload.matches[0]?.['id']).toBe(found?.['id']);
      autoMemory = found;
      expect(payload.estimated_tokens).toBeLessThanOrEqual(payload.token_budget);
      expect(Buffer.byteLength(JSON.stringify(payload.context_pack), 'utf8')).toBe(
        payload.estimated_tokens,
      );
    }
    expect(autoMemory).toMatchObject({
      lifecycle: 'active',
      attribution: { actor_kind: 'curator', authority: 'ai_proposal' },
    });
    expect((autoMemory?.['evidence'] as Record<string, unknown>[])[0]).toMatchObject({
      speaker: 'user',
      span: statement,
    });

    const irrelevant = await post('/v1/recall', user, {
      query: `zxqv-${randomUUID()} nebular-whistle-${randomUUID()}`,
      scope_ids: [scopeB],
      mode: 'contextual',
      token_budget: 8_000,
    });
    expect(await irrelevant.json()).toMatchObject({ unknown: true, matches: [] });

    const opaqueIdentifier = `a1${randomUUID().replaceAll('-', '').slice(0, 6)}`;
    const unrelatedProcedure = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: {
          kind: 'procedure',
          statement: `During calibration, close the amber valve before pressure testing ${opaqueIdentifier}.`,
          context: { procedure: { action: 'close amber valve', before: 'pressure test' } },
          evidence: [evidence(`opaque-id-procedure-${opaqueIdentifier}`)],
        },
      },
      `opaque-id-procedure-${opaqueIdentifier}`,
    );
    expect(unrelatedProcedure.status).toBe(200);
    const belowRetrievalThreshold = await post('/v1/recall', user, {
      query: `AI draft proposal ${opaqueIdentifier}-5: the zephyr buoy pulses violet twice before dawn.`,
      scope_ids: [scopeB],
      mode: 'historical',
      known_at: '2099-01-01T00:00:00.000Z',
      token_budget: 8_000,
    });
    expect(belowRetrievalThreshold.status).toBe(200);
    expect(await belowRetrievalThreshold.json()).toMatchObject({ unknown: true, matches: [] });

    const decisionExternalId = `decision-${randomUUID()}`;
    const decision = await setupCapture(
      decisionExternalId,
      'I decided to take the early train to avoid delays.',
    );
    expect(decision.status).toMatchObject({ status: 'held' });
    const reviewList = await fetch(`${baseUrl}/v1/review?scope_id=${scopeB}&status=held`, {
      headers: { authorization: `Bearer ${user}` },
    });
    const heldRows = ((await reviewList.json()) as { reviews: Record<string, unknown>[] }).reviews;
    const decisionReview = heldRows.find((row) => {
      const summary = row['candidate_summary'] as { candidates?: { statement?: string }[] };
      return (
        summary.candidates?.some(
          (candidate) =>
            candidate.statement === 'I decided to take the early train to avoid delays.',
        ) === true
      );
    });
    expect(decisionReview).toBeDefined();
    const decisionReviewId = String(decisionReview?.['id']);
    const approveBody = {
      expected_revision: 1,
      decision: 'approve',
      confirmation: 'accept_candidate',
    } as const;
    const approveKey = `decision-${randomUUID()}`;
    const accepted = await post(
      `/v1/review/${decisionReviewId}:decision`,
      user,
      approveBody,
      approveKey,
    );
    expect(accepted.status).toBe(200);
    const acceptedJson = (await accepted.json()) as Record<string, unknown>;
    const acceptedBody = acceptedJson as { operations: { memory_ids: string[] }[] };
    const acceptedId = acceptedBody.operations[0]!.memory_ids[0]!;
    const acceptedReplay = await post(
      `/v1/review/${decisionReviewId}:decision`,
      user,
      approveBody,
      approveKey,
    );
    expect(acceptedReplay.status).toBe(200);
    const acceptedReplayJson = (await acceptedReplay.json()) as Record<string, unknown>;
    const responseResult = (value: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'request_id' && key !== 'trace_id'),
      );
    expect(responseResult(acceptedReplayJson)).toEqual(responseResult(acceptedJson));
    const changedApproveReplay = await post(
      `/v1/review/${decisionReviewId}:decision`,
      user,
      { ...approveBody, reason: 'A different decision request.' },
      approveKey,
    );
    expect(changedApproveReplay.status).toBe(409);
    expect(await changedApproveReplay.json()).toMatchObject({
      error: { code: 'idempotency_conflict' },
    });
    const otherOwner = await token([scopeB], 'memory:read memory:write', recoveryUserSubject);
    const otherPrincipalReplay = await post(
      `/v1/review/${decisionReviewId}:decision`,
      otherOwner,
      approveBody,
      approveKey,
    );
    expect(otherPrincipalReplay.status).toBe(409);
    expect(await otherPrincipalReplay.json()).toMatchObject({
      error: { code: 'review_revision_conflict' },
    });
    const acceptedView = await fetch(`${baseUrl}/v1/memories/${acceptedId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(await acceptedView.json()).toMatchObject({
      lifecycle: 'active',
      attribution: { actor_kind: 'curator', authority: 'ai_proposal' },
    });
    const revokedDecisionSource = await post('/v1/connectors', user, {
      scope_id: scopeB,
      source_kind: 'chat',
      external_id: decisionExternalId,
      enabled: false,
      consent: false,
    });
    expect(revokedDecisionSource.status).toBe(200);
    const revokedSourceReplay = await post(
      `/v1/review/${decisionReviewId}:decision`,
      user,
      approveBody,
      approveKey,
    );
    expect(revokedSourceReplay.status).toBe(403);
    expect(await revokedSourceReplay.json()).toMatchObject({
      error: { code: 'source_not_authorized' },
    });

    const preference = await setupCapture(
      `preference-${randomUUID()}`,
      'I prefer quiet mornings for focused work.',
    );
    expect(preference.status).toMatchObject({ status: 'held' });
    const preferenceRows = (
      (await (
        await fetch(`${baseUrl}/v1/review?scope_id=${scopeB}&status=held`, {
          headers: { authorization: `Bearer ${user}` },
        })
      ).json()) as { reviews: Record<string, unknown>[] }
    ).reviews;
    const preferenceReview = preferenceRows.find((row) => {
      const summary = row['candidate_summary'] as { candidates?: { statement?: string }[] };
      return (
        summary.candidates?.some(
          (candidate) => candidate.statement === 'I prefer quiet mornings for focused work.',
        ) === true
      );
    });
    expect(preferenceReview).toBeDefined();
    const confirmed = await post(
      `/v1/review/${String(preferenceReview?.['id'])}:decision`,
      user,
      {
        expected_revision: 1,
        decision: 'approve',
        confirmation: 'user_statement',
      },
      `preference-${randomUUID()}`,
    );
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as { operations: { memory_ids: string[] }[] };
    const confirmedId = confirmedBody.operations[0]!.memory_ids[0]!;
    const confirmedViewResponse = await fetch(
      `${baseUrl}/v1/memories/${confirmedId}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    const confirmedView = (await confirmedViewResponse.json()) as Record<string, unknown>;
    expect(confirmedView).toMatchObject({
      attribution: { actor_kind: 'curator', authority: 'user_preference' },
    });
    expect((confirmedView['evidence'] as Record<string, unknown>[])[0]).toMatchObject({
      speaker: 'user',
    });
    const confirmations = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_confirmations WHERE user_id = $1 AND scope_id = $2 AND memory_ids @> ARRAY[$3::uuid]`,
      [userId, scopeB, confirmedId],
    );
    expect(confirmations.rows[0]!.count).toBe('1');

    const oldCaptureReplay = await post(
      '/v1/captures',
      user,
      {
        scope_id: scopeB,
        operation_id: `reprocess-old-${randomUUID()}`,
        source: preference.source,
        observations: [{ locator: 'message/1', content: preference.content, speaker: 'user' }],
      },
      `reprocess-old-${randomUUID()}`,
    );
    expect(oldCaptureReplay.status).toBe(202);
    expect(await oldCaptureReplay.json()).toMatchObject({ job_id: preference.job_id });
    const afterOldCaptureReplay = await fetch(
      `${baseUrl}/v1/memories/${confirmedId}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(await afterOldCaptureReplay.json()).toMatchObject({
      revision: confirmedView['revision'],
      attribution: { authority: 'user_preference' },
    });

    const preexistingStatement = 'I prefer a paper planner for daily tasks.';
    const existing = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: {
          kind: 'preference',
          statement: preexistingStatement,
          epistemic_status: 'asserted',
          evidence: [evidence(`manual-${randomUUID()}`)],
        },
      },
      `manual-preference-${randomUUID()}`,
    );
    expect(existing.status).toBe(200);
    const existingBody = (await existing.json()) as {
      operations: { memory_ids: string[]; revisions: number[] }[];
    };
    const existingId = existingBody.operations[0]!.memory_ids[0]!;
    const reconciliation = await setupCapture(`reconcile-${randomUUID()}`, preexistingStatement);
    expect(reconciliation.status).toMatchObject({ status: 'held' });
    const reconciliationRows = (
      (await (
        await fetch(`${baseUrl}/v1/review?scope_id=${scopeB}&status=held`, {
          headers: { authorization: `Bearer ${user}` },
        })
      ).json()) as { reviews: Record<string, unknown>[] }
    ).reviews;
    const reconciliationReview = reconciliationRows.find((row) => {
      const summary = row['candidate_summary'] as {
        candidates?: { statement?: string; candidate_matches?: { id?: string }[] }[];
      };
      return (
        summary.candidates?.some(
          (candidate) =>
            candidate.statement === preexistingStatement &&
            candidate.candidate_matches?.some((match) => match.id === existingId),
        ) === true
      );
    });
    expect(reconciliationReview).toBeDefined();
    const unsafeApproval = await post(
      `/v1/review/${String(reconciliationReview?.['id'])}:decision`,
      user,
      {
        expected_revision: 1,
        decision: 'approve',
        confirmation: 'accept_candidate',
      },
      `unsafe-reconcile-${randomUUID()}`,
    );
    expect(unsafeApproval.status).toBe(409);
    expect(await unsafeApproval.json()).toMatchObject({
      error: { code: 'manual_reconciliation_required' },
    });
    const reconciliationReviewId = String(reconciliationReview?.['id']);
    const rejectBody = {
      expected_revision: 1,
      decision: 'reject',
      reason: 'Resolve with a Core CORROBORATE operation.',
    } as const;
    const rejectKey = `reject-reconcile-${randomUUID()}`;
    const rejected = await post(
      `/v1/review/${reconciliationReviewId}:decision`,
      user,
      rejectBody,
      rejectKey,
    );
    expect(rejected.status).toBe(200);
    const rejectedJson = (await rejected.json()) as Record<string, unknown>;
    const rejectedReplay = await post(
      `/v1/review/${reconciliationReviewId}:decision`,
      user,
      rejectBody,
      rejectKey,
    );
    expect(rejectedReplay.status).toBe(200);
    expect(await rejectedReplay.json()).toMatchObject({
      review_id: reconciliationReviewId,
      scope_id: rejectedJson['scope_id'],
      status: 'rejected',
    });
    const changedRejectReplay = await post(
      `/v1/review/${reconciliationReviewId}:decision`,
      user,
      { ...rejectBody, reason: 'A different rejection reason.' },
      rejectKey,
    );
    expect(changedRejectReplay.status).toBe(409);
    expect(await changedRejectReplay.json()).toMatchObject({
      error: { code: 'idempotency_conflict' },
    });
    const corroborationEvidence = {
      source: {
        kind: 'chat',
        external_id: `reconcile-${String(reconciliation.status['job_id'])}`,
        revision: '1',
        locator: 'message/1',
      },
      span: preexistingStatement,
      snippet: preexistingStatement,
      snippet_allowed: true,
      speaker: 'user',
    };
    const sourceExternal = await admin.query<{ external_id: string }>(
      `SELECT s.external_id FROM capture_jobs j JOIN sources s ON s.user_id = j.user_id AND s.scope_id = j.scope_id AND s.id = j.source_id WHERE j.id = $1`,
      [reconciliation.status['job_id']],
    );
    corroborationEvidence.source.external_id = sourceExternal.rows[0]!.external_id;
    const proposed = await post(
      '/v1/changesets',
      user,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'CORROBORATE',
            memory_id: existingId,
            expected_revision: 1,
            evidence: [corroborationEvidence],
          },
        ],
      },
      `manual-corroborate-${randomUUID()}`,
    );
    expect(proposed.status).toBe(200);
    const proposedBody = (await proposed.json()) as { change_set_id: string };
    const committed = await post(
      `/v1/changesets/${proposedBody.change_set_id}:commit`,
      user,
      {},
      `manual-corroborate-commit-${randomUUID()}`,
    );
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ operations: [{ revisions: [2] }] });
  }, 40_000);

  it('reprocesses an old Observation under a new prompt/model generation without changing an User decision', async () => {
    const generationScope = randomUUID();
    await admin.query('INSERT INTO scopes(user_id, id, name) VALUES ($1, $2, $3)', [
      userId,
      generationScope,
      'isolated-reprocess-generation',
    ]);
    await admin.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES ($1, $2, $3, ARRAY['read', 'write', 'admin'])`,
      [userId, generationScope, principalId],
    );
    const user = await token([generationScope], 'memory:read memory:write');
    const externalId = `generation-reprocess-${randomUUID()}`;
    const statement = `I prefer a quiet workspace for focused planning ${randomUUID()}.`;
    const configured = await post('/v1/connectors', user, {
      scope_id: generationScope,
      source_kind: 'chat',
      external_id: externalId,
      enabled: true,
      consent: true,
    });
    expect(configured.status).toBe(200);
    const payload = {
      scope_id: generationScope,
      operation_id: `generation-v1-${randomUUID()}`,
      source: { kind: 'chat', external_id: externalId, revision: '1' },
      observations: [{ locator: 'message/1', content: statement, speaker: 'user' }],
    };
    const originalCapture = await post(
      '/v1/captures',
      user,
      payload,
      `generation-v1-${randomUUID()}`,
    );
    expect(originalCapture.status).toBe(202);
    const originalJobId = ((await originalCapture.json()) as { job_id: string }).job_id;
    const originalProcessor = new CaptureJobProcessor(
      workerDb,
      workerCore,
      workerRecall,
      new LocalDeterministicCuratorProvider(),
    );
    expect(await originalProcessor.process(originalJobId)).toMatchObject({
      status: 'held',
      job_id: originalJobId,
    });

    const heldResponse = await fetch(
      `${baseUrl}/v1/review?scope_id=${generationScope}&status=held`,
      {
        headers: { authorization: `Bearer ${user}` },
      },
    );
    const heldReviews = (
      (await heldResponse.json()) as {
        reviews: Record<string, unknown>[];
      }
    ).reviews;
    const originalReview = heldReviews.find((row) => {
      const summary = row['candidate_summary'] as { candidates?: { statement?: string }[] };
      return summary.candidates?.some((candidate) => candidate.statement === statement) === true;
    });
    expect(originalReview).toBeDefined();
    const accepted = await post(
      `/v1/review/${String(originalReview?.['id'])}:decision`,
      user,
      { expected_revision: 1, decision: 'approve', confirmation: 'user_statement' },
      `generation-owner-confirm-${randomUUID()}`,
    );
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(200);
    const acceptedBody = (await accepted.json()) as {
      operations: { memory_ids: string[]; revisions: number[] }[];
    };
    const memoryId = acceptedBody.operations[0]!.memory_ids[0]!;
    expect(acceptedBody.operations[0]!.revisions).toEqual([1]);
    const beforeReprocessResponse = await fetch(
      `${baseUrl}/v1/memories/${memoryId}?scope_id=${generationScope}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    const beforeReprocess = (await beforeReprocessResponse.json()) as Record<string, unknown>;
    expect(beforeReprocess).toMatchObject({
      revision: 1,
      statement,
      attribution: { authority: 'user_preference' },
    });

    const actor = await authenticator.authenticate(`Bearer ${user}`);
    const nextGeneration = new ConnectorService(app, {
      promptGeneration: 'curator-v2-reprocess-test',
      modelId: 'local-fake-v2-reprocess-test',
      forgetHmacKey,
    });
    const nextCapture = await nextGeneration.capture(
      actor,
      { ...payload, operation_id: `generation-v2-${randomUUID()}` },
      `generation-v2-${randomUUID()}`,
      randomUUID(),
    );
    const nextJobId = String(nextCapture['job_id']);
    expect(nextCapture).toMatchObject({ status: 'accepted', replayed: false });
    expect(nextJobId).not.toBe(originalJobId);

    const jobGenerations = await admin.query<{
      id: string;
      prompt_generation: string;
      model_id: string;
      request_hash: string;
    }>(
      `SELECT id, prompt_generation, model_id, request_hash
       FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND id = ANY($3::uuid[])
       ORDER BY prompt_generation`,
      [userId, generationScope, [originalJobId, nextJobId]],
    );
    expect(jobGenerations.rows).toHaveLength(2);
    expect(jobGenerations.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: originalJobId,
          prompt_generation: 'curator-v1',
          model_id: 'local-fake-v1',
        }),
        expect.objectContaining({
          id: nextJobId,
          prompt_generation: 'curator-v2-reprocess-test',
          model_id: 'local-fake-v2-reprocess-test',
        }),
      ]),
    );
    expect(jobGenerations.rows[0]!.request_hash).not.toBe(jobGenerations.rows[1]!.request_hash);

    let providerInput: { promptVersion: string; modelId: string } | undefined;
    const localV2Base = new LocalDeterministicCuratorProvider();
    const localV2Provider: CuratorProvider = {
      async extract(input) {
        providerInput = { promptVersion: input.promptVersion, modelId: input.modelId };
        const result = await localV2Base.extract(input);
        return {
          ...result,
          modelVersion: input.modelId,
          promptVersion: input.promptVersion,
        };
      },
    };
    const nextProcessor = new CaptureJobProcessor(
      workerDb,
      workerCore,
      workerRecall,
      localV2Provider,
    );
    expect(await nextProcessor.process(nextJobId)).toMatchObject({
      status: 'held',
      job_id: nextJobId,
    });
    expect(providerInput).toEqual({
      promptVersion: 'curator-v2-reprocess-test',
      modelId: 'local-fake-v2-reprocess-test',
    });
    const processedGeneration = await admin.query<{
      state: string;
      prompt_generation: string;
      model_id: string;
      result_prompt: string;
      result_model: string;
    }>(
      `SELECT state, prompt_generation, model_id,
         checkpoint->'curator_result'->>'promptVersion' AS result_prompt,
         checkpoint->'curator_result'->>'modelVersion' AS result_model
       FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND id = $3`,
      [userId, generationScope, nextJobId],
    );
    expect(processedGeneration.rows[0]).toEqual({
      state: 'held',
      prompt_generation: 'curator-v2-reprocess-test',
      model_id: 'local-fake-v2-reprocess-test',
      result_prompt: 'curator-v2-reprocess-test',
      result_model: 'local-fake-v2-reprocess-test',
    });

    const afterReprocessResponse = await fetch(
      `${baseUrl}/v1/memories/${memoryId}?scope_id=${generationScope}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(await afterReprocessResponse.json()).toMatchObject({
      id: memoryId,
      revision: beforeReprocess['revision'],
      statement: beforeReprocess['statement'],
      attribution: { authority: 'user_preference' },
    });
    const preservedDecision = await admin.query<{
      revisions: string;
      evidence_rows: string;
      user_confirmations: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM memory_versions WHERE user_id = $1 AND scope_id = $2 AND memory_id = $3) AS revisions,
         (SELECT count(*)::text FROM memory_version_evidence WHERE user_id = $1 AND scope_id = $2 AND memory_id = $3) AS evidence_rows,
         (SELECT count(*)::text FROM user_confirmations WHERE user_id = $1 AND scope_id = $2 AND memory_ids @> ARRAY[$3::uuid]) AS user_confirmations`,
      [userId, generationScope, memoryId],
    );
    expect(preservedDecision.rows[0]).toEqual({
      revisions: '1',
      evidence_rows: '1',
      user_confirmations: '1',
    });
  }, 40_000);

  it('holds a partial fact proposal from an episode instead of auto-committing it', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const externalId = `episode-partial-${randomUUID()}`;
    const action = `opened a violet hatch ${randomUUID()}`;
    const content = JSON.stringify({
      condition: { weather: 'rain' },
      action,
      outcome: 'the room dried',
    });
    const configured = await post('/v1/connectors', user, {
      scope_id: scopeB,
      source_kind: 'episode',
      external_id: externalId,
      enabled: true,
      consent: true,
    });
    expect(configured.status).toBe(200);
    const captured = await post(
      '/v1/captures',
      user,
      {
        scope_id: scopeB,
        operation_id: `episode-op-${randomUUID()}`,
        source: { kind: 'episode', external_id: externalId, revision: '1' },
        observations: [{ locator: 'episode/1', content, speaker: 'user' }],
      },
      `episode-capture-${randomUUID()}`,
    );
    expect(captured.status).toBe(202);
    const captureBody = (await captured.json()) as { job_id: string };
    const jobId = captureBody.job_id;

    const partialFactProvider: CuratorProvider = {
      async extract({ observations }) {
        const observation = observations[0];
        if (observation === undefined) throw new Error('Episode fixture observation is missing');
        const spanStart = observation.content.indexOf(action);
        const spanEnd = spanStart + action.length;
        return {
          proposals: [
            {
              kind: 'fact',
              statement: action,
              context: {},
              subjects: [],
              valid_from: null,
              valid_to: null,
              epistemic_status: 'inferred',
              contested: false,
              anchors: [
                { observation_id: observation.id, span_start: spanStart, span_end: spanEnd },
              ],
              rationale: 'Provider returned only the action sentence.',
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
          modelVersion: 'partial-episode-test',
          promptVersion: 'test-v1',
        };
      },
    };
    const processor = new CaptureJobProcessor(
      workerDb,
      workerCore,
      new RecallService(workerDb, workerCore, new LocalDeterministicEmbeddingProvider()),
      partialFactProvider,
      { maxProviderMs: 5_000 },
    );
    const processed = await processor.process(jobId);
    expect(processed).toMatchObject({ status: 'held', job_id: jobId });
    const jobState = await admin.query<{ state: string; last_error_code: string | null }>(
      `SELECT j.state, j.last_error_code
       FROM capture_jobs j JOIN sources s ON s.user_id = j.user_id AND s.scope_id = j.scope_id AND s.id = j.source_id
       WHERE j.user_id = $1 AND j.scope_id = $2 AND s.external_id = $3`,
      [userId, scopeB, externalId],
    );
    expect(jobState.rows[0]).toEqual({
      state: 'held',
      last_error_code: 'invalid_episode_structure',
    });
    const committedMemories = await admin.query<{ count: string; reviews: string }>(
      `SELECT
         (SELECT count(DISTINCT m.id)::text FROM memories m
          JOIN memory_evidence me ON me.user_id = m.user_id AND me.scope_id = m.scope_id AND me.memory_id = m.id
          JOIN evidence e ON e.user_id = me.user_id AND e.scope_id = me.scope_id AND e.id = me.evidence_id
          JOIN observations o ON o.user_id = e.user_id AND o.scope_id = e.scope_id AND o.id = e.observation_id
          JOIN sources s ON s.user_id = o.user_id AND s.scope_id = o.scope_id AND s.id = o.source_id
          WHERE m.user_id = $1 AND m.scope_id = $2 AND s.external_id = $3) AS count,
         (SELECT count(*)::text FROM curation_reviews r WHERE r.user_id = $1 AND r.scope_id = $2 AND r.job_id = $4) AS reviews`,
      [userId, scopeB, externalId, jobId],
    );
    expect(committedMemories.rows[0]).toEqual({ count: '0', reviews: '0' });
  }, 40_000);

  it('resumes a checkpoint after a transient failure and commits one evidence row once', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const externalId = `retry-${randomUUID()}`;
    const statement = 'The integration worker resumes from its saved extraction checkpoint.';
    const configured = await post('/v1/connectors', user, {
      scope_id: scopeB,
      source_kind: 'chat',
      external_id: externalId,
      enabled: true,
      consent: true,
    });
    expect(configured.status).toBe(200);
    const captured = await post(
      '/v1/captures',
      user,
      {
        scope_id: scopeB,
        operation_id: `retry-op-${randomUUID()}`,
        source: { kind: 'chat', external_id: externalId, revision: '1' },
        observations: [{ locator: 'message/1', content: statement, speaker: 'user' }],
      },
      `retry-capture-${randomUUID()}`,
    );
    const { job_id: jobId } = (await captured.json()) as { job_id: string };

    const provider = new LocalDeterministicCuratorProvider();
    const extract = vi.spyOn(provider, 'extract');
    const recall = new RecallService(
      workerDb,
      workerCore,
      new LocalDeterministicEmbeddingProvider(),
    );
    const search = recall.searchCandidates.bind(recall);
    let searchCalls = 0;
    vi.spyOn(recall, 'searchCandidates').mockImplementation(async (...args) => {
      searchCalls += 1;
      if (searchCalls === 2) throw new Error('transient local recall failure after checkpoint');
      return search(...args);
    });
    const processor = new CaptureJobProcessor(workerDb, workerCore, recall, provider, {
      retryBaseSeconds: 1,
    });
    const firstAttempt = await processor.process(jobId);
    const checkpoint = await admin.query<{
      state: string;
      last_error_code: string | null;
      checkpoint: Record<string, unknown>;
    }>(
      'SELECT state, last_error_code, checkpoint FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND id = $3',
      [userId, scopeB, jobId],
    );
    expect(firstAttempt, JSON.stringify(checkpoint.rows[0])).toMatchObject({
      status: 'failed',
      job_id: jobId,
    });
    expect(checkpoint.rows[0]?.state).toBe('failed');
    expect(checkpoint.rows[0]?.checkpoint['curator_result']).toBeDefined();
    await admin.query(
      "UPDATE capture_jobs SET next_retry_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    expect(await processor.process(jobId)).toMatchObject({ status: 'committed', job_id: jobId });
    expect(extract).toHaveBeenCalledTimes(1);
    const committed = await admin.query<{ memories: string; evidence: string }>(
      `SELECT count(DISTINCT m.id)::text AS memories, count(mve.evidence_id)::text AS evidence
       FROM memories m LEFT JOIN memory_version_evidence mve
         ON mve.user_id = m.user_id AND mve.scope_id = m.scope_id AND mve.memory_id = m.id
       WHERE m.user_id = $1 AND m.scope_id = $2 AND m.statement = $3`,
      [userId, scopeB, statement],
    );
    expect(committed.rows[0]).toEqual({ memories: '1', evidence: '1' });
  });

  it('refuses to resume a saved extraction checkpoint after source consent is revoked', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const externalId = `revoked-retry-${randomUUID()}`;
    const statement = 'A copper label marks the archive box.';
    const configured = await post('/v1/connectors', user, {
      scope_id: scopeB,
      source_kind: 'chat',
      external_id: externalId,
      enabled: true,
      consent: true,
    });
    expect(configured.status).toBe(200);
    const captured = await post(
      '/v1/captures',
      user,
      {
        scope_id: scopeB,
        operation_id: `revoked-op-${randomUUID()}`,
        source: { kind: 'chat', external_id: externalId, revision: '1' },
        observations: [{ locator: 'message/1', content: statement, speaker: 'user' }],
      },
      `revoked-capture-${randomUUID()}`,
    );
    const { job_id: jobId } = (await captured.json()) as { job_id: string };
    const provider = new LocalDeterministicCuratorProvider();
    const recall = new RecallService(
      workerDb,
      workerCore,
      new LocalDeterministicEmbeddingProvider(),
    );
    const search = recall.searchCandidates.bind(recall);
    let searchCalls = 0;
    vi.spyOn(recall, 'searchCandidates').mockImplementation(async (...args) => {
      searchCalls += 1;
      if (searchCalls === 2) throw new Error('pause after extraction checkpoint');
      return search(...args);
    });
    const processor = new CaptureJobProcessor(workerDb, workerCore, recall, provider, {
      retryBaseSeconds: 1,
    });
    const firstAttempt = await processor.process(jobId);
    const firstCheckpoint = await admin.query<{
      state: string;
      last_error_code: string | null;
      checkpoint: Record<string, unknown>;
    }>(
      'SELECT state, last_error_code, checkpoint FROM capture_jobs WHERE user_id = $1 AND scope_id = $2 AND id = $3',
      [userId, scopeB, jobId],
    );
    expect(firstAttempt, JSON.stringify(firstCheckpoint.rows[0])).toMatchObject({
      status: 'failed',
      job_id: jobId,
    });
    const revoked = await post('/v1/connectors', user, {
      scope_id: scopeB,
      source_kind: 'chat',
      external_id: externalId,
      enabled: false,
      consent: false,
    });
    expect(revoked.status).toBe(200);
    await admin.query(
      "UPDATE capture_jobs SET next_retry_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    expect(await processor.process(jobId)).toMatchObject({ status: 'held', job_id: jobId });
    const state = await admin.query<{ state: string; curator_result: unknown; memories: string }>(
      `SELECT j.state, j.checkpoint->'curator_result' AS curator_result,
         (SELECT count(*)::text FROM memories m WHERE m.user_id = j.user_id AND m.scope_id = j.scope_id AND m.statement = $4) AS memories
       FROM capture_jobs j WHERE j.user_id = $1 AND j.scope_id = $2 AND j.id = $3`,
      [userId, scopeB, jobId, statement],
    );
    expect(state.rows[0]).toMatchObject({ state: 'held', memories: '0' });
    expect(state.rows[0]?.curator_result).toBeDefined();
  });

  it('fences stale job workers from committing after a lease has been stolen', async () => {
    const user = await token([scopeB], 'memory:read memory:write');
    const externalId = `lease-${randomUUID()}`;
    const configured = await post('/v1/connectors', user, {
      scope_id: scopeB,
      source_kind: 'chat',
      external_id: externalId,
      enabled: true,
      consent: true,
    });
    expect(configured.status).toBe(200);
    const statement = 'The test runner uses PostgreSQL for integration.';
    const captured = await post(
      '/v1/captures',
      user,
      {
        scope_id: scopeB,
        operation_id: `lease-op-${randomUUID()}`,
        source: { kind: 'chat', external_id: externalId, revision: '1' },
        observations: [{ locator: 'message/1', content: statement, speaker: 'user' }],
      },
      `lease-capture-${randomUUID()}`,
    );
    const capturedBody = (await captured.json()) as { job_id: string };
    const oldLease = randomUUID();
    const oldClaim = await workerDb.query(
      'SELECT * FROM app.claim_capture_job($1::uuid, $2::uuid, 120)',
      [capturedBody.job_id, oldLease],
    );
    expect(oldClaim.rowCount).toBe(1);
    await admin.query(
      "UPDATE capture_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
      [capturedBody.job_id],
    );
    const newLease = randomUUID();
    const newClaim = await workerDb.query(
      'SELECT * FROM app.claim_capture_job($1::uuid, $2::uuid, 120)',
      [capturedBody.job_id, newLease],
    );
    expect(newClaim.rowCount).toBe(1);
    const observation = await admin.query<{ id: string; locator: string }>(
      `SELECT o.id, o.locator FROM observations o JOIN capture_job_observations jo
       ON jo.user_id = o.user_id AND jo.scope_id = o.scope_id AND jo.observation_id = o.id WHERE jo.job_id = $1`,
      [capturedBody.job_id],
    );
    const actor = await authenticator.authenticate(`Bearer ${user}`);
    const staleWrite = workerCore.commitCuratedFacts(
      actor,
      scopeB,
      [
        {
          memory: {
            kind: 'fact',
            statement,
            context: {},
            subjects: [],
            valid_from: null,
            valid_to: null,
            epistemic_status: 'inferred',
            contested: false,
            evidence: [
              {
                source: {
                  kind: 'chat',
                  external_id: externalId,
                  revision: '1',
                  locator: observation.rows[0]!.locator,
                },
                span: statement,
                snippet: statement,
                snippet_allowed: true,
                speaker: 'user',
              },
            ],
          },
          anchors: [
            { observationId: observation.rows[0]!.id, spanStart: 0, spanEnd: statement.length },
          ],
        },
      ],
      randomUUID(),
      `stale-worker-${randomUUID()}`,
      { jobId: capturedBody.job_id, leaseToken: oldLease },
    );
    await expect(staleWrite).rejects.toMatchObject({ code: 'job_lease_lost' });
    const written = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memories WHERE user_id = $1 AND scope_id = $2 AND statement = $3',
      [userId, scopeB, statement],
    );
    expect(written.rows[0]!.count).toBe('0');
    await admin.query(
      "UPDATE capture_jobs SET state = 'held', lease_token = NULL, lease_until = NULL WHERE id = $1",
      [capturedBody.job_id],
    );
  });

  it('denies forgotten content immediately, then purges only its own memory and review after a worker ledger ACK', async () => {
    await admin.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES ($1, $2, $3, ARRAY['read', 'write', 'admin'])
       ON CONFLICT (user_id, scope_id, principal_id) DO UPDATE
         SET capabilities = EXCLUDED.capabilities, updated_at = clock_timestamp()`,
      [userId, scopeB, principalId],
    );
    const user = await token([scopeB], 'memory:admin');
    const createMemory = async (externalId: string) => {
      const response = await post(
        '/v1/memories:remember',
        user,
        {
          scope_id: scopeB,
          memory: { ...sampleMemory(), evidence: [evidence(externalId)] },
        },
        `governance-create-${externalId}`,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        change_set_id: string;
        operations: { memory_ids: string[] }[];
      };
    };
    const forgotten = await createMemory(`forget-a-${randomUUID()}`);
    const retained = await createMemory(`forget-b-${randomUUID()}`);
    const memoryA = forgotten.operations[0]!.memory_ids[0]!;
    const memoryB = retained.operations[0]!.memory_ids[0]!;
    const sourceIds = await admin.query<{ memory_id: string; source_id: string }>(
      `SELECT me.memory_id, e.source_id FROM memory_evidence me JOIN evidence e
       ON e.user_id=me.user_id AND e.scope_id=me.scope_id AND e.id=me.evidence_id
       WHERE me.user_id=$1 AND me.scope_id=$2 AND me.memory_id=ANY($3::uuid[])`,
      [userId, scopeB, [memoryA, memoryB]],
    );
    const sourceA = sourceIds.rows.find((row) => row.memory_id === memoryA)?.source_id;
    const sourceB = sourceIds.rows.find((row) => row.memory_id === memoryB)?.source_id;
    expect(sourceA).toBeDefined();
    expect(sourceB).toBeDefined();

    const makeReview = async (
      sourceId: string,
      changeSetId: string,
      memoryId: string,
      text: string,
    ) => {
      const jobId = randomUUID();
      const reviewId = randomUUID();
      await admin.query(
        `INSERT INTO capture_jobs(id, user_id, scope_id, source_id, state, principal_id, actor_kind, checkpoint)
         VALUES ($1, $2, $3, $4, 'held', $5, 'user', $6::jsonb)`,
        [
          jobId,
          userId,
          scopeB,
          sourceId,
          principalId,
          JSON.stringify({ curator_result: { text } }),
        ],
      );
      await admin.query(
        `INSERT INTO curation_reviews(id, user_id, scope_id, job_id, change_set_id,
           rationale, candidate_summary, evidence_anchors)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '[]'::jsonb)`,
        [
          reviewId,
          userId,
          scopeB,
          jobId,
          changeSetId,
          `review ${text}`,
          JSON.stringify({ statement: text }),
        ],
      );
      await admin.query(
        `INSERT INTO user_confirmations(user_id, scope_id, review_id, principal_id, confirmation_type, memory_ids)
         VALUES ($1, $2, $3, $4, 'user_statement', $5::uuid[])`,
        [userId, scopeB, reviewId, principalId, [memoryId]],
      );
      return reviewId;
    };
    const reviewA = await makeReview(
      sourceA!,
      forgotten.change_set_id,
      memoryA,
      'forgotten private statement',
    );
    const reviewB = await makeReview(
      sourceB!,
      retained.change_set_id,
      memoryB,
      'retained unrelated statement',
    );

    const request = await post(
      '/v1/forget',
      user,
      {
        scope_id: scopeB,
        selector: { memory_ids: [memoryA] },
        reason_code: 'user_requested',
      },
      `forget-${randomUUID()}`,
    );
    expect(request.status).toBe(202);
    const result = (await request.json()) as {
      forget_request_id: string;
      status: string;
      ledger_durable: boolean;
    };
    expect(result).toMatchObject({ status: 'ledger_pending', ledger_durable: true });

    const immediateRead = await fetch(`${baseUrl}/v1/memories/${memoryA}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(immediateRead.status).toBe(404);
    const actor = await authenticator.authenticate(`Bearer ${user}`);
    await expect(coreService.getMemory(actor, scopeB, memoryA, {})).rejects.toMatchObject({
      status: 404,
    });
    const retainedRead = await fetch(`${baseUrl}/v1/memories/${memoryB}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(retainedRead.status).toBe(200);
    await expect(coreService.getMemory(actor, scopeB, memoryB, {})).resolves.toBeDefined();

    const sweep = await fetch(`${workerBaseUrl}/internal/governance/sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${workerTaskToken}` },
    });
    expect(sweep.status).toBe(200);
    expect(await sweep.json()).toMatchObject({ purged: 1, pending: 0, exports: 0, failed: 0 });

    const remaining = await admin.query<{
      memory_a: string;
      memory_b: string;
      versions_a: string;
      evidence_a: string;
      review_a: string;
      review_b: string;
      confirmation_a: string;
      confirmation_b: string;
      review_b_payload: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$3) AS memory_a,
         (SELECT count(*)::text FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$4) AS memory_b,
         (SELECT count(*)::text FROM memory_versions WHERE user_id=$1 AND scope_id=$2 AND memory_id=$3) AS versions_a,
         (SELECT count(*)::text FROM evidence e JOIN memory_evidence me ON me.user_id=e.user_id
           AND me.scope_id=e.scope_id AND me.evidence_id=e.id WHERE me.user_id=$1 AND me.scope_id=$2
           AND me.memory_id=$3) AS evidence_a,
         (SELECT count(*)::text FROM curation_reviews WHERE user_id=$1 AND scope_id=$2 AND id=$5) AS review_a,
         (SELECT count(*)::text FROM curation_reviews WHERE user_id=$1 AND scope_id=$2 AND id=$6) AS review_b,
         (SELECT count(*)::text FROM user_confirmations WHERE user_id=$1 AND scope_id=$2 AND review_id=$5) AS confirmation_a,
         (SELECT count(*)::text FROM user_confirmations WHERE user_id=$1 AND scope_id=$2 AND review_id=$6) AS confirmation_b,
         (SELECT candidate_summary->>'statement' FROM curation_reviews WHERE user_id=$1 AND scope_id=$2 AND id=$6) AS review_b_payload`,
      [userId, scopeB, memoryA, memoryB, reviewA, reviewB],
    );
    expect(remaining.rows[0]).toEqual({
      memory_a: '0',
      memory_b: '1',
      versions_a: '0',
      evidence_a: '0',
      review_a: '0',
      review_b: '1',
      confirmation_a: '0',
      confirmation_b: '1',
      review_b_payload: 'retained unrelated statement',
    });
    const retainedReadAfterAck = await fetch(
      `${baseUrl}/v1/memories/${memoryB}?scope_id=${scopeB}`,
      {
        headers: { authorization: `Bearer ${user}` },
      },
    );
    expect(retainedReadAfterAck.status).toBe(200);
    const purgedApiRead = await fetch(`${baseUrl}/v1/memories/${memoryA}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(purgedApiRead.status).toBe(404);
    const forgetStatus = await fetch(
      `${baseUrl}/v1/forget/${result.forget_request_id}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(forgetStatus.status, await forgetStatus.clone().text()).toBe(200);
    expect(await forgetStatus.json()).toMatchObject({
      forget_request_id: result.forget_request_id,
      status: 'complete',
      content_available: false,
    });
    await expect(governance.verifyLedgerReadiness()).resolves.toBeUndefined();
  }, 40_000);

  it('replays ledger entries for a missing original principal and repeats when the HEAD advances during restore', async () => {
    const ledger = deletionLedger;
    const original = ledger.readSnapshot.bind(ledger);
    const user = await token([scopeB], 'memory:admin');
    const retainedStatement = `restore gate retained memory ${randomUUID()}`;
    const retainedCreated = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: {
          ...sampleMemory(),
          statement: retainedStatement,
          evidence: [evidence(`restore-gate-${randomUUID()}`)],
        },
      },
      `restore-gate-${randomUUID()}`,
    );
    expect(retainedCreated.status).toBe(200);
    const retainedId = (
      (await retainedCreated.json()) as { operations: { memory_ids: string[] }[] }
    ).operations[0]!.memory_ids[0]!;
    const preexistingEntry = {
      request_id: randomUUID(),
      user_id: userId,
      scope_id: scopeB,
      principal_id: principalId,
      actor_kind: 'user' as const,
      target_memory_ids: [randomUUID()],
      target_source_ids: [],
      target_subject_ids: [],
      source_locator_hmacs: [],
      blocked_at: new Date().toISOString(),
    };
    await ledger.append(preexistingEntry);
    await expect(governance.verifyLedgerReadiness()).rejects.toThrow(
      /suppressions are not applied/,
    );
    const blockedGet = await fetch(`${baseUrl}/v1/memories/${retainedId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(blockedGet.status).toBe(503);
    const blockedRecall = await fetch(`${baseUrl}/v1/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: retainedStatement, scope_id: scopeB }),
    });
    expect(blockedRecall.status).toBe(503);
    const blockedMcp = await fetch(`${baseUrl}/mcp/read`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token([scopeB], 'memory:read', subject, mcpReadAudience)}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'restore-gate', version: '1' },
        },
      }),
    });
    expect(blockedMcp.status).toBe(503);
    const unknownPrincipalEntry = {
      request_id: randomUUID(),
      user_id: userId,
      scope_id: scopeB,
      principal_id: randomUUID(),
      actor_kind: 'user' as const,
      target_memory_ids: [randomUUID()],
      target_source_ids: [],
      target_subject_ids: [],
      source_locator_hmacs: [],
      blocked_at: new Date().toISOString(),
    };
    const readSnapshot = vi.spyOn(ledger, 'readSnapshot').mockImplementationOnce(async () => {
      const snapshot = await original();
      await ledger.append(unknownPrincipalEntry);
      return snapshot;
    });
    const restored = await governance.applyLedgerForRestore(workerDb);
    expect(restored.replayed).toBeGreaterThanOrEqual(1);
    expect(readSnapshot).toHaveBeenCalled();
    const replayed = await admin.query<{ principal_id: string | null; status: string }>(
      `SELECT principal_id, status FROM deletion_requests WHERE user_id=$1 AND scope_id=$2 AND id=$3`,
      [userId, scopeB, unknownPrincipalEntry.request_id],
    );
    expect(replayed.rows[0]).toEqual({ principal_id: null, status: 'complete' });
    await expect(governance.verifyLedgerReadiness()).resolves.toBeUndefined();
    const restoredRead = await fetch(`${baseUrl}/v1/memories/${retainedId}?scope_id=${scopeB}`, {
      headers: { authorization: `Bearer ${user}` },
    });
    expect(restoredRead.status).toBe(200);
  }, 40_000);

  it('serves a read-only MCP audience through the official SDK client', async () => {
    const statement = `MCP read client fixture ${randomUUID()}`;
    const user = await token([scopeB], 'memory:admin');
    const created = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: { ...sampleMemory(), statement, evidence: [evidence(`mcp-read-${randomUUID()}`)] },
      },
      `mcp-read-seed-${randomUUID()}`,
    );
    expect(created.status).toBe(200);

    const accessToken = await token([scopeB], 'memory:read', subject, mcpReadAudience);
    const client = new McpClient({ name: 'memory-read-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/read`), {
        authProvider: { token: async () => accessToken },
      }),
    );
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(['recall_memories', 'get_memory', 'get_changes']),
      );
      expect(names).not.toContain('remember_memory');
      expect(names).not.toContain('forget_memory');
      const result = await client.callTool({
        name: 'recall_memories',
        arguments: { query: statement, scope_id: scopeB, mode: 'precise' },
      });
      expect(JSON.stringify(result)).toContain(statement);
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('serves MCP writes only to a distinct write audience and commits through CoreService', async () => {
    const accessToken = await token([scopeB], 'memory:write', subject, mcpWriteAudience);
    const client = new McpClient({ name: 'memory-write-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/write`), {
        authProvider: { token: async () => accessToken },
      }),
    );
    const statement = `MCP write client fixture ${randomUUID()}`;
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(['remember_memory', 'forget_memory', 'capture', 'commit_changeset']),
      );
      const result = await client.callTool({
        name: 'remember_memory',
        arguments: {
          scope_id: scopeB,
          idempotency_key: `mcp-write-${randomUUID()}`,
          memory: {
            ...sampleMemory(),
            statement,
            evidence: [evidence(`mcp-write-${randomUUID()}`)],
          },
        },
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    const committed = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memories WHERE user_id=$1 AND scope_id=$2 AND statement=$3',
      [userId, scopeB, statement],
    );
    expect(committed.rows[0]?.count).toBe('1');

    const wrongAudienceClient = new McpClient({
      name: 'memory-wrong-audience',
      version: '1.0.0',
    });
    await expect(
      wrongAudienceClient.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/read`), {
          authProvider: { token: async () => accessToken },
        }),
      ),
    ).rejects.toThrow();
    await wrongAudienceClient.close().catch(() => undefined);
  }, 20_000);

  it('publishes protected-resource metadata and rejects untrusted MCP hosts and origins', async () => {
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp/read`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: mcpReadAudience,
      authorization_servers: [gateIssuer],
      scopes_supported: ['openid'],
    });
    const badOrigin = await fetch(`${baseUrl}/mcp/read`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(badOrigin.status).toBe(403);
    const badHost = await fetch(`${baseUrl}/mcp/read`, {
      method: 'POST',
      headers: { host: 'attacker.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(badHost.status).toBe(401);
    const rawHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: Number(new URL(baseUrl).port),
          path: '/mcp/read',
          method: 'POST',
          headers: {
            host: 'attacker.example',
            'content-type': 'application/json',
            'content-length': '2',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end('{}');
    });
    expect(rawHostStatus).toBe(403);
  });

  it('exposes only bearer-protected API and MCP routes', async () => {
    const callback = await fetch(`${baseUrl}/auth-return.html?code=synthetic-code`);
    expect(callback.status).toBe(404);
    const session = await fetch(`${baseUrl}/v1/session`);
    expect(session.status).toBe(404);

    const openapi = await fetch(`${baseUrl}/openapi.json`);
    const document = (await openapi.json()) as {
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(document.paths).not.toHaveProperty('/v1/session');
    expect(document.components.securitySchemes).not.toHaveProperty('browserSessionCookie');

    const body = JSON.stringify({ scope_id: scopeB, memory: sampleMemory() });
    const cookieOnly = await fetch(`${baseUrl}/v1/memories:remember`, {
      method: 'POST',
      headers: {
        cookie: '__Secure-gate_session=synthetic-session',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body,
    });
    expect(cookieOnly.status).toBe(401);

    const mcpCookieOnly = await fetch(`${baseUrl}/mcp/read`, {
      method: 'POST',
      headers: {
        cookie: '__Secure-gate_session=synthetic-session',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(mcpCookieOnly.status).toBe(401);
    const mcpGet = await fetch(`${baseUrl}/mcp/read`, { method: 'GET' });
    expect(mcpGet.status).toBe(405);

    const bearer = await token([scopeB], 'memory:read memory:write');
    const committed = await fetch(`${baseUrl}/v1/memories:remember`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        cookie: '__Secure-gate_session=ignored-with-bearer',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body,
    });
    expect(committed.status).toBe(200);
    expect(committed.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('rejects duplicate Authorization headers and ignores duplicate cookies with a valid bearer', async () => {
    const url = new URL(baseUrl);
    const duplicateAuthorization = await rawHttpPost(url, '/v1/memories:remember', [
      ['authorization', 'Bearer opaque-first'],
      ['authorization', 'Bearer opaque-second'],
      ['content-type', 'application/json'],
    ]);
    expect(duplicateAuthorization.status).toBe(401);

    const bearer = await token([scopeB], 'memory:read memory:write');
    const duplicateCookie = await rawHttpPost(url, '/v1/memories:remember', [
      ['authorization', `Bearer ${bearer}`],
      ['cookie', '__Secure-gate_session=first'],
      ['cookie', '__Secure-gate_session=second'],
      ['content-type', 'application/json'],
      ['idempotency-key', randomUUID()],
    ]);
    expect(duplicateCookie.status).toBe(400);
  });

  it('admits dynamic clients by subject and locks revoked admission without widening capabilities', async () => {
    const bearer = await token([scopeB], 'memory:read');
    const claims = gateTokens.get(bearer)!;
    claims.client_id = `dynamic-${randomUUID()}`;
    const actor = await authenticator.authenticate(`Bearer ${bearer}`);
    expect(actor.capabilities).toEqual(['read']);
    const locked = await app.connect();
    const operator = await admin.connect();
    try {
      await locked.query('BEGIN');
      await locked.query('SELECT * FROM app.lock_external_identity_binding($1,$2)', [
        gateIssuer,
        claims.sub,
      ]);
      await operator.query('BEGIN');
      await operator.query("SET LOCAL lock_timeout='50ms'");
      await expect(
        operator.query(
          'UPDATE external_identity_bindings SET active=false WHERE external_issuer=$1 AND external_subject=$2',
          [gateIssuer, claims.sub],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
      await operator.query('ROLLBACK');
      await locked.query('COMMIT');
      await admin.query(
        'UPDATE external_identity_bindings SET active=false WHERE external_issuer=$1 AND external_subject=$2',
        [gateIssuer, claims.sub],
      );
      await expect(authenticator.assertCurrent(actor)).rejects.toMatchObject({ status: 403 });
      await expect(authenticator.authenticate(`Bearer ${bearer}`)).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await locked.query('ROLLBACK');
      await operator.query('ROLLBACK');
      locked.release();
      operator.release();
    }
  });

  it('rolls back writes when Gate revokes or becomes unavailable at the final commit check', async () => {
    for (const finalFailure of ['revoke_on_call', 'fail_on_call'] as const) {
      const bearer = await token([scopeB], 'memory:read memory:write');
      gateTokens.get(bearer)![finalFailure] = 2;
      const idempotencyKey = `final-gate-${randomUUID()}`;
      const response = await post(
        '/v1/memories:remember',
        bearer,
        { scope_id: scopeB, memory: sampleMemory() },
        idempotencyKey,
      );
      expect(response.status).toBe(finalFailure === 'revoke_on_call' ? 401 : 503);
      const persisted = await admin.query(
        'SELECT 1 FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2',
        [userId, idempotencyKey],
      );
      expect(persisted.rowCount).toBe(0);
    }
  });

  it('completes Remember → Recall → get_changes → Forget → not found with two official SDK clients', async () => {
    const writeToken = await token([scopeB], 'memory:admin', subject, mcpWriteAudience);
    let readToken = await token([scopeB], 'memory:read', subject, mcpReadAudience);
    const writer = new McpClient({ name: 'memory-governance-write-client', version: '1.0.0' });
    const reader = new McpClient({ name: 'memory-governance-read-client', version: '1.0.0' });
    await writer.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/write`), {
        authProvider: { token: async () => writeToken },
      }),
    );
    await reader.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/read`), {
        authProvider: { token: async () => readToken },
      }),
    );
    const statement = `MCP complete governance ${randomUUID()}`;
    try {
      const remembered = await writer.callTool({
        name: 'remember_memory',
        arguments: {
          scope_id: scopeB,
          idempotency_key: `mcp-e2e-${randomUUID()}`,
          memory: { ...sampleMemory(), statement, evidence: [evidence(`mcp-e2e-${randomUUID()}`)] },
        },
      });
      expect(remembered.isError).not.toBe(true);
      const memory = await admin.query<{ id: string }>(
        'SELECT id FROM memories WHERE user_id=$1 AND scope_id=$2 AND statement=$3',
        [userId, scopeB, statement],
      );
      const memoryId = memory.rows[0]?.id;
      expect(memoryId).toBeDefined();

      const recalled = await reader.callTool({
        name: 'recall_memories',
        arguments: { query: statement, scope_id: scopeB, mode: 'precise' },
      });
      expect(recalled.isError).not.toBe(true);
      expect(JSON.stringify(recalled)).toContain(statement);
      const changes = await reader.callTool({
        name: 'get_changes',
        arguments: { scope_id: scopeB, limit: 100 },
      });
      expect(changes.isError).not.toBe(true);
      expect(JSON.stringify(changes)).toContain(memoryId);

      const forgotten = await writer.callTool({
        name: 'forget_memory',
        arguments: {
          scope_id: scopeB,
          memory_id: memoryId!,
          idempotency_key: `mcp-forget-${randomUUID()}`,
        },
      });
      expect(forgotten.isError).not.toBe(true);
      const freshActorToken = await token([scopeB], 'memory:admin');
      const freshActor = await authenticator.authenticate(`Bearer ${freshActorToken}`);
      await expect(coreService.getMemory(freshActor, scopeB, memoryId!, {})).rejects.toMatchObject({
        status: 404,
      });
      readToken = await token([scopeB], 'memory:read', subject, mcpReadAudience);
      const sweep = await fetch(`${workerBaseUrl}/internal/governance/sweep`, {
        method: 'POST',
        headers: { authorization: `Bearer ${workerTaskToken}` },
      });
      expect(sweep.status).toBe(200);
      const afterForget = await reader.callTool({
        name: 'get_memory',
        arguments: { scope_id: scopeB, memory_id: memoryId! },
      });
      expect(afterForget.isError).toBe(true);
      expect(JSON.stringify(afterForget)).not.toContain(statement);
      const persistedForgetEvents = await admin.query<{ op: string; tombstone: boolean }>(
        'SELECT op, tombstone FROM change_log WHERE user_id=$1 AND scope_id=$2 AND memory_id=$3 ORDER BY seq',
        [userId, scopeB, memoryId],
      );
      expect(persistedForgetEvents.rows).toContainEqual({ op: 'RETRACT', tombstone: true });
      const changesAfterForget = await reader.callTool({
        name: 'get_changes',
        arguments: { scope_id: scopeB, limit: 100 },
      });
      expect(changesAfterForget.isError).not.toBe(true);
      expect(JSON.stringify(changesAfterForget)).toContain('RETRACT');
      expect(JSON.stringify(changesAfterForget)).toContain('"tombstone":true');
      expect(JSON.stringify(changesAfterForget)).toContain(memoryId);
      expect(JSON.stringify(changesAfterForget)).not.toContain(statement);
    } finally {
      await writer.close();
      await reader.close();
    }
  }, 30_000);

  it('exports and imports complete history across users without importing authority', async () => {
    let sourceOwner = await token([scopeB], 'memory:admin');
    const externalId = `portable-history-${randomUUID()}`;
    const originalStatement = `Portable history original ${randomUUID()}`;
    const revisedStatement = `${originalStatement} revised`;
    const created = await post(
      '/v1/memories:remember',
      sourceOwner,
      {
        scope_id: scopeB,
        memory: {
          ...sampleMemory(),
          statement: originalStatement,
          evidence: [evidence(externalId)],
        },
      },
      `portable-create-${randomUUID()}`,
    );
    expect(created.status).toBe(200);
    const initial = (await created.json()) as { operations: { memory_ids: string[] }[] };
    const sourceMemoryId = initial.operations[0]!.memory_ids[0]!;
    const proposal = await post(
      '/v1/changesets',
      sourceOwner,
      {
        scope_id: scopeB,
        operations: [
          {
            op: 'REFINE',
            memory_id: sourceMemoryId,
            expected_revision: 1,
            statement: revisedStatement,
            evidence: [evidence(`${externalId}-revision-2`)],
          },
        ],
      },
      `portable-refine-${randomUUID()}`,
    );
    expect(proposal.status).toBe(200);
    const proposed = (await proposal.json()) as { change_set_id: string };
    const commit = await post(
      `/v1/changesets/${proposed.change_set_id}:commit`,
      sourceOwner,
      {},
      `portable-commit-${randomUUID()}`,
    );
    expect(commit.status).toBe(200);
    const versions = await admin.query<{ revision: number }>(
      'SELECT revision FROM memory_versions WHERE user_id=$1 AND scope_id=$2 AND memory_id=$3 ORDER BY revision',
      [userId, scopeB, sourceMemoryId],
    );
    expect(versions.rows.map((row) => row.revision)).toEqual([1, 2]);

    sourceOwner = await token([scopeB], 'memory:admin');
    const exportRequest = await post(
      '/v1/exports',
      sourceOwner,
      { scope_id: scopeB },
      `export-${randomUUID()}`,
    );
    expect(exportRequest.status, await exportRequest.clone().text()).toBe(202);
    const requested = (await exportRequest.json()) as { export_id: string; state: string };
    expect(requested.state).toBe('accepted');
    const exportProcessed = await portability.processPendingWorker(workerDb);
    expect(exportProcessed).toMatchObject({ exports: 1, failed: 0 });
    const downloaded = await fetch(
      `${baseUrl}/v1/exports/${requested.export_id}:download?scope_id=${scopeB}`,
      {
        headers: { authorization: `Bearer ${sourceOwner}` },
      },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toBe(LEGACY_PORTABILITY_MIME_TYPE);
    const encryptedBundle = await downloaded.text();
    expect(encryptedBundle).toMatch(/^v1\./);

    const revokedDuringRead = await token([scopeB], 'memory:admin');
    gateTokens.get(revokedDuringRead)!.revoke_on_call = 2;
    const storageRead = vi.spyOn(portabilityStore, 'read');
    const revokedDownload = await fetch(
      `${baseUrl}/v1/exports/${requested.export_id}:download?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${revokedDuringRead}` } },
    );
    expect(storageRead).toHaveBeenCalledOnce();
    expect(revokedDownload.status).toBe(401);
    expect(await revokedDownload.text()).not.toContain(encryptedBundle);
    storageRead.mockRestore();

    const destinationOwner = await token([importedScopeId], 'memory:admin', importedUserSubject);
    const importKey = `portable-import-${randomUUID()}`;
    const body = {
      scope_id: importedScopeId,
      encrypted_bundle: encryptedBundle,
      grant_imported_sources: true,
    };
    const importedResponse = await post('/v1/imports', destinationOwner, body, importKey);
    expect(importedResponse.status, await importedResponse.clone().text()).toBe(200);
    const imported = (await importedResponse.json()) as {
      import_id: string;
      state: string;
      imported_memories: number;
      id_map: Record<string, string>;
      grant_imported_sources: boolean;
    };
    expect(imported).toMatchObject({
      state: 'complete',
      imported_memories: expect.any(Number),
      grant_imported_sources: true,
    });
    const destinationMemoryId = imported.id_map[`memories:${sourceMemoryId}`];
    expect(destinationMemoryId).toBeDefined();
    const destinationRead = await fetch(
      `${baseUrl}/v1/memories/${destinationMemoryId}?scope_id=${importedScopeId}`,
      {
        headers: { authorization: `Bearer ${destinationOwner}` },
      },
    );
    expect(destinationRead.status).toBe(200);
    const destinationMemory = (await destinationRead.json()) as {
      revision: number;
      statement: string;
      attribution: { actor_kind: string; authority: string };
    };
    expect(destinationMemory).toMatchObject({
      revision: 2,
      statement: revisedStatement,
      attribution: { actor_kind: 'connector', authority: 'third_party_claim' },
    });
    const importedHistory = await admin.query<{
      version_count: string;
      origin_user_id: string;
      created_by: string;
      rights_status: string;
      origin_authority: string;
    }>(
      `SELECT (SELECT count(*)::text FROM memory_versions WHERE user_id=$1 AND scope_id=$2 AND memory_id=$3) AS version_count,
        m.import_provenance->>'origin_user_id' AS origin_user_id, m.created_by::text AS created_by,
        (SELECT rights_status FROM sources WHERE user_id=$1 AND scope_id=$2 LIMIT 1) AS rights_status,
        (SELECT origin_provenance->>'origin_authority' FROM memory_versions
          WHERE user_id=$1 AND scope_id=$2 AND memory_id=$3 ORDER BY revision DESC LIMIT 1) AS origin_authority
       FROM memories m WHERE m.user_id=$1 AND m.scope_id=$2 AND m.id=$3`,
      [importedUserId, importedScopeId, destinationMemoryId],
    );
    expect(importedHistory.rows[0]).toMatchObject({
      version_count: '2',
      origin_user_id: userId,
      created_by: importedPrincipalId,
      rights_status: 'granted',
      origin_authority: expect.any(String),
    });

    const importedReaderToken = await token(
      [importedScopeId],
      'memory:read',
      importedReaderSubject,
    );
    const importedChangesResponse = await fetch(
      `${baseUrl}/v1/changes?scope_ids=${importedScopeId}&limit=100`,
      { headers: { authorization: `Bearer ${importedReaderToken}` } },
    );
    expect(importedChangesResponse.status).toBe(200);
    const importedChanges = (await importedChangesResponse.json()) as {
      changes: {
        operation: string;
        memory_id: string | null;
        revision: number | null;
        tombstone: boolean;
      }[];
    };
    const persistedImportEvents = await admin.query<{ op: string; memory_revision: number }>(
      'SELECT op, memory_revision FROM change_log WHERE user_id=$1 AND scope_id=$2 AND memory_id=$3 ORDER BY seq',
      [importedUserId, importedScopeId, destinationMemoryId],
    );
    expect(persistedImportEvents.rows).toContainEqual({ op: 'IMPORT', memory_revision: 2 });
    expect(importedChanges.changes).toContainEqual(
      expect.objectContaining({
        operation: 'IMPORT',
        memory_id: destinationMemoryId,
        revision: 2,
        tombstone: false,
      }),
    );
    expect(JSON.stringify(importedChanges)).not.toContain(revisedStatement);

    const recalled = await post('/v1/recall', destinationOwner, {
      query: revisedStatement,
      scope_ids: [importedScopeId],
      mode: 'precise',
    });
    expect(recalled.status).toBe(200);
    expect(JSON.stringify(await recalled.json())).toContain(destinationMemoryId);
    const replay = await post('/v1/imports', destinationOwner, body, importKey);
    expect(replay.status).toBe(200);
    const replayedImport = (await replay.json()) as Record<string, unknown>;
    const replayedResult = { ...replayedImport };
    const firstResult = { ...(imported as unknown as Record<string, unknown>) };
    delete replayedResult['request_id'];
    delete replayedResult['trace_id'];
    delete firstResult['request_id'];
    delete firstResult['trace_id'];
    expect(replayedResult).toEqual(firstResult);
    const changedOptions = await post(
      '/v1/imports',
      destinationOwner,
      {
        ...body,
        grant_imported_sources: false,
      },
      importKey,
    );
    expect(changedOptions.status).toBe(409);
    const tamperIndex = encryptedBundle.indexOf('.') + 8;
    const originalChar = encryptedBundle[tamperIndex];
    if (originalChar === undefined) throw new Error('Encrypted bundle payload is too short');
    const tamperedBundle = `${encryptedBundle.slice(0, tamperIndex)}${originalChar === 'A' ? 'B' : 'A'}${encryptedBundle.slice(tamperIndex + 1)}`;
    const tampered = await post(
      '/v1/imports',
      destinationOwner,
      {
        ...body,
        encrypted_bundle: tamperedBundle,
      },
      `portable-tamper-${randomUUID()}`,
    );
    expect(tampered.status).toBe(400);
  }, 40_000);

  it('invalidates ready exports after source-rights revocation while leaving other scopes usable', async () => {
    const user = await token([scopeB], 'memory:admin');
    const statement = `Rights-revoked export must not remain downloadable ${randomUUID()}`;
    const externalId = `rights-export-${randomUUID()}`;
    const remembered = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: {
          ...sampleMemory(),
          statement,
          evidence: [evidence(externalId)],
        },
      },
      `rights-export-memory-${randomUUID()}`,
    );
    expect(remembered.status, await remembered.clone().text()).toBe(200);
    const sourceRow = await admin.query<{ id: string }>(
      'SELECT id FROM sources WHERE user_id=$1 AND scope_id=$2 AND external_id=$3',
      [userId, scopeB, externalId],
    );
    expect(sourceRow.rows).toHaveLength(1);

    const affectedRequest = await post(
      '/v1/exports',
      user,
      { scope_id: scopeB },
      `rights-export-affected-${randomUUID()}`,
    );
    expect(affectedRequest.status, await affectedRequest.clone().text()).toBe(202);
    const affected = (await affectedRequest.json()) as { export_id: string };

    const unrelatedOwner = await token([importedScopeId], 'memory:admin', importedUserSubject);
    const unrelatedRequest = await post(
      '/v1/exports',
      unrelatedOwner,
      { scope_id: importedScopeId },
      `rights-export-unrelated-${randomUUID()}`,
    );
    expect(unrelatedRequest.status, await unrelatedRequest.clone().text()).toBe(202);
    const unrelated = (await unrelatedRequest.json()) as { export_id: string };

    await portability.processPendingWorker(workerDb);
    const affectedReady = await fetch(
      `${baseUrl}/v1/exports/${affected.export_id}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(affectedReady.status).toBe(200);
    expect(await affectedReady.json()).toMatchObject({ state: 'ready', content_available: true });
    const affectedDownload = await fetch(
      `${baseUrl}/v1/exports/${affected.export_id}:download?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(affectedDownload.status).toBe(200);
    const affectedArtifact = await admin.query<{ artifact_key: string }>(
      'SELECT artifact_key FROM export_jobs WHERE id=$1',
      [affected.export_id],
    );
    expect(affectedArtifact.rows[0]?.artifact_key).toBeTruthy();

    const unrelatedReady = await fetch(
      `${baseUrl}/v1/exports/${unrelated.export_id}?scope_id=${importedScopeId}`,
      { headers: { authorization: `Bearer ${unrelatedOwner}` } },
    );
    expect(unrelatedReady.status).toBe(200);
    expect(await unrelatedReady.json()).toMatchObject({ state: 'ready', content_available: true });
    const unrelatedDownload = await fetch(
      `${baseUrl}/v1/exports/${unrelated.export_id}:download?scope_id=${importedScopeId}`,
      { headers: { authorization: `Bearer ${unrelatedOwner}` } },
    );
    expect(unrelatedDownload.status).toBe(200);

    const revoke = await fetch(`${baseUrl}/v1/sources/${sourceRow.rows[0]!.id}:rights`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope_id: scopeB, rights_status: 'revoked', consent: false }),
    });
    expect(revoke.status, await revoke.clone().text()).toBe(200);
    const scopeEpochs = await admin.query<{
      ready_auth_epoch: number;
      current_auth_epoch: number;
      state: string;
    }>(
      `SELECT ej.ready_auth_epoch, s.auth_epoch AS current_auth_epoch, ej.state
       FROM export_jobs ej JOIN scopes s ON s.user_id=ej.user_id AND s.id=ej.scope_id
       WHERE ej.id=$1`,
      [affected.export_id],
    );
    expect(scopeEpochs.rows[0]).toMatchObject({ state: 'ready' });
    expect(scopeEpochs.rows[0]!.ready_auth_epoch).not.toBe(scopeEpochs.rows[0]!.current_auth_epoch);

    const refreshedOwner = await token([scopeB], 'memory:admin');
    const affectedStatusAfterRevoke = await fetch(
      `${baseUrl}/v1/exports/${affected.export_id}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${refreshedOwner}` } },
    );
    expect(affectedStatusAfterRevoke.status).toBe(404);
    expect(await affectedStatusAfterRevoke.json()).toMatchObject({
      error: { code: 'export_unavailable' },
    });
    const affectedDownloadAfterRevoke = await fetch(
      `${baseUrl}/v1/exports/${affected.export_id}:download?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${refreshedOwner}` } },
    );
    expect(affectedDownloadAfterRevoke.status).toBe(404);

    const unrelatedStatusAfterRevoke = await fetch(
      `${baseUrl}/v1/exports/${unrelated.export_id}?scope_id=${importedScopeId}`,
      { headers: { authorization: `Bearer ${unrelatedOwner}` } },
    );
    expect(unrelatedStatusAfterRevoke.status).toBe(200);
    expect(await unrelatedStatusAfterRevoke.json()).toMatchObject({
      state: 'ready',
      content_available: true,
    });
    const unrelatedDownloadAfterRevoke = await fetch(
      `${baseUrl}/v1/exports/${unrelated.export_id}:download?scope_id=${importedScopeId}`,
      { headers: { authorization: `Bearer ${unrelatedOwner}` } },
    );
    expect(unrelatedDownloadAfterRevoke.status).toBe(200);

    expect(await portability.expireArtifacts(workerDb)).toBeGreaterThanOrEqual(1);
    const removedFiles = await portability.processPendingFileDeletions(workerDb);
    expect(removedFiles.deleted).toBeGreaterThanOrEqual(1);
    const staleArtifactRow = await admin.query<{ state: string; artifact_key: string | null }>(
      'SELECT state, artifact_key FROM export_jobs WHERE id=$1',
      [affected.export_id],
    );
    expect(staleArtifactRow.rows[0]).toEqual({ state: 'expired', artifact_key: null });
    const deletionAck = await admin.query<{ state: string }>(
      'SELECT state FROM governance_file_deletions WHERE artifact_key=$1',
      [affectedArtifact.rows[0]!.artifact_key],
    );
    expect(deletionAck.rows[0]?.state).toBe('deleted');
    const filesAfterRightsExpiry = await readdir(portabilityDirectory);
    expect(filesAfterRightsExpiry).not.toContain(affectedArtifact.rows[0]!.artifact_key);

    const regeneratedRequest = await post(
      '/v1/exports',
      refreshedOwner,
      { scope_id: scopeB },
      `rights-export-regenerated-${randomUUID()}`,
    );
    expect(regeneratedRequest.status, await regeneratedRequest.clone().text()).toBe(202);
    const regenerated = (await regeneratedRequest.json()) as { export_id: string };
    await portability.processPendingWorker(workerDb);
    const regeneratedDownload = await fetch(
      `${baseUrl}/v1/exports/${regenerated.export_id}:download?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${refreshedOwner}` } },
    );
    expect(regeneratedDownload.status).toBe(200);
    const regeneratedPayload = portabilityStore.open(await regeneratedDownload.text()) as {
      tables: { memories: { statement: string }[] };
    };
    expect(
      regeneratedPayload.tables.memories.some((memory) => memory.statement === statement),
    ).toBe(false);
  }, 40_000);

  it('fences stale export claims and removes every claim file before Forget completes', async () => {
    const user = await token([scopeB], 'memory:admin');
    const actor = await authenticator.authenticate(`Bearer ${user}`);
    const statement = `Forget exported artifact ${randomUUID()}`;
    const created = await post(
      '/v1/memories:remember',
      user,
      {
        scope_id: scopeB,
        memory: {
          ...sampleMemory(),
          statement,
          evidence: [evidence(`artifact-forget-${randomUUID()}`)],
        },
      },
      `artifact-memory-${randomUUID()}`,
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = (await created.json()) as { operations: { memory_ids: string[] }[] };
    const memoryId = createdBody.operations[0]!.memory_ids[0]!;

    const requested = (await portability.requestExport(
      actor,
      { scope_id: scopeB },
      `claim-race-${randomUUID()}`,
    )) as {
      export_id: string;
    };
    const firstClaim = await workerDb.query<{
      export_id: string;
      user_id: string;
      scope_id: string;
      principal_id: string;
      deletion_epoch: number;
      claim_token: string;
    }>('SELECT * FROM app.list_pending_export_jobs()');
    const first = firstClaim.rows.find((row) => row.export_id === requested.export_id);
    expect(first).toBeDefined();
    const exportAuthEpoch = await admin.query<{ auth_epoch: number }>(
      'SELECT auth_epoch FROM scopes WHERE user_id=$1 AND id=$2',
      [userId, scopeB],
    );
    const artifactA = await portabilityStore.write(
      requested.export_id,
      portabilityStore.seal({ claim: 'A', statement }),
      first!.claim_token,
    );
    const crashedTempA = join(
      portabilityDirectory,
      `.${requested.export_id}.${first!.claim_token}.${'a'.repeat(24)}.tmp`,
    );
    await writeFile(crashedTempA, 'claim A crashed after final rename', {
      mode: 0o600,
      flag: 'wx',
    });
    expect(await readdir(portabilityDirectory)).toEqual(
      expect.arrayContaining([
        artifactA,
        `.${requested.export_id}.${first!.claim_token}.${'a'.repeat(24)}.tmp`,
      ]),
    );
    expect(portabilityStore.open(await portabilityStore.read(artifactA))).toMatchObject({
      statement,
    });

    await admin.query(
      "UPDATE export_jobs SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [requested.export_id],
    );
    const secondClaim = await workerDb.query<{
      export_id: string;
      user_id: string;
      scope_id: string;
      principal_id: string;
      deletion_epoch: number;
      claim_token: string;
    }>('SELECT * FROM app.list_pending_export_jobs() WHERE export_id=$1', [requested.export_id]);
    const second = secondClaim.rows[0];
    expect(second).toBeDefined();
    expect(second!.claim_token).not.toBe(first!.claim_token);
    const artifactB = await portabilityStore.write(
      requested.export_id,
      portabilityStore.seal({ claim: 'B', statement }),
      second!.claim_token,
    );
    const crashedTempB = join(
      portabilityDirectory,
      `.${requested.export_id}.${second!.claim_token}.${'b'.repeat(24)}.tmp`,
    );
    await writeFile(crashedTempB, 'claim B temporary encrypted bundle', {
      mode: 0o600,
      flag: 'wx',
    });
    const staleFinish = await workerDb.query<{ ok: boolean }>(
      `SELECT app.finish_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS ok`,
      [
        requested.export_id,
        first!.user_id,
        first!.scope_id,
        first!.principal_id,
        first!.deletion_epoch,
        exportAuthEpoch.rows[0]!.auth_epoch,
        artifactA,
        new Date(Date.now() + 60_000).toISOString(),
        true,
        first!.claim_token,
      ],
    );
    expect(staleFinish.rows[0]?.ok).toBe(false);
    // Claim A's final and temp files intentionally remain untracked, as if its worker
    // crashed after rename and before finish_export_job committed the artifact key.
    expect(portabilityStore.open(await portabilityStore.read(artifactB))).toMatchObject({
      statement,
    });
    const winnerFinish = await workerDb.query<{ ok: boolean }>(
      `SELECT app.finish_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS ok`,
      [
        requested.export_id,
        second!.user_id,
        second!.scope_id,
        second!.principal_id,
        second!.deletion_epoch,
        exportAuthEpoch.rows[0]!.auth_epoch,
        artifactB,
        new Date(Date.now() + 60_000).toISOString(),
        true,
        second!.claim_token,
      ],
    );
    expect(winnerFinish.rows[0]?.ok).toBe(true);

    const uncommitted = (await portability.requestExport(
      actor,
      { scope_id: scopeB },
      `claim-null-key-${randomUUID()}`,
    )) as { export_id: string };
    const claimCResult = await workerDb.query<{
      export_id: string;
      user_id: string;
      scope_id: string;
      principal_id: string;
      deletion_epoch: number;
      claim_token: string;
    }>('SELECT * FROM app.list_pending_export_jobs() WHERE export_id=$1', [uncommitted.export_id]);
    const claimC = claimCResult.rows[0];
    expect(claimC).toBeDefined();
    const artifactC = await portabilityStore.write(
      uncommitted.export_id,
      portabilityStore.seal({ claim: 'C', statement }),
      claimC!.claim_token,
    );
    expect(portabilityStore.open(await portabilityStore.read(artifactC))).toMatchObject({
      statement,
    });
    const crashedTempC = join(
      portabilityDirectory,
      `.${uncommitted.export_id}.${claimC!.claim_token}.${'c'.repeat(24)}.tmp`,
    );
    await writeFile(crashedTempC, 'claim C crashed temporary bundle', {
      mode: 0o600,
      flag: 'wx',
    });
    await admin.query(
      "UPDATE export_jobs SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [uncommitted.export_id],
    );
    const claimDResult = await workerDb.query<{ claim_token: string }>(
      'SELECT claim_token FROM app.list_pending_export_jobs() WHERE export_id=$1',
      [uncommitted.export_id],
    );
    const claimD = claimDResult.rows[0];
    expect(claimD).toBeDefined();
    expect(claimD!.claim_token).not.toBe(claimC!.claim_token);
    const artifactD = await portabilityStore.write(
      uncommitted.export_id,
      portabilityStore.seal({ claim: 'D', statement }),
      claimD!.claim_token,
    );
    expect(portabilityStore.open(await portabilityStore.read(artifactD))).toMatchObject({
      statement,
    });
    const crashedTempD = join(
      portabilityDirectory,
      `.${uncommitted.export_id}.${claimD!.claim_token}.${'d'.repeat(24)}.tmp`,
    );
    await writeFile(crashedTempD, 'claim D crashed temporary bundle', {
      mode: 0o600,
      flag: 'wx',
    });
    const nullArtifactKey = await admin.query<{ state: string; artifact_key: string | null }>(
      'SELECT state, artifact_key FROM export_jobs WHERE id=$1',
      [uncommitted.export_id],
    );
    expect(nullArtifactKey.rows[0]).toEqual({ state: 'processing', artifact_key: null });

    const otherOwner = await token([importedScopeId], 'memory:admin', importedUserSubject);
    const otherExportResponse = await post(
      '/v1/exports',
      otherOwner,
      { scope_id: importedScopeId },
      `claim-other-scope-${randomUUID()}`,
    );
    expect(otherExportResponse.status, await otherExportResponse.clone().text()).toBe(202);
    const otherExport = (await otherExportResponse.json()) as { export_id: string };
    await portability.processPendingWorker(workerDb);
    const otherArtifact = await admin.query<{ artifact_key: string }>(
      'SELECT artifact_key FROM export_jobs WHERE id=$1',
      [otherExport.export_id],
    );
    expect(otherArtifact.rows[0]?.artifact_key).toBeTruthy();
    const otherFileBeforeForget = otherArtifact.rows[0]!.artifact_key;
    expect((await readdir(portabilityDirectory)).includes(otherFileBeforeForget)).toBe(true);

    const completedKey =
      (
        await admin.query<{ artifact_key: string }>(
          'SELECT artifact_key FROM export_jobs WHERE id=$1',
          [requested.export_id],
        )
      ).rows[0]?.artifact_key ?? artifactB;
    expect(completedKey).toBe(artifactB);
    const forget = await post(
      '/v1/forget',
      user,
      {
        scope_id: scopeB,
        selector: { memory_ids: [memoryId] },
        reason_code: 'user_requested',
      },
      `artifact-forget-${randomUUID()}`,
    );
    expect(forget.status).toBe(202);
    const forgetBody = (await forget.json()) as { forget_request_id: string };
    const firstDeletionPass = await governance.processPendingWorker(workerDb);
    expect(firstDeletionPass.pending).toBe(1);
    const heldForget = await admin.query<{ status: string }>(
      'SELECT status FROM public.deletion_requests WHERE id=$1',
      [forgetBody.forget_request_id],
    );
    expect(heldForget.rows[0]?.status).toBe('purging');
    const queuedFileDeletions = await admin.query<{ pending: string }>(
      `SELECT count(*)::text AS pending FROM public.governance_file_deletions
       WHERE user_id=$1 AND scope_id=$2 AND state <> 'deleted'`,
      [userId, scopeB],
    );
    expect(Number(queuedFileDeletions.rows[0]?.pending)).toBeGreaterThan(0);
    const sweep = await fetch(`${workerBaseUrl}/internal/governance/sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${workerTaskToken}` },
    });
    expect(sweep.status).toBe(200);
    const forgetStatus = await fetch(
      `${baseUrl}/v1/forget/${forgetBody.forget_request_id}?scope_id=${scopeB}`,
      { headers: { authorization: `Bearer ${user}` } },
    );
    expect(forgetStatus.status, await forgetStatus.clone().text()).toBe(200);
    expect(await forgetStatus.json()).toMatchObject({
      status: 'complete',
      content_available: false,
    });
    const files = await readdir(portabilityDirectory);
    expect(files.some((name) => name.startsWith(requested.export_id))).toBe(false);
    expect(files.some((name) => name.startsWith(`.${requested.export_id}.`))).toBe(false);
    expect(files.some((name) => name.startsWith(uncommitted.export_id))).toBe(false);
    expect(files.some((name) => name.startsWith(`.${uncommitted.export_id}.`))).toBe(false);
    expect(files).toContain(otherFileBeforeForget);
    const fileQueue = await admin.query<{ pending: string; deleted: string }>(
      `SELECT count(*) FILTER (WHERE state <> 'deleted')::text AS pending,
         count(*) FILTER (WHERE state='deleted')::text AS deleted
       FROM governance_file_deletions WHERE user_id=$1 AND scope_id=$2
         AND (artifact_key LIKE $3 OR artifact_key LIKE $4)`,
      [userId, scopeB, `${requested.export_id}%`, `${uncommitted.export_id}%`],
    );
    expect(fileQueue.rows[0]).toMatchObject({ pending: '0' });
    expect(Number(fileQueue.rows[0]?.deleted)).toBeGreaterThanOrEqual(3);
    const staleAfterForget = await workerDb.query<{ ok: boolean }>(
      `SELECT app.finish_export_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS ok`,
      [
        requested.export_id,
        first!.user_id,
        first!.scope_id,
        first!.principal_id,
        first!.deletion_epoch,
        exportAuthEpoch.rows[0]!.auth_epoch,
        artifactA,
        new Date(Date.now() + 60_000).toISOString(),
        true,
        first!.claim_token,
      ],
    );
    expect(staleAfterForget.rows[0]?.ok).toBe(false);
    const otherDownload = await fetch(
      `${baseUrl}/v1/exports/${otherExport.export_id}:download?scope_id=${importedScopeId}`,
      { headers: { authorization: `Bearer ${otherOwner}` } },
    );
    expect(otherDownload.status).toBe(200);
    expect(portabilityStore.open(await otherDownload.text())).toBeDefined();
    const finalFiles = await readdir(portabilityDirectory);
    expect(finalFiles.some((name) => name.startsWith(requested.export_id))).toBe(false);
    expect(finalFiles.some((name) => name.startsWith(uncommitted.export_id))).toBe(false);
    expect(finalFiles).toContain(otherFileBeforeForget);
  }, 40_000);

  it('runs bounded retention expiry, feedback hold, and stale index backfill in the worker', async () => {
    await admin.query(
      `INSERT INTO grants(user_id, scope_id, principal_id, capabilities)
       VALUES ($1, $2, $3, ARRAY['read', 'write', 'admin'])
       ON CONFLICT (user_id, scope_id, principal_id) DO UPDATE
         SET capabilities=EXCLUDED.capabilities, updated_at=clock_timestamp()`,
      [userId, scopeB, principalId],
    );
    const user = await token([scopeB], 'memory:admin');
    const createMemory = async (label: string) => {
      const response = await post(
        '/v1/memories:remember',
        user,
        {
          scope_id: scopeB,
          memory: {
            ...sampleMemory(),
            statement: `maintenance ${label} ${randomUUID()}`,
            evidence: [evidence(`maintenance-${label}-${randomUUID()}`)],
          },
        },
        `maintenance-${label}-${randomUUID()}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { operations: { memory_ids: string[] }[] };
      return body.operations[0]!.memory_ids[0]!;
    };
    const expiredMemoryId = await createMemory('expired');
    const freshMemoryId = await createMemory('fresh');
    const expiredSource = await admin.query<{ source_id: string }>(
      `SELECT e.source_id FROM memory_evidence me JOIN evidence e ON e.user_id=me.user_id
        AND e.scope_id=me.scope_id AND e.id=me.evidence_id
       WHERE me.user_id=$1 AND me.scope_id=$2 AND me.memory_id=$3 LIMIT 1`,
      [userId, scopeB, expiredMemoryId],
    );
    expect(expiredSource.rows[0]?.source_id).toBeDefined();
    await admin.query(
      `UPDATE observations SET captured_at=clock_timestamp()-interval '3 days'
       WHERE user_id=$1 AND scope_id=$2 AND source_id=$3`,
      [userId, scopeB, expiredSource.rows[0]!.source_id],
    );
    await admin.query(
      `UPDATE evidence SET captured_at=clock_timestamp()-interval '3 days'
       WHERE user_id=$1 AND scope_id=$2 AND source_id=$3`,
      [userId, scopeB, expiredSource.rows[0]!.source_id],
    );
    await admin.query(
      `UPDATE memories SET recorded_at=clock_timestamp()-interval '3 days'
       WHERE user_id=$1 AND scope_id=$2 AND id=$3`,
      [userId, scopeB, expiredMemoryId],
    );

    const retention = await fetch(`${baseUrl}/v1/scopes/${scopeB}/retention`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      body: JSON.stringify({ observation_days: 1, memory_days: 1 }),
    });
    expect(retention.status).toBe(200);
    const feedback = await post(`/v1/memories/${freshMemoryId}:feedback`, user, {
      scope_id: scopeB,
      feedback_type: 'stale',
      metadata: { reason: 'local maintenance fixture' },
    });
    expect(feedback.status).toBe(200);

    const beforeIndex = await admin.query<{ indexed_revision: number; committed_revision: number }>(
      'SELECT indexed_revision, committed_revision FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$3',
      [userId, scopeB, freshMemoryId],
    );
    expect(beforeIndex.rows[0]?.indexed_revision).toBe(0);
    expect(beforeIndex.rows[0]?.committed_revision).toBeGreaterThan(0);
    const sweep = await fetch(`${workerBaseUrl}/internal/governance/sweep`, {
      method: 'POST',
      headers: { authorization: `Bearer ${workerTaskToken}` },
    });
    expect(sweep.status).toBe(200);
    const metrics = (await sweep.json()) as Record<string, number>;
    expect(metrics['retention_queued']).toBeGreaterThanOrEqual(2);
    expect(metrics['feedback_held']).toBeGreaterThanOrEqual(1);
    expect(metrics['reindexed']).toBeGreaterThanOrEqual(1);
    expect(metrics['pending']).toBe(0);

    const state = await admin.query<{
      expired: string;
      fresh: string;
      expired_source: string;
      feedback_state: string | null;
      fresh_indexed: number;
      fresh_committed: number;
    }>(
      `SELECT
         (SELECT count(*)::text FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$3) AS expired,
         (SELECT count(*)::text FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$4) AS fresh,
         (SELECT count(*)::text FROM sources WHERE user_id=$1 AND scope_id=$2 AND id=$5) AS expired_source,
         (SELECT fr.state FROM feedback_reassessments fr JOIN feedback f ON f.id=fr.feedback_id
          WHERE f.user_id=$1 AND f.scope_id=$2 AND f.memory_id=$4 ORDER BY fr.created_at DESC LIMIT 1) AS feedback_state,
         (SELECT indexed_revision FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$4) AS fresh_indexed,
         (SELECT committed_revision FROM memories WHERE user_id=$1 AND scope_id=$2 AND id=$4) AS fresh_committed`,
      [userId, scopeB, expiredMemoryId, freshMemoryId, expiredSource.rows[0]!.source_id],
    );
    expect(state.rows[0]).toMatchObject({
      expired: '0',
      fresh: '1',
      expired_source: '0',
      feedback_state: 'held',
    });
    expect(state.rows[0]!.fresh_indexed).toBe(state.rows[0]!.fresh_committed);
    await expect(governance.verifyLedgerReadiness()).resolves.toBeUndefined();
  }, 40_000);

  async function token(
    scopeIds: string[],
    scope: string,
    tokenSubject = subject,
    tokenAudience = audience,
  ): Promise<string> {
    const gateSubject = `gate-${randomUUID()}`;
    const clientId = 'integration-app-client';
    const principal = await admin.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM principals WHERE issuer = $1 AND subject = $2',
      [issuer, tokenSubject],
    );
    if (principal.rows[0] === undefined) {
      throw new Error(`Unknown local integration principal ${tokenSubject}`);
    }
    const capabilityCeiling = scope
      .split(/\s+/u)
      .map(
        (value) =>
          ({
            'memory:read': 'read',
            'memory:write': 'write',
            'memory:admin': 'admin',
          })[value],
      )
      .filter((value): value is 'read' | 'write' | 'admin' => value !== undefined);
    if (capabilityCeiling.length === 0)
      throw new Error(`Unknown local capability fixture ${scope}`);
    await admin.query(
      `INSERT INTO external_identity_bindings
         (external_issuer, external_subject, user_id, principal_id, scope_ids, capability_ceiling)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6::text[])`,
      [
        gateIssuer,
        gateSubject,
        principal.rows[0].user_id,
        principal.rows[0].id,
        scopeIds,
        capabilityCeiling,
      ],
    );
    const tokenValue = `opaque-${randomUUID()}`;
    gateTokens.set(tokenValue, {
      active: true,
      token_type: 'Bearer',
      gate_approved: true,
      iss: gateIssuer,
      sub: gateSubject,
      connection_id: `connection-${randomUUID()}`,
      client_id: clientId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: tokenAudience,
    });
    return tokenValue;
  }

  async function post(
    path: string,
    bearer: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(body),
    });
  }
});

function sampleMemory() {
  return {
    kind: 'fact',
    statement: 'Elara uses a blue notebook.',
    context: { episode: { condition: { weather: 'rain' }, action: 'packed', outcome: 'dry' } },
    subjects: [{ name: 'Elara Voss', aliases: [{ name: 'L. Vega' }] }],
    evidence: [evidence('source-1')],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

function rawHttpPost(
  target: URL,
  path: string,
  headers: readonly (readonly [string, string])[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path,
        method: 'POST',
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    for (const [name, value] of headers) request.appendHeader(name, value);
    request.appendHeader('content-length', '2');
    request.end('{}');
  });
}

function evidence(externalId: string) {
  return {
    source: {
      kind: 'explicit_remember',
      external_id: externalId,
      revision: '1',
      locator: `note/${externalId}`,
    },
    snippet: `Directly supplied evidence ${externalId}`,
    snippet_allowed: true,
  };
}

function connectionUrlForRole(base: string, username: string, password: string): string {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  return url.toString();
}
