#!/usr/bin/env node
import { mkdir, realpath, readdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  await readFile(join(repositoryRoot, 'infra/cloud/deployment.json'), 'utf8'),
);
const { image, outputDirectory } = parseArguments(process.argv.slice(2));
assertImage(image);
if (!isAbsolute(outputDirectory)) throw new Error('--output-dir must be an absolute path');

const output = resolve(outputDirectory);
await mkdir(output, { recursive: true, mode: 0o700 });
const realOutput = await realpath(output);
const relativeOutput = relative(repositoryRoot, realOutput);
if (
  relativeOutput === '' ||
  (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..' && !isAbsolute(relativeOutput))
) {
  throw new Error('Generated manifests must be written outside the repository');
}
if ((await readdir(realOutput)).length !== 0) {
  throw new Error('--output-dir must be an empty directory');
}

const issuer = config.gate.issuer;
const apiUrl = config.gate.resourceOrigin;
const workerUrl = config.services.worker.url;
const sharedRuntimeEnv = [
  env('NODE_ENV', 'production'),
  env('PRODUCT_DISPLAY_NAME', config.productDisplayName),
  env('PORTABILITY_SIGNER_ID', config.portabilitySignerId),
  env('STORAGE_MODE', 'gcs'),
  env('GCS_LEDGER_BUCKET', config.buckets.ledger),
  env('GCS_LEDGER_PREFIX', 'ledger/'),
  env('GCS_ARTIFACT_BUCKET', config.buckets.artifacts),
  env('GCS_ARTIFACT_PREFIX', 'artifacts/'),
  env('CURATOR_PROVIDER', 'vertex'),
  env('VERTEX_PROJECT_ID', config.project),
  env('VERTEX_LOCATION', config.vertex.location),
  env('CURATOR_MODEL_ID', config.vertex.extractionModel),
  env('EMBEDDING_MODEL_ID', config.vertex.embeddingModel),
  env('EMBEDDING_DIMENSION', config.vertex.embeddingDimension),
  env('CURSOR_HMAC_ACTIVE_KEY', config.cursorKeyId),
  env('AUTH_ISSUER', issuer),
  env('AUTH_AUDIENCE', apiUrl),
  env('AUTH_GATE_ALLOW_LOOPBACK_HTTP', '0'),
  secretEnv('FORGET_HMAC_KEY', config.secrets.forgetHmac),
  secretEnv('PORTABILITY_MASTER_KEY', config.secrets.portabilityMaster),
  secretEnv('CURSOR_HMAC_KEYS', config.secrets.cursorKeys),
];

const api = serviceManifest(config.services.api, image, [
  ...sharedRuntimeEnv,
  env('AUTH_API_RESOURCE_CLIENT_ID', config.gate.apiResource.clientId),
  secretEnv('AUTH_API_RESOURCE_CLIENT_SECRET', config.gate.apiResource.clientSecretSecret),
  env('AUTH_MCP_READ_RESOURCE_CLIENT_ID', config.gate.readResource.clientId),
  secretEnv('AUTH_MCP_READ_RESOURCE_CLIENT_SECRET', config.gate.readResource.clientSecretSecret),
  env('AUTH_MCP_WRITE_RESOURCE_CLIENT_ID', config.gate.writeResource.clientId),
  secretEnv('AUTH_MCP_WRITE_RESOURCE_CLIENT_SECRET', config.gate.writeResource.clientSecretSecret),
  env('MCP_BASE_URL', apiUrl),
  env('API_ALLOWED_ORIGINS', (config.gate.apiOrigins ?? []).join(',')),
  env('AUTH_MCP_READ_AUDIENCE', `${apiUrl}/mcp/read`),
  env('AUTH_MCP_WRITE_AUDIENCE', `${apiUrl}/mcp/write`),
  env('MCP_ALLOWED_HOSTS', new URL(apiUrl).host),
  secretEnv('DATABASE_URL', config.secrets.appDatabase),
]);

const worker = serviceManifest(config.services.worker, image, [
  ...sharedRuntimeEnv,
  env('TASK_DISPATCH_MODE', 'cloud-tasks'),
  env('WORKER_PRIVATE_IAM', 'true'),
  env('WORKER_TASK_URL', workerUrl),
  env('CLOUD_TASKS_PROJECT_ID', config.project),
  env('CLOUD_TASKS_LOCATION', config.region),
  env('CLOUD_TASKS_QUEUE', config.taskQueue.name),
  env('TASK_INVOKER_SERVICE_ACCOUNT', config.taskQueue.invokerServiceAccount),
  secretEnv('WORKER_DATABASE_URL', config.secrets.workerDatabase),
]);
// Cloud Tasks and Scheduler mint ID tokens for this canonical project-number URL.
// Keep the accepted audience at service scope so every revision accepts it.
worker.metadata.annotations['run.googleapis.com/custom-audiences'] = JSON.stringify([
  config.services.worker.customAudience,
]);
worker.spec.template.spec.containers[0].command = ['node'];
worker.spec.template.spec.containers[0].args = ['apps/worker/dist/main.js'];

const migration = jobManifest(config.migration, image, [
  env('DATABASE_NAME', config.migration.databaseName),
  env('DB_ROLE_SOURCE_PREFIX', config.migration.roleSourcePrefix),
  secretEnv(
    'MIGRATION_DATABASE_URL',
    config.secrets.migrationDatabase,
    config.migration.secretVersions.migration,
  ),
  secretEnv('APP_DATABASE_URL', config.secrets.appDatabase, config.migration.secretVersions.app),
  secretEnv(
    'WORKER_DATABASE_URL',
    config.secrets.workerDatabase,
    config.migration.secretVersions.worker,
  ),
]);
migration.spec.template.spec.template.spec.containers[0].args = ['scripts/cloud-neon-migrate.mjs'];

const ledgerReconcile = jobManifest(
  config.ledgerReconcile,
  image,
  [
    env('STORAGE_MODE', 'gcs'),
    env('GCS_LEDGER_BUCKET', config.buckets.ledger),
    env('GCS_LEDGER_PREFIX', 'ledger/'),
    secretEnv('WORKER_DATABASE_URL', config.secrets.workerDatabase),
    secretEnv('FORGET_HMAC_KEY', config.secrets.forgetHmac),
  ],
  'worker',
);
ledgerReconcile.spec.template.spec.template.spec.containers[0].args = [
  'scripts/cloud-ledger-reconcile.mjs',
];

const queue = {
  name: config.taskQueue.name,
  project: config.project,
  location: config.region,
  maxConcurrentDispatches: config.taskQueue.maxConcurrentDispatches,
  maxDispatchesPerSecond: config.taskQueue.maxDispatchesPerSecond,
  retryConfig: {
    maxAttempts: config.taskQueue.maxAttempts,
    maxRetryDuration: `${config.taskQueue.maxRetryDurationSeconds}s`,
    minBackoff: `${config.taskQueue.minBackoffSeconds}s`,
    maxBackoff: `${config.taskQueue.maxBackoffSeconds}s`,
  },
};

const scheduler = {
  name: config.taskQueue.schedulerJob,
  project: config.project,
  location: config.region,
  schedule: '* * * * *',
  timeZone: 'Etc/UTC',
  httpTarget: {
    uri: `${workerUrl}/internal/dispatch/sweep`,
    httpMethod: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from('{}').toString('base64'),
    oidcToken: {
      serviceAccountEmail: config.taskQueue.schedulerServiceAccount,
      audience: config.services.worker.customAudience,
    },
  },
};

const files = new Map([
  ['api-service.json', api],
  ['worker-service.json', worker],
  ['neon-migration-job.json', migration],
  ['ledger-reconcile-job.json', ledgerReconcile],
  ['task-queue.json', queue],
  ['scheduler-job.json', scheduler],
]);
for (const [name, value] of files) {
  await writeFile(join(realOutput, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}
process.stdout.write(
  `${JSON.stringify({ outputDirectory: realOutput, manifests: [...files.keys()] })}\n`,
);

function serviceManifest(service, containerImage, environment) {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: service.name,
      namespace: config.projectNumber,
      annotations: { 'run.googleapis.com/ingress': 'all' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': '0',
            'autoscaling.knative.dev/maxScale': String(service.maxInstances),
            'run.googleapis.com/execution-environment': 'gen2',
            'run.googleapis.com/startup-cpu-boost': 'true',
            'run.googleapis.com/cpu-throttling': 'true',
          },
        },
        spec: {
          serviceAccountName: service.serviceAccount,
          containerConcurrency: service.concurrency,
          timeoutSeconds: service.timeoutSeconds,
          containers: [
            {
              name: 'app',
              image: containerImage,
              ports: [{ containerPort: 8080 }],
              env: environment,
              resources: { limits: { cpu: service.cpu, memory: service.memory } },
              startupProbe: {
                httpGet: { path: '/readyz', port: 8080 },
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 24,
              },
            },
          ],
        },
      },
    },
  };
}

