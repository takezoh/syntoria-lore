# Cloud OAuth and MCP verification — 2026-10-17

This dated record covers the hosted identity service and the deployed OAuth checks for REST and both MCP resources. The identity design is in [infrastructure](../technical/infrastructure.md#identity-and-access); setup and smoke commands are in the [infrastructure runbook](../technical/infrastructure-runbook.md#identity-setup). Current status across all cloud boundaries is in the [cloud verification register](cloud-verification.md).

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

## Owner account entry

The intended personal entry is the public [Keycloak account console](https://thymesis-identity-533289977919.asia-southeast1.run.app/realms/thymesis/account/). A read-only public probe returned 404 before the proxy correction that added the account routes. Repository allowlist tests establish which methods and paths the proxy forwards, but do not prove the deployed route, account-console client behavior, or an authenticated browser session. The public redirect/login/logout/revisit flow still requires post-deployment browser verification.

## Limits

- Owner password change and TOTP enrollment remain human actions; no automated check performs or judges them.
- Account-console sign-in does not verify private API connectivity or external AI usability.
- Local proxy tests cover denied paths, spoofed hosts and forwarding headers, loopback callback preservation, and compressed response integrity; the live Cloud Run boundary is established only by the deployed probes above.
- The checks do not exercise every write tool or authorize public API invocation.
