import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase } from '@memory/db';
import { LocalDeletionLedger } from '@memory/governance';

const pool = createDatabase(required('MIGRATION_DATABASE_URL'), 1);
const directory = required('DELETION_LEDGER_DIR');
const ledger = new LocalDeletionLedger(directory);
try {
  try {
    await access(join(directory, 'HEAD.json'));
    await ledger.readSnapshot();
    process.stdout.write('Existing deletion ledger verified.\n');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const data = await pool.query(
      `SELECT
         (SELECT count(*)::text FROM owners) AS owners,
         (SELECT count(*)::text FROM memories) AS memories,
         (SELECT count(*)::text FROM deletion_requests) AS deletions`,
    );
    const counts = data.rows[0];
    if (
      counts === undefined ||
      counts.owners !== '0' ||
      counts.memories !== '0' ||
      counts.deletions !== '0'
    ) {
      throw new Error(
        'Deletion ledger is missing for a populated database; restore the matching ledger before readiness.',
        { cause: error },
      );
    }
    await LocalDeletionLedger.createEmpty(directory);
    process.stdout.write(
      'Initialized an empty deletion ledger for a verified empty local database.\n',
    );
  }
} finally {
  await pool.end();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
