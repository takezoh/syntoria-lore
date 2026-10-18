import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { readOptionalBearerTokenFile } from './cloud-oauth-smoke.mjs';
import {
  requireDurableForgetAccepted,
  requireEncryptedExport,
  requireExportAccepted,
  requireExportReady,
  requireForgottenExportRemoved,
  requireForgetComplete,
  requireGovernanceHttpStatus,
  requireImportedMemoryId,
  requireRecallIncludesMemory,
  requireRememberedMemoryId,
} from './cloud-governance-contract.mjs';
import { readCloudIdentityConfig } from './cloud-identity-config.mjs';

const cloudIdentity = await readCloudIdentityConfig();
const apiUrl = requiredHttpsOrigin('GOVERNANCE_API_URL');
const identityUrl = requiredHttpsOrigin('IDENTITY_PUBLIC_URL');
const clientId = process.env['OAUTH_SMOKE_CLIENT_ID'] ?? cloudIdentity.smokeClientId;
const sourceUsername = required('GOVERNANCE_SOURCE_USERNAME');
const sourcePassword = required('GOVERNANCE_SOURCE_PASSWORD');
const destinationUsername = required('GOVERNANCE_DESTINATION_USERNAME');
const destinationPassword = required('GOVERNANCE_DESTINATION_PASSWORD');
const sourceScopeId = requiredUuid('GOVERNANCE_SOURCE_SCOPE_ID');
const destinationScopeId = requiredUuid('GOVERNANCE_DESTINATION_SCOPE_ID');
const schedulerJob = required('GOVERNANCE_SCHEDULER_JOB');
const invokerToken = await readOptionalBearerTokenFile(
  required('CLOUD_API_IAM_TOKEN_FILE'),
  'CLOUD_API_IAM_TOKEN_FILE',
);
const timeoutMs = positiveInteger(process.env['GOVERNANCE_TIMEOUT_MS'], 1_200_000);

if (sourceScopeId === destinationScopeId || sourceUsername === destinationUsername) {
  throw new Error('Governance smoke requires distinct synthetic source and destination principals');
}
if (!/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/.test(schedulerJob)) {
  throw new Error('GOVERNANCE_SCHEDULER_JOB must be a Cloud Scheduler job resource name');
}

const issuer = `${identityUrl}/realms/${cloudIdentity.realm}`;
const runId = randomUUID();
const startedAt = Date.now();
const results = {};
const created = { sourceMemoryId: undefined, destinationMemoryId: undefined };
const tokens = {};
let stage = 'oauth-pkce';
let completed = false;
let schedulerAccessToken;

