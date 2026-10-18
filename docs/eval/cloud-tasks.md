# Cloud Tasks and Scheduler verification — 2026-10-17

This dated record covers asynchronous delivery through Cloud Tasks and the Scheduler sweep. The delivery design is in [infrastructure](../technical/infrastructure.md#asynchronous-delivery); the smoke command and its variables are in the [infrastructure runbook](../technical/infrastructure-runbook.md#verification-harnesses).

## Contract under test

In `cloud-tasks` mode the worker creates tasks with random names, a body containing only `job_id`, a task-invoker OIDC token for the worker origin and a 600-second dispatch deadline, and accepts internal calls only behind Cloud Run private IAM (`WORKER_PRIVATE_IAM=true`). Cloud Scheduler calls `POST /internal/dispatch/sweep` once a minute; each sweep processes up to 50 outbox rows and 100 due capture jobs, then a governance pass, a portability pass and a second governance pass. The legacy governance route is disabled in this mode. Deletion recovery reads at most 100 requests per call and backs off failed requests; its `pending` result is a 0/1 backlog indicator, and the visibility checkpoint does not advance while work remains.

## Executed evidence

- Local verification on 2026-10-17 passed `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run test:unit` (42 tests). PostgreSQL integration passed all 28 contract-core cases, restore-clone reconciliation and fresh-database portability checks, including limit enforcement, retry deferral and progress past a failed oldest request after migrations through `0039_bounded_pending_deletions.sql`.
- Offline smoke-contract tests require two completed worker responses before reading terminal state, reject an empty HTTP 200 and fail if either sweep changes the terminal state. They make no cloud request.
- An earlier live task creation returned HTTP 400 `INVALID_ARGUMENT` because the adapter sent the full REST endpoint as `task.name` instead of `projects/<PROJECT_ID>/locations/<LOCATION_ID>/queues/<QUEUE_ID>/tasks/<TASK_ID>`. Capture `0992e5d3-40a4-420a-bd6a-92436c71d8cb` stayed `accepted` and its outbox event undelivered; a later readback recorded that job as held with `stale_authorization`. This is a historical failure.
- The latest deployed smoke passed for synthetic capture `ce946440-96af-4691-b1df-39e6d1fac9d0`. Two authenticated Scheduler `jobs.run` requests returned HTTP 200 (855 ms and 837 ms), recorded as dispatch acceptance only. The capture reached terminal `held` at attempt 1 with no last error, and Cloud Tasks delivery logs show HTTP 200 requests to worker revision `thymesis-worker-00002-hg8`. Two direct authenticated worker sweeps each returned HTTP 200 with completed metrics (1,231 ms and 1,368 ms), and the capture remained `held` after both.

## Limits

The live run verifies delivery to a terminal held state and duplicate worker-sweep stability for one capture. The direct duplicate calls are not duplicate Scheduler executions. It does not demonstrate auto-commit, extraction quality or recovery from a transient delivery or worker failure; forced failures are covered only locally by `scripts/local-recovery-smoke.mjs`. Other outbox event types were not asserted as drained. The earlier `stale_authorization` hold does not indicate an authority bypass.
