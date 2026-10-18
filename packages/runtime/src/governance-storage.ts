import { Storage } from '@google-cloud/storage';
import {
  CloudDeletionLedger,
  CloudPortabilityStore,
  GoogleCloudObjectBucket,
  LocalDeletionLedger,
  LocalPortabilityStore,
  type CloudObjectBucket,
  type DeletionLedger,
  type PortabilityStore,
} from '@memory/governance';

export interface GovernanceStorage {
  readonly deletionLedger: DeletionLedger;
  readonly portabilityStore: PortabilityStore;
}

export interface GovernanceStorageDependencies {
  readonly createObjectBucket?: (bucketName: string) => CloudObjectBucket;
}

export function createGovernanceStorage(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: GovernanceStorageDependencies = {},
): GovernanceStorage {
  if (storageMode(environment) === 'local') {
    return {
      deletionLedger: createLocalDeletionLedger(environment),
      portabilityStore: createLocalPortabilityStore(environment),
    };
  }
  const createObjectBucket =
    dependencies.createObjectBucket ?? defaultObjectBucketFactory(new Storage());
  return {
    deletionLedger: createCloudDeletionLedger(environment, createObjectBucket),
    portabilityStore: createCloudPortabilityStore(environment, createObjectBucket),
  };
}

/** The restore command uses the ledger alone and should not need artifact configuration or keys. */
export function createDeletionLedger(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: GovernanceStorageDependencies = {},
): DeletionLedger {
  if (storageMode(environment) === 'local') return createLocalDeletionLedger(environment);
  const createObjectBucket =
    dependencies.createObjectBucket ?? defaultObjectBucketFactory(new Storage());
  return createCloudDeletionLedger(environment, createObjectBucket);
}

export function createPortabilityStore(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: GovernanceStorageDependencies = {},
): PortabilityStore {
  if (storageMode(environment) === 'local') return createLocalPortabilityStore(environment);
  const createObjectBucket =
    dependencies.createObjectBucket ?? defaultObjectBucketFactory(new Storage());
  return createCloudPortabilityStore(environment, createObjectBucket);
}

function createLocalDeletionLedger(environment: NodeJS.ProcessEnv): LocalDeletionLedger {
  return new LocalDeletionLedger(required(environment, 'DELETION_LEDGER_DIR'));
}

function createLocalPortabilityStore(environment: NodeJS.ProcessEnv): LocalPortabilityStore {
  return new LocalPortabilityStore(
    required(environment, 'PORTABILITY_STORAGE_DIR'),
    required(environment, 'PORTABILITY_MASTER_KEY'),
    required(environment, 'PORTABILITY_SIGNER_ID'),
  );
}

function createCloudDeletionLedger(
  environment: NodeJS.ProcessEnv,
  createObjectBucket: (bucketName: string) => CloudObjectBucket,
): CloudDeletionLedger {
  return new CloudDeletionLedger(createObjectBucket(required(environment, 'GCS_LEDGER_BUCKET')), {
    prefix: environment['GCS_LEDGER_PREFIX'] ?? 'ledger/',
  });
}

function createCloudPortabilityStore(
  environment: NodeJS.ProcessEnv,
  createObjectBucket: (bucketName: string) => CloudObjectBucket,
): CloudPortabilityStore {
  return new CloudPortabilityStore(
    createObjectBucket(required(environment, 'GCS_ARTIFACT_BUCKET')),
    required(environment, 'PORTABILITY_MASTER_KEY'),
    {
      prefix: environment['GCS_ARTIFACT_PREFIX'] ?? 'artifacts/',
      signerId: required(environment, 'PORTABILITY_SIGNER_ID'),
    },
  );
}

function storageMode(environment: NodeJS.ProcessEnv): 'local' | 'gcs' {
  const configuredMode = environment['STORAGE_MODE'];
  const hasCloudConfiguration =
    environment['GCS_LEDGER_BUCKET'] !== undefined ||
    environment['GCS_ARTIFACT_BUCKET'] !== undefined ||
    environment['GCS_LEDGER_PREFIX'] !== undefined ||
    environment['GCS_ARTIFACT_PREFIX'] !== undefined;
  const mode = configuredMode ?? 'local';
  if (configuredMode === undefined && hasCloudConfiguration) {
    throw new Error('STORAGE_MODE must explicitly select gcs when cloud buckets are configured');
  }
  if (mode !== 'local' && mode !== 'gcs') {
    throw new Error('STORAGE_MODE must be local or gcs');
  }
  if (mode === 'local' && hasCloudConfiguration) {
    throw new Error('GCS bucket settings cannot be used with STORAGE_MODE=local');
  }
  return mode;
}

function defaultObjectBucketFactory(storage: Storage): (bucketName: string) => CloudObjectBucket {
  return (bucketName) => GoogleCloudObjectBucket.forBucket(storage, bucketName);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
