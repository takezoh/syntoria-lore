import { createGovernanceStorage, parsePort } from '@memory/runtime';
import { assertNobypassRls, assertWorkerMember, createDatabase, pingDatabase } from '@memory/db';
import { CoreService, CursorCodec } from '@memory/domain';
import { createConfiguredCuratorProviders } from '@memory/curator';
import { RecallService } from '@memory/recall';
import {
  CaptureJobProcessor,
  CloudTasksTaskDispatcher,
  HttpTaskDispatcher,
  OutboxDispatcher,
  type TaskDispatcher,
} from '@memory/jobs';
import { GoogleAuth } from 'google-auth-library';
import { createWorkerServer } from './server.js';
import { createDispatchSweep } from './sweep.js';
import { ForgetService, PortabilityService } from '@memory/governance';

const host = process.env['WORKER_HOST'] ?? '0.0.0.0';
const portValue = process.env['PORT'] ?? process.env['WORKER_PORT'];
const portVariable = process.env['PORT'] === undefined ? 'WORKER_PORT' : 'PORT';
const port = parsePort(portValue, portVariable, 8081);
const pool = createDatabase(requiredEnvironment('WORKER_DATABASE_URL'), 5);
await assertNobypassRls(pool);
await assertWorkerMember(pool);
const cursors = CursorCodec.fromEnvironment();
const core = new CoreService(pool, cursors);
const governanceStorage = createGovernanceStorage();
const governance = new ForgetService(pool, governanceStorage.deletionLedger);
const portability = new PortabilityService(pool, governanceStorage.portabilityStore, {
  hmacKey: requiredEnvironment('FORGET_HMAC_KEY'),
});
const providers = createConfiguredCuratorProviders();
const recall = new RecallService(pool, core, providers.embeddings);
const processor = new CaptureJobProcessor(pool, core, recall, providers.curator, {
  leaseSeconds: 600,
});
const taskMode = process.env['TASK_DISPATCH_MODE'] ?? 'local-http';
if (taskMode !== 'local-http' && taskMode !== 'cloud-tasks')
  throw new Error('TASK_DISPATCH_MODE must be local-http or cloud-tasks');
