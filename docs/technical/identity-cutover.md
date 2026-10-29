# Gate identity cutover

The Gate identity cutover is deployed and preserves existing Lore user IDs, principals, grants, memories and history. The follow-up API-only correction is also deployed: Lore has no browser sign-in behavior and Gate remains the online identity authority. The obsolete Lore browser binding was deactivated through the reviewed exact-baseline procedure; existing users, principals, grants and the MCP binding were retained. Neither step creates a user from an OAuth profile or expands grants.

## Data and authority contract

The current `external_identity_bindings` table is keyed by exact Gate issuer and immutable subject. Migration 0043 consolidates equivalent active admissions without merging inactive permissions or conflicting policies. Each row points to an existing user and principal and limits access to an explicit scope list and capability ceiling. Existing principals, grants, source rights, authorization epochs and forced RLS remain in force. Migration 0041 and earlier applied SQL are unchanged.

The identity mapping utility in `scripts/gate-identity-map.mjs` requires a reviewed JSON mapping file and `IDENTITY_MAPPING_DATABASE_URL`. Its dry-run locks the selected existing principal and grants, verifies their issuer/subject/activity and capability ceiling, reads the exact target binding state, then emits a SHA-256 baseline. `--apply --expected-baseline` repeats those reads under a serializable transaction and refuses if any source grant, principal or target binding changed. This detects revocation and competing enrollment between review and apply. Deactivation uses the same two-step check with `--deactivate`; reactivation requires a fresh dry-run. A matching active mapping is a truthful no-op.

Do not use a Gate login token as evidence for an operator mapping. The operator's explicit review of an existing identity and grant is the authority for admission. Do not add a grant, widen a capability ceiling, or select a user from an email address as part of mapping.

## Runtime authentication

The API has three independent Gate resource verifiers: API, MCP read and MCP write. Each uses its own introspection client credentials and exact audience. Lore accepts bearer tokens only; Gate owns sign-in, approvals, sessions and logout, while MCP clients own their OAuth callback. A token must be active at Gate and name an introspected client ID and expected issuer/audience. Tokens are not decoded as local JWTs. The service does not cache successful Gate checks. Invalid or revoked credentials return 401; an identity without a local binding or current grant returns 403; a Gate or authorization-storage outage returns 503 and fails closed. `/auth-return.html` and `/v1/session` return 404; a cookie alone does not authorize REST or MCP.

REST and MCP ignore Cookie headers; cookie-only requests do not authorize, and a valid resource-specific Gate bearer token is required. `/auth-return.html` and `/v1/session` return 404. REST CORS is non-credentialed and uses the optional `API_ALLOWED_ORIGINS` allowlist; Origin does not authorize a request. MCP checks Host and supplied Origin only for DNS-rebinding protection. Gate owns browser login, sessions and logout; OAuth client grants remain revocable there.

Every actor-bound database operation verifies the local identity and grants inside its transaction. Before commit, it acquires local binding and grant locks and then performs a final online Gate check immediately adjacent to `COMMIT`. A Gate revocation, binding change, expired grant, source-rights change or unavailable authorization source aborts the transaction. Export download applies the same final check after storage reads and before bytes are released.

## Local verification

Use the local actual-Gate harness to verify the public protocol and storage path. It requires the Gate dist build, Firestore Emulator and loopback PostgreSQL from `/tmp/memory-gate-test.env` and fails if a prerequisite is missing:

```sh
npm run build
node --env-file=/tmp/memory-gate-test.env scripts/testing/verify-gate-integration.mjs
```

The harness uses a synthetic GitHub exchange and local Gate configuration. It verifies removed Lore callback/session routes, cookie-only rejection, API bearer write/read, resource separation, opaque API/MCP tokens, SDK MCP calls, outage handling and actual OAuth grant revocation. Hosted DNS/TLS, GitHub identity, Cloud Run, Firestore and Neon remain outside this local evidence.

For the preservation regression, the disposable database test applies prior migration SQL unchanged, creates existing user, principal, scopes, grants, memory, idempotency receipt/hash and v1 cursor, applies 0041 and then 0042 twice, and checks exact IDs, values, table OID, RLS and empty initial Gate bindings. Keep this procedure on isolated test databases; the hosted migration requires its own backup, readback and approved deployment window.

## Hosted cutover gates

The Gate cutover, migration 0042, public API invocation and public HTTPS boundary are active. The API-only correction was deployed on 2026-10-19. On 2026-10-20, migration 0043 and the DCR-compatible API revision were released, and Gate began registering MCP clients dynamically; see the [DCR production release record](../eval/dcr-production-release-20261020.md). Production probes confirmed `/auth-return.html` and `/v1/session` return 404, cookie-only and invalid-bearer requests are rejected, MCP GET returns 405, and the worker remains private. Gate accepted MCP read and write login initiation, but positive hosted MCP data access with a real user remains unverified. Local Gate integration evidence covers bearer resource access, audience separation, grant revocation and outage behavior; it is not hosted user-acceptance evidence. See the [API-only correction record](../eval/api-only-gate-auth-correction-20261019.md) for production readbacks.

The existing Cloud Run canonical API URL remains the IAM identity. The API's explicitly approved public invoker and Ready HTTPS certificate are active; the worker remains private, with its IAM unchanged. The configured public alias and Gate secrets are not proof of successful MCP data access. See [deployment](deployment.md), [runbook](infrastructure-runbook.md) and the [API-only correction record](../eval/api-only-gate-auth-correction-20261019.md).
