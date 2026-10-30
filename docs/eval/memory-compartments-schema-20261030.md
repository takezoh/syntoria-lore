# Memory compartments schema migration review

This is the migration review record for `0049_memory_compartments.sql`, following the [migration review template](../templates/migration-review.md). The migration has run against a disposable local database. It has not been deployed.

- **Migration file / version:** `packages/db/migrations/0049_memory_compartments.sql`.
- **Contract, requirement, or incident:** unit U1 of the [memory compartments design](../design/memory-compartments.md) for [ADR 0006](../adr/0006-enforce-disclosure-with-compartments-and-connection-allowances.md); requirements CMP-1, CMP-2 and MIG-1 (first half).
- **User and reviewer:** owner-directed on 2026-10-30; no independent review has run.
- **Forward-only deployment order:** apply the migration, then deploy any image. The current image runs unchanged after the migration: it never names the new tables or columns, and every new row it writes takes the constant Unclassified label. The export change in this unit only removes the new column from payload version 1, so it can deploy before or after the migration.
- **Existing rows and expected data volume:** every existing row in `sources`, `observations`, `episodes`, `evidence`, `subjects`, `subject_aliases`, `memories`, `memory_versions`, `changesets`, `change_log`, `curation_reviews`, `change_confirmations` and `idempotency_keys` reads as labeled Unclassified through the column default; no row is rewritten. Each existing user receives one reserved Unclassified compartment row. The service is not yet in operational use with a real user, so these tables are small.
- **Lock, table rewrite, and index-build behavior:** thirteen `ALTER TABLE … ADD COLUMN` statements with a constant default and a CHECK constraint. Each takes a brief `ACCESS EXCLUSIVE` lock; a constant default is stored in the catalog, so no table is rewritten, but PostgreSQL scans each table once to validate the CHECK constraint. `memory_versions` is not updated, so its immutability trigger does not fire. One index is built on the new, empty `connection_allowance_events` table.
- **Backfill batching, checkpoints, restart, and forward-repair procedure:** the only data write is one compartment row per existing user, in the migration transaction. If the migration fails, nothing is applied. A forward fix replaces a constraint, the function or the trigger in a new migration.
- **RLS, grants, worker permissions, and tenant-isolation impact:** the three new tables have forced row-level security with a `tenant_user` policy on `app.user_id`. `memory_app` can read and insert compartments, read, insert and update the allowance's label, epoch and timestamp, and read and insert allowance history; it cannot update or delete history. `memory_worker` can read compartments. The label check function is executable by the application, worker, purge and authority roles only. The reserved-compartment trigger is `SECURITY DEFINER`; it sets `app.user_id` to the new user for its own insert and restores the previous value. Existing policies, grants and executor policies are unchanged; the new columns are covered by existing table-level grants.
- **Read/write compatibility while old and new application versions overlap:** old and new images write the same rows; no reader depends on the new columns or tables yet.
- **Forget, source-rights, export, and restore-ledger impact:** labels are compartment IDs, not content. Purge deletes labeled rows as before. Compartment names are user content that Forget does not yet remove; the design must add compartment removal before names are written by operations. Export payload version 1 excludes `compartment_ids`, so bundles keep their previous shape, and import fills the default Unclassified label. The deletion ledger and restore reconciliation are unaffected.
- **Verification commands and observed results:** see [Verification](#verification).
- **Operational signals and stop condition:** stop if the migration fails or takes locks long enough to delay requests; there is no partial state to repair.

## Verification

On 2026-10-30, against a disposable `pgvector/pgvector` container pinned to the digest in `compose.yaml`, listening only on the loopback interface, with synthetic local credentials:

- Before the change, the integration suite passed 46 tests, and the restore-clone, fresh-database portability, user-identity migration and subject-admission migration scripts passed.
- `npm run verify:local` passed with exit code 0 after the change. It applied all 49 migrations, reapplied them as current, and passed build, typecheck, lint, format check, 92 unit tests in 15 files, 52 PostgreSQL integration tests (the 46 earlier tests and 6 new compartment schema tests), the restore-clone, fresh-database portability and both identity migration scripts, the OpenAPI snapshot check, the secret scan and `npm audit` with 0 vulnerabilities.
- The new tests check that every new user receives the reserved compartment and that the trigger restores the caller's `app.user_id`; that rows written by the current service in `sources`, `evidence`, `memories`, `memory_versions` and `change_log` are all Unclassified; that non-canonical labels are rejected; that compartment names are unique per user and the reserved compartment cannot be created; that compartments are isolated by user and invisible without context; and that allowance history rejects update, delete and inconsistent approvals.

These checks establish the schema and its compatibility with the current service. They do not establish any disclosure behavior: no operation reads labels or allowances yet.

## Review checklist

- [x] The migration is additive or otherwise forward-only; no applied migration is edited.
- [x] Constraints and indexes can be deployed safely for the expected data volume.
- [x] Backfills are bounded, resumable, and safe to retry.
- [x] Application roles retain only the required grants and RLS behavior.
- [x] Mixed-version operation has a defined order and compatibility window.
- [x] Forget, export/import, and restore behavior account for the changed data.
- [x] Failure can be repaired by a documented forward action.
- [x] The listed checks ran against a disposable database and their results are attached.
