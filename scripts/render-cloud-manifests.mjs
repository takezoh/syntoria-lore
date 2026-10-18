#!/usr/bin/env node
import { mkdir, realpath, readdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  await readFile(join(repositoryRoot, 'infra/cloud/deployment.json'), 'utf8'),
);
const { image, identityKeycloakImage, identityProxyImage, outputDirectory } = parseArguments(
  process.argv.slice(2),
);
assertImage(image);
assertImage(identityKeycloakImage, config.identity.keycloakImageName, '--identity-keycloak-image');
assertImage(identityProxyImage, config.identity.proxyImageName, '--identity-proxy-image');
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

const issuer = `${config.identity.url}/realms/${config.identity.realm}`;
const apiUrl = config.services.api.url;
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
  secretEnv('FORGET_HMAC_KEY', config.secrets.forgetHmac),
  secretEnv('PORTABILITY_MASTER_KEY', config.secrets.portabilityMaster),
  secretEnv('CURSOR_HMAC_KEYS', config.secrets.cursorKeys),
];

const api = serviceManifest(config.services.api, image, [
  ...sharedRuntimeEnv,
  env('AUTH_ISSUER', issuer),
  env('AUTH_AUDIENCE', apiUrl),
  env('AUTH_JWKS_URL', `${issuer}/protocol/openid-connect/certs`),
  env('MCP_BASE_URL', apiUrl),
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
  env('IDENTITY_ISSUER_CUTOVER_ACTION', config.migration.identityIssuerCutover.action),
  env('IDENTITY_ISSUER_SOURCE', config.migration.identityIssuerCutover.sourceIssuer),
  env('IDENTITY_ISSUER_TARGET', config.migration.identityIssuerCutover.targetIssuer),
  env('IDENTITY_OWNER_PRINCIPAL_ID', config.migration.identityIssuerCutover.ownerPrincipalId),
  env('IDENTITY_OWNER_ID', config.migration.identityIssuerCutover.ownerId),
  env('IDENTITY_OWNER_SUBJECT_ID', config.migration.identityIssuerCutover.ownerSubjectId),
  env('IDENTITY_DATABASE_ADMIN_ROLE', config.migration.identityIssuerCutover.databaseAdminRole),
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

const identityService = createIdentityService(identityKeycloakImage, identityProxyImage);
const identityMigration = createIdentityMigrationJob(identityKeycloakImage);

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
  ['identity-service.json', identityService],
  ['identity-migration-job.json', identityMigration],
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

function createIdentityService(keycloakImage, proxyImage) {
  const identity = config.identity;
  const service = {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: identity.serviceName,
      namespace: config.projectNumber,
      annotations: { 'run.googleapis.com/ingress': 'all' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': '0',
            'autoscaling.knative.dev/maxScale': '1',
            'run.googleapis.com/execution-environment': 'gen2',
            'run.googleapis.com/container-dependencies': '{"proxy":["keycloak"]}',
            'run.googleapis.com/startup-cpu-boost': 'true',
            'run.googleapis.com/cpu-throttling': 'true',
          },
        },
        spec: {
          serviceAccountName: config.serviceAccounts.identity,
          containerConcurrency: 8,
          timeoutSeconds: 120,
          containers: [
            {
              name: 'proxy',
              image: proxyImage,
              ports: [{ containerPort: 8080 }],
              env: [
                env('IDENTITY_PUBLIC_URL', identity.url),
                env('IDENTITY_BACKEND_URL', 'http://127.0.0.1:8081'),
                env('IDENTITY_REALM', identity.realm),
              ],
              resources: { limits: { cpu: '0.08', memory: '128Mi' } },
              startupProbe: {
                tcpSocket: { port: 8080 },
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 48,
              },
            },
            {
              name: 'keycloak',
              image: keycloakImage,
              env: [
                env('KC_HOSTNAME', identity.url),
                env('KC_HOSTNAME_STRICT', 'true'),
                env('KC_DB_USERNAME', identity.databaseRole),
                env('KC_DB_POOL_INITIAL_SIZE', '1'),
                env('KC_DB_POOL_MIN_SIZE', '0'),
                env('KC_DB_POOL_MAX_SIZE', '5'),
                secretEnv('KC_DB_URL', identity.jdbcSecret, identity.jdbcSecretVersion),
                secretEnv('KC_DB_PASSWORD', identity.databasePasswordSecret, '1'),
              ],
              resources: { limits: { cpu: '1', memory: '2Gi' } },
              startupProbe: {
                httpGet: { path: '/health/ready', port: 9000 },
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 48,
              },
            },
          ],
        },
      },
      traffic: [{ latestRevision: true, percent: 100 }],
    },
  };
  return service;
}

