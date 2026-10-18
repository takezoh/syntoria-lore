import { createDatabase, provisionApplicationRole, provisionWorkerRole } from './index.js';

const password = process.env['APP_DB_PASSWORD'];
if (password === undefined) throw new Error('APP_DB_PASSWORD is required');
const workerPassword = process.env['WORKER_DB_PASSWORD'];
const pool = createDatabase(process.env['MIGRATION_DATABASE_URL']);
try {
  await provisionApplicationRole(pool, password);
  console.log('The NOBYPASSRLS application role is ready');
  if (workerPassword !== undefined) {
    await provisionWorkerRole(pool, workerPassword);
    console.log('The dedicated NOBYPASSRLS worker role is ready');
  }
} finally {
  await pool.end();
}
