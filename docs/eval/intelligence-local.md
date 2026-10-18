# Local contract-intelligence verification evidence

> Historical component snapshot. Its counts and “remaining limits” describe that earlier milestone. Current combined local status, evaluation and production boundaries are recorded in [local acceptance](local-acceptance.md).

- Date: 2026-10-14
- Scope: consented Capture, durable worker delivery and recovery, Curator review, pgvector hybrid Recall, API contracts, and PostgreSQL role boundaries.
- Status: local implementation evidence for independent review; it does not mark G0/G1 or the full product acceptance gate complete.

## Environment and boundaries

- PostgreSQL ran locally at `127.0.0.1:55432` in the `thymesis_test` database. Migrations through `0011_worker_source_lock.sql` were current.
- Test setup and fixtures used the local migration/test-admin role. API requests used the non-bypass `thymesis_app` role; capture processing and outbox delivery used a provisioned `NOSUPERUSER NOBYPASSRLS` worker login pool. The tests assert those role boundaries and that job operations are not exposed to the API role.
- API/worker task delivery used a local HTTP fixture token. This verifies request authentication and durable processing locally; it is not Cloud Tasks OIDC, Google IAM, or production identity evidence.
- The deterministic curator and embedding providers are explicitly local test fixtures. Their output exercises extraction, matching, review, and vector search code paths; it is not a semantic-quality or production-provider measurement.
- No cloud resources, paid providers, production credentials, or production data were used.

## Commands and results

| Command | Result |
| --- | --- |
| `MIGRATION_DATABASE_URL=<local test-admin URL> npm run db:migrate` | Passed; PostgreSQL migrations, including `0008`–`0011`, reported current. |
| `npm run openapi:export` | Passed; generated `docs/api/openapi.json` from the served API contract. |
| `npm run format:check` | Passed after formatting the generated OpenAPI snapshot. |
| `npm run lint` | Passed. |
| `npm run typecheck` | Passed for workspace and test TypeScript. |
| `npm run build` | Passed. |
| `npm test` | Passed: 18 tests; 16 PostgreSQL cases skipped because this command was run without database test URLs. |
| `TEST_ADMIN_URL=<local test-admin URL> TEST_APP_URL=<local app URL> npm run test:integration` | Passed: all 16 real-PostgreSQL integration cases. |

The integration suite covers connector consent and capture through the formal `/v1/captures` API, worker delivery and automatic low-risk commit, hybrid Recall across all five modes, explicit unknown results and token budgets, held Owner review and reconciliation, approve/reject idempotency replay and payload conflict, principal-bound replay, source-rights rechecks on replay, source/observation deduplication across operation IDs, app/worker privilege separation, provider failure followed by checkpoint retry with one commit/evidence row, rejection of a checkpoint after source consent revocation, lease-steal fencing against stale workers, and holding a partial fact proposal from an episode before any memory or review is written. Episode proposals are checked in the worker against stored source kind: auto-processing requires a single experience candidate anchored to the complete observation with matching structured episode context (or a full verbatim description for plain-text episodes); prompt instructions alone do not authorize partial facts.

## Remaining limits

Local fake retrieval is not a recall-quality evaluation, and no performance, availability, cost, 100k/1m-memory load, or production-provider result is claimed. The local task token does not establish production IAM/OIDC. Forget/export, MCP, external OAuth integration, one-command Compose operations, cloud deployment, and broader product acceptance remain outside this evidence.