const cloudTaskVariables = [
  'CLOUD_TASKS_PROJECT_ID',
  'CLOUD_TASKS_LOCATION',
  'CLOUD_TASKS_QUEUE',
  'TASK_INVOKER_SERVICE_ACCOUNT',
  'WORKER_PRIVATE_IAM',
];
let taskToken: string | undefined;
let authorizeInternal: ((request: import('node:http').IncomingMessage) => boolean) | undefined;
let taskDispatcher: TaskDispatcher;
if (taskMode === 'cloud-tasks') {
  if (process.env['WORKER_PRIVATE_IAM'] !== 'true')
    throw new Error('WORKER_PRIVATE_IAM=true is required in cloud-tasks mode');
  if (process.env['WORKER_TASK_TOKEN'] !== undefined)
    throw new Error('WORKER_TASK_TOKEN is local-only and must be unset in cloud-tasks mode');
  if (process.env['LOCAL_TASK_FIXTURE'] !== undefined)
    throw new Error('LOCAL_TASK_FIXTURE is local-only');
  const googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  taskDispatcher = new CloudTasksTaskDispatcher(
    {
      projectId: requiredEnvironment('CLOUD_TASKS_PROJECT_ID'),
      location: requiredEnvironment('CLOUD_TASKS_LOCATION'),
      queue: requiredEnvironment('CLOUD_TASKS_QUEUE'),
      workerUrl: requiredEnvironment('WORKER_TASK_URL'),
      taskInvokerServiceAccount: requiredEnvironment('TASK_INVOKER_SERVICE_ACCOUNT'),
    },
    async () => {
      const client = await googleAuth.getClient();
      const token = (await client.getAccessToken()).token;
      if (token === null || token === undefined || token.length === 0)
        throw new Error('Google Cloud access token is unavailable');
      return token;
    },
  );
  // Cloud Run IAM authenticates the private service before the request reaches this handler.
  // No request header is accepted as caller identity by the application.
  authorizeInternal = () => true;
} else {
  if (cloudTaskVariables.some((name) => process.env[name] !== undefined))
    throw new Error('Cloud Tasks and private IAM configuration require cloud-tasks mode');
  taskToken = requiredEnvironment('WORKER_TASK_TOKEN');
  const taskUrl = process.env['WORKER_TASK_URL'] ?? `http://127.0.0.1:${port}`;
  taskDispatcher = new HttpTaskDispatcher(
    taskUrl,
    taskToken,
    300_000,
    fetch,
    process.env['LOCAL_TASK_FIXTURE'] === '1' && taskUrl === 'http://tasks:9091',
  );
}
const dispatcher = new OutboxDispatcher(pool, taskDispatcher);
const runGovernanceSweep = async (cloudLimits = false) => {
  const maintenance = await governance.processMaintenanceWorker(
    pool,
    (actor, scopeId, limit) => recall.indexStaleMemories(actor, scopeId, limit),
    cloudLimits ? { reindexActorLimit: 1, reindexItemLimit: 5 } : {},
  );
  const deletion = await governance.processPendingWorker(pool);
  return { ...deletion, ...maintenance };
};
const server = createWorkerServer({
  processor,
  ...(taskToken === undefined ? {} : { taskToken }),
  ...(authorizeInternal === undefined ? {} : { authorizeInternal }),
  ...(taskMode === 'local-http'
    ? {
        allowLocalGovernanceSweep: true,
        runGovernanceSweep: () => runGovernanceSweep(),
      }
    : { allowLocalGovernanceSweep: false }),
  ready: async () => {
    await pingDatabase(pool);
    await governance.verifyLedgerReadiness();
  },
  runPortabilitySweep: async () => {
    const result = await portability.processPendingWorker(pool);
    const expired = await portability.expireArtifacts(pool);
    const files = await portability.processPendingFileDeletions(pool);
    return {
      ...result,
      expired,
      deleted_files: files.deleted,
      file_deletions_pending: files.pending,
    };
  },
  runDispatchSweep: createDispatchSweep({
    dispatchPending: (limit) => dispatcher.dispatchPending(limit),
    sweepDueJobs: (limit) => dispatcher.sweepDueJobs(limit),
    runGovernanceSweep: () => runGovernanceSweep(true),
    runPortabilitySweep: async () => {
      const result = await portability.processPendingWorker(pool);
      const expired = await portability.expireArtifacts(pool);
      const files = await portability.processPendingFileDeletions(pool);
      return {
        ...result,
        expired,
        deleted_files: files.deleted,
        file_deletions_pending: files.pending,
      };
    },
  }),
});
let dispatching = false;
const dispatchTick = async (): Promise<void> => {
  if (dispatching) return;
  dispatching = true;
  try {
    await dispatcher.dispatchPending();
    await dispatcher.sweepDueJobs();
    await runGovernanceSweep();
    await portability.processPendingWorker(pool);
    await portability.expireArtifacts(pool);
    await portability.processPendingFileDeletions(pool);
    await runGovernanceSweep();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'worker.sweep.failed',
        error_code: errorCode(error),
      }),
    );
  } finally {
    dispatching = false;
  }
};
const dispatchTimer =
  taskMode === 'local-http' ? setInterval(() => void dispatchTick(), 2_000) : undefined;
dispatchTimer?.unref();

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: 'worker.started', host, port, task_mode: taskMode }));
  if (taskMode === 'local-http') void dispatchTick();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (dispatchTimer !== undefined) clearInterval(dispatchTimer);
    server.close(() => void pool.end());
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value)) return value;
  }
  return error instanceof Error ? error.name : 'unknown';
}
