# Verification design

## Environment and harness selection

Verify the actual responsibility boundary. Unit tests establish deterministic logic and adapter behavior against fakes; the PostgreSQL suite establishes transactions, row-level security and concurrency; the local Compose stack establishes process composition, OAuth resource checks, worker delivery and recovery; deployed smoke runs establish hosted identity, IAM, queue, storage and provider behavior. A passing lower-fidelity check never closes a higher boundary, and local fixtures never count as cloud evidence. Inventory the runners below and read their paths before running them. Record failed, skipped and unexecuted scenarios explicitly.

## Layers and contracts

- **Unit** (`npm run test:unit`): contracts, curator schema and evidence-anchor validation, Vertex adapter, cloud storage adapters with SDK preconditions, task dispatch, OAuth bootstrap and smoke contracts, Keycloak proxy allowlist, packaging and source-context policy, deployment manifest rendering.
- **PostgreSQL integration** (`npm run test:integration`): `tests/core.postgres.test.ts` against a real server and the non-bypass application role—RLS, grant intersection and expiry at authentication and operation time, idempotency, separate proposal and commit, parallel compare-and-set, rollback after a late source-rights failure, per-revision evidence, bitemporal reads, every change operation, cursor tampering and epoch expiry, append-only privileges, pooled-context reset, capture and review, Forget and purge, export and import, MCP clients. It then runs the restore-clone and fresh-database portability scripts. The runner fails when `TEST_ADMIN_URL` and `TEST_APP_URL` are missing; `npm test` alone does not prove database behavior.
- **Local stack** (`sh scripts/local.sh smoke`, `acceptance`): signed-token REST and MCP with two principals and wrong-audience rejection, forced task and provider failures with retries and duplicate scheduler sweeps, stop/start persistence, restore reconciliation, the deterministic evaluation and a mixed-load smoke.
- **Offline cloud contracts**: tests that drive the cloud smoke runners against fixtures. They make no network request and are not hosted evidence.
- **Hosted smoke**: OAuth PKCE and MCP, Cloud Tasks delivery, governance across users, GCS ledger and restore clone, Vertex provider identity. See the [infrastructure runbook](infrastructure-runbook.md).

## PostgreSQL acceptance

Exercise concurrent writers on the same memory and scope, stale revisions, identical and changed replays, rollback in the middle of a change set, source-rights revocation racing an authorized read, grant expiry between authentication and commit, cursor paging across rollbacks, and the read-after-write path while the index lags. Verify that a Forget hides the target at commit, leaves unrelated memories readable, purges content and stays effective after a snapshot clone is reconciled. Use disposable databases and synthetic data; never run destructive fixtures against personal or production data.

## Evaluation

`npm run eval:local` (part of `acceptance`) runs a versioned deterministic fixture set through the real API, database and worker: temporal and rename, authority, independent evidence, unknown and abstention, experience and procedure, security and rights, and asynchronous capture. The same Recall/QA queries are scored against a no-memory baseline and a fixed-input summary baseline (AC-13). Results, the fixture version and digest are written to `var/`. With deterministic local providers this is a contract regression, not a measurement of semantic quality, paid-model behavior or production Recall@5.

## Performance and evidence

`npm run load:local` (and `acceptance` with `LOAD_*` variables) measures a small mixed Remember/Recall/Changes workload locally. Report counts, concurrency, p50/p95, errors and database growth together with the environment; a small local run is not capacity or SLO evidence. Hosted latency, cold start, Neon round-trip time and cost require measurements in the deployed environment against the [service targets](../design/requirements.md#service-targets).

Each verification record names the source, image digest where relevant, configuration, commands, results and limitations, and keeps correctness, latency and user value separate. Dated records live in [docs/eval](../eval/); the current hosted status is the [cloud verification register](../eval/cloud-verification.md).

## Implemented runners

| Command | Scope |
| --- | --- |
| `npm run verify:local` | Build, migrations twice, typecheck, lint, format, unit, required PostgreSQL integration, OpenAPI sync, secret scan, dependency audit |
| `npm run test:unit` | All unit suites, excluding the PostgreSQL contract file |
| `npm run test:integration` | PostgreSQL contract suite, restore-clone and fresh-database portability scripts; requires database URLs |
| `sh scripts/local.sh smoke` | OAuth resources, REST→MCP recall, read/write separation on the local stack |
| `sh scripts/local.sh acceptance` | Everything above plus MCP clients, recovery, evaluation, mixed load and restart persistence |
| `node scripts/local-recovery-smoke.mjs` | Forced task/provider failures, retries, duplicate sweeps and Forget on the local stack |
| `node scripts/local-evidence-digest.mjs` | Reproducible digest of source, configuration and operational documentation |

CI runs the PostgreSQL contract job defined in [local-contract.yml](../../.github/workflows/local-contract.yml) on push and pull request.

## User identity migration regression

`TEST_ADMIN_URL=... node --import tsx scripts/test-user-identity-migration.ts`
creates and removes a disposable database on the supplied local test cluster.
It applies the immutable preceding migrations, populates user/principal/grant,
memory and receipt records, applies the user-name migration twice, and checks
stable UUIDs and table OIDs, exact receipt and hash values, old signed cursors,
forced RLS and cross-user rejection. It also checks unchanged arbitrary nested
context and SQL NULL values. This is local PostgreSQL evidence, not a hosted
migration or deployment check.
