import { spawn } from 'node:child_process';

const primary = required('MIGRATION_DATABASE_URL');
const test = required('TEST_MIGRATION_DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');
const workerPassword = required('WORKER_DB_PASSWORD');
const ledgerDirectory = required('DELETION_LEDGER_DIR');
const roleSourcePrefix = required('DB_ROLE_SOURCE_PREFIX');

await run('packages/db/dist/migrate-cli.js', {
  MIGRATION_DATABASE_URL: primary,
  DB_ROLE_SOURCE_PREFIX: roleSourcePrefix,
});
await run('packages/db/dist/migrate-cli.js', {
  MIGRATION_DATABASE_URL: test,
  DB_ROLE_SOURCE_PREFIX: roleSourcePrefix,
});
await run('packages/db/dist/setup-role.js', {
  MIGRATION_DATABASE_URL: primary,
  APP_DB_PASSWORD: appPassword,
  WORKER_DB_PASSWORD: workerPassword,
});
await run('scripts/local-ledger-bootstrap.mjs', {
  MIGRATION_DATABASE_URL: primary,
  DELETION_LEDGER_DIR: ledgerDirectory,
});
await run('packages/db/dist/migrate-cli.js', {
  MIGRATION_DATABASE_URL: primary,
  DB_ROLE_SOURCE_PREFIX: roleSourcePrefix,
});
await run('packages/db/dist/migrate-cli.js', {
  MIGRATION_DATABASE_URL: test,
  DB_ROLE_SOURCE_PREFIX: roleSourcePrefix,
});
process.stdout.write(
  'Local schema, non-bypass roles, and migration reapply are ready. Configure explicit Gate admission before serving requests.\n',
);

function run(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env: { ...process.env, ...environment },
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed with exit code ${code ?? 'signal'}`));
    });
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
