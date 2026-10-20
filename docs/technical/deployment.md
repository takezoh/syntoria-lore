# Deployment and operations

The DCR-only production release completed on 2026-10-20. Lore and shared Gate serve their DCR-compatible revisions at 100% traffic. Migration 0043 is applied and automatic API scaling is restored. Existing data, effective user authority, RLS and worker/IAM boundaries were preserved. See the [production release record](../eval/dcr-production-release-20261020.md) for source commits, artifacts, preservation checks and hosted limitations. Positive hosted MCP access with a real user remains unverified.

## Current boundary

The checked-in `infra/cloud/deployment.json` remains a synthetic example profile with placeholder public origins. It is not the active production configuration or a cloud readback; private production configuration stays in ignored local deployment state. The Cloud Run API URL remains the canonical service identity. Production uses the approved direct Cloud Run domain-mapping design, with domain mapping, DNS and a Ready managed TLS certificate. No separate proxy or edge was added. Gate registration values in the example profile are not evidence of DNS, TLS, live registration or secret payloads.

The explicitly approved service-level `allUsers` invoker binding is active on the API. Application-level Gate bearer verification remains mandatory for protected data. The worker remains private with task and scheduler invokers only, and its IAM boundary is unchanged.

## Existing service and storage contract

The Gate work leaves these non-auth deployment resources and limits unchanged:

| Resource | Configured contract |
| --- | --- |
| GCP | Project `syntoria`, region `asia-southeast1`; Artifact Registry `asia-southeast1-docker.pkg.dev/syntoria/lore` |
| API | Cloud Run service `lore-api`; canonical service URL remains `https://lore-api-533289977919.asia-southeast1.run.app`; max 2 instances, concurrency 8, 60-second timeout, pool max 5; public invocation enabled, with Gate bearer authentication required for protected data |
| Worker | Cloud Run service `lore-worker`; custom audience remains its canonical Cloud Run URL; max 2 instances, concurrency 1, 600-second timeout, pool max 5; IAM-private, with direct task/scheduler invokers and inherited operator access unchanged |
| Neon | Project `ancient-butterfly-18185264`, AWS `ap-southeast-1`, database `lore`; migration 0043 is applied, for 43 migrations |
| Delivery | Cloud Tasks queue `lore-capture`, max 2 concurrent and 2 dispatches/second, 5 attempts, 3600-second retry window; `lore-worker-sweep` runs every minute with the worker audience |
| Storage | `syntoria-lore-ledger` for Forget records and `syntoria-lore-artifacts` for encrypted exports; existing object-prefix custom roles and direct IAM contract remain unchanged |
| Jobs | `lore-neon-migrate` for forward schema migration and `lore-ledger-reconcile` for readback/recovery; migration, worker and app database secrets remain separate |

Use `deployment.json` for synthetic configuration shape and `iam-contract.json` for the intended direct IAM/secret boundary. The release record contains current readbacks; neither example values nor this table replace those observations.

The app database has 43 applied migrations. Migration 0043 replaces client-specific admission with explicit issuer/subject admission while preserving effective active authority. Prior migration records and public RLS policies are unchanged. See the [release record](../eval/dcr-production-release-20261020.md) for the fenced rollout, preservation evidence and rollback restrictions.

## Gate configuration contract

Runtime configuration requires:

| Setting | Purpose |
| --- | --- |
| `AUTH_ISSUER` | Canonical HTTPS Gate issuer, with no trailing slash, credentials, query or fragment |
| `AUTH_AUDIENCE` | Public API resource origin under the configured Gate cookie parent |
| `AUTH_API_RESOURCE_CLIENT_ID`, `AUTH_API_RESOURCE_CLIENT_SECRET` | API-only Gate introspection credentials |
| `AUTH_MCP_READ_AUDIENCE`, `AUTH_MCP_READ_RESOURCE_CLIENT_ID`, `AUTH_MCP_READ_RESOURCE_CLIENT_SECRET` | MCP read resource and its independent introspection credentials |
| `AUTH_MCP_WRITE_AUDIENCE`, `AUTH_MCP_WRITE_RESOURCE_CLIENT_ID`, `AUTH_MCP_WRITE_RESOURCE_CLIENT_SECRET` | MCP write resource and its independent introspection credentials |
| `API_ALLOWED_ORIGINS` | Optional exact Origin allowlist for browser clients that send bearer tokens; CORS is not an authorization control |
| `MCP_BASE_URL`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | Public resource metadata and MCP Host/Origin allowlists |

The API, read and write resources use distinct Gate resource registrations and secrets. Configure their audiences as the public API origin, `/mcp/read` and `/mcp/write`. Resource credentials must not be reused as OAuth client secrets. Secret values belong only in the approved secret manager and never in checked-in configuration, manifests, build contexts or logs.