try {
  tokens.sourceWrite = await oauthToken(sourceUsername, sourcePassword, 'memory:write');
  tokens.sourceAdmin = await oauthToken(sourceUsername, sourcePassword, 'memory:admin');
  tokens.sourceRead = await oauthToken(sourceUsername, sourcePassword, 'memory:read');
  tokens.destinationAdmin = await oauthToken(
    destinationUsername,
    destinationPassword,
    'memory:admin',
  );
  tokens.destinationRead = await oauthToken(
    destinationUsername,
    destinationPassword,
    'memory:read',
  );
  results.sourceAndDestinationPkce_tokens = 5;

  stage = 'synthetic-memory-create';
  const syntheticStatement = `${cloudIdentity.productDisplayName} cloud governance verification ${runId}`;
  const remembered = await apiJson('/v1/memories:remember', tokens.sourceWrite, {
    method: 'POST',
    idempotencyKey: `cloud-governance-remember-${runId}`,
    body: {
      scope_id: sourceScopeId,
      memory: {
        kind: 'fact',
        statement: syntheticStatement,
        context: { purpose: 'automated cloud verification', run_id: runId },
        evidence: [
          {
            source: {
              kind: 'explicit_remember',
              external_id: `cloud-governance-${runId}`,
              revision: '1',
              locator: 'cloud-governance-smoke/synthetic',
            },
            snippet: syntheticStatement,
            snippet_allowed: true,
          },
        ],
      },
    },
  });
  requireGovernanceHttpStatus(remembered.status, 200, 'synthetic memory write');
  created.sourceMemoryId = requireRememberedMemoryId(remembered.body);
  results.synthetic_memory_created = true;

  stage = 'export-request';
  const exportRequest = await apiJson('/v1/exports', tokens.sourceAdmin, {
    method: 'POST',
    idempotencyKey: `cloud-governance-export-${runId}`,
    body: { scope_id: sourceScopeId },
  });
  const exportId = requireExportAccepted(exportRequest.status, exportRequest.body);
  const exportStatus = await waitForExport(exportId);
  requireExportReady(exportStatus);
  const download = await apiFetch(
    `/v1/exports/${encodeURIComponent(exportId)}:download?scope_id=${encodeURIComponent(sourceScopeId)}`,
    tokens.sourceAdmin,
  );
  const encryptedBundle = await download.text();
  requireEncryptedExport(download.status, download.headers.get('content-type'), encryptedBundle);
  results.encrypted_export_ready = true;

  stage = 'cross-owner-import';
  const imported = await apiJson('/v1/imports', tokens.destinationAdmin, {
    method: 'POST',
    idempotencyKey: `cloud-governance-import-${runId}`,
    body: {
      scope_id: destinationScopeId,
      encrypted_bundle: encryptedBundle,
      grant_imported_sources: true,
    },
  });
  requireGovernanceHttpStatus(imported.status, 200, 'cross-owner encrypted import');
  created.destinationMemoryId = requireImportedMemoryId(imported.body, created.sourceMemoryId);
  const recall = await apiJson('/v1/recall', tokens.destinationRead, {
    method: 'POST',
    body: {
      query: syntheticStatement,
      scope_ids: [destinationScopeId],
      mode: 'precise',
    },
  });
  requireRecallIncludesMemory(recall.status, recall.body, created.destinationMemoryId);
  results.cross_owner_import_and_recall_verified = true;

  stage = 'forget-suppression';
  const forgotten = await Promise.all([
    forgetMemory('source', created.sourceMemoryId),
    forgetMemory('destination', created.destinationMemoryId),
  ]);
  const forgetIds = forgotten.map((result, index) => {
    requireGovernanceHttpStatus(
      result.status,
      202,
      `Forget ${index === 0 ? 'source' : 'destination'}`,
    );
    return requireDurableForgetAccepted(result.body);
  });
  await assertMemoryHidden('source', tokens.sourceRead, sourceScopeId, created.sourceMemoryId);
  await assertMemoryHidden(
    'destination',
    tokens.destinationRead,
    destinationScopeId,
    created.destinationMemoryId,
  );
  results.immediate_forget_suppression_verified = true;

  stage = 'ledger-purge-and-artifact-delete';
  const forgetStatuses = [];
  for (const [index, id] of forgetIds.entries()) {
    forgetStatuses.push(
      await waitForForget(
        id,
        index === 0 ? 'source' : 'destination',
        index === 0 ? tokens.sourceAdmin : tokens.destinationAdmin,
        index === 0 ? sourceScopeId : destinationScopeId,
      ),
    );
  }
  forgetStatuses.forEach(requireForgetComplete);
  const removedExport = await apiFetch(
    `/v1/exports/${encodeURIComponent(exportId)}:download?scope_id=${encodeURIComponent(sourceScopeId)}`,
    tokens.sourceAdmin,
  );
  requireForgottenExportRemoved(removedExport.status);
  await assertMemoryHidden('source', tokens.sourceRead, sourceScopeId, created.sourceMemoryId);
  await assertMemoryHidden(
    'destination',
    tokens.destinationRead,
    destinationScopeId,
    created.destinationMemoryId,
  );
  results.forget_ledger_purge_and_artifact_removal_verified = true;
  results.status = 'passed';
  results.elapsed_ms = Date.now() - startedAt;
  completed = true;
  process.stdout.write(`${JSON.stringify(results)}\n`);
} catch {
  results.status = 'failed';
  results.failed_stage = stage;
  results.elapsed_ms = Date.now() - startedAt;
  console.error(JSON.stringify(results));
  process.exitCode = 1;
} finally {
  if (!completed) await bestEffortForgetCreatedMemories();
}

async function oauthToken(username, password, permission) {
  const { acquireOAuthResourceToken } = await import('./cloud-oauth-smoke.mjs');
  return acquireOAuthResourceToken({
    issuer,
    clientId,
    resource: apiUrl,
    scope: `openid ${permission} ${cloudIdentity.scopes.api} ${cloudIdentity.scopes.scopeIds}`,
    username,
    password,
  });
}

