# Verification design

## Environment and harness selection

Verify the actual responsibility boundary. Unit tests establish the deterministic value model. The emulator suite establishes the Firestore repository, capture and recall contracts against a local Firestore emulator. Managed IAM, real transaction contention, latency, cost, managed restore, Firestore vector search and hosted identity need separate hosted evidence. A passing lower-fidelity check never closes a higher boundary. Record failed, skipped and unexecuted scenarios explicitly.

## Layers and contracts

- **Unit** (`npm run test:unit`): `tests/memory-records.test.ts` checks validation of the stored shape, rejection of unknown keys, lifecycle, approval and time selectors: a proposal is never a decision, supersede and retract stay distinct, and valid time and known time are selected independently. `tests/api-config.test.ts` checks that the service configuration fails fast and reports every invalid or missing variable, including the cursor key ring and the production bans on loopback HTTP and deterministic embeddings. `tests/api-gate.test.ts` checks Gate introspection with a fake fetch: exact audience, `gate_approved`, issuer, expiry and connection binding are required, Gate failures are 503, and token, response size and time are bounded. `tests/api-embeddings.test.ts` checks the Vertex AI request shape and vector validation with a fake fetch, not a real model. It runs every test file except `*.firestore.test.ts`.
- **Firestore repository, capture and recall** (`npm run test:firestore`): every `tests/*.firestore.test.ts` file against a loopback Firestore emulator. The repository suite checks commits, idempotency, revision races, approval provenance, source rights, suppression, stored-record identity and authority on writes and reads, approved compartment relaxation, Forget acknowledgment against a deterministic independent ledger fake, purge, restore checkpoints, proposal visibility and feed cursors. The capture suite checks consent and range gating, exact cited-text matching, candidate persistence, source-body exclusion and repeated-lineage idempotency. The derived-recall suite checks revision-fenced term and embedding entries, Japanese term candidates, stale job ordering, the unindexed-change overlay, rights rechecks and bounded Context Packs; deterministic embeddings prove the port contract only, not semantic recall quality. The API suite (`tests/api-mcp.firestore.test.ts`) starts the HTTP service in-process on both emulator databases with a local fake Gate introspection server and deterministic embeddings, admits subjects with `scripts/admit-subject.mjs`, and drives it through the `@modelcontextprotocol/client` Streamable HTTP client: 401 with the resource-metadata challenge, 403 without an admission, remember, recall, history, supersede, historical recall, Forget with a ledger head that advances once, idempotent replay and key reuse, General-only allowances for new connections, proposals that recall does not return, `as_user` authority through the `automatic` policy, `user_required` under another policy, and reconciliation of a scope behind the ledger. It does not exercise real Gate, Vertex AI, IAM or Cloud Run. The runner fails when `FIRESTORE_EMULATOR_HOST` is unset or not loopback.

## Runners

| Command | Scope |
| --- | --- |
| `npm run verify:local` | Build, typecheck, lint, format, unit, the Firestore emulator suite, secret scan and dependency audit |
| `npm run test:unit` | Unit suites; emulator-dependent files are excluded unless `VITEST_FIRESTORE=1` |
| `npm run test:firestore` | Repository, capture, derived-recall and API suites against a loopback Firestore emulator |

CI runs build, typecheck, lint, format, unit tests, the secret scan and the dependency audit in [local-contract.yml](../../.github/workflows/local-contract.yml) on push and pull request. It does not run the emulator suite.

## Evidence

Each verification record names the source, configuration, commands, results and limitations, and keeps correctness, latency and user value separate. Dated records live in [docs/eval](../eval/). Measurements against the [service targets](../design/requirements.md#service-targets) need the deployed environment.
