# Local contract-governance acceptance

> Component milestone snapshot. The current combined verification and final case counts are recorded in [local acceptance](local-acceptance.md).

This acceptance record covers the local Forget, restore reconciliation, source rights, retention and feedback maintenance, encrypted portability, and MCP adapters. It does not claim production-grade object-store durability or exercise a hosted commercial MCP client.

## Verification

The local PostgreSQL integration command runs the API as the non-bypass `thymesis_app` role and the worker through its separate non-bypass login/member role. The fixture contains 26 PostgreSQL cases, including a ready-export/source-rights-revocation regression: the revoked scope's prior bundle returns unavailable for status and download, while a separate scope's ready bundle remains available and a newly generated export reflects current rights. The stale-claim Forget case injects encrypted final files and temporary files for multiple claims after simulating crashes around rename/DB completion; it checks the export-ID deletion tombstone removes all of them and Forget reaches `complete`, while a different scope's export stays downloadable. It covers both a ready second claim with a recorded key and a processing claim whose `artifact_key` is still null. The integration command then creates a distinct PostgreSQL database clone from a pre-Forget snapshot, proves protected readiness is blocked, replays the independent deletion ledger, and checks the forgotten memory, versions, evidence, observations, and unreferenced source identity are absent before readiness opens.

To reproduce with the local PostgreSQL fixture, set `TEST_ADMIN_URL` to the admin connection for the migrated `thymesis_test` database and `TEST_APP_URL` to its `thymesis_app` connection, then run:

```sh
npm run test:integration
```

That command runs the PostgreSQL contract suite and then invokes the snapshot-clone case in `scripts/test-governance-restore-clone.ts`. Once the fixture is prepared, the clone case can also be rerun by itself with:

```sh
node --import tsx scripts/test-governance-restore-clone.ts
```

The clone runner creates a pre-Forget source database from the fixture template, takes a separate PostgreSQL clone, appends and applies Forget on the source, and reconciles the clone using the newer local deletion ledger. It removes both temporary databases and its temporary ledger directory on completion.

The completed local checks were:

- `npm run test:integration`: 26 PostgreSQL cases passed, followed by the separate snapshot-clone restore reconciliation.
- `npm test`: 21 unit tests passed. The PostgreSQL cases are skipped by this command unless its explicit local database fixture is supplied; the integration command runs them separately.
- `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run format:check`: passed.
- `npm run openapi:export`: generated the checked-in API document from the served OpenAPI definition.

The PostgreSQL cases include ledger tamper/orphan recovery and readiness fencing, immediate suppression with unrelated-memory continuity, purge and content-free change-feed tombstones, export source-rights invalidation and all-claim crash-window artifact cleanup, encrypted full-history export/import and idempotency, authority downgrade and provenance retention, two independent official MCP SDK clients, bounded worker retention/feedback/index maintenance, and API/MCP fail-closed behavior while restore is unreconciled.

## Restore boundary

The snapshot test uses a separate database cloned before Forget. The independent local deletion ledger is newer than that snapshot. Protected reads remain closed until the verified entry is replayed, physical purge finishes, the database checkpoint catches the fresh ledger HEAD, and the readiness check confirms the same HEAD again. This demonstrates PostgreSQL snapshot reconciliation; replaying against the source live database alone would not demonstrate backup recovery.

## Portability trust boundary

The export/import PostgreSQL test creates a revision history, exports and authenticates an encrypted bundle, imports it into another Owner and scope, verifies ordinary Get and Recall, checks the imported current revision appears in a separate read client's change feed, and retries the same import idempotently. Source recorded-time history and origin attribution remain in provenance. The current Owner's import never adopts the prior Owner's `owner_assertion`; it records the importing principal with `connector` / `third_party_claim` authority. The destination change event uses the import transaction time and carries only a memory ID, revision, and operation.

Any source-rights or authorization change advances the scope's authorization epoch. Because an export contains a complete scope snapshot, this conservatively invalidates all earlier ready exports in that scope, including exports whose contents happen not to reference the changed source. Status and download deny those artifacts immediately; bounded worker maintenance expires them and durably removes their files. Other scopes keep their existing exports, and a new export in the changed scope uses current rights.

## Local limitations

The filesystem ledger and encrypted artifact store use local fsync and permissions for this test environment. A hosted deployment still needs an independently governed durable ledger and artifact backend with equivalent CAS, access, retention, and deletion-acknowledgement guarantees. No cloud resources or hosted MCP clients are created by this contract unit.
