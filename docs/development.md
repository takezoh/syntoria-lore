# Development and acceptance guide

## Infrastructure

Lore is an independent Cloud Run and Neon service exposing REST and Remote MCP, with a private worker driven by Cloud Tasks and Cloud Scheduler. Follow [infrastructure](technical/infrastructure.md) for runtime, identity and resources. Backend correctness, hosted deployment and client integration are verified separately. Confirm command behavior from package.json and source; a design decision does not prove implementation.

[README](../README.md) and [PRODUCT](../PRODUCT.md) describe the product for its users. [ARCHITECTURE](../ARCHITECTURE.md) describes current responsibilities and contracts. Development instructions belong here and in the technical references.

## Product and caller boundary

Syntoria Lore is Syntoria's Memory Service: long-term memory with evidence for the user's authorized AIs. It manages what is remembered, on what evidence and how—extraction and consolidation under policy, attribution, valid time, revision history, recall, Forget and portability. The Personal AI decides when to remember or recall, interprets results and acts. Current shared state belongs to Syntoria Weave, a separate service with its own database, API and cursors; never copy actions or task progress into Lore or add a cross-service dependency.

The curator is part of memory management, not an assistant: its output is a proposal that passes schema, evidence-anchor, policy and revision checks before any commit, and it never decides authority. Product text must stay within the claim boundaries in [product design](design/product.md); the measurable contract is in [requirements](design/requirements.md).

## Current contract and references

| Reference | Purpose |
| --- | --- |
| [Data model](technical/data-model.md) | Memory model, authority, time, tables, roles, commit and change feed contracts |
| [MCP/API](technical/mcp-api.md) | Endpoints, tools, payloads, errors and recovery |
| [Infrastructure](technical/infrastructure.md) | Runtime, HTTP boundaries, identity, delivery, storage, providers and resources |
| [Security](technical/security.md) | Trust boundaries, controls and remaining limits |
| [Testing](technical/testing.md) | Harness selection, layers and implemented runners |
| [Deployment](technical/deployment.md) | Environment contract, preservation rules, release, rollback and evidence |
| [Infrastructure runbook](technical/infrastructure-runbook.md), [identity cutover](technical/identity-cutover.md), [local operations](technical/local-operations.md) | Executable procedures |
| [Agent workflow guide](usage/agent-workflows.md) | How callers discover tools and compose workflows |
| [Product design](design/product.md), [requirements](design/requirements.md) | Positioning, claim boundaries, FR/AC and service targets |
| [ADRs](adr/) | Infrastructure and contract decisions; [template](adr/template.md) |
| [Templates](templates/) | Migration review and recovery rehearsal records |
| [Evaluation records](eval/) | Dated local and hosted evidence; the [cloud verification register](eval/cloud-verification.md) is current |
| [Development plan](DEVELOPMENT_PLAN.md) | Delivery gates, epics and task status registers |

## Responsibility and verification principles

For every change, identify the cause and the responsibility that owns it, then make the smallest correction that is sound in responsibility, boundary and structure. Minimality means the least change that restores correct behavior and structure, not the fewest edited lines; include necessary internal API or layout changes and leave unrelated refactoring out.

Preserve the memory contract (M1–M7 in [ARCHITECTURE](../ARCHITECTURE.md#memory-contract)). In particular: authority never comes from model output or caller arguments; caller and source text is data, never policy; every tenant operation runs inside an authorized transaction with transaction-local context; applied migrations are never edited and schema changes are forward-only; Forget, source rights and export invalidation are considered for every new piece of stored data; logs and diagnostics never contain memory content, evidence, tokens or secrets. Packages, roles and scopes keep generic `memory` identifiers; the product name stays in documentation and `PRODUCT_DISPLAY_NAME`.

Assign each assertion to the narrowest boundary that can establish it. Storage, authorization and concurrency claims need the real PostgreSQL suite; a fake never closes that boundary. Cloud behavior needs hosted evidence. Record failed, skipped and unexecuted checks explicitly.

## Documentation

All documentation is in English. Each document has one reader and one role: README and PRODUCT for users, `docs/usage/` for users and agent builders, `docs/design/` for product positioning and the requirements contract, ARCHITECTURE and `docs/technical/` for developers and operators. README, PRODUCT, ARCHITECTURE, `docs/design/`, `docs/technical/` and `docs/usage/` describe only the current state. Dated evidence, rationale and history belong in `docs/eval/` and `docs/adr/`. When behavior changes, update the document whose reader needs it rather than appending notes elsewhere.

## Local development

Use Node.js 24 and npm 11 (`packageManager` in package.json). Install with `npm ci`; do not update dependencies or the lockfile without a relevant requirement. The local stack requires Docker Compose.

```sh
npm ci
sh scripts/local.sh start
sh scripts/local.sh smoke
```

The first start generates local-only secrets in `.env.local`, starts pinned PostgreSQL with pgvector, migrations, least-privilege roles, a signed issuer with JWKS, the API, a separate private worker and Cloud Tasks and Scheduler fixtures, and waits for readiness. Ports bind to localhost only: the API at `http://localhost:18080` (OpenAPI at `/openapi.json`) and PostgreSQL at `127.0.0.1:55433`. Tokens from `sh scripts/local.sh token user` belong to the local fixture issuer, not the cloud user account. `stop` keeps the database, keys, deletion ledger and artifacts; `reset` deletes this project's volumes and `.env.local` after confirmation. Failure injection, restore reconciliation and other operations are in [local operations](technical/local-operations.md).

## Acceptance and release

For code changes run `npm run verify:local`: build, migrations twice, typecheck, lint, format check, unit tests, the required PostgreSQL integration suite, OpenAPI synchronization, secret scan and dependency audit. It fails when the integration database is missing.

```sh
npm ci
npm run build
npm run verify:local
```

`sh scripts/local.sh acceptance` reruns all of that on the Compose stack and adds MCP client smokes, recovery with forced failures, the deterministic 231-case evaluation, a mixed-load smoke and restart persistence. `LOAD_COUNT`, `LOAD_CONCURRENCY`, `LOAD_EVIDENCE_PER_MEMORY`, `LOAD_RECALL_PERCENT` and `LOAD_CHANGES_PERCENT` tune the load. Reports go to `var/`, which git ignores. CI runs the PostgreSQL contract job in [local-contract.yml](../.github/workflows/local-contract.yml).

Documentation-only changes need content and link checks, not claims of runtime acceptance. Cloud releases follow [deployment](technical/deployment.md): immutable digests, forward migrations, preserved identity and ledger state, private API and worker, and a release record that binds source, artifact, revision and actual results. Local results never establish hosted behavior or production SLOs.
