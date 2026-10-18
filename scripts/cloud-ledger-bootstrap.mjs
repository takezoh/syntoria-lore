import { readFile, stat } from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { createDatabase } from '@memory/db';
import { CloudDeletionLedger, GoogleCloudObjectBucket } from '@memory/governance';

const pool = createDatabase(required('MIGRATION_DATABASE_URL'), 1);
try {
  const history = await pool.query(
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
  const row = history.rows[0];
  if (row === undefined || Object.values(row).some((value) => value !== '0')) {
    throw new Error('Cloud ledger bootstrap requires an empty database with no ledger history');
  }

  const storage = await createStorageClient();
  const bucket = GoogleCloudObjectBucket.forBucket(storage, required('GCS_LEDGER_BUCKET'));
  const ledger = new CloudDeletionLedger(bucket, {
    prefix: required('GCS_LEDGER_PREFIX'),
  });
  await ledger.bootstrapEmpty(false);
  process.stdout.write(
    `${JSON.stringify({ status: 'bootstrapped', ledger_bucket: required('GCS_LEDGER_BUCKET') })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ event: 'cloud.ledger.bootstrap.failed', error_code: safeErrorCode(error) })}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function safeErrorCode(error) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = error.code;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value);
      if (/^[a-zA-Z0-9_.-]{1,64}$/.test(text)) return text;
    }
  }
  return error instanceof Error ? error.name : 'unknown';
}

async function createStorageClient() {
  const tokenPath = process.env['CLOUD_STORAGE_SMOKE_TOKEN_FILE'];
  if (tokenPath === undefined || tokenPath.length === 0) return new Storage();
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
  return new Storage({ authClient });
}
