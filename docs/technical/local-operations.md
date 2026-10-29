# Local stack operations

This runbook describes the loopback-only Compose stack used for development and local acceptance. Setup and the acceptance command are in [development](../development.md); cloud procedures are in [deployment](deployment.md). Nothing here is a GCP, Neon or production recovery procedure.

## Start, inspect, stop, reset

```sh
sh scripts/local.sh start
sh scripts/local.sh status
sh scripts/local.sh diagnostics
sh scripts/local.sh logs api
sh scripts/local.sh stop
sh scripts/local.sh start
```

`start` generates local-only infrastructure secrets, starts PostgreSQL, reapplies migrations, verifies the existing deletion-ledger snapshot, and waits for API/worker readiness. It does not replay the ledger into a restored database. Use the explicit `restore-reconcile` command for that operation. `stop` preserves the named volumes, database, export artifacts, and deletion ledger. `reset` is destructive: it removes only this Compose project's named volumes and `.env.local`, so the next start creates an empty test stack.

API, Tasks fixture, and Scheduler fixture listen only on loopback. Generated local secrets have user-only permissions; never copy them into a shared environment. The API needs the operator-configured Gate issuer, API resource credentials and one MCP resource credential. MCP read and write tools use the same exact `/mcp` audience and are exposed from the authenticated principal's current capabilities. API/worker request logs contain correlation ID, route template, result code, and duration, never statement/evidence text or bearer tokens. Diagnostics returns database counters and ledger checkpoint metadata, not remembered content; the ledger checkpoint is read through the checked non-bypass worker login. Outbox diagnostics distinguishes the `capture.accepted` task-dispatch queue from `memory.change` rows served by the change feed and `forget.accepted` metadata handled by the worker's deletion poll. Only the capture rows count as pending Task deliveries.

## OAuth and client boundary

The API listener binds to `127.0.0.1:18080` for local use, while Gate resource audiences use HTTPS URLs. Configure an operator-controlled local TLS proxy for `https://memory.example.test` to the loopback API and register the API resource plus one MCP resource whose exact audience is `https://memory.example.test/mcp` with the test Gate. Lore has no callback or shared-cookie configuration; an MCP client owns its OAuth callback. The repository does not provide or start a TLS proxy.

Supply short-lived Gate bearer tokens to the smoke process through its protected environment: `LOCAL_API_BEARER_TOKEN` and `LOCAL_MCP_BEARER_TOKEN`. The MCP token must target `https://memory.example.test/mcp` and have both `read` and `write` capabilities so the smoke can use both operation groups through one connection. Set `LOCAL_API_BASE_URL` to the canonical HTTPS origin served by the proxy; it defaults to `https://memory.example.test`. The API and MCP resource URLs must exactly match the Gate audiences and metadata. `sh scripts/local.sh smoke` proves REST-to-MCP Recall and MCP write on one connection, and rejects an API token at `/mcp`.

## Provider and queue retry

The local fixtures can fail a single deterministic provider or task request:

```sh
sh scripts/local.sh fail-next-provider curator
sh scripts/local.sh fail-next-provider embedding
sh scripts/local.sh fail-next-task
sh scripts/local.sh duplicate-scheduler
sh scripts/local.sh scheduler
sh scripts/local.sh diagnostics
```

Provider failures are consumed from a shared local fixture directory. A failed capture remains durable with a retryable job state; the next worker attempt resumes its checkpoint. A task failure leaves the job/outbox visible for dispatch retry. Scheduler recovery is idempotent; the duplicate control deliberately redelivers and should not create a second memory/evidence result. `scheduler` runs the bounded maintenance sweep, including retention, index repair, feedback review hold, and pending task recovery. Inspect counts with `diagnostics`, then query the authenticated capture job or review item through its API route.

For a new confirmed Capture, the local async worker may auto-commit a safe proposal. Ambiguous/prohibited decisions stay held until an User makes an explicit review decision. Replaying an old source revision after User confirmation resolves to the original job and preserves the confirmed memory revision; see the PostgreSQL case `keeps User authority separate from client proposals and lets User confirm a candidate`.

## Source-rights revocation and Forget

Source rights revocation and User Forget are distinct actions. Revocation removes dependent content from protected reads/Recall immediately under current source-rights checks; it does not imply that the User requested physical deletion. Forget records immediate suppression in PostgreSQL and the independent local deletion ledger; worker acknowledgement and purge are asynchronous.

Use the `forget_request_id` returned by `POST /v1/forget` to poll `GET /v1/forget/{forget_request_id}?scope_id=...`. Do not use the transport `request_id` as a business identifier. `sh scripts/local.sh diagnostics` reports queued/failed purge state without returning content. A stalled request is safe to retry with the same idempotency key. Do not manually delete the ledger entry or its checkpoint.

## Backup snapshot and restore reconciliation

The automated acceptance suite creates a separate PostgreSQL clone from a pre-Forget snapshot, then proves readiness is blocked until the newer ledger is replayed through the non-bypass worker login. Reproduce the service-level clone case after the local fixture has been bootstrapped with:

```sh
node --import tsx scripts/test-governance-restore-clone.ts
```

For a restored local database, invoke the executable reconciliation command against that target while mounting the same independent artifact/ledger volume. Supply the target database URLs as the tool-container environment; do not point it at the original live database and call that a restore test:

```sh
docker compose --env-file .env.local -f compose.yaml --profile tools run --rm \
  -e DATABASE_URL='<restored-app-url>' \
  -e WORKER_DATABASE_URL='<restored-worker-url>' \
  restore-reconcile
```

The command checks that the app login is non-superuser and `NOBYPASSRLS`, checks that the worker login is a non-superuser member of the narrowly privileged worker role and is also `NOBYPASSRLS`, applies the latest ledger through the worker role, and rechecks readiness before reporting success. A missing, corrupt, gapped, or unverifiable ledger exits non-zero. The restored target must remain unavailable for protected reads until this command succeeds.

## Fresh-database encrypted import

`npm run test:integration` also creates a fresh source database and an independent empty target database in the local PostgreSQL cluster. It applies all migrations to both, verifies the target API principal is `NOBYPASSRLS` (and the source worker is a non-superuser `NOBYPASSRLS` member), exports an encrypted two-revision history, then imports it into the target through the portability service. It checks destination ID/source mappings, Get, Recall, both history revisions, evidence, origin provenance, authority downgrade, and the target import change event. The target begins without the source memory row. This proves database isolation within one local PostgreSQL cluster; it does not claim a separate server/cluster or hosted migration.

## Boundaries

The local queue, Scheduler, filesystem ledger, and encrypted export store are test adapters. Their deterministic failure/retry and local fsync behavior do not establish Cloud Tasks delivery guarantees, hosted Gate or GitHub identity, managed key custody, external-source OAuth, Neon backup retention, production alerting, or production RPO/RTO.