Gate access tokens are opaque. The service discovers the issuer's introspection endpoint and checks each presented token online for active state, issuer, client and exact audience. There is no local JWKS verifier or positive authorization cache. A Gate subject is admitted only when an operator-created `external_identity_bindings` row maps that exact identity to an existing principal, selected scopes and capability ceiling. Current grants, source rights and authorization epochs still apply.

## Identity mapping and cutover

Prepare one reviewed mapping file per Gate subject. It must identify the expected existing principal, user, scopes and capability ceiling; it cannot create accounts, broaden grants or infer a user from email. Use `scripts/gate-identity-map.mjs` against the migration database URL in dry-run mode first. The dry-run hashes the existing principal and grant state together with any current target binding. Apply only by repeating the operation with that exact baseline hash; any changed or revoked binding requires a new dry-run and review. Deactivation requires the exact existing mapping and the same two-step baseline check.

The 2026-10-18 production cutover and current state are:

1. Gate API, MCP read and MCP write resources and their secret references are configured for the deployed API. Private probes verified resource credentials; Gate identity bindings point to existing users and grants.
2. Migration 0042 was applied and rechecked; backup bytes, database hashes, RLS, sequences and the GCS ledger head were read back. Ledger reconciliation reported already-current with zero replay and zero purge.
3. The immutable image is serving 100% on the API and worker. The worker's private readiness and Scheduler path passed. A real Gate browser login and approval were confirmed; positive authenticated MCP data access was not.
4. Domain mapping, DNS, public API invocation and the Ready TLS certificate are active. The 2026-10-19 API-only correction now serves 100% of API and Gate traffic. Production probes verified the removed Lore login/session routes, cookie-only and invalid-bearer rejection, MCP method behavior, worker privacy, and removal of the obsolete browser app. Positive hosted MCP data access and successful real-user retrieval remain unverified.

The release record distinguishes completed readbacks from pending acceptance. The checked-in example does not disclose private production origins, client identifiers, or secret payloads.

## Release and recovery

Build future releases from the fixed source allowlist and deploy only an immutable image digest. Rendered manifests are local artifacts; inspect their Gate audiences, secret references and subject admission before release. Keep migration, ledger reconciliation, worker IAM checks and API deployment separately evidenced. Follow the [IAM contract](../../infra/cloud/iam-contract.json) without replacing whole policies; changes to public API IAM require explicit authorization and must not widen worker access.

Rollback API code only to a revision compatible with the applied schema. Migration 0043 changes the binding lookup contract; image-only rollback to a client-specific version is incompatible. Do not delete bindings or rewrite existing identity, memory or ledger data as a rollback shortcut. Revoke or deactivate a specific binding through the reviewed mapping workflow if an admission is wrong. Restore protected data only through the established deletion-ledger reconciliation procedure. Cloud backup, point-in-time recovery and RPO/RTO remain separate operational gates.

## Verification boundaries

`npm run test:unit` verifies deterministic contracts. The PostgreSQL suite verifies local transaction and RLS behavior. `npm run gate:integration` runs the actual local Gate service against the prepared Firestore Emulator and loopback PostgreSQL, with a synthetic GitHub exchange. These local checks do not replace hosted user acceptance. See [testing](testing.md), the historical [cloud verification register](../eval/cloud-verification.md), the original [production release record](../eval/gate-production-release-20261018.md) and the [API-only correction record](../eval/api-only-gate-auth-correction-20261019.md).

## Dynamic client registration and subject admission

MCP clients register their callback URLs with Gate's advertised registration endpoint.
Lore does not configure or admit public OAuth client IDs. Each request requires an
online Gate-approved bearer token with a nonempty client ID; an optional `azp`
must match it. The immutable issuer and subject must have an active local binding.
The binding's principal, actor kind, scope set and capability ceiling still bound
all operations, and are locked and revalidated together with live grants before commit.
Registering a client alone grants no data access.

Migration 0043 removes client-specific bindings. It consolidates active rows only
when their user, principal, scope set and capability ceiling agree; conflicting
active rows abort the transaction for explicit operator resolution. An existing
active admission is retained without incorporating inactive policies. Subjects
with only inactive rows remain inactive. The operator mapping file's `target`
contains exactly `issuer` and `subject`; activation remains an explicit,
fingerprint-checked administration operation. No policy is automatically unioned.

Fence API traffic during this schema migration. Apply the forward migration and
release the matching API image before reopening traffic; an old API image cannot
be rolled back alone because its three-argument binding lookup no longer exists.
