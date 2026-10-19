import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyCloudBoundaryReadbacks } from '../scripts/cloud-boundary-policy.mjs';
import type {
  CloudBoundaryConfig,
  CloudBoundaryReadbacks,
} from '../scripts/cloud-boundary-policy.mjs';
import { isExcludedBuildContextPath } from '../scripts/cloud-build-context-policy.mjs';

const renderer = join(process.cwd(), 'scripts/render-cloud-manifests.mjs');
const contextPreparer = join(process.cwd(), 'scripts/prepare-cloud-build-context.mjs');
const contextPolicy = join(process.cwd(), 'scripts/cloud-build-context-policy.mjs');
const deploymentConfig = JSON.parse(
  await readFile(join(process.cwd(), 'infra/cloud/deployment.json'), 'utf8'),
);
const immutableImage = `${deploymentConfig.artifactRegistry}/${deploymentConfig.imageName}@sha256:${'a'.repeat(64)}`;

type SecretReference = { name: string; key: string };
type EnvironmentEntry = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: SecretReference };
};
type ContainerManifest = {
  image: string;
  env: EnvironmentEntry[];
  startupProbe: { httpGet: { path: string } };
};
type ServiceManifest = {
  metadata: { annotations: Record<string, string> };
  spec: { template: { spec: { containers: ContainerManifest[] } } };
};
type JobManifest = {
  spec: { template: { spec: { template: { spec: { containers: ContainerManifest[] } } } } };
};
type QueueManifest = {
  retryConfig: {
    maxAttempts: number;
    maxRetryDuration: string;
    minBackoff: string;
    maxBackoff: string;
  };
};
type SchedulerManifest = {
  httpTarget: { oidcToken: { audience: string } };
};
type SourceManifest = {
  format: string;
  fileCount: number;
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
};
type SourceContextSummary = {
  outputDirectory: string;
  fileCount: number;
  manifestSha256: string;
  immutable: boolean;
};

