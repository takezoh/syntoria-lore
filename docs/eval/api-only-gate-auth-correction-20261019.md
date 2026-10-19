# API-only Gate authentication correction — deployment record, 2026-10-19

## Current state

The API-only correction is deployed. The latest API and Gate revisions are Ready and serve 100% traffic. The API remains public behind its approved HTTPS boundary; Gate's image and unrelated environment settings are unchanged, and worker IAM is unchanged. The obsolete Lore browser app/client admissions were removed, and the obsolete Lore browser identity binding was deactivated with the reviewed exact-baseline apply. Existing users, principals, grants and the MCP binding were preserved. Production negative-authentication probes passed, but positive hosted MCP data access with a real user remains unverified. The [2026-10-18 production release record](gate-production-release-20261018.md) remains an accurate historical cutoff.

## Deployed authentication contract

Gate owns sign-in, approvals, sessions and logout. MCP clients own their OAuth callback. Lore accepts resource-specific Gate bearer tokens for REST and MCP, verifies each token online, and continues to require the exact existing identity binding, authorization bounds, grants and RLS. It does not create users or grants. `/auth-return.html` and `/v1/session` return 404; cookie-only REST and MCP requests return 401; MCP GET returns 405.

The Gate resource schema requires a nonempty, unique `browser_client_id` on each resource. The deployed change retained those inert values for API, MCP read and MCP write and kept the shared Gate schema and all three resources. It removed only the obsolete Lore browser app/client admissions while preserving the introspection credentials, OAuth keys and unrelated clients, apps and resources.

## Source configuration changes

| Removed from Lore runtime/config | Replacement or remaining contract |
| --- | --- |
| `AUTH_BROWSER_CLIENT_ID` | `AUTH_ALLOWED_CLIENT_IDS` contains only the OAuth clients allowed to use Lore resources; production retains `lore-mcp` |
| `GATE_BROWSER_APP_ID` | Gate owns OAuth and browser sign-in |
| `GATE_BROWSER_REDIRECT_URI` | MCP clients register and handle their own callbacks |
| `BROWSER_ALLOWED_ORIGINS` | Optional `API_ALLOWED_ORIGINS` is non-credentialed CORS for bearer clients; Origin is not authorization |
| Lore personal-login launcher and `/auth-return.html` UI | No Lore login/logout UI |
| Cookie authentication and `/v1/session` | API and MCP call `authenticateBearer` only |

The tracked deployment profile remains synthetic. It removes the browser app/client values, allows only the MCP OAuth client, and keeps the three resource registrations and their separate secret references. No production secret, subject, UUID or private domain is stored here.

## Production deployment and readback

The API and Gate latest revisions are Ready at 100% traffic. The API's public invoker remains active. Readback confirmed the Gate image and unrelated environment settings were unchanged, and worker IAM was unchanged. The obsolete Lore browser app/client admissions were removed; the existing Lore browser identity binding was deactivated through the reviewed exact-baseline workflow without creating users, grants or replacement bindings.

Production probes returned 200 for `/readyz` and protected-resource metadata; 404 for `/auth-return.html` and `/v1/session`; 401 for unauthenticated, cookie-only and invalid-bearer REST/MCP requests where applicable; 405 for MCP GET; and 403 for anonymous worker access. The removed Gate browser app path returned 4xx. MCP read and write login initiation each returned a redirect to the identity provider and set a cookie. These results establish the deployed negative boundaries and login initiation; they do not establish successful hosted MCP data retrieval. Positive hosted MCP access with a real user remains unverified.

The production changes and readbacks are documented here; this documentation update performs no runtime or cloud changes.

## Local verification evidence

Before production deployment, the API-only source correction passed `npm run build`, `npm run typecheck`, `npm run test:unit` (14 files, 88 tests), `npm run test:integration` (33 PostgreSQL contract tests, restore-clone ledger reconciliation, fresh-database portability and migration 0042 preservation/reapply), `npm run lint`, `npm run format:check`, `npm run openapi:check`, and `npm run secret:scan`.

The local Gate + Firestore Emulator harness passed against the isolated PostgreSQL fixture. It verified callback and `/v1/session` 404, cookie-only REST/MCP 401, MCP GET 405, API bearer write/read, MCP SDK read of that same memory, exact audience separation, actual local Gate OAuth grant revocation and fail-closed behavior during a Gate outage. The harness used a synthetic GitHub exchange and did not contact hosted Firestore, GitHub, Cloud Run, public DNS/TLS or hosted Neon. These local checks establish implementation behavior only; they do not establish positive hosted MCP access.
