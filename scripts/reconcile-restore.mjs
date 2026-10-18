import { assertNobypassRls, assertWorkerMember, createDatabase } from '@memory/db';
import { ForgetService } from '@memory/governance';
import { createDeletionLedger } from '@memory/runtime';

const app = createDatabase(required('DATABASE_URL'), 4);
const worker = createDatabase(required('WORKER_DATABASE_URL'), 4);
let result;
try {
  await assertNobypassRls(app);
  await assertWorkerMember(worker);
  const ledger = createDeletionLedger();
  const governance = new ForgetService(app, ledger, {
    hmacKey: required('FORGET_HMAC_KEY'),
  });
  try {
    await governance.verifyLedgerReadiness();
    result = { status: 'already-current', replayed: 0, purged: 0 };
  } catch {
    result = { status: 'reconciled', ...(await governance.applyLedgerForRestore(worker)) };
  }
  await governance.verifyLedgerReadiness();
  process.stdout.write(`${JSON.stringify({ ...result, readiness: 'ready' })}\n`);
} catch (error) {
  const code = safeErrorCode(error);
  process.stderr.write(
    `${JSON.stringify({ event: 'restore.reconcile.failed', error_code: code })}\n`,
  );
  process.exitCode = 1;
} finally {
  await Promise.all([app.end(), worker.end()]);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeErrorCode(error) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const candidate = String(error.code);
    if (/^[a-zA-Z0-9_.-]{1,64}$/.test(candidate)) return candidate;
  }
  return error instanceof Error ? error.name : 'unknown';
}
