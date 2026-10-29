# Gate cutover runbook

This runbook describes code-level and local verification for the Gate cutover; it does not authorize hosted changes. The Gate-only API and worker rollout, the 2026-10-19 API-only authentication correction, the 2026-10-20 DCR release and the 2026-10-29 change confirmation release are deployed. The latest API and Gate revisions are Ready at 100% traffic, and the connection-principal switch is set for the production binding; the API's approved public invoker binding and public HTTPS certificate remain active, and the worker remains private with unchanged IAM. The checked-in `infra/cloud/deployment.json` is a synthetic example and does not contain private production configuration. Production negative-authentication probes passed; positive hosted MCP data access remains unverified.

## Verify the implementation locally

Use Node.js 24 and npm 11. The unit command does not need a database. The PostgreSQL command requires the prepared loopback test cluster and never targets the hosted database.

```sh
npm run build
npm run typecheck
npm run test:unit
node --env-file=/tmp/memory-gate-test.env node_modules/vitest/vitest.mjs run tests/core.postgres.test.ts
node --env-file=/tmp/memory-gate-test.env --import tsx scripts/test-user-identity-migration.ts
```

The actual Gate harness requires a built Gate sibling, its local Firestore Emulator, and the same isolated PostgreSQL fixture. It refuses missing or non-loopback prerequisites and does not skip:

```sh
npm run build
node --env-file=/tmp/memory-gate-test.env scripts/testing/verify-gate-integration.mjs
```

The harness uses a synthetic GitHub identity exchange. It exercises Gate OAuth approval and grant revocation, while Lore callback and session routes remain absent; cookie-only REST and MCP requests are rejected; an opaque API-resource token writes and reads a memory; a resource-specific MCP token reads that same memory; resource audiences remain isolated; and a Gate outage fails closed. It does not use hosted Firestore, GitHub, Cloud Run, public DNS/TLS or hosted Neon.

## Review an identity mapping

Create a private JSON file with the exact existing principal and intended Gate identity. Keep the file outside the repository; it contains identity information. Example shape:

```json
{
  "expected_source": {
    "issuer": "https://legacy.example.test/",
    "subject": "existing-principal-subject"
  },
  "user_id": "00000000-0000-4000-8000-000000000001",
  "principal_id": "00000000-0000-4000-8000-000000000002",
  "target": {
    "issuer": "https://gate.example.test",
    "subject": "github:12345"
  },
  "scope_ids": ["00000000-0000-4000-8000-000000000003"],
  "capability_ceiling": ["read"]
}
```

Point `IDENTITY_MAPPING_DATABASE_URL` only at the authorized target database. Run a dry-run and review its principal, active grants, target-binding state and baseline digest:

```sh
IDENTITY_MAPPING_DATABASE_URL="$MIGRATION_DATABASE_URL" \
  npm run gate:identity:map -- --file /secure/path/gate-map.json
```

Apply only after the exact output has been reviewed and approved. Supply the reported digest; the tool reacquires locks and refuses if principal, grants, scope policy or target binding changed since the dry-run:

```sh
IDENTITY_MAPPING_DATABASE_URL="$MIGRATION_DATABASE_URL" \
  npm run gate:identity:map -- --file /secure/path/gate-map.json \
  --apply --expected-baseline <reported-sha256>
```

An exact existing mapping is idempotent. An inactive mapping can be reactivated only by a fresh baseline and apply. Deactivate with the same two-step procedure and `--deactivate`; do not delete bindings or change a policy through ad hoc SQL. The mapping file is an authorization decision and must be reviewed by the service owner.

## Switch connections to a connection principal

Stage 3 of [ADR 0003](../adr/0003-attribute-ai-clients-and-confirm-user-decisions.md) makes every Gate connection of a person act as one non-user connection principal, so AI writes stay proposals and protected changes need the person's approval at Gate. Set it only after Gate with change confirmations and the Lore API from the same release are deployed, migrations 0045 and 0046 are applied, and a hosted readback has confirmed both.

Use the reviewed mapping file of the existing active binding. The binding's principal must be the person's active user principal; the tool refuses otherwise, because confirmed changes are applied as that principal. Run the dry-run and review `existing_binding.connection_principal_id` and `connection_principal`:

```sh
IDENTITY_MAPPING_DATABASE_URL="$MIGRATION_DATABASE_URL" \
  npm run gate:identity:map -- --file /secure/path/gate-map.json \
  --connection-principal enable
```

Apply with the reported digest and the same flag. The tool creates a `client` principal with issuer `urn:syntoria:lore:connection` and subject `binding:<binding id>`, acting for the binding's principal, and names it on the binding. It holds no grants; connections read the user principal's grants through it. Rerunning reuses the same principal.

On 2026-10-29 the switch was set for the single production binding. The owner ran the tool from their own shell, reading the migration URL into an environment variable so it was never printed. See the [change confirmation release record](../eval/change-confirmation-release-20261029.md).

To revert, run the same two steps with `--connection-principal disable`. It clears the binding field, keeps the principal for a later enable, and works on an inactive binding. Connections then act as the user principal again. Confirmations that were pending stay valid and can still be completed.

## Rotate the migration credential

`lore-neon-migrate` reads the owner-role URL from a pinned version of `lore-migration-direct-url`. After changing the owner password in Neon:

1. Add a new secret version from a terminal whose input is not recorded, for example with `read -rs` and `gcloud secrets versions add lore-migration-direct-url --data-file=-`.
2. Point the job at it with `gcloud run jobs update lore-neon-migrate --update-secrets=MIGRATION_DATABASE_URL=lore-migration-direct-url:<version>`.
3. Run the job once. With every migration applied, it changes nothing and reports `reapply=passed`, which proves that the new credential authenticates.
4. Disable the old version.

The API, worker, Weave runtime and Weave jobs use other roles and are not affected by an owner-password change. On 2026-10-29 the job moved to version 2 and passed this check. The Weave migrator and backup jobs also passed a no-op run.

## Production readback and remaining acceptance

The 2026-10-19 production readback is recorded in the [API-only correction record](../eval/api-only-gate-auth-correction-20261019.md). `/readyz` returned 200; `/auth-return.html` and `/v1/session` returned 404; unauthenticated, cookie-only and invalid-bearer REST/MCP probes returned 401 where applicable; MCP GET returned 405; resource metadata returned 200; and anonymous worker access returned 403. Gate returned a GitHub redirect and set a cookie for both MCP read and write login initiation. These checks establish the deployed negative boundaries and OAuth initiation only. The 2026-10-29 readbacks for the change confirmation release, the switch and the follow-up release are in the [change confirmation release record](../eval/change-confirmation-release-20261029.md).

Positive hosted MCP data access with a real user, including successful retrieval from Lore, remains unverified. Hosted bearer access to each exact resource, wrong-resource rejection, and hosted grant-revocation or Gate-outage behavior also remain separate acceptance checks; local harness results do not establish them. Track recovery, PITR, observability, capacity, cost, security/privacy and broader production acceptance separately, and capture future readbacks in a dated release record.
