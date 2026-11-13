# Lore service operations

This guide covers the current observation ledger and Remote MCP service. It replaces historical PostgreSQL and Gate cutover pages as the operating entry point. It describes procedures; it does not assert that the latest code is deployed or authorize a hosted change.

For client setup, everyday use and checking saved or recalled memories, use the [user guide](user-guide.md). This page is for service operators.

## Operating boundaries

Keep actual projects, accounts, domains, URLs and resource identifiers in ignored `.local/cloud/deployment.json`, `.local/cloud/iam-contract.json`, or an approved external configuration store. Render deployment material outside tracked files or under `.local/`. Never copy tokens, observation text or production identifiers into public evidence, commit messages or fixtures.

The repository does not provide a complete current deployment pipeline. Use the deployment process owned by the target environment; record the release commit, previous revision, configured model, traffic change and rollback target privately. Pushing main is not evidence that a hosted deployment succeeded.

Do not delete admissions or identity bindings, change their tenant/scope, rewrite memory data, or remove deletion-ledger data to clear an error. Admission changes use `scripts/admit-subject.mjs`; approval policies and permission changes need their reviewed operator path.

## Configuration

[Configuration validation](../apps/api/src/config.ts) is authoritative and fails startup on invalid required values. Preserve the existing identity mapping and database configuration during a recall-only release.

| Concern | Settings and behavior |
| --- | --- |
| Persistence | `FIRESTORE_PROJECT_ID`, `FIRESTORE_DATABASE_ID`, `LEDGER_DATABASE_ID`; memory and deletion databases must differ |
| Cursor integrity | `CURSOR_HMAC_KEYS`, `CURSOR_HMAC_ACTIVE_KEY`; keep keys in secret configuration, not tracked files |
| Access authentication | `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `ACCESS_OWNER_EMAIL`, `OWNER_ADMISSION_ISSUER`, `OWNER_ADMISSION_SUBJECT`; bind verified assertions to the existing admission |
| MCP endpoint | `MCP_RESOURCE_URL`, optional `MCP_ALLOWED_HOSTS`; accept only the intended public and backend hosts |
| Legacy Gate mode | Without Access mode: `GATE_ISSUER`, `GATE_MCP_CLIENT_ID`, `GATE_MCP_CLIENT_SECRET`; do not mix identity modes as a repair shortcut |
| Embeddings | `EMBEDDING_PROVIDER=vertex`, `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `EMBEDDING_MODEL`, optional `EMBEDDING_DIMENSION` (default 768); model and dimension must match the intended index strategy |
| Applicability assessment | Optional `RECALL_ASSESSMENT_MODEL`; uses the same Vertex project/location and credential mechanism; absent means disabled |
| Local tests only | `FIRESTORE_EMULATOR_HOST` must be loopback; use demo- projects. Deterministic embeddings and `ALLOW_LOOPBACK_HTTP=1` are not production configuration |

The configured runtime identity needs the existing database access and the Vertex permissions required for both the embedding model and any assessment model. An embedding call succeeding does not prove a generative model is available in that region or permitted. Do not widen IAM globally to work around a denied model request.

Changing the embedding model or dimension is not the same operation as enabling assessment. Index migration/rebuild requires its own plan; assessment does not migrate stored vectors or observations.

## Pre-release checks

