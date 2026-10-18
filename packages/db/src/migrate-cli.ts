import { createDatabase, migrate } from './index.js';

const pool = createDatabase(process.env['MIGRATION_DATABASE_URL']);
try {
  const roleSourcePrefix = process.env['DB_ROLE_SOURCE_PREFIX'];
  await migrate(pool, roleSourcePrefix === undefined ? {} : { roleSourcePrefix });
  console.log('PostgreSQL migrations are current');
} finally {
  await pool.end();
}
