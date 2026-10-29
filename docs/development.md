# Development guide

This guide gets a contributor from a checkout to a meaningful local verification and points to the contract each area owns. Lore is a personal, evidence-linked memory service: API and MCP clients call shared domain services, while a private worker handles capture and maintenance. The memory lifecycle itself is explained in the [memory-system reference](technical/memory-system.md).

## Start locally

The repository uses Node.js 24, npm 11 and Docker Compose. Before starting the API, configure `.env.local` with the Gate issuer, HTTPS audiences and separate API, MCP-read and MCP-write resource credentials. The local stack also needs an operator-configured HTTPS proxy for its API origin. To run the smoke check, obtain short-lived Gate bearer tokens for those exact resources and export them as `LOCAL_API_BEARER_TOKEN`, `LOCAL_MCP_READ_BEARER_TOKEN` and `LOCAL_MCP_WRITE_BEARER_TOKEN`. Follow [local operations: OAuth and client boundary](technical/local-operations.md#oauth-and-client-boundary) for the full setup; this repository does not register Gate resources, issue tokens or provide the proxy.

After those prerequisites are ready, install dependencies and start the local PostgreSQL, API and worker stack. The smoke command requires the bearer-token environment variables above:

```sh
npm ci
sh scripts/local.sh start
sh scripts/local.sh smoke
```

Lore does not issue those tokens or provide a local login page. The start script creates local-only storage credentials, applies migrations and configures the database roles. The API listens on localhost at port 18080; PostgreSQL listens on 127.0.0.1:55433. The stack and recovery commands are documented in [local operations](technical/local-operations.md).

## Verify a code change

For code changes, `npm run verify:local` runs build, migrations, typecheck, lint, formatting, unit tests, the required real-PostgreSQL integration suite, OpenAPI synchronization, secret scanning and dependency audit. It fails if the integration database is unavailable. `sh scripts/local.sh acceptance` adds MCP client smoke checks, forced-failure recovery, a deterministic 231-case evaluation, mixed-load smoke and restart persistence. Local deterministic providers exercise code paths; they do not measure hosted extraction quality or broad semantic recall quality.

Cloud verification needs separate hosted evidence. The API-only authentication correction was deployed on 2026-10-19, and Gate dynamic client registration with Lore subject admission was released on 2026-10-20. The API is reached over public HTTPS and requires a Gate bearer token for protected data, while the worker remains private. Positive hosted MCP memory retrieval with a real user remains unverified, so local checks do not establish hosted client acceptance, production SLOs, managed database recovery or scale. See [deployment](technical/deployment.md), the [correction record](eval/api-only-gate-auth-correction-20261019.md), the [DCR production release record](eval/dcr-production-release-20261020.md) and the [cloud verification register](eval/cloud-verification.md).

For documentation-only changes, check the changed pages' relative file and heading links, run `npm run secret:scan`, and run `git diff --check`. A documentation check does not establish runtime behavior.

## Where to change a contract

| Concern | Primary document or source |
| --- | --- |
| User value, examples and access prerequisites | [README](../README.md), [Product](../PRODUCT.md), [use cases](usage/use-cases.md), [client access](usage/sign-in.md) |
| Product positioning and claims | [Product design](design/product.md) |
| Required behavior and measurable service targets | [Product requirements](design/requirements.md) |
| Service responsibilities and data flow | [Architecture](../ARCHITECTURE.md), [memory system](technical/memory-system.md) |
| Memory schema, authority, time, transactions and RLS | [Data model](technical/data-model.md), `packages/domain/`, `packages/db/` |
| Recall and Context Pack behavior | [Memory system](technical/memory-system.md), `packages/recall/` |
| REST/MCP operations and errors | [MCP/API contract](technical/mcp-api.md), [OpenAPI](api/openapi.json) |
| Runtime, identity and operator procedures | [Infrastructure](technical/infrastructure.md), [security](technical/security.md), [deployment](technical/deployment.md), [infrastructure runbook](technical/infrastructure-runbook.md), [identity cutover](technical/identity-cutover.md), [local operations](technical/local-operations.md) |
| Delivery status and evidence | [Development plan](DEVELOPMENT_PLAN.md), [dated evaluation records](eval/), [ADRs](adr/) |

Keep user pages focused on what someone can do and expect. Keep implementation behavior in architecture and technical references. Keep dated observations in evaluation records and the reasoning for a decision in an ADR; do not turn an old test result into a current product guarantee.
