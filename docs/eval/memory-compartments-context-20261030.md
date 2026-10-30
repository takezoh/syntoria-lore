# Memory compartments context and allowance lookup review

This record covers unit U2 of the [memory compartments design](../design/memory-compartments.md) and is the migration review for `0050_connection_allowance_lookup.sql`, following the [migration review template](../templates/migration-review.md). It has run against a disposable local database. It has not been deployed.

## Change

- Every transaction that sets the row-level-security context now goes through `setDatabaseContext` in `packages/db`. It replaced nine direct setters in `packages/auth`, `packages/domain`, `packages/governance`, `packages/jobs` and `apps/api`, and also sets `app.compartment_ids`. A unit test fails if any other source file under `packages/*/src` or `apps/*/src` calls `set_config('app.…')`.
- `ActorContext` carries `compartments`: a Gate connection's allowance (explicit list and epoch), or `all` for worker and system actors. `all` is resolved to the user's explicit compartment list before it reaches the database.
- Authentication reads the connection's allowance with its grants. Before every commit, Lore rereads it and refuses the commit with `stale_authorization` if the epoch changed.
- An actor that applies an approved protected change as the user keeps the requesting connection's allowance.
- No policy reads `app.compartment_ids` yet, so no read or write result changes.

## Migration review

- **Migration file / version:** `packages/db/migrations/0050_connection_allowance_lookup.sql`.
- **Contract, requirement, or incident:** unit U2; requirements RD-2, ALW-1, ALW-5 (commit side), GOV-1 and GOV-3. The first U2 test run found that commit revalidation in a transaction without tenant context read no allowance through row-level security and accepted a changed allowance; the lookup function fixes it.
- **User and reviewer:** owner-directed on 2026-10-30; no independent review has run.
- **Forward-only deployment order:** apply 0049, then 0050, then deploy the U2 image. An image from before U2 never calls the function. The U2 image fails authentication with `authorization_unavailable` if 0050 is missing, so it must not run first.
- **Existing rows and expected data volume:** no data changes. `connection_allowances` is empty until an operation writes it.
- **Lock, table rewrite, and index-build behavior:** grants and one function; no table lock beyond catalog updates.
- **Backfill batching, checkpoints, restart, and forward-repair procedure:** no backfill. A forward fix replaces the function in a new migration.
- **RLS, grants, worker permissions, and tenant-isolation impact:** `memory_auth_lookup`, the existing `BYPASSRLS` lookup role that already owns the binding lookup, gains `SELECT` on `compartments` and `connection_allowances` and `UPDATE (updated_at)` on `connection_allowances` for the share lock. The `SECURITY DEFINER` function filters by the user ID that the caller took from the locked binding, and only `memory_app` can execute it. No policy changes.
- **Read/write compatibility while old and new application versions overlap:** compatible after the migration; see the deployment order.
- **Forget, source-rights, export, and restore-ledger impact:** none.
- **Verification commands and observed results:** see [Verification](#verification).
- **Operational signals and stop condition:** authentication failures with `authorization_unavailable` after deployment indicate a missing migration or grant; stop the rollout.

## Verification

On 2026-10-30, against the same disposable loopback-only `pgvector/pgvector` container used for [U1](memory-compartments-schema-20261030.md), with synthetic local credentials:

- The first `npm run verify:local` run after the code change failed one new integration test: `assertCurrent` accepted a connection whose allowance had changed, because revalidation ran without tenant context and row-level security hid the allowance row. Migration 0050 and the lookup function were added in response.
- The second run passed with exit code 0. It applied all 50 migrations, reapplied them as current, and passed build, typecheck, lint, format check, 93 unit tests in 16 files (including the new check that only the shared helper sets the database context), 54 PostgreSQL integration tests, the restore-clone, fresh-database portability and both identity migration scripts, the OpenAPI snapshot check, the secret scan and `npm audit` with 0 vulnerabilities.
- The two new integration tests check that a connection without an allowance has General only at epoch 0; that a recorded allowance is limited to existing compartments; that a commit after the allowance changed fails with `stale_authorization` while a freshly authenticated actor commits; that `userActorFor` keeps the connection's allowance; that another connection of the same subject keeps General only; and that the helper sets an explicit, sorted compartment list and resolves `all` to the user's compartments without setting an absent principal.

These checks establish the context plumbing. They do not establish disclosure behavior: no policy or query reads the compartment context yet.

## Review checklist

- [x] The migration is additive or otherwise forward-only; no applied migration is edited.
- [x] Constraints and indexes can be deployed safely for the expected data volume.
- [x] Backfills are bounded, resumable, and safe to retry.
- [x] Application roles retain only the required grants and RLS behavior.
- [x] Mixed-version operation has a defined order and compatibility window.
- [x] Forget, export/import, and restore behavior account for the changed data.
- [x] Failure can be repaired by a documented forward action.
- [x] The listed checks ran against a disposable database and their results are attached.
