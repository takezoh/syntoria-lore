import { GoogleAuth } from 'google-auth-library';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACTIONS = new Set(['configure', 'ensure-smoke-user', 'delete-smoke-user', 'rename-existing']);
const OPERATION_POLL_MS = 2_000;
const JOB_TIMEOUT_MS = 1_800_000;

export async function runCloudOAuthBootstrap(action, env = process.env, dependencies = {}) {
  if (!ACTIONS.has(action)) throw new Error('The cloud OAuth bootstrap action is invalid');
  const job = required(env, 'CLOUD_OAUTH_BOOTSTRAP_JOB');
  if (!/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/i.test(job)) {
    throw new Error('CLOUD_OAUTH_BOOTSTRAP_JOB must be a Cloud Run Job resource name');
  }
  const container = env['CLOUD_OAUTH_BOOTSTRAP_CONTAINER'] ?? 'keycloak';
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(container)) {
    throw new Error('CLOUD_OAUTH_BOOTSTRAP_CONTAINER is invalid');
  }

  const accessToken = await getAccessToken(dependencies);
  if (accessToken === null || accessToken === undefined || accessToken.length === 0) {
    throw new Error('Cloud Run Job authorization is unavailable');
  }

  const startedAt = Date.now();
  const request = (url, token, init) =>
    apiRequest(url, token, init, dependencies.fetchImpl ?? fetch);
  const wait = dependencies.pause ?? pause;
  const operation = await request(`https://run.googleapis.com/v2/${job}:run`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      overrides: {
        containerOverrides: [
          { name: container, env: [{ name: 'OAUTH_SMOKE_ACTION', value: action }] },
        ],
        taskCount: 1,
      },
    }),
  });
  const operationName = operation.name;
  if (typeof operationName !== 'string' || !operationName.startsWith('projects/')) {
    throw new Error('Cloud Run Job did not return an operation reference');
  }

  const deadline = startedAt + JOB_TIMEOUT_MS;
  let completedOperation = operation;
  while (completedOperation.done !== true && Date.now() < deadline) {
    await wait(OPERATION_POLL_MS);
    completedOperation = await request(
      `https://run.googleapis.com/v2/${operationName}`,
      accessToken,
    );
  }
  if (completedOperation.done !== true) throw new Error('Cloud Run bootstrap Job timed out');
  if (completedOperation.error !== undefined) throw new Error('Cloud Run bootstrap Job failed');

  const executionName = readExecutionName(completedOperation);
  if (executionName === undefined) throw new Error('Cloud Run Job execution could not be verified');
  await waitForExecution(executionName, accessToken, deadline, request, wait);
  return { status: 'completed', action };
}

async function waitForExecution(executionName, accessToken, deadline, request, wait) {
  while (Date.now() < deadline) {
    const execution = await request(`https://run.googleapis.com/v2/${executionName}`, accessToken);
    if (!Array.isArray(execution.conditions)) {
      await wait(OPERATION_POLL_MS);
      continue;
    }
    const completed = execution.conditions.find((condition) => condition.type === 'Completed');
    if (completed?.state === 'CONDITION_SUCCEEDED') return;
    if (completed?.state === 'CONDITION_FAILED') throw new Error('Cloud Run bootstrap Job failed');
    if (Number(execution.failedCount ?? 0) > 0) throw new Error('Cloud Run bootstrap Job failed');
    await wait(OPERATION_POLL_MS);
  }
  throw new Error('Cloud Run bootstrap Job execution timed out');
}

function readExecutionName(operation) {
  const possible = [operation.response?.name, operation.metadata?.execution];
  for (const value of possible) {
    if (
      typeof value === 'string' &&
      /^projects\/.+\/locations\/.+\/jobs\/.+\/executions\/.+$/.test(value)
    ) {
      return value;
    }
    if (typeof value === 'object' && value !== null && 'name' in value) {
      const name = value.name;
      if (typeof name === 'string' && name.includes('/executions/')) return name;
    }
  }
  return undefined;
}

async function apiRequest(url, accessToken, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Cloud Run API returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('Cloud Run API returned an invalid response');
  }
}

async function getAccessToken(dependencies) {
  if (dependencies.getAccessToken !== undefined) return dependencies.getAccessToken();
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const authClient = await auth.getClient();
  return (await authClient.getAccessToken()).token;
}

function required(env, name) {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function pause(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const action = process.argv[2] ?? 'configure';
  try {
    const result = await runCloudOAuthBootstrap(action);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Cloud OAuth bootstrap failed; inspect the Cloud Run Job logs.\n');
    process.exitCode = 1;
  }
}
