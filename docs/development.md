# Development guide

This guide gets a contributor from a checkout to a meaningful local verification and points to the contract each area owns. The PostgreSQL implementation was removed on 2026-11-09. The repository holds the Firestore Memory Records package and `apps/api`, a Remote MCP service over it. See the [architecture](../ARCHITECTURE.md) for what exists and what does not.

## Set up

The repository uses Node.js 24 (`.node-version`) and npm 11. The emulator suite also needs Java 25 and the Firestore emulator from the gcloud `cloud-firestore-emulator` component.

```sh
npm ci
npm run build
```

Start the emulator on a loopback address and point the suite at it:

```sh
gcloud emulators firestore start --host-port=127.0.0.1:8085
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8085
```

Tests use synthetic `demo-` project IDs; never point them at a real project.

## Verify a code change

For code changes, `npm run verify:local` runs build, typecheck, lint, formatting, unit tests, the Firestore emulator suite, secret scanning and dependency audit. It fails if `FIRESTORE_EMULATOR_HOST` is unset or not a loopback address. CI runs the same checks except the emulator suite. The [testing reference](technical/testing.md) describes each suite.

For documentation-only changes, check the changed pages' relative file and heading links, run `npm run secret:scan`, and run `git diff --check`. A documentation check does not establish runtime behavior.

Local checks with deterministic doubles do not establish hosted behavior, extraction quality or recall quality.

## Where to change a contract

| Concern | Primary document or source |
| --- | --- |
| User value and examples | [README](../README.md), [Product](../PRODUCT.md) |
| Product positioning and claims | [Product design](design/product.md) |
| Required behavior and measurable service targets | [Product requirements](design/requirements.md) |
| Memory Records contracts, access, Forget, recall and the decision-model evaluation | [Memory Records design](design/memory-records.md) |
| Components and correctness boundaries | [Architecture](../ARCHITECTURE.md) |
| Value model, repository, capture, recall, access and service operations | `packages/memory-records/src/` |
| MCP adapter, Gate verification, configuration and embeddings | `apps/api/src/` |
| Admitting a Gate subject | `scripts/admit-subject.mjs` |
| Test suites and runners | [Testing](technical/testing.md) |
| Decisions and their reasons | [ADRs](adr/) |
| Dated evidence | [Evaluation records](eval/) |

## Historical pages

These pages describe the removed PostgreSQL implementation and are kept because ADRs and evaluation records cite them. They are not current contracts: the other pages under `technical/`, the pages under `usage/`, the [change confirmation](design/change-confirmation.md) and [memory compartments](design/memory-compartments.md) designs, the [templates](templates/) and the [development plan](DEVELOPMENT_PLAN.md). Where they state product behavior, the Memory Records design says what carries over.
