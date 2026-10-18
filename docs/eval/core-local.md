# Local contract-core verification evidence

> Historical milestone snapshot: this records the core-only verification at the time it was run. Later governance, intelligence, operations and acceptance work superseded the “next unit” limits below. Current repository evidence and scope are in [local acceptance](local-acceptance.md).

- Date: 2026-10-14
- Scope: local PostgreSQL migrations, authenticated API routes, transaction semantics, and generated OpenAPI snapshot.
- Independent review: pending. This evidence is not a G0/G1 acceptance claim.

## Environment

- Node.js 24.16.0 and npm 11.13.0.
- Real PostgreSQL at `127.0.0.1:55432`, database `thymesis_test`.
- Migrations and test fixtures connect through the local test administrator. HTTP/API tests connect through `thymesis_app`; the test asserts the role is `NOSUPERUSER NOBYPASSRLS` and reads no tenant rows without transaction context.
- JWTs are signed with a generated local RSA key and checked against an ephemeral localhost JWKS endpoint. There is no request-header identity bypass or external OAuth account.
- No cloud resources, deployment, production credentials, or production data were used.

## Commands and results

| Command | Result |
| --- | --- |
| `MIGRATION_DATABASE_URL=<local test-admin URL> npm run db:migrate` | Passed; migrations including `0007_grant_expiry_and_immutable_versions.sql` are current and checksums match. |
| `npm run openapi:export` | Passed; writes `docs/api/openapi.json` from the API's OpenAPI source. |
| `npm run typecheck` | Passed; workspace project references and test TypeScript checks. |
| `npm run build` | Passed. |
| `npm run lint` | Passed. |
| `npm run format:check` | Passed. |
| `TEST_ADMIN_URL=<local test-admin URL> TEST_APP_URL=<local non-bypass app URL> npm run test:integration` | Passed; the dedicated PostgreSQL integration target runs 10 real-DB cases. |
| `TEST_ADMIN_URL=<local test-admin URL> TEST_APP_URL=<local non-bypass app URL> npm test` | Passed; 26 tests across 2 files, including 10 real-PostgreSQL contract-core cases. |
| `env -u TEST_ADMIN_URL -u TEST_APP_URL npm run test:integration` | Failed as intended with exit 1 and a message naming both required URLs; it cannot silently report a skipped integration suite as green. |

The PostgreSQL tests cover denied read-only writes, inability to self-grant, grant/scope intersection and expiry at authentication and transaction time, repeat-safe Remember, proposal-before-commit behavior and committed-proposal principal checks, evidence by revision, simultaneous 200/409 CAS, full rollback after a source-rights failure, RLS context reset on a max-one pooled connection, exact two-scope signed cursor binding and epoch expiry, Owner/client authority, all eight ChangeOps, SUPERSEDE interval cutover, append-only version privileges despite a forged purge GUC, and bitemporal Get plus precise Recall. Migration `0007` adds `grants.expires_at`, checks it in authentication and locked transaction authorization, and removes runtime UPDATE/DELETE privileges on immutable versions; purge remains a future restricted governance responsibility.

## Current limits for the next units

- These checks exercise the current PostgreSQL-backed contract core, not a one-command Compose development stack. Worker currently exposes health only; fake Tasks/Scheduler and fake LLM integration remain to be supplied by later units.
- Migration `0001` reserves an embedding `real[]` column. Add a new migration for actual `pgvector` types/indexes before implementing hybrid search; the current exact Recall uses statement/subject/alias equality only.
- Only `mode: precise` Recall is implemented. Other modes return `unsupported_recall_mode`.
- The current security and lifecycle work does not implement complete Forget/physical purge, capture/curation workflows, export/import, outbox dispatch/recovery, CI, performance acceptance, or production deployment. README and the development plan continue to mark the overall local product and G0/G1 incomplete.
