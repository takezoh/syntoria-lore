import { assertWorkerMember, createDatabase } from '@memory/db';

const pool = createDatabase(required('MIGRATION_DATABASE_URL'), 2);
const worker = createDatabase(required('WORKER_DATABASE_URL'), 1);
try {
  await assertWorkerMember(worker);
  const jobs = await pool.query(
    `SELECT count(*) FILTER (WHERE state='failed')::int AS failed,
            count(*) FILTER (WHERE state='held')::int AS held,
            count(*) FILTER (WHERE state IN ('accepted','processing'))::int AS active
     FROM capture_jobs`,
  );
  const outbox = await pool.query(
    `SELECT count(*) FILTER (WHERE event_type='capture.accepted'
              AND delivered_at IS NULL)::int AS pending_capture_dispatch,
            coalesce(floor(extract(epoch FROM clock_timestamp() -
              min(created_at) FILTER (WHERE event_type='capture.accepted'
                AND delivered_at IS NULL)))::int, 0) AS oldest_capture_dispatch_seconds
     FROM outbox`,
  );
  const outboxEvents = await pool.query(
    `SELECT event_type, count(*)::int AS rows,
            count(*) FILTER (WHERE delivered_at IS NULL)::int AS undelivered_rows,
            count(*) FILTER (WHERE event_type='capture.accepted'
              AND delivered_at IS NULL)::int AS pending_task_dispatch
     FROM outbox GROUP BY event_type ORDER BY event_type`,
  );
  const purge = await pool.query(
    `SELECT count(*) FILTER (WHERE status <> 'complete')::int AS incomplete,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM deletion_requests`,
  );
  const index = await pool.query(
    `SELECT count(*) FILTER (WHERE indexed_revision < committed_revision)::int AS behind,
            count(*) FILTER (WHERE indexed_revision > committed_revision)::int AS ahead
     FROM memories`,
  );
  const ledger = await worker.query('SELECT * FROM app.deletion_ledger_checkpoint()');
  process.stdout.write(
    `${JSON.stringify(
      {
        database: {
          jobs: jobs.rows[0],
          outbox: outbox.rows[0],
          outbox_event_types: outboxEvents.rows,
          purge: purge.rows[0],
          index: index.rows[0],
        },
        deletion_ledger: ledger.rows[0] ?? null,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.all([pool.end(), worker.end()]);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
