# Gate-only production release — 2026-10-18

**Readback cutoff: 18:10 UTC.** This record covers the deployed Gate-only API and worker, database migration, IAM and preserved data. It does not publish production domains, redirect URLs, identity subjects, UUIDs or secret payloads. The checked-in `infra/cloud/deployment.json` remains a synthetic example and is not the private production configuration.

## Release state

Cloud Build succeeded from the final sanitized source snapshot (manifest SHA-256 `2a6e2a8586cd48966fbe174b32cefe265f3252b51e9907e60399953dcb7e5cec`). The immutable image is `asia-southeast1-docker.pkg.dev/syntoria/lore/runtime@sha256:d9a81c7838dd59dd72ae5e0f32dc7de102daf8910377a9e44df6ce5872ac3ae7`.

The API revision `lore-api-gate-r2-20261018` and worker revision `lore-worker-gate-20261018` each serve 100% of their respective service traffic, with no traffic tags. The API runs the Gate-only authentication path. The worker's private IAM boundary is preserved; task and scheduler invocation passed. The prior Keycloak identity service is retained as a fallback and is not used by serving Lore.

Gate configuration revision `gate-api-lore-r2-20261018` serves 100%; its `gate-resources` input is pinned to numeric version 5. The three separate API, MCP read and MCP write introspection references are `lore-gate-api-secret:1`, `lore-gate-mcp-read-secret:1` and `lore-gate-mcp-write-secret:1`. The Lore API service account is their only configured runtime accessor. Secret payloads are not included in this repository.

Gate has a Lore browser app (`memory-service`), a browser resource client (`lore-web`) and a loopback-only MCP client registration (`lore-mcp`). API, MCP read and MCP write resources use distinct introspection clients (`lore-api`, `lore-mcp-read` and `lore-mcp-write`) and distinct browser client associations where required (`lore-web`, `lore-mcp-read-browser` and `lore-mcp-write-browser`). All three resource registrations are configured; MCP access remains bearer-only. Existing signing and cookie keys and the issuer were preserved. A private hosted probe accepted the four configured resource credentials, including Weave; unknown sessions remained inactive. Browser and MCP authorization initiation reached real GitHub. A real user login, consent and positive authenticated hosted data access were not witnessed.

## Database, identity and ledger preservation

Migration 0042 was applied through `lore-neon-migrate-24gr7`. That first run used an earlier candidate image with the same migration SQL as the final source. Reapplication passed across all 42 migrations. The prior 41 migration checksums and RLS policies were unchanged. Logical data-table hashes remained unchanged except for the normal timestamp update to `deletion_ledger_checkpoint.updated_at`; sequence values and the ledger checkpoint's hash and generation fields were unchanged.

The GCS ledger HEAD remained at generation `1792301441803503` with its hash unchanged. `lore-ledger-reconcile-55cb5` reported `already-current`, with zero replay and zero purge. The existing resources, app and clients were preserved. Explicit Gate identity bindings were applied from a dry-run baseline to the same existing active user, principal and grants; no replacement account or additional grant was created. The new binding uses forced RLS and the existing `memory_auth_lookup` function owner.

A private pre-cutover database backup was written to `gs://syntoria-lore-backups/gate-cutover-20261018T1744Z/before.dump`. The bucket enforces public access prevention and uniform bucket-level access and uses Google-managed encryption; API and worker service accounts have no backup-bucket grants. The backup SHA-256 was `65ec11d9e9b71d1776979828eb642bd3b92345868058232f3793c72cb33f0528`; readback bytes matched and `pg_restore --list` parsed the archive. A full restore rehearsal and managed Neon PITR validation remain outstanding. No portability master key was extracted or rotated.

## IAM and hosted access boundary

The API service has no service-level `allUsers` invoker binding. Explicit user approval for public API invocation is still pending. The API public-IAM request did not apply; do not infer public access from the domain mapping, Gate registration or successful private probes. The API and worker remain inaccessible to unauthenticated public callers at this cutoff.

The production domain mapping and DNS-only CNAME are configured, and DNS/CAA/Google frontend checks passed. The managed TLS certificate is still pending. Production follows the approved direct Cloud Run domain-mapping design; no proxy or separate edge was added. The worker IAM policy is unchanged: an anonymous `/readyz` request returned 403 and an authenticated request returned 200. A real Scheduler dispatch to `/internal/dispatch/sweep` returned 200 at 18:05 UTC.

The public API invoker binding may be applied after explicit user approval and verification that the Gate-only API serves 100% of traffic with no legacy traffic tags while the worker remains private. TLS issuance is a separate requirement for using the registered custom origin; it is not a precondition to applying the approved IAM binding. After public invocation is approved and the custom-origin certificate is active, complete a real user login, consent and authenticated API/MCP data acceptance. Those user acceptance results remain unverified. Deployment success does not establish production acceptance, availability, recovery objectives, load, cost, alerting, or external security/privacy review.
