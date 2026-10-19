# Historical pre-Gate cloud OAuth and MCP verification

> Archived snapshot of Lore's pre-Gate Keycloak deployment and verification. The identity URLs, account and credential actions, and deployment descriptions below are historical and must not be used as current setup instructions. See the [current cloud verification register](cloud-verification.md) and [current identity design](../technical/infrastructure.md#identity-and-access).

This record preserves hosted identity and OAuth observations from 2026-10-17 and the Lore Keycloak cutover verification from 2026-10-18. It documents the former Keycloak account, password and TOTP flow; it is not the current identity contract.

## Historical Lore Keycloak cutover verification — 2026-10-18

The Lore identity, API and worker services are ready on revisions `lore-identity-00001-zsq`, `lore-api-00001-bkf` and `lore-worker-00001-zlf`. The application database migration completed with 40 migrations; the prior 39 checksums, seven role OIDs, attributes and memberships were preserved. The two databases are `lore` and `lore_identity`.

The `lore-identity-bootstrap` Job renamed the realm, scopes, clients and account URL, but its final mapper-name readback failed because of a limitation in the pinned Keycloak API. Do not count that Job as successful. An offline correction applied the four mapper names (`applied: 4`, `retry: 0`) while preserving mapper IDs and configuration. A separate maintenance identity-verification Job passed the existing assertions for the four mapper names and IDs, realm ID, owner subject and scope, then was deleted. The realm, owner and scope IDs remained unchanged; credential, required-action, user, component and Liquibase tables retained their recorded hashes.

The full OAuth, REST and MCP verification passed on the Lore target. It verified discovery, PKCE S256, token signature/issuer/expiry/audience/subject, JWKS, scope IDs and read capability, REST API resource and Recall, MCP read Recall, the read and write tool catalogs, write-resource separation and audience isolation. Invalid resources, PKCE verifier, token-resource mismatch, redirects, wrong audiences and wrong scopes were rejected. The API remained private; this run does not establish that every write operation was exercised or open external AI onboarding.

The account-browser smoke passed login, settings, logout with HTTP 204 session removal, and revisit to the username login form at `/realms/lore/login-actions/authenticate`. The browser did not use the local callback. This verifies the account route and browser flow; the owner's required password update and TOTP enrollment remain pending human actions.

## Contract under test

Keycloak 26.8.1 is the OAuth issuer, deployed as one Cloud Run service with a proxy sidecar; the API verifies its access tokens against the realm JWKS with an exact issuer and protected-resource audience. MCP read and write are separate resources at `https://<api-origin>/mcp/read` and `https://<api-origin>/mcp/write`; each route accepts only its own audience. Keycloak's `resource-indicators` feature is experimental and explicitly enabled in the pinned image, so any Keycloak upgrade must repeat the real PKCE and resource-audience smoke before rollout. Local fixture authentication is unchanged.

## Deployed identity verification

On 2026-10-17, the pinned Keycloak/proxy image pair was built and the private bootstrap completed against the existing identity database. The bootstrap adopted Keycloak's generated Owner subject after a partial first run, set its initial password only because the generated account had no password credential, and reported generated Owner and synthetic smoke subject IDs. The deployed sidecar passed identity mode with `identity-passed`: discovery and JWKS metadata, valid read PKCE, signature/issuer/expiry/subject/exact-audience validation, exactly one expected synthetic `scope_ids` value, and `memory:read` without write/admin. The negative checks rejected an unknown resource with `invalid_target` after authentication, an unregistered redirect, a mismatched PKCE verifier, and exchanging a read code for the write resource. A separate probe confirmed six admin/master/management paths returned 404. This smoke used the operator's private Cloud Run invocation path; the OAuth authorization and token flow remained the public identity origin.

At the identity-only checkpoint, the Owner and isolated synthetic principal database bindings passed twice each, with the synthetic principal read/write/admin grant verified. `identity-passed` alone does not imply MCP authorization passed.

## Full-mode REST and MCP verification

Full mode performs a second PKCE authorization-code flow for the API resource, verifies the API token's signature, issuer, expiry, exact audience, subject, scope ID and requested capability, then calls REST Recall. It checks that an MCP-read audience token is rejected at REST and that a `memory:write` API token cannot perform a read. It calls the actual `recall_memories` tool through the official MCP client, validates the structured and JSON-text Recall response envelopes, verifies the separate MCP write token and `remember_memory` tool, and checks read/write audience isolation. The smoke uses random nonmatching queries and does not write memory content. The API stayed private: the operator Cloud Run ID token travelled only in `X-Serverless-Authorization`, and no public API invocation was granted.

The deployed full-mode run passed these checks. The latest results and their limits are recorded in the [cloud verification register](cloud-verification.md).

## Governance across owners

On 2026-10-17, the final strict hosted governance run passed in 33.183s using real PKCE tokens, the private API IAM path, and actual Neon, GCS, and Scheduler resources. It verified encrypted cross-owner Import, destination Recall, immediate Forget suppression, completed ledger purge, and artifact removal. The first full attempt exposed a Scheduler concurrency failure; polling was serialized after a TDZ fix, and the fresh-destination rerun passed. Reusing a destination correctly returned `source_conflict`. Identity setup maintenance was explicitly approved; both setup Jobs succeeded and the original pinned identity configuration and public invocation were restored. API and worker remain private. Cleanup disabled three synthetic app principals and removed their grants (existing tokens returned 401); Keycloak test users/client remain configured, and the temporary setup Job and private credential directory were removed.

## Owner account entry at the historical snapshot

The personal entry is the public [Keycloak account console](https://lore-identity-123456789012.asia-southeast1.run.app/realms/lore/account/). The earlier 2026-10-17 probe returned 404 before the proxy correction; the 2026-10-18 browser smoke verified the live login, settings, logout and revisit flow described above. The registered 1Password connection entry has not yet been updated.

## Limits

- Owner password change and TOTP enrollment remain human actions; no automated check performs or judges them.
- Account-console sign-in does not verify private API connectivity or external AI usability.
- Local proxy tests cover denied paths, spoofed hosts and forwarding headers, loopback callback preservation, and compressed response integrity; the live Cloud Run boundary is established only by the deployed probes above.
- The checks do not exercise every write tool or authorize public API invocation.