function jobManifest(job, containerImage, environment, resourceProfile = 'api') {
  const service = config.services[resourceProfile];
  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Job',
    metadata: { name: job.job, namespace: config.projectNumber },
    spec: {
      template: {
        spec: {
          taskCount: 1,
          parallelism: 1,
          template: {
            spec: {
              serviceAccountName: job.serviceAccount,
              maxRetries: 0,
              timeoutSeconds: String(job.timeoutSeconds),
              containers: [
                {
                  name: 'migrate',
                  image: containerImage,
                  command: ['node'],
                  args: [],
                  env: environment,
                  resources: { limits: { cpu: service.cpu, memory: service.memory } },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function env(name, value) {
  return { name, value };
}

function secretEnv(name, secret, version = '1') {
  return { name, valueFrom: { secretKeyRef: { name: secret, key: version } } };
}

function parseArguments(args) {
  let image;
  let outputDirectory;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--image') image = args[++index];
    else if (argument === '--output-dir') outputDirectory = args[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (image === undefined || outputDirectory === undefined) {
    throw new Error(
      'Usage: render-cloud-manifests.mjs --image <repository@sha256:digest> --output-dir <absolute-path>',
    );
  }
  return { image, outputDirectory };
}

function assertImage(value, imageName = config.imageName, argumentName = '--image') {
  const expectedPrefix = `${config.artifactRegistry}/${imageName}@sha256:`;
  if (
    !value.startsWith(expectedPrefix) ||
    !/^[a-f0-9]{64}$/.test(value.slice(expectedPrefix.length))
  ) {
    throw new Error(`${argumentName} must be an immutable digest in ${expectedPrefix}<sha256>`);
  }
}
