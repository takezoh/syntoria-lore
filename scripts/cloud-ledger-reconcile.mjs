#!/usr/bin/env node
import { assertNobypassRls, assertWorkerMember, createDatabase } from '@memory/db';
import { ForgetService } from '@memory/governance';
import { createDeletionLedger } from '@memory/runtime';

const pool = createDatabase(required('WORKER_DATABASE_URL'), 1);
try {
  await assertNobypassRls(pool);
  await assertWorkerMember(pool);
  const governance = new ForgetService(pool, createDeletionLedger(), {
    hmacKey: required('FORGET_HMAC_KEY'),
  });
  let result;
  try {
    await governance.verifyLedgerReadiness();
    result = { status: 'already-current', replayed: 0, purged: 0 };
  } catch {
    result = { status: 'reconciled', ...(await governance.applyLedgerForRestore(pool)) };
  }
  await governance.verifyLedgerReadiness();
  process.stdout.write(`${JSON.stringify({ ...result, readiness: 'ready' })}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: 'cloud.ledger.reconcile.failed',
      error_code: safeErrorCode(error),
    })}\n`,
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
    const value = String(error.code);
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  }
  return error instanceof Error ? error.name : 'unknown';
}
