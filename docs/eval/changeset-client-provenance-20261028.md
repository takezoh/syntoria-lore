# Changeset client provenance migration review

This is the migration review record for `0044_changeset_client_provenance.sql`, following the [migration review template](../templates/migration-review.md). The migration has run against a disposable local database. It has not been deployed.

- **Migration file / version:** `packages/db/migrations/0044_changeset_client_provenance.sql`.
- **Contract, requirement, or incident:** stage 1 of [ADR 0003](../adr/0003-attribute-ai-clients-and-confirm-user-decisions.md), requirement L-1 in the [change confirmation design](../design/change-confirmation.md).
- **User and reviewer:** owner-directed on 2026-10-28; no independent review has run.
- **Forward-only deployment order:** apply the migration, then deploy the API and worker that write `client_id`. The new application writes the column, so it must not run before the migration. An older image runs unchanged after the migration, because it never names the column.
- **Existing rows and expected data volume:** existing rows keep `client_id` NULL because their client is unknown. There is no backfill. The service is not yet in operational use, so `changesets` is small.
- **Lock, table rewrite, and index-build behavior:** one `ALTER TABLE … ADD COLUMN` with a nullable column, no default and a CHECK constraint. It takes a brief `ACCESS EXCLUSIVE` lock. It does not rewrite the table, but PostgreSQL may scan it to check the constraint. No index is built.
- **Backfill batching, checkpoints, restart, and forward-repair procedure:** no backfill. If the migration fails, nothing is applied. A forward fix replaces the constraint in a new migration.
- **RLS, grants, worker permissions, and tenant-isolation impact:** the existing table-level grants and forced row-level security cover the new column. No policy, role or function changes.
- **Read/write compatibility while old and new application versions overlap:** old writers leave NULL; new writers store the verified Gate client ID, or NULL for the worker and curator. No reader depends on the column.
- **Forget, source-rights, export, and restore-ledger impact:** the column holds a client registration identifier, not memory content. Forget tombstone changesets also record the requesting client. Export does not include changeset rows, and import attributes to the importing principal as before. The restore ledger is unaffected.
- **Verification commands and observed results:**
  - `npm run typecheck` passed.
  - `npm run test:unit` passed: 14 files, 88 tests.
  - ESLint and Prettier passed on the changed TypeScript files.
  - A disposable `pgvector/pgvector` container was used, pinned to the CI digest, with its data directory under `/home`. `scripts/local-bootstrap.mjs` applied all 44 migrations, set up the non-bypass roles and reapplied the migrations. `changesets.client_id` was then present as nullable `text`.
  - `npm run test:integration` passed. `tests/core.postgres.test.ts` passed 35 of 35, including a new case: a remembered memory's changeset records the token's client ID, and a second client's write receives the same authority. The restore-clone, fresh-database portability, user-identity migration and subject-admission migration scripts also passed.
  - Replacing the committed-path client ID with NULL in the built output made the new case fail. The build was then regenerated from unchanged source with `tsc --build --force`, and the suite passed again.
  - The local passwords were longer than those in `.github/workflows/local-contract.yml`. Role setup requires at least 24 characters, and the workflow's application password is shorter.
- **Operational signals and stop condition:** the migration runner reports the applied version count. Stop if the migration fails or a new write returns a database error naming `client_id`.

## Review checklist

- [x] The migration is additive or otherwise forward-only; no applied migration is edited.
- [x] Constraints and indexes can be deployed safely for the expected data volume.
- [x] Backfills are bounded, resumable, and safe to retry (none).
- [x] Application roles retain only the required grants and RLS behavior.
- [x] Mixed-version operation has a defined order and compatibility window.
- [x] Forget, export/import, and restore behavior account for the changed data.
- [x] Failure can be repaired by a documented forward action.
- [x] The listed checks ran against a disposable database and their results are attached.