function createIdentityMigrationJob(keycloakImage) {
  const identity = config.identity;
  const mapping = (pairs) => pairs.map(([source, target]) => `${source}=${target}`).join(',');
  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Job',
    metadata: {
      name: identity.migration.jobName,
      namespace: config.projectNumber,
      annotations: { 'deployment-status': 'pending' },
    },
    spec: {
      template: {
        spec: {
          taskCount: 1,
          parallelism: 1,
          template: {
            spec: {
              serviceAccountName: config.serviceAccounts.identityBootstrap,
              maxRetries: 0,
              timeoutSeconds: '900',
              containers: [
                {
                  name: 'migrate',
                  image: keycloakImage,
                  command: ['/opt/keycloak/cloud-oauth-bootstrap.sh'],
                  args: [],
                  env: [
                    env('IDENTITY_PUBLIC_URL', identity.url),
                    env('IDENTITY_SOURCE_REALM', identity.migration.sourceRealm),
                    env('IDENTITY_REALM', identity.migration.targetRealm),
                    env('IDENTITY_OWNER_ID', identity.migration.ownerId),
                    env('IDENTITY_OWNER_SCOPE_ID', identity.migration.ownerScopeId),
                    env('IDENTITY_OWNER_SUBJECT_ID', identity.migration.ownerSubjectId),
                    env('IDENTITY_OWNER_USERNAME', identity.migration.ownerUsername),
                    env('IDENTITY_SCOPE_RENAMES', mapping(identity.migration.scopeRenames)),
                    env('IDENTITY_CLIENT_RENAMES', mapping(identity.migration.clientRenames)),
                    env(
                      'IDENTITY_SOURCE_AUDIENCE_MAPPER_NAME',
                      identity.migration.sourceAudienceMapperName,
                    ),
                    env(
                      'IDENTITY_AUDIENCE_MAPPER_NAME',
                      identity.migration.targetAudienceMapperName,
                    ),
                    env(
                      'IDENTITY_SOURCE_SCOPE_IDS_MAPPER_NAME',
                      identity.migration.sourceScopeIdsMapperName,
                    ),
                    env(
                      'IDENTITY_SCOPE_IDS_MAPPER_NAME',
                      identity.migration.targetScopeIdsMapperName,
                    ),
                    env(
                      'IDENTITY_SOURCE_SCOPE_IDS_SCOPE_NAME',
                      identity.migration.sourceScopeIdsScopeName,
                    ),
                    env(
                      'IDENTITY_SCOPE_IDS_SCOPE_NAME',
                      identity.migration.targetScopeIdsScopeName,
                    ),
                    env('IDENTITY_SOURCE_API_SCOPE_NAME', identity.migration.sourceApiScopeName),
                    env('IDENTITY_SOURCE_READ_SCOPE_NAME', identity.migration.sourceReadScopeName),
                    env(
                      'IDENTITY_SOURCE_WRITE_SCOPE_NAME',
                      identity.migration.sourceWriteScopeName,
                    ),
                    env('IDENTITY_SOURCE_API_URL', identity.migration.sourceApiUrl),
                    env('API_RESOURCE_URL', identity.migration.targetApiUrl),
                    env('MCP_RESOURCE_BASE_URL', identity.migration.targetApiUrl),
                    env('OAUTH_PUBLIC_CLIENT_ID', identity.migration.targetPublicClientId),
                    env('OAUTH_PUBLIC_REDIRECT_URI', identity.migration.publicRedirectUri),
                    env('OAUTH_SMOKE_CLIENT_ID', identity.migration.targetSmokeClientId),
                    env('OAUTH_SMOKE_REDIRECT_URI', identity.migration.smokeRedirectUri),
                    env('OAUTH_SMOKE_USERNAME', identity.existing.smokeUsername),
                    env('OAUTH_SMOKE_USER_ID', identity.existing.smokeSubjectId),
                    env('OAUTH_SMOKE_SCOPE_ID', identity.existing.smokeScopeId),
                    env('OAUTH_SMOKE_ACTION', identity.migration.action),
                    env('KC_BOOTSTRAP_ADMIN_USERNAME', identity.migration.bootstrapAdminUsername),
                    secretEnv('KC_BOOTSTRAP_ADMIN_PASSWORD', identity.bootstrapPasswordSecret, '1'),
                    env('KC_DB_USERNAME', identity.databaseRole),
                    secretEnv('KC_DB_URL', identity.jdbcSecret, identity.jdbcSecretVersion),
                    secretEnv('KC_DB_PASSWORD', identity.databasePasswordSecret, '1'),
                  ],
                  resources: { limits: { cpu: '1', memory: '2Gi' } },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function parseArguments(args) {
  let image;
  let identityKeycloakImage;
  let identityProxyImage;
  let outputDirectory;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--image') image = args[++index];
    else if (argument === '--identity-keycloak-image') identityKeycloakImage = args[++index];
    else if (argument === '--identity-proxy-image') identityProxyImage = args[++index];
    else if (argument === '--output-dir') outputDirectory = args[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (
    image === undefined ||
    identityKeycloakImage === undefined ||
    identityProxyImage === undefined ||
    outputDirectory === undefined
  ) {
    throw new Error(
      'Usage: render-cloud-manifests.mjs --image <repository@sha256:digest> --identity-keycloak-image <repository@sha256:digest> --identity-proxy-image <repository@sha256:digest> --output-dir <absolute-path>',
    );
  }
  return { image, identityKeycloakImage, identityProxyImage, outputDirectory };
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