describe('cloud deployment manifests', () => {
  it('keeps local defaults generic while deployment.env pins Lore physical volumes', async () => {
    const [compose, deploymentEnv, workflow, envExample] = await Promise.all([
      readFile(join(process.cwd(), 'compose.yaml'), 'utf8'),
      readFile(join(process.cwd(), 'infra/local/deployment.env'), 'utf8'),
      readFile(join(process.cwd(), '.github/workflows/local-contract.yml'), 'utf8'),
      readFile(join(process.cwd(), '.env.example'), 'utf8'),
    ]);

    expect(compose).toContain('${LOCAL_DB_VOLUME:-memory_service_local_db}');
    expect(compose).toContain('${LOCAL_ARTIFACTS_VOLUME:-memory_service_local_artifacts}');
    expect(deploymentEnv).toContain('LOCAL_DB_VOLUME=lore_local_db');
    expect(deploymentEnv).toContain('LOCAL_ARTIFACTS_VOLUME=lore_local_artifacts');
    expect(envExample).toContain('AUTH_AUDIENCE=https://memory.example.test');
    expect(envExample).toContain('MCP_BASE_URL=https://memory.example.test');
    expect(compose).not.toContain('LOCAL_ISSUER_VOLUME');

    expect(workflow).toContain('POSTGRES_USER: memory_admin');
    expect(workflow).toContain('memory_service_test');
    expect(workflow).toContain('TEST_ADMIN_URL:');
    expect(workflow).toContain('TEST_APP_URL:');
    expect(workflow).toContain('DB_ROLE_SOURCE_PREFIX: thymesis');
    expect(workflow).toContain('docker build -t memory-service:ci .');
    expect(workflow).not.toContain('THYMESIS_TEST_ADMIN_URL');
  });

  it('configures API-only Gate resources with separate resource audiences', () => {
    expect(deploymentConfig.gate.issuer).toBe('https://gate.example.com');
    expect(deploymentConfig.services.api.url).toMatch(/^https:\/\/[^/]+\.run\.app$/);
    expect(deploymentConfig.services.api.publicUrl).toBe(deploymentConfig.gate.resourceOrigin);
    expect(deploymentConfig.gate.resourceOrigin).toBe('https://memory.example.com');
    expect(deploymentConfig.gate.allowedClientIds).toEqual(['memory-mcp-client']);
    expect(deploymentConfig.gate).not.toHaveProperty('browserAppId');
    expect(deploymentConfig.gate).not.toHaveProperty('browserClientId');
    expect(deploymentConfig.gate).not.toHaveProperty('browserRedirectUri');
    expect(
      new Set([
        deploymentConfig.gate.apiResource.clientId,
        deploymentConfig.gate.readResource.clientId,
        deploymentConfig.gate.writeResource.clientId,
      ]).size,
    ).toBe(3);
    expect(deploymentConfig.neon.sourceMigrationCount).toBe(41);
    expect(deploymentConfig.neon.targetActivationStatus).toBe(
      'gate-cutover-deployed; public-https-active; api-only-auth-pending',
    );
  });

  it('pins runtime image, exact database secrets, and canonical private worker audience', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'memory-cloud-manifests-'));
    const outputDirectory = join(temporaryRoot, 'manifests');
    try {
      const result = spawnSync(
        process.execPath,
        [renderer, '--image', immutableImage, '--output-dir', outputDirectory],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);

      const [api, worker, migration, ledger, queue, scheduler] = await Promise.all([
        readManifest<ServiceManifest>(outputDirectory, 'api-service.json'),
        readManifest<ServiceManifest>(outputDirectory, 'worker-service.json'),
        readManifest<JobManifest>(outputDirectory, 'neon-migration-job.json'),
        readManifest<JobManifest>(outputDirectory, 'ledger-reconcile-job.json'),
        readManifest<QueueManifest>(outputDirectory, 'task-queue.json'),
        readManifest<SchedulerManifest>(outputDirectory, 'scheduler-job.json'),
      ]);
      expect(await readdir(outputDirectory)).toHaveLength(6);

      expect(container(api).image).toBe(immutableImage);
      expect(container(worker).image).toBe(immutableImage);
      expect(envSecret(api, 'DATABASE_URL')).toEqual({
        name: deploymentConfig.secrets.appDatabase,
        key: '1',
      });
      expect(envValue(api, 'AUTH_ISSUER')).toBe(deploymentConfig.gate.issuer);
      expect(envValue(api, 'AUTH_AUDIENCE')).toBe(deploymentConfig.gate.resourceOrigin);
      expect(envValue(api, 'AUTH_ALLOWED_CLIENT_IDS')).toBe(
        deploymentConfig.gate.allowedClientIds.join(','),
      );
      expect(envValue(api, 'GATE_BROWSER_APP_ID')).toBeUndefined();
      expect(envValue(api, 'AUTH_BROWSER_CLIENT_ID')).toBeUndefined();
      expect(envValue(api, 'GATE_BROWSER_REDIRECT_URI')).toBeUndefined();
      expect(envValue(api, 'API_ALLOWED_ORIGINS')).toBe('');
      expect(envValue(api, 'MCP_BASE_URL')).toBe(deploymentConfig.gate.resourceOrigin);
      expect(envValue(api, 'MCP_ALLOWED_HOSTS')).toBe(
        new URL(deploymentConfig.gate.resourceOrigin).host,
      );
      expect(envValue(api, 'AUTH_JWKS_URL')).toBeUndefined();
      expect(envSecret(api, 'AUTH_API_RESOURCE_CLIENT_SECRET')).toEqual({
        name: deploymentConfig.gate.apiResource.clientSecretSecret,
        key: '1',
      });
      expect(envSecret(worker, 'WORKER_DATABASE_URL')).toEqual({
        name: deploymentConfig.secrets.workerDatabase,
        key: '1',
      });
      expect(envValue(worker, 'WORKER_TASK_TOKEN')).toBeUndefined();
      expect(worker.metadata.annotations['run.googleapis.com/custom-audiences']).toBe(
        JSON.stringify([deploymentConfig.services.worker.customAudience]),
      );
      expect(envValue(worker, 'WORKER_TASK_URL')).toBe(deploymentConfig.services.worker.url);
      expect(container(worker).startupProbe.httpGet.path).toBe('/readyz');

      expect(secretRefs(migration)).toEqual([
        { name: deploymentConfig.secrets.appDatabase, key: '1' },
        { name: deploymentConfig.secrets.migrationDatabase, key: '1' },
        { name: deploymentConfig.secrets.workerDatabase, key: '1' },
      ]);
      expect(secretRefs(ledger)).toEqual([
        { name: deploymentConfig.secrets.forgetHmac, key: '1' },
        { name: deploymentConfig.secrets.workerDatabase, key: '1' },
      ]);
      expect(queue.retryConfig).toEqual({
        maxAttempts: 5,
        maxRetryDuration: '3600s',
        minBackoff: '10s',
        maxBackoff: '300s',
      });
      expect(scheduler.httpTarget.oidcToken.audience).toBe(
        deploymentConfig.services.worker.customAudience,
      );
      expect(envValue(migration, 'IDENTITY_ISSUER_TARGET')).toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects mutable image tags without touching a nonempty destination', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'memory-cloud-manifests-'));
    const outputDirectory = join(temporaryRoot, 'manifests');
    try {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, 'keep.txt'), 'preserve');
      const result = spawnSync(
        process.execPath,
        [
          renderer,
          '--image',
          `${deploymentConfig.artifactRegistry}/${deploymentConfig.imageName}:latest`,
          '--output-dir',
          outputDirectory,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(await readFile(join(outputDirectory, 'keep.txt'), 'utf8')).toBe('preserve');
      expect(await readdir(outputDirectory)).toEqual(['keep.txt']);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('excludes incremental compiler state from immutable Cloud Build contexts', async () => {
    expect(isExcludedBuildContextPath('packages/api/tsconfig.tsbuildinfo')).toBe(true);
    expect(isExcludedBuildContextPath('packages/api/dist/index.js')).toBe(true);
    expect(isExcludedBuildContextPath('scripts/worker-secret.json')).toBe(true);
    expect(isExcludedBuildContextPath('infra/cloud/secrets/deployment.json')).toBe(true);
    expect(isExcludedBuildContextPath('packages/api/src/index.ts')).toBe(false);

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'memory-cloud-context-'));
    const outputDirectory = join(temporaryRoot, 'snapshot');
    try {
      const result = spawnSync(
        process.execPath,
        [contextPreparer, '--output-dir', outputDirectory],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout) as SourceContextSummary;
      const sourceManifest = await readManifest<SourceManifest>(
        outputDirectory,
        'source-manifest.json',
      );
      expect(summary).toEqual({
        outputDirectory,
        fileCount: sourceManifest.files.length,
        manifestSha256: createHash('sha256')
          .update(await readFile(join(outputDirectory, 'source-manifest.json')))
          .digest('hex'),
        immutable: true,
      });
      expect(sourceManifest.format).toBe('memory-service-cloud-build-source@1');
      expect(sourceManifest.fileCount).toBe(sourceManifest.files.length);

      const sourcePaths = new Set(sourceManifest.files.map((entry) => entry.path));
      const requiredSourcePaths = [
        'Dockerfile',
        '.dockerignore',
        '.gcloudignore',
        'scripts/secret-scan.mjs',
        'infra/cloud/iam-contract.json',
        'infra/cloud/deployment.json',
      ];
      for (const sourcePath of requiredSourcePaths) {
        expect(sourcePaths.has(sourcePath), `missing Cloud Build source: ${sourcePath}`).toBe(true);
        const entry = sourceManifest.files.find((file) => file.path === sourcePath);
        if (entry === undefined) throw new Error(`Source manifest omitted ${sourcePath}`);
        const bytes = await readFile(join(outputDirectory, sourcePath));
        expect(entry.sizeBytes).toBe(bytes.length);
        expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      }

      expect(sourceManifest.files.some((entry) => entry.path.endsWith('.tsbuildinfo'))).toBe(false);
      expect(sourceManifest.files.some((entry) => entry.path.endsWith('.env'))).toBe(false);
    } finally {
      await makeWritable(outputDirectory);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('excludes embedded secret and credential path components during source generation', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'memory-cloud-context-fixtures-'));
    const sourceRoot = join(temporaryRoot, 'source');
    const outputDirectory = join(temporaryRoot, 'snapshot');
    const sourceScripts = join(sourceRoot, 'scripts');
    const sourceCloud = join(sourceRoot, 'infra/cloud');
    try {
      const requiredFiles = [
        'Dockerfile',
        '.dockerignore',
        '.gcloudignore',
        '.prettierignore',
        '.prettierrc.json',
        'eslint.config.mjs',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'tsconfig.base.json',
        'tsconfig.test.json',
        'vitest.config.ts',
        'docs/api/openapi.json',
      ];
      for (const sourcePath of requiredFiles) {
        const targetPath = join(sourceRoot, sourcePath);
        await mkdir(join(targetPath, '..'), { recursive: true });
        await writeFile(targetPath, 'fixture\n');
      }
      for (const sourcePath of ['apps', 'packages', 'tests']) {
        await mkdir(join(sourceRoot, sourcePath), { recursive: true });
      }
      await mkdir(sourceScripts, { recursive: true });
      await mkdir(sourceCloud, { recursive: true });
      await copyFile(contextPreparer, join(sourceScripts, 'prepare-cloud-build-context.mjs'));
      await copyFile(contextPolicy, join(sourceScripts, 'cloud-build-context-policy.mjs'));
      await copyFile(
        join(process.cwd(), 'scripts/secret-scan.mjs'),
        join(sourceScripts, 'secret-scan.mjs'),
      );
      await writeFile(join(sourceScripts, 'worker-secret.json'), '{"fixture":true}\n');
      await mkdir(join(sourceCloud, 'secrets'), { recursive: true });
      await writeFile(join(sourceCloud, 'secrets/service.json'), '{"fixture":true}\n');
      await mkdir(join(sourceCloud, 'worker-secret-directory'), { recursive: true });
      await writeFile(
        join(sourceCloud, 'worker-secret-directory/deployment.json'),
        '{"fixture":true}\n',
      );
      await mkdir(join(sourceCloud, 'worker-credential-directory'), { recursive: true });
      await writeFile(
        join(sourceCloud, 'worker-credential-directory/config.json'),
        '{"fixture":true}\n',
      );
      await writeFile(join(sourceCloud, 'deployment.json'), '{"fixture":true}\n');

      const result = spawnSync(
        process.execPath,
        [join(sourceScripts, 'prepare-cloud-build-context.mjs'), '--output-dir', outputDirectory],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      const sourceManifest = await readManifest<SourceManifest>(
        outputDirectory,
        'source-manifest.json',
      );
      const sourcePaths = new Set(sourceManifest.files.map((entry) => entry.path));
      expect(sourcePaths.has('scripts/secret-scan.mjs')).toBe(true);
      expect(sourcePaths.has('infra/cloud/deployment.json')).toBe(true);
      expect(sourcePaths.has('scripts/worker-secret.json')).toBe(false);
      expect(sourcePaths.has('infra/cloud/secrets/service.json')).toBe(false);
      expect(sourcePaths.has('infra/cloud/worker-secret-directory/deployment.json')).toBe(false);
      expect(sourcePaths.has('infra/cloud/worker-credential-directory/config.json')).toBe(false);
    } finally {
      await makeWritable(outputDirectory);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('cloud IAM and artifact retention readback', () => {
  it('accepts the declared service accounts, secret accessors, resource grants, and erasure settings', async () => {
    const config = await readBoundaryConfig();
    const result = verifyCloudBoundaryReadbacks(config, makeBoundaryReadbacks(config));

    expect(result.status).toBe('passed');
    expect(result.failures).toEqual([]);
    expect(result.checks).toHaveLength(9);
  });

  it('rejects widened custom permissions, ledger conditions, and runtime policy grants', async () => {
    const config = await readBoundaryConfig();
    const readbacks = makeBoundaryReadbacks(config);
    const ledgerNodeRole = customRoleId(config.gcsBoundary.customRoles['ledgerNode']?.name);
    readbacks.customRoles[ledgerNodeRole]?.includedPermissions?.push('storage.objects.delete');
    const expectedNodeRole = config.gcsBoundary.customRoles['ledgerNode'];
    if (expectedNodeRole === undefined) throw new Error('Ledger node role is not declared');
    const nodeBinding = readbacks.ledgerPolicy.bindings?.find(
      (binding) => binding.role === expectedNodeRole.name,
    );
    if (nodeBinding?.condition !== undefined) {
      nodeBinding.condition.expression = `resource.name.startsWith('projects/_/buckets/${deploymentConfig.buckets.ledger}/objects/ledger/')`;
      nodeBinding.members?.push('group:unexpected@example.test');
    }
    const projectModelRole = readbacks.projectPolicy.bindings?.find(
      (binding) => binding.role === 'roles/aiplatform.user',
    );
    projectModelRole?.members?.push('group:unexpected@example.test');
    readbacks.projectPolicy.bindings?.push({
      role: 'roles/storage.admin',
      members: [`serviceAccount:${config.serviceAccounts['api']}`],
    });
    readbacks.artifactPolicy.bindings?.push({
      role: 'roles/storage.objectAdmin',
      members: [`serviceAccount:${config.serviceAccounts['worker']}`],
    });

    const result = verifyCloudBoundaryReadbacks(config, readbacks);
    expect(result.status).toBe('failed');
    expect(result.failures.join('\n')).toContain(`custom role ${ledgerNodeRole} permissions`);
    expect(result.failures.join('\n')).toContain(
      'ledger bucket IAM policy: bindings do not match the exact declared role, member, and condition sets',
    );
    expect(result.failures.join('\n')).toContain('project IAM policy: api roles');
    expect(result.failures.join('\n')).toContain(
      'project IAM policy controlled roles: bindings do not match the exact declared role, member, and condition sets',
    );
    expect(result.failures.join('\n')).toContain(
      'artifact bucket IAM policy: bindings do not match the exact declared role, member, and condition sets',
    );
  });

  it('rejects added or disabled custom roles and conditioned worker invokers', async () => {
    const config = await readBoundaryConfig();
    const readbacks = makeBoundaryReadbacks(config);
    readbacks.customRoles['unexpectedRole'] = {
      name: `projects/${deploymentConfig.project}/roles/unexpectedRole`,
      title: 'Unexpected role',
      stage: 'GA',
      includedPermissions: ['storage.objects.get'],
    };
    const artifactReadRole = customRoleId(config.gcsBoundary.customRoles['artifactRead']?.name);
    readbacks.customRoles[artifactReadRole]!.disabled = true;
    const workerInvoker = readbacks.workerPolicy.bindings?.[0];
    if (workerInvoker !== undefined) {
      workerInvoker.condition = { title: 'unreviewed', expression: 'true' };
      workerInvoker.members?.push('user:operator@example.test');
    }

    const result = verifyCloudBoundaryReadbacks(config, readbacks);
    expect(result.status).toBe('failed');
    expect(result.failures.join('\n')).toContain('custom role IDs');
    expect(result.failures).toContain(`custom role ${artifactReadRole} is disabled`);
    expect(result.failures).toContain(
      'worker service IAM policy: taskInvoker has an unexpected condition on roles/run.invoker',
    );
    expect(result.failures.join('\n')).toContain(
      'worker service IAM policy: bindings do not match the exact declared role, member, and condition sets',
    );
  });

  it('rejects artifact versioning or nonzero soft-delete retention', async () => {
    const config = await readBoundaryConfig();
    const readbacks = makeBoundaryReadbacks(config);
    readbacks.artifactBucket.versioning = { enabled: true };
    readbacks.artifactBucket.soft_delete_policy = { retentionDurationSeconds: '3600' };

    const result = verifyCloudBoundaryReadbacks(config, readbacks);
    expect(result.status).toBe('failed');
    expect(result.failures).toContain(
      'artifact bucket versioning is enabled or could not be confirmed disabled',
    );
    expect(result.failures).toContain(
      'artifact bucket soft-delete retention is 3600 seconds; expected 0',
    );
  });

  it('rejects project grants to non-runtime service accounts and excess secret accessors', async () => {
    const config = await readBoundaryConfig();
    const readbacks = makeBoundaryReadbacks(config);
    readbacks.projectPolicy.bindings?.push({
      role: 'roles/storage.admin',
      members: [`serviceAccount:${config.serviceAccounts['migration']}`],
    });
    const forgetSecret = secretNameBySuffix(config, 'forget-hmac-key');
    const migrationSecret = secretNameBySuffix(config, 'migration-direct-url');
    const cursorSecret = secretNameBySuffix(config, 'cursor-hmac-keys');
    readbacks.secretPolicies[forgetSecret]?.bindings?.push({
      role: 'roles/secretmanager.secretAccessor',
      members: [`serviceAccount:${config.serviceAccounts['migration']}`],
    });
    const neonMigrationPolicy = readbacks.secretPolicies[migrationSecret];
    if (neonMigrationPolicy === undefined) throw new Error('Neon migration policy is missing');
    neonMigrationPolicy.bindings = [
      {
        role: 'roles/secretmanager.secretAccessor',
        members: [`serviceAccount:${config.serviceAccounts['identity']}`],
      },
    ];
    readbacks.secretPolicies[cursorSecret]?.bindings?.push({
      role: 'roles/secretmanager.secretAccessor',
      members: ['group:unexpected@example.test'],
    });

    const result = verifyCloudBoundaryReadbacks(config, readbacks);
    expect(result.status).toBe('failed');
    expect(result.failures.join('\n')).toContain('project IAM policy: migration roles');
    expect(result.failures.join('\n')).toContain(
      `secret ${forgetSecret} IAM policy: migration roles`,
    );
    expect(result.failures.join('\n')).toContain(
      `secret ${migrationSecret} IAM policy: identity roles`,
    );
    expect(result.failures.join('\n')).toContain(
      `secret ${cursorSecret} IAM policy: Secret Accessor members`,
    );
  });

  it('rejects drift in queue, registry, source bucket, and service-account policy scopes', async () => {
    const config = await readBoundaryConfig();
    const readbacks = makeBoundaryReadbacks(config);
    readbacks.resourcePolicies['queue']?.bindings?.[0]?.members?.push(
      'group:unexpected@example.test',
    );
    readbacks.resourcePolicies['registry']?.bindings?.push({
      role: 'roles/artifactregistry.admin',
      members: [`serviceAccount:${config.serviceAccounts['worker']}`],
    });
    readbacks.resourcePolicies['build-source']?.bindings
      ?.find((binding) => binding.role === 'roles/storage.legacyBucketOwner')
      ?.members?.push('group:unexpected@example.test');
    const apiServiceAccountPolicy = readbacks.serviceAccountPolicies[config.serviceAccounts['api']];
    if (apiServiceAccountPolicy === undefined)
      throw new Error('API service-account policy is missing');
    apiServiceAccountPolicy.bindings = [
      ...(apiServiceAccountPolicy.bindings ?? []),
      {
        role: 'roles/iam.serviceAccountTokenCreator',
        members: [
          `serviceAccount:${config.serviceAccounts['migration']}`,
          'group:unexpected@example.test',
        ],
      },
    ];

    const result = verifyCloudBoundaryReadbacks(config, readbacks);
    expect(result.status).toBe('failed');
    expect(result.failures.join('\n')).toContain('registry IAM policy: worker roles');
    expect(result.failures.join('\n')).toContain(
      'queue IAM policy: bindings do not match the exact declared role, member, and condition sets',
    );
    expect(result.failures.join('\n')).toContain(
      'build-source IAM policy: bindings do not match the exact declared role, member, and condition sets',
    );
    expect(result.failures.join('\n')).toContain(
      `service account policy ${config.serviceAccounts['api']}: migration roles`,
    );
    expect(result.failures.join('\n')).toContain(
      `service account policy ${config.serviceAccounts['api']}: bindings do not match the exact declared role, member, and condition sets`,
    );
  });
});

async function readManifest<T>(directory: string, name: string): Promise<T> {
  return JSON.parse(await readFile(join(directory, name), 'utf8')) as T;
}

async function readBoundaryConfig(): Promise<CloudBoundaryConfig> {
  return JSON.parse(
    await readFile(join(process.cwd(), 'infra/cloud/iam-contract.json'), 'utf8'),
  ) as CloudBoundaryConfig;
}

function secretNameBySuffix(config: CloudBoundaryConfig, suffix: string): string {
  const name = Object.keys(config.secretAccessors).find((secretName) =>
    secretName.endsWith(suffix),
  );
  if (name === undefined) throw new Error(`Secret contract has no ${suffix} entry`);
  return name;
}

function customRoleId(name: string | undefined): string {
  const roleId = name?.split('/').at(-1);
  if (roleId === undefined) throw new Error('Custom role has no role ID');
  return roleId;
}

function makeBoundaryReadbacks(config: CloudBoundaryConfig): CloudBoundaryReadbacks {
  const serviceAccount = (email: string) => `serviceAccount:${email}`;
  const serviceAccountBindings = (roleMap: Record<string, string[]>) => {
    const membersByRole = new Map<string, string[]>();
    for (const [accountKey, roles] of Object.entries(roleMap)) {
      const email =
        config.serviceAccounts[accountKey as keyof CloudBoundaryConfig['serviceAccounts']];
      if (email === undefined) throw new Error(`Unknown service account key: ${accountKey}`);
      for (const role of roles) {
        const members = membersByRole.get(role) ?? [];
        members.push(serviceAccount(email));
        membersByRole.set(role, members);
      }
    }
    return [...membersByRole].map(([role, members]) => ({ role, members }));
  };
  const customRoles = Object.fromEntries(
    Object.values(config.gcsBoundary.customRoles).map((role) => {
      const roleId = role.name.split('/').at(-1);
      if (roleId === undefined) throw new Error('Custom role has no role ID');
      return [
        roleId,
        {
          name: role.name,
          title: role.title,
          stage: role.stage,
          includedPermissions: [...role.permissions],
        },
      ];
    }),
  );
  const preservedBucketBindings = structuredClone(config.gcsBoundary.preservedBucketBindings);

  return {
    projectPolicy: {
      bindings: [
        ...serviceAccountBindings(config.serviceAccountProjectRoles),
        { role: 'roles/user', members: ['user:operator@example.test'] },
        {
          role: 'roles/editor',
          members: [
            `serviceAccount:default-compute@${deploymentConfig.project}.iam.gserviceaccount.com`,
          ],
        },
      ],
    },
    ledgerPolicy: {
      bindings: [
        ...structuredClone(config.gcsBoundary.bucketBindings.ledger),
        ...preservedBucketBindings,
      ],
    },
    artifactPolicy: {
      bindings: [
        ...structuredClone(config.gcsBoundary.bucketBindings.artifacts),
        ...preservedBucketBindings,
      ],
    },
    workerPolicy: {
      bindings: [
        {
          role: 'roles/run.invoker',
          members: config.workerService.expectedServiceAccountInvokers.map(serviceAccount),
        },
      ],
    },
    secretPolicies: Object.fromEntries(
      Object.entries(config.secretAccessors).map(([secretName, accountKeys]) => {
        const rolesByAccount = Object.fromEntries(
          Object.keys(config.serviceAccounts).map((accountKey) => [
            accountKey,
            accountKeys.includes(accountKey) ? ['roles/secretmanager.secretAccessor'] : [],
          ]),
        );
        const bindings = serviceAccountBindings(rolesByAccount);
        return [
          secretName,
          bindings.length === 0 ? { etag: 'synthetic-empty-policy' } : { bindings },
        ];
      }),
    ),
    resourcePolicies: Object.fromEntries(
      Object.entries(config.resourceServiceAccountRoles).map(([resourceName, rolesByAccount]) => [
        resourceName,
        {
          bindings: [
            ...serviceAccountBindings(rolesByAccount),
            ...structuredClone(config.preservedResourceBindings[resourceName] ?? []),
          ],
        },
      ]),
    ),
    serviceAccountPolicies: Object.fromEntries(
      Object.entries(config.serviceAccountPolicyBindings).map(([targetKey, expectedBindings]) => {
        const bindings = expectedBindings.map((binding) => ({
          role: binding.role,
          members: binding.members.map((accountKey) =>
            serviceAccount(
              config.serviceAccounts[accountKey as keyof CloudBoundaryConfig['serviceAccounts']],
            ),
          ),
        }));
        return [
          config.serviceAccounts[targetKey as keyof CloudBoundaryConfig['serviceAccounts']],
          bindings.length === 0 ? { etag: 'synthetic-empty-policy' } : { bindings },
        ];
      }),
    ),
    artifactBucket: {
      name: config.gcsBoundary.artifactBucket,
      soft_delete_policy: { retentionDurationSeconds: '0' },
      uniform_bucket_level_access: true,
      public_access_prevention: 'enforced',
    },
    customRoles,
  };
}

function container(manifest: ServiceManifest | JobManifest): ContainerManifest {
  const containers =
    'containers' in manifest.spec.template.spec
      ? manifest.spec.template.spec.containers
      : manifest.spec.template.spec.template.spec.containers;
  const first = containers[0];
  if (first === undefined) throw new Error('Manifest has no container');
  return first;
}

function envValue(manifest: ServiceManifest | JobManifest, name: string): string | undefined {
  return container(manifest).env.find((entry) => entry.name === name)?.value;
}

function envSecret(
  manifest: ServiceManifest | JobManifest,
  name: string,
): SecretReference | undefined {
  return container(manifest).env.find((entry) => entry.name === name)?.valueFrom?.secretKeyRef;
}

function secretRefs(manifest: ServiceManifest | JobManifest): SecretReference[] {
  return container(manifest)
    .env.flatMap((entry) =>
      entry.valueFrom?.secretKeyRef === undefined ? [] : [entry.valueFrom.secretKeyRef],
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function makeWritable(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    return;
  }
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) await makeWritable(join(path, child));
  } else {
    await chmod(path, 0o600);
  }
}
