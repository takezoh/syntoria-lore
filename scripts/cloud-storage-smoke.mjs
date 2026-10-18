import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { OAuth2Client } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { createDatabase } from '@memory/db';
import { GoogleCloudObjectBucket } from '@memory/governance';
import { createGovernanceStorage } from '@memory/runtime';

const smokeId = required('CLOUD_STORAGE_SMOKE_ID').toLowerCase();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(smokeId)) {
  throw new Error('CLOUD_STORAGE_SMOKE_ID must be a UUID');
}

const ledgerBucket = required('GCS_LEDGER_BUCKET');
const artifactBucket = required('GCS_ARTIFACT_BUCKET');
const ledgerPrefix = `ledger/verification/${smokeId}/`;
const artifactPrefix = `artifacts/verification/${smokeId}/`;
const database = createDatabase(required('CLOUD_STORAGE_SMOKE_DATABASE_URL'), 1);

try {
  await assertDatabaseHasNoGovernanceHistory(database);
} finally {
  await database.end();
}

const environment = {
  ...process.env,
  STORAGE_MODE: 'gcs',
  GCS_LEDGER_BUCKET: ledgerBucket,
  GCS_ARTIFACT_BUCKET: artifactBucket,
  GCS_LEDGER_PREFIX: ledgerPrefix,
  GCS_ARTIFACT_PREFIX: artifactPrefix,
  PORTABILITY_MASTER_KEY: randomBytes(32).toString('base64url'),
  PORTABILITY_SIGNER_ID: 'storage-smoke',
};
const storageDependencies = await createStorageDependencies();
const governanceStorage = createGovernanceStorage(environment, storageDependencies);

try {
  const { deletionLedger, portabilityStore } = governanceStorage;
  await deletionLedger.initialize();
  const baseHead = await deletionLedger.currentHead();

  const entries = [smokeEntry(randomUUID()), smokeEntry(randomUUID())];
  const receipts = await Promise.all(entries.map((entry) => deletionLedger.append(entry)));
  const snapshot = await deletionLedger.readSnapshot();
  const expectedHeadSequence = baseHead.sequence + entries.length;
  assert(
    snapshot.head.sequence === expectedHeadSequence &&
      snapshot.entries.length === expectedHeadSequence,
    'concurrent ledger appends were not both committed',
  );
  assert(
    new Set(receipts.map((receipt) => receipt.sequence)).size === entries.length &&
      receipts.every((receipt) => receipt.sequence > baseHead.sequence),
    'ledger receipts conflict',
  );
  for (const entry of entries) {
    const receipt = await deletionLedger.append(entry);
    const original = receipts.find((candidate) => candidate.entry_hash === receipt.entry_hash);
    assert(original !== undefined, 'ledger retry did not return its committed receipt');
  }
  const exportId = randomUUID();
  const claims = [randomUUID(), randomUUID(), randomUUID()];
  const keys = [];
  try {
    for (const [index, claimToken] of claims.entries()) {
      const payload = { smoke_id: smokeId, claim: claimToken, ordinal: index };
      const encrypted = portabilityStore.seal(payload);
      const key = await portabilityStore.write(exportId, encrypted, claimToken);
      assert((await portabilityStore.read(key)) === encrypted, 'artifact bytes changed on read');
      assert(
        isDeepStrictEqual(portabilityStore.open(encrypted), payload),
        'artifact envelope did not round trip',
      );
      assert(
        (await portabilityStore.write(exportId, encrypted, claimToken)) === key,
        'same claim retry changed key',
      );
      keys.push({ key, encrypted, claimToken });
    }

    await expectFailure(
      () => portabilityStore.write(exportId, 'different claim payload', claims[0]),
      'different contents',
    );
    await portabilityStore.remove(keys[0].key);
    await expectFailure(() => portabilityStore.read(keys[0].key), 'missing');
    assert(
      (await portabilityStore.read(keys[1].key)) === keys[1].encrypted,
      'claim cleanup removed a sibling',
    );

    await portabilityStore.remove(`${exportId}.bundle`);
    for (const { key } of keys.slice(1))
      await expectFailure(() => portabilityStore.read(key), 'missing');
  } finally {
    await portabilityStore.remove(`${exportId}.bundle`);
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      smoke_id: smokeId,
      ledger_bucket: ledgerBucket,
      ledger_prefix: ledgerPrefix,
      artifact_bucket: artifactBucket,
      artifact_prefix: artifactPrefix,
      base_sequence: baseHead.sequence,
      concurrent_entries: entries.length,
      final_sequence: snapshot.head.sequence,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ event: 'cloud.storage.smoke.failed', smoke_id: smokeId, error_code: safeErrorCode(error) })}\n`,
  );
  process.exitCode = 1;
}

async function assertDatabaseHasNoGovernanceHistory(pool) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::text FROM users) AS users,
       (SELECT count(*)::text FROM scopes) AS scopes,
       (SELECT count(*)::text FROM memories) AS memories,
       (SELECT count(*)::text FROM deletion_requests) AS deletion_requests,
       (SELECT count(*)::text FROM export_jobs) AS export_jobs,
       (SELECT count(*)::text FROM deletion_ledger_visibility_items) AS visibility_items,
       (SELECT count(*)::text FROM deletion_ledger_checkpoint
         WHERE sequence <> 0 OR entry_hash <> repeat('0', 64)
           OR head_generation <> 'uninitialized-local-ledger'
           OR visible_sequence <> 0 OR visible_entry_hash <> repeat('0', 64)
           OR visible_head_generation <> 'uninitialized-local-ledger') AS checkpoint_history`,
  );
  const row = result.rows[0];
  if (row === undefined || Object.values(row).some((value) => value !== '0')) {
    throw new Error(
      'Cloud storage smoke requires a dedicated empty database with no governance history',
    );
  }
}

function smokeEntry(requestId) {
  return {
    request_id: requestId,
    user_id: randomUUID(),
    scope_id: randomUUID(),
    principal_id: randomUUID(),
    actor_kind: 'user',
    target_memory_ids: [],
    target_source_ids: [],
    target_subject_ids: [],
    source_locator_hmacs: [],
    blocked_at: new Date().toISOString(),
  };
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function createStorageDependencies() {
  const tokenPath = process.env['CLOUD_STORAGE_SMOKE_TOKEN_FILE'];
  if (tokenPath === undefined || tokenPath.length === 0) return {};
  const tokenFile = await stat(tokenPath);
  if (!tokenFile.isFile() || (tokenFile.mode & 0o077) !== 0) {
    throw new Error('CLOUD_STORAGE_SMOKE_TOKEN_FILE must be a private regular file');
  }
  const accessToken = (await readFile(tokenPath, 'utf8')).trim();
  if (accessToken.length < 32 || /\s/.test(accessToken)) {
    throw new Error('CLOUD_STORAGE_SMOKE_TOKEN_FILE does not contain a valid access token');
  }
  const authClient = new OAuth2Client();
  authClient.setCredentials({
    access_token: accessToken,
    expiry_date: Date.now() + 50 * 60 * 1000,
  });
  const client = new Storage({ authClient });
  return {
    createObjectBucket: (bucketName) => GoogleCloudObjectBucket.forBucket(client, bucketName),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectFailure(run, expectedMessage) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) return;
    throw error;
  }
  throw new Error(`Expected operation to fail with ${expectedMessage}`);
}

function safeErrorCode(error) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = String(error.code);
    if (/^[a-zA-Z0-9_.-]{1,64}$/.test(value)) return value;
  }
  return error instanceof Error ? error.name : 'unknown';
}
