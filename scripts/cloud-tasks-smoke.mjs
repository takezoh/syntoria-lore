import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { readOptionalBearerTokenFile } from './cloud-oauth-smoke.mjs';
import { verifyDuplicateWorkerSweeps } from './cloud-tasks-smoke-contract.mjs';

const apiUrl = requiredUrl('CLOUD_SMOKE_API_URL');
const workerUrl = requiredUrl('CLOUD_SMOKE_WORKER_URL');
const schedulerJob = required('CLOUD_SMOKE_SCHEDULER_JOB');
const userToken = required('CLOUD_SMOKE_USER_TOKEN');
const scopeId = required('CLOUD_SMOKE_SCOPE_ID');
const timeoutMs = positiveInteger(process.env['CLOUD_SMOKE_TIMEOUT_MS'], 1_200_000);
const apiInvokerToken = await readOptionalBearerTokenFile(
  process.env['CLOUD_API_IAM_TOKEN_FILE'],
  'CLOUD_API_IAM_TOKEN_FILE',
);
const workerInvokerToken = await readOptionalBearerTokenFile(
  required('CLOUD_SMOKE_WORKER_IAM_TOKEN_FILE'),
  'CLOUD_SMOKE_WORKER_IAM_TOKEN_FILE',
);
if (workerInvokerToken === undefined)
  throw new Error('CLOUD_SMOKE_WORKER_IAM_TOKEN_FILE is required');
const apiBase = new URL(apiUrl);
const workerBase = new URL(workerUrl);
const startedAt = Date.now();
let stage = 'configuration';

if (apiBase.protocol !== 'https:' || workerBase.protocol !== 'https:') {
  throw new Error('Cloud smoke API and worker URLs must use HTTPS');
}
if (!/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/.test(schedulerJob)) {
  throw new Error('CLOUD_SMOKE_SCHEDULER_JOB must be a Cloud Scheduler job resource name');
}
if (!/^[0-9a-f-]{36}$/i.test(scopeId)) throw new Error('CLOUD_SMOKE_SCOPE_ID must be a UUID');

try {
  await run();
} catch {
  console.error(
    JSON.stringify({
      result: 'failed',
      failed_stage: stage,
      elapsed_ms: Date.now() - startedAt,
      hint: 'Check Cloud Run, Scheduler, Tasks, and API logs for the failed stage.',
    }),
  );
  process.exitCode = 1;
}

async function run() {
  stage = 'anonymous-worker-denial';
  const anonymous = await fetch(new URL('/internal/dispatch/sweep', workerBase), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (anonymous.status !== 403)
    throw new Error(`Anonymous worker request returned HTTP ${anonymous.status}`);

  stage = 'synthetic-connector-create';
  const sourceExternalId = `cloud-smoke-${randomUUID()}`;
  const connector = await apiRequest('/v1/connectors', {
    method: 'POST',
    body: {
      scope_id: scopeId,
      source_kind: 'chat',
      external_id: sourceExternalId,
      enabled: true,
      consent: true,
      metadata: { cloud_tasks_smoke: true },
    },
  });
  if (connector.status !== 200)
    throw new Error(`Connector setup returned HTTP ${connector.status}`);

  stage = 'capture-enqueue';
  const capture = await apiRequest('/v1/captures', {
    method: 'POST',
    headers: { 'idempotency-key': `cloud-smoke-${randomUUID()}` },
    body: {
      scope_id: scopeId,
      operation_id: `cloud-smoke-${randomUUID()}`,
      source: { kind: 'chat', external_id: sourceExternalId, revision: '1' },
      observations: [
        {
          locator: 'cloud-smoke/1',
          speaker: 'user',
          content: 'Cloud Tasks smoke test: water freezes at zero degrees Celsius.',
        },
      ],
    },
  });
  if (capture.status !== 202) throw new Error(`Capture request returned HTTP ${capture.status}`);
  const captureBody = await capture.json();
  if (typeof captureBody.job_id !== 'string') throw new Error('Capture response omitted job_id');

  stage = 'scheduler-authentication';
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  if (token === null || token === undefined || token.length === 0)
    throw new Error('Cloud Scheduler access token is unavailable');
  const schedulerUrl = `https://cloudscheduler.googleapis.com/v1/${schedulerJob}:run`;
  const schedulerRuns = [];
  for (let run = 0; run < 2; run += 1) {
    stage = 'scheduler-dispatch';
    const dispatchStartedAt = Date.now();
    const response = await fetch(schedulerUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw new Error(`Cloud Scheduler trigger returned HTTP ${response.status}`);
    schedulerRuns.push({ status: response.status, elapsed_ms: Date.now() - dispatchStartedAt });
  }

  stage = 'capture-terminal-state';
  const deadline = Date.now() + timeoutMs;
  let status = await captureStatus(captureBody.job_id);
  while (Date.now() < deadline) {
    if (status === 'committed' || status === 'held') break;
    if (status === 'failed') throw new Error('Capture reached failed state');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    status = await captureStatus(captureBody.job_id);
  }
  if (status !== 'committed' && status !== 'held')
    throw new Error('Capture did not reach a terminal state');

  stage = 'duplicate-worker-sweep-completion';
  const duplicateWorkerSweeps = await verifyDuplicateWorkerSweeps({
    workerUrl: workerBase,
    workerIdToken: workerInvokerToken,
    timeoutMs,
    expectedCaptureStatus: status,
    readCaptureStatus: () => captureStatus(captureBody.job_id),
  });

  stage = 'complete';
  console.log(
    JSON.stringify({
      result: 'passed',
      anonymous_worker_status: anonymous.status,
      scheduler_dispatches: schedulerRuns,
      capture_job_id: captureBody.job_id,
      capture_status: status,
      duplicate_worker_sweeps: duplicateWorkerSweeps,
      elapsed_ms: Date.now() - startedAt,
    }),
  );
}

async function captureStatus(jobId) {
  const response = await fetch(new URL(`/v1/captures/${jobId}`, apiBase), {
    headers: {
      authorization: `Bearer ${userToken}`,
      ...(apiInvokerToken === undefined
        ? {}
        : { 'X-Serverless-Authorization': `Bearer ${apiInvokerToken}` }),
    },
  });
  if (!response.ok) throw new Error(`Capture status returned HTTP ${response.status}`);
  const result = await response.json();
  return result.status;
}

async function apiRequest(path, { method, body, headers = {} }) {
  const response = await fetch(new URL(path, apiBase), {
    method,
    headers: {
      authorization: `Bearer ${userToken}`,
      ...(apiInvokerToken === undefined
        ? {}
        : { 'X-Serverless-Authorization': `Bearer ${apiInvokerToken}` }),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return response;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  const value = required(name);
  try {
    return new URL(value).href;
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error('CLOUD_SMOKE_TIMEOUT_MS must be a positive integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000)
    throw new Error('CLOUD_SMOKE_TIMEOUT_MS must be between 1000 and 3600000');
  return value;
}