1. Review the commit and the [current contract](design/situational-recall.md#optional-applicability-assessment-contract), including the assessment latency and quality limitations.
2. Run `npm run verify:local` with Node.js 24, npm 11 and a loopback Firestore emulator. Keep all fixture writes in synthetic demo- projects.
3. Compare baseline and assessment-enabled retrieval on synthetic cases with real embeddings. Review required evidence, irrelevant results, forbidden evidence, citations, effective-time interpretation and final answer use separately. [The evaluation guide](eval/README.md) lists the runners.
4. Select explicit latency, provider-quota and cost limits for the environment. No accepted production budget or latency objective is established by the small-corpus evaluations.
5. Preserve the current deployment configuration and revision as the rollback target. Keep assessment disabled until the enabled path has passed the environment's acceptance checks.

## Enable or disable applicability assessment

To enable, set `RECALL_ASSESSMENT_MODEL` to the selected, tested Vertex model ID in private service configuration, preserving other variables. Apply the configuration through the environment's normal revision/rollout process. The setting is read at process startup; it is not a per-request switch or hot reload.

To disable, **remove** `RECALL_ASSESSMENT_MODEL` and restart or roll out a revision with that configuration. Do not set it to an empty string or to `off`: empty fails validation, and `off` would be interpreted as a model name. Removing it restores the unassessed retrieval path without rewriting or deleting data.

If the deployment platform supports limited traffic to a new revision, compare it with the prior revision before expanding traffic. Otherwise use the environment's staging/rollback process. This repository does not establish that such traffic controls are configured.

For an authorized, existing test observation, call contextual `recall` and inspect the returned `notes` and `applicability_assessment`. A nonempty candidate set should show `recall-assessment-applied` when assessment succeeds. Empty candidate sets and entity/historical intent bypass assessment, so they are not sufficient activation probes. Confirm latency, relevant evidence retention and source/authority preservation, then check a no-match query. Keep probe payloads private; use synthetic test accounts for write or Forget probes.

## Health and monitoring

`GET /healthz` establishes process liveness. `GET /readyz` checks the memory and deletion database readiness paths and returns 503 on failure. Neither proves that authentication, embeddings, assessment or useful recall works. Use an authenticated functional probe in addition to these endpoints.

Existing logs include request timing/status, `observation.recall.candidates`, `observation.recall.embedding_unavailable`, `observation.recall.vector_search_failed`, `observation.recall.assessment_unavailable`, `observation.index.failed`, `observation.after_write.failed`, `observation.maintenance.scope_limit`, `observation.purge`, and `observation.restore.reconciled`. Assessment failures are deliberately logged without provider payloads or memory text; the log does not classify their exact cause.

The following are **MCP response notes**, not dedicated metrics or dashboards:

| Note | Meaning and response |
| --- | --- |
| `recall-assessment-applied` | Valid assessment applied; inspect relevance and annotations, not just presence of the flag |
| `assessment-no-applicable-candidates` | Model selection kept nothing; distinguish this from no stored memory or provider failure |
| `recall-assessment-unavailable` | Assessment failed, timed out, exceeded bounds or returned invalid output; unannotated retrieval remains available |
| `assessment-evidence-changed` | An input observation became invisible during inference; annotations were discarded and affected items removed |
| `assessment-candidates-truncated` | The assessment candidate-count bound was reached; relevant evidence may remain outside that window |
| `index-pending` | Semantic indexing is still queued; a write receipt does not imply semantic availability |
| `embedding-unavailable` / `semantic-search-unavailable` | Embedding generation or vector retrieval failed; remaining retrieval channels are not proof of complete recall |
| `semantic-candidate-budget-exhausted` / `term-search-partial` | Candidate limits may have hidden eligible results; do not promise exhaustiveness |
| `byte-budget-dropped-matches` | Output byte limits removed trailing results |
| `semantic-match-only` | Semantic retrieval supplied the matches; this is not a truth or applicability guarantee |

Track assessment fallback rate, end-to-end recall latency, candidate exhaustion, indexing lag symptoms, and answer quality separately. Aggregate counters or redacted synthetic probes are preferable to exporting complete memory responses. Provider billing and token usage must be measured through the approved observability path; the runtime does not currently expose complete per-request assessment token/cost metrics.

## Failure response

| Symptom | Checks and action |
| --- | --- |
| Increased latency or assessment fallbacks | Check revision configuration, model availability, IAM, quota and provider health privately. The domain deadline is ten seconds; disable assessment if the service exceeds its selected limits. Do not remove auth or data protections |
| Relevant evidence missing after enabling assessment | Compare the same authorized query with an assessment-disabled revision; preserve synthetic reproductions, candidate notes and final answers. Restore the baseline if useful evidence is being filtered |
| Incorrect applicability or invented citation | Inspect original observation and source. An annotation is not verified truth. Record a synthetic reproduction; do not rewrite original observations merely to match a generated answer |
| Client says saved but nothing exists | Inspect the actual `observe` result. A validation error is not a save. Correct required fields and retry; after a successful write, retries must use the same idempotency key and identical input to replay the receipt |
| Semantic recall misses a recent successful write | Read the returned observation ID, inspect `index-pending` and indexing failure logs, and check embedding configuration. Do not resubmit duplicates as an indexing repair |
| 401/403 or readiness failure | Check the authenticated assertion, audience, existing admission mapping, database availability and runtime permissions through their owned paths. Do not delete bindings or point the identity at a new tenant |

For a definite failed validation, correct the request and follow the error contract. For an ambiguous timeout after a possible write, first retry the exact request/key to discover whether it committed; do not invent a new key and create a duplicate. No operator repair should silently fabricate source facts or grant person authority.

## Indexing and recovery

Writes queue indexing transactionally and run a bounded maintenance pass. The API also retries maintenance for scopes seen through authenticated operations, with backoff up to 60 seconds. It tracks at most 100 active scopes and removes drained scopes. The queue survives a process restart; discovery of all pending scopes does not.

After provider recovery, a running process with an active scope can retry without a new write. After restart, an authenticated operation must reactivate that scope; an authorized read can do so. CPU-suspended or stopped instances cannot make progress. An external durable scheduler/worker is not implemented, so do not promise bounded recovery for inactive scopes.

Verify recovery using a synthetic observation: confirm its write receipt and ID read, observe pending indexing during the simulated failure, restore the provider, and check paraphrased recall without another write. Process-restart and realistic-volume recovery remain separate acceptance requirements.

## Forget, restore and rollback

Forget must append to the independent deletion ledger before content is suppressed and purged. When assessment is running, inputs are rechecked afterward; if visibility changed, annotations are discarded rather than allowed to repeat forgotten content.

Do not restore a memory database into service while bypassing deletion-ledger reconciliation. The domain checks restore readiness on authenticated operations and reconciles through its controlled worker capability. A deployment health probe is not a substitute for an authorized restore/read test. Current backup and restore execution remains environment-owned; this guide does not provide a generic production restore command.

For recall-quality rollback, remove the assessment setting or route traffic back to the recorded prior revision. Verify authenticated baseline recall and confirm the active configuration; do not roll back the deletion ledger or overwrite observations. Keep evidence of the symptom and configuration change privately. Re-enable only after a bounded reproduction demonstrates improvement within selected quality, latency and cost limits.
