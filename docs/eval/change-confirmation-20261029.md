# Change confirmation migration review

This is the migration review record for `0045_change_confirmations.sql` and `0046_connection_principals.sql`, following the [migration review template](../templates/migration-review.md). Both migrations have run against disposable local databases. No hosted Gate or MCP host was used for this review. Both migrations were applied in production on 2026-10-29; see the [change confirmation release record](change-confirmation-release-20261029.md).

- **Migration files / versions:** `packages/db/migrations/0045_change_confirmations.sql` and `packages/db/migrations/0046_connection_principals.sql`.
- **Contract, requirement, or incident:** stages 2 and 3 of [ADR 0003](../adr/0003-attribute-ai-clients-and-confirm-user-decisions.md) and requirements L-2 to L-10 in the [change confirmation design](../design/change-confirmation.md).
- **User and reviewer:** owner-directed on 2026-10-28; no independent review has run.
- **Forward-only deployment order:** deploy Gate with change confirmations first, apply both migrations, then deploy the API and worker. The new application reads `user_principal_id` from `app.lock_external_identity_binding`, so it must not run before 0046. An older image keeps working after 0046, because it selects named columns from that function and never names the new ones. Before the switch is set, an image rollback restores the previous behavior. After it is set, an older image refuses protected changes from connections with `user_required` instead of offering a confirmation.
- **Existing rows and expected data volume:** 0045 creates an empty table. 0046 adds nullable columns; existing principals and bindings keep NULL, so every connection keeps acting as the binding's principal. Nothing changes behavior until the switch (`connection_principal_id`) is set.
- **Lock, table rewrite, and index-build behavior:**
  - 0045 creates a table, three indexes and a trigger on `suppressions`.
  - 0046 adds nullable columns with constraints to `principals` and `external_identity_bindings` under brief `ACCESS EXCLUSIVE` locks. It replaces `app.lock_actor_access` in place and drops and recreates `app.lock_external_identity_binding`, because its result type changed.
  - No table is rewritten.
- **Backfill batching, checkpoints, restart, and forward-repair procedure:** no backfill. A failed migration applies nothing. A forward fix replaces the functions or constraints in a new migration.
- **RLS, grants, worker permissions, and tenant-isolation impact:**
  - `change_confirmations` has forced row-level security on user and scope. `memory_app` has `SELECT`, `INSERT` and `UPDATE`.
  - `memory_worker`, `memory_purge_executor` and `memory_authority_executor` may update only the columns that the suppression trigger changes. They need this because the trigger also fires inside their Forget, retention and ledger-replay routines.
  - The binding function keeps its owner (`memory_auth_lookup`) and its single `EXECUTE` grant to `memory_app`.
  - `app.lock_actor_access` keeps its owner and grants. It now reads a connection principal's grants from the active user principal it acts for.
- **Read/write compatibility while old and new application versions overlap:** old and new images can both run after both migrations. While no switch is set, both behave as before. Once set, the old image only refuses protected changes, which fails closed.
- **Forget, source-rights, export, and restore-ledger impact:**
  - Pending and approved rows hold memory text in `payload` and `summary`. Resolution clears both.
  - Suppressing a memory cancels pending rows that show it and fails approved rows, except the Forget being applied. This happens through API Forget, retention and ledger replay during restore.
  - Export does not include the table.
  - Gate keeps its own copy of a summary until decision, consumption, cancellation or the requesting connection's end.
- **Verification commands and observed results:**
  - `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run openapi:check` and `npm run secret:scan` passed.
  - `npm run test:unit` passed: 14 files, 88 tests.
  - On fresh databases in a disposable `pgvector/pgvector` container pinned to the CI digest, with data under `/home`: `scripts/local-bootstrap.mjs` applied 46 migrations and reapplied them. `npm run test:integration` then passed `tests/core.postgres.test.ts` 42 of 42, along with the restore-clone, fresh-database portability, user-identity migration and subject-admission migration scripts.
  - The new cases cover:
    - one non-user principal for two clients, writing `ai_proposal`
    - a Forget that applies once only after approval, with replay and key reuse
    - denied, hash-modified, foreign-subject and revoked-connection confirmations
    - a decision committed with `user_decision` authority as the user principal, and a 413 for an oversized summary
    - cancellation locally and at Gate when a shown memory is forgotten
    - refusal when a shown memory changed
    - the MCP route, and refusal on another endpoint
    - the identity-mapping switch: enable creates a `client` connection principal acting for the user principal, which `app.lock_external_identity_binding` then returns; a stale baseline is refused; disable clears the binding field; a second enable reuses the principal; enable is refused for a binding whose principal is not a user
  - Four deliberate faults each made a test fail: no subject and connection check on consumption, no suppression trigger, no staleness check, and no user-principal check in the identity-mapping tool. The sources were then restored and the suite passed again.
  - The first run exposed that the trigger also fires in ledger replay under `memory_purge_executor`. The grant above fixes this; 0045 had not been applied anywhere else.
- **Operational signals and stop condition:** the migration runner reports 46 applied versions. Stop if `app.lock_external_identity_binding` returns no row for an admitted subject, or if Forget, retention or restore report a permission error on `change_confirmations`.

## Review checklist

- [x] The migration is additive or otherwise forward-only; no applied migration is edited.
- [x] Constraints and indexes can be deployed safely for the expected data volume.
- [x] Backfills are bounded, resumable, and safe to retry (none).
- [x] Application roles retain only the required grants and RLS behavior.
- [x] Mixed-version operation has a defined order and compatibility window.
- [x] Forget, export/import, and restore behavior account for the changed data.
- [x] Failure can be repaired by a documented forward action.
- [x] The listed checks ran against a disposable database and their results are attached.