async function waitForExport(exportId) {
  const deadline = Date.now() + timeoutMs;
  let nextSweep = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextSweep) {
      await triggerSchedulerSweep();
      nextSweep = Date.now() + 10_000;
    }
    const response = await apiJson(
      `/v1/exports/${encodeURIComponent(exportId)}?scope_id=${encodeURIComponent(sourceScopeId)}`,
      tokens.sourceAdmin,
    );
    requireGovernanceHttpStatus(response.status, 200, 'export status request');
    if (response.body?.state === 'ready' || response.body?.state === 'failed') return response.body;
    await delay(2_000);
  }
  throw new Error('export did not reach a terminal state before timeout');
}

async function waitForForget(requestId, side, token, scopeId) {
  const deadline = Date.now() + timeoutMs;
  let nextSweep = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextSweep) {
      await triggerSchedulerSweep();
      nextSweep = Date.now() + 10_000;
    }
    const response = await apiJson(
      `/v1/forget/${encodeURIComponent(requestId)}?scope_id=${encodeURIComponent(scopeId)}`,
      token,
    );
    requireGovernanceHttpStatus(response.status, 200, `${side} Forget status request`);
    if (response.body?.status === 'complete' || response.body?.status === 'failed') {
      return response.body;
    }
    if (response.body?.content_available !== false) {
      throw new Error(`${side} Forget status exposed content as available`);
    }
    await delay(2_000);
  }
  throw new Error(`${side} Forget did not reach a terminal state before timeout`);
}

async function forgetMemory(side, memoryId) {
  const token = side === 'source' ? tokens.sourceAdmin : tokens.destinationAdmin;
  const scopeId = side === 'source' ? sourceScopeId : destinationScopeId;
  return apiJson('/v1/forget', token, {
    method: 'POST',
    idempotencyKey: `cloud-governance-forget-${side}-${runId}`,
    body: {
      scope_id: scopeId,
      selector: { memory_ids: [memoryId] },
      reason_code: 'user_requested',
    },
  });
}

async function assertMemoryHidden(side, token, scopeId, memoryId) {
  const response = await apiJson(
    `/v1/memories/${encodeURIComponent(memoryId)}?scope_id=${encodeURIComponent(scopeId)}`,
    token,
  );
  if (response.status !== 404) throw new Error(`${side} forgotten memory remained readable`);
}

async function apiJson(path, token, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    'X-Serverless-Authorization': `Bearer ${invokerToken}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
  };
  const response = await fetch(new URL(path, apiUrl), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function apiFetch(path, token) {
  return fetch(new URL(path, apiUrl), {
    headers: {
      authorization: `Bearer ${token}`,
      'X-Serverless-Authorization': `Bearer ${invokerToken}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function triggerSchedulerSweep() {
  if (schedulerAccessToken === undefined) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const access = (await client.getAccessToken()).token;
    if (typeof access !== 'string' || access.length === 0) {
      throw new Error('Scheduler API access is unavailable');
    }
    schedulerAccessToken = access;
  }
  const response = await fetch(`https://cloudscheduler.googleapis.com/v1/${schedulerJob}:run`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${schedulerAccessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Scheduler trigger returned HTTP ${response.status}`);
}

async function bestEffortForgetCreatedMemories() {
  const pending = [];
  if (typeof created.sourceMemoryId === 'string' && typeof tokens.sourceAdmin === 'string') {
    pending.push(forgetMemory('source', created.sourceMemoryId));
  }
  if (
    typeof created.destinationMemoryId === 'string' &&
    typeof tokens.destinationAdmin === 'string'
  ) {
    pending.push(forgetMemory('destination', created.destinationMemoryId));
  }
  if (pending.length === 0) return;
  const results = await Promise.allSettled(pending);
  if (results.some((result) => result.status === 'fulfilled' && result.value.status === 202)) {
    await triggerSchedulerSweep().catch(() => undefined);
  }
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredHttpsOrigin(name) {
  let url;
  try {
    url = new URL(required(name));
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin`);
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be a valid HTTPS origin`);
  }
  return url.origin;
}

function requiredUuid(name) {
  const value = required(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error('GOVERNANCE_TIMEOUT_MS must be a positive integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error('GOVERNANCE_TIMEOUT_MS must be between 1000 and 3600000');
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
