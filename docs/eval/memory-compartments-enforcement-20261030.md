# Memory compartments write path, enforcement and portability review

This record covers units U3 to U8 of the [memory compartments design](../design/memory-compartments.md) and is the migration review for `0051_compartment_write_path.sql` and `0052_compartment_visibility.sql`, following the [migration review template](../templates/migration-review.md). Everything ran against a disposable local database. Nothing has been deployed, and no hosted client has used compartments.

## Change

- **Write path (U3).** Remember, change sets, curator proposals, capture and Forget tombstones set labels: a connection's writes default to its allowance, a General write from a connection holding compartments is held, versions join the labels of newly cited evidence and of the previous version, a SUPERSEDE replacement keeps its predecessor's label, and `RECLASSIFY` narrows directly or relaxes only as the user. Sources take their configured label, observations and evidence take their source's, subjects are keyed by label, and changesets, feed events, reviews, confirmations and stored responses carry the union of what they contain.
- **Read path (U4).** Memory views list their compartments and report `withheld_evidence` for a declassified version; rights checks include withheld evidence. Recall can be narrowed to named compartments. The change feed omits events outside the allowance, reports a narrowing as a content-free `WITHDRAWN`, and binds cursors to the allowance (payload version 2).
- **Operations (U5).** `get_access`, `create_compartment`, `narrow_access` and `request_compartment_access` over MCP, and `GET /v1/access`, `POST /v1/compartments`, `POST /v1/access:narrow` and `POST /v1/access:request` over REST; widening is the protected change `change_connection_allowance`. `scope_id` is optional on recall, memory reads, the change feed and remember. The OpenAPI document was regenerated.
- **Enforcement (U6).** Restrictive RLS policies on labeled and derived tables for the application and worker roles.
- **Portability (U7).** Export payload version 2 with compartments and labels; import maps them by name.
- **Documentation (U8).** README, Product, Architecture, client access, agent workflows, MCP and API contract, data model, memory system, security and the change confirmation design.

## Migration review

- **Migration files / versions:** `packages/db/migrations/0051_compartment_write_path.sql`, `packages/db/migrations/0052_compartment_visibility.sql`.
- **Contract, requirement, or incident:** units U3 to U7; requirements WR-1 to WR-6, DRV-1 to DRV-6, RD-1 to RD-8, ALW-3, ALW-4, GOV-1, GOV-2 and MIG-1 (second half), MIG-2.
- **User and reviewer:** owner-directed on 2026-10-30; no independent review has run.
- **Forward-only deployment order:** apply 0049 and 0050 (already reviewed), then 0051 together with the new image behind the existing write fence, because 0051 drops the label defaults and an older image would fail every insert into a labeled table. Apply 0052 only after every API and worker instance runs the new image; an older image does not set `app.compartment_ids` and would see General rows only.
- **Existing rows and expected data volume:** no row is rewritten. `memory_versions.label_origin` reads `legacy` and `connector_authorizations.compartment_ids` reads Unclassified for existing rows through constant defaults that are then dropped. The service is not in operational use with a real user, so tables are small.
- **Lock, table rewrite, and index-build behavior:** brief `ACCESS EXCLUSIVE` locks for column additions, default drops, constraint replacements and policy creation. One unique index is built on `subjects` and one exclusion constraint on `subject_aliases`; both scan their table once. No table is rewritten.
- **Backfill batching, checkpoints, restart, and forward-repair procedure:** no backfill. Each migration runs in one transaction; a failure leaves nothing applied. A forward fix replaces a policy, function or constraint in a new migration. Withdrawing enforcement in an emergency means a new migration that drops the `compartment_visibility` policies, which reopens every labeled row to every connection of the user and must be decided by the owner.
- **RLS, grants, worker permissions, and tenant-isolation impact:** 0052 adds restrictive policies for `memory_app` and `memory_worker` only, so purge, maintenance, export-executor and lookup roles are unchanged and the existing permissive tenant and scope policies still apply. 0051 adds `SECURITY DEFINER` functions owned by the existing `BYPASSRLS` lookup role: the allowance lookup (now also reporting whether this transaction changed it), the user's compartment list for worker contexts, name resolution for a widening request, and a boolean rights check for a version's evidence. The lookup role gains `SELECT` on `memory_version_evidence`, `evidence`, `sources` and `suppressions` for that check. `memory_app` gains `UPDATE (changed_by_transaction)` on `connection_allowances`.
- **Read/write compatibility while old and new application versions overlap:** none across 0051; see the deployment order. Between 0051 and 0052 the new image already labels and filters, and the database does not yet enforce.
- **Forget, source-rights, export, and restore-ledger impact:** Forget tombstones keep the forgotten memory's label, so other connections never see the event; a Forget over a connection reaches only what it can see. Purge runs as the executor role and still reaches every row. Rights checks for declassified versions include withheld evidence. Export payload version 2 carries labels and the compartments used; import maps them by name and refuses compartments the importer does not hold. The deletion ledger and restore reconciliation are unchanged; the restore-clone and fresh-database portability checks passed.
- **Verification commands and observed results:** see [Verification](#verification).
- **Operational signals and stop condition:** inserts failing with not-null violations on `compartment_ids` mean an image older than 0051 is running; `compartment_not_available` or empty reads for every connection after 0052 mean an image that does not set the compartment context. Stop the rollout in either case.

## Verification

On 2026-10-30, against the same disposable loopback-only `pgvector/pgvector` container used for [U1](memory-compartments-schema-20261030.md) and [U2](memory-compartments-context-20261030.md), with synthetic local credentials:

- `npm run verify:local` passed with exit code 0: all 52 migrations applied and reapplied as current, build, typecheck, lint, format check, 93 unit tests in 16 files, 55 PostgreSQL integration tests, the restore-clone, fresh-database portability, user-identity and subject-admission migration scripts, the OpenAPI snapshot check, the secret scan and `npm audit` with 0 vulnerabilities.
- Earlier runs during the change failed and were fixed: test fixtures that inserted labeled rows without a label; the current-memory read that omitted the label; a test that wrote labeled memories into a scope another test exported, which the importer correctly refused; and the identity migration script, whose pre-existing rows are now Unclassified and visible only within that compartment.
- One integration test exercises the design's scenarios end to end through REST with three connections of one subject under the `auto` policy: a new connection sees General only and writes without naming a scope; a created compartment joins the creating connection's allowance; its writes default to that compartment and a General write is held; another connection gets 404 for the memory, does not recall it and cannot write into the compartment; subjects with the same name exist separately per label; a widening request is applied by policy and recorded, and narrowing removes access at once; with the compartment context unset the database hides the row and refuses an update to a label outside the context; a relaxation is refused on direct commit and applied through `request_user_decision`, after which a third connection reads the memory with its evidence withheld, while the version before the relaxation stays readable only by the holder; a narrowing appears in that connection's feed as `WITHDRAWN` and the memory becomes unreadable.

These checks establish local behavior with deterministic providers. They do not establish hosted client acceptance, real Gate approvals, recall quality or performance at the planned workload; the policy overhead requirement NFR-1 has not been measured.

## Review checklist

- [x] The migration is additive or otherwise forward-only; no applied migration is edited.
- [x] Constraints and indexes can be deployed safely for the expected data volume.
- [x] Backfills are bounded, resumable, and safe to retry.
- [x] Application roles retain only the required grants and RLS behavior.
- [x] Mixed-version operation has a defined order and compatibility window.
- [x] Forget, export/import, and restore behavior account for the changed data.
- [x] Failure can be repaired by a documented forward action.
- [x] The listed checks ran against a disposable database and their results are attached.
