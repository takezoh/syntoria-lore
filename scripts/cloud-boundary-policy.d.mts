type IAMBinding = {
  role?: string;
  members?: string[];
  condition?: { title?: string; expression?: string };
};

type IAMPolicy = { bindings?: IAMBinding[] };

type ExpectedBinding = {
  role: string;
  members: string[];
  condition?: { title: string; expression: string };
};

export type CloudBoundaryConfig = {
  serviceAccounts: {
    api: string;
    worker: string;
    migration: string;
    taskInvoker: string;
    schedulerInvoker: string;
    build: string;
    identity: string;
    identityBootstrap: string;
  };
  principals: Record<string, { secrets?: string[] }>;
  serviceAccountProjectRoles: Record<string, string[]>;
  secretAccessors: Record<string, string[]>;
  resourceServiceAccountRoles: Record<string, Record<string, string[]>>;
  preservedResourceBindings: Record<string, ExpectedBinding[]>;
  serviceAccountPolicyBindings: Record<string, Array<{ role: string; members: string[] }>>;
  workerService: { expectedServiceAccountInvokers: string[] };
  gcsBoundary: {
    artifactBucket: string;
    artifactBucketSettings: {
      versioningEnabled: boolean;
      softDeleteRetentionSeconds: number;
      uniformBucketLevelAccess?: boolean;
      publicAccessPrevention?: string;
    };
    customRoles: Record<
      string,
      { name: string; title: string; stage: string; permissions: string[] }
    >;
    preservedBucketBindings: ExpectedBinding[];
    bucketBindings: { ledger: ExpectedBinding[]; artifacts: ExpectedBinding[] };
  };
};

export type CustomRoleReadback = {
  name?: string;
  title?: string;
  stage?: string;
  deleted?: boolean;
  disabled?: boolean;
  includedPermissions?: string[];
};

export type ArtifactBucketReadback = {
  name?: string;
  versioning?: { enabled?: boolean };
  soft_delete_policy?: { retentionDurationSeconds?: string | number };
  uniform_bucket_level_access?: boolean;
  public_access_prevention?: string;
};

export type CloudBoundaryReadbacks = {
  projectPolicy: IAMPolicy;
  ledgerPolicy: IAMPolicy;
  artifactPolicy: IAMPolicy;
  workerPolicy: IAMPolicy;
  artifactBucket: ArtifactBucketReadback;
  customRoles: Record<string, CustomRoleReadback>;
  secretPolicies: Record<string, IAMPolicy>;
  resourcePolicies: Record<string, IAMPolicy>;
  serviceAccountPolicies: Record<string, IAMPolicy>;
};

export type CloudBoundaryVerification = {
  status: 'passed' | 'failed';
  checks: string[];
  failures: string[];
};

export function verifyCloudBoundaryReadbacks(
  config: CloudBoundaryConfig,
  readbacks: CloudBoundaryReadbacks,
): CloudBoundaryVerification;
