# Recall evaluation guide

Evaluation records are dated observations, not permanent product guarantees. Current behavior is defined by [architecture](../../ARCHITECTURE.md) and the [situational recall contract](../design/situational-recall.md). Hosted configuration and rollout belong to [operations](../operations.md).

## Read the evidence in order

| Record | What it establishes and limits |
| --- | --- |
| [Local plumbing](situational-recall-local-20261112.md) | Deterministic checks; not semantic quality |
| [Initial real-provider evaluation](situational-recall-real-20261112.md) | Small-corpus retrieval and simplified-client observations; client results superseded by full MCP testing |
| [Full HTTP/MCP reevaluation](situational-recall-mcp-20261112.md) | Actual schemas and tool failures; the earlier simplified 5/5 spontaneous-recall result did not reproduce |
| [Client policy comparison](recall-client-policies-20261112.md) | Server instructions, added client instruction and prefetch; capture and answer-use regressions retained |
| [Response quality ablation](lore-response-quality-20261112.md) | Selection and applicability annotations with fixed answer instructions; replay, not spontaneous tool use |
| [Integrated assessment](recall-assessment-implementation-20261112.md) | Implemented opt-in provider/domain/MCP path; required evidence retained in 22 small-corpus questions, answer acceptance incomplete |

The [development fixtures](fixtures/situational-recall.json) and [challenge fixtures](fixtures/situational-recall-challenge.json) are synthetic and previously inspected. Neither is independent holdout. The [protocol](fixtures/situational-recall.md) defines the broader acceptance work that remains.

## Choose the correct measurement

- Retrieval: required evidence at the output limit, prohibited evidence, irrelevant candidates, bounds and latency.
- Capture: successful receipts and actual saved facts, rather than a model's acknowledgement.
- Invocation: whether the model called recall, or the host issued it; report these separately.
- Answer use: applicability, temporal interpretation, citations, abstention and whether advice respects constraints.
- Operations: indexing recovery, managed indexes, hosted authentication, realistic volume and observed cost.

Do not turn `retrieval_passed: true` into overall acceptance. `passed: null` means overall quality is not measured by that scorer. Empty-gold cases need answer-level checks. Repeated deterministic answers to the same inspected questions are not independent statistical samples.

## Runners

Build before use. Local persistence must point to a loopback Firestore emulator and synthetic demo- projects. Real embeddings and answer models require authorized provider access; keep provider configuration, account identifiers and short-lived tokens in ignored local files. Remove the token after the run.

| Script | Purpose |
| --- | --- |
| `scripts/run-situational-recall.mjs` | Load controlled fixtures and call actual MCP recall; optionally run separate client conversations |
| `scripts/evaluate-situational-recall.mjs` | Validate/score labeled retrieval results or perform read-only recall against a loopback MCP endpoint |
| `scripts/evaluate-situational-answers.mjs` | Answer-only evaluation using saved real recall responses; not invocation testing |
| `scripts/evaluate-recall-policies.mjs` | Compare client instructions and host-controlled retrieval with separate capture tests |
| `scripts/evaluate-lore-response-quality.mjs` | Replay selected tracked responses in selection/annotation ablations |
| `scripts/evaluate-capture-recovery.mjs` | Compare original and decorated errors after actual MCP validation |

For integrated retrieval, set `LORE_EVAL_CONFIG`, `LORE_EVAL_TOKEN_FILE`, and a fresh `LORE_EVAL_OUTPUT` directory. Set `LORE_EVAL_ASSESSMENT_MODEL` only for the assessed treatment. `LORE_EVAL_DATASET` selects the challenge fixture; `LORE_EVAL_CLIENTS=1` enables client conversations and `LORE_EVAL_TRIALS` defaults to five. The answer-only helper reads the fixed ignored `.local/recall-eval-config.json` and `.local/recall-eval-token.txt` paths and accepts `LORE_EVAL_OUTPUT` and `LORE_EVAL_DATASET`.

Keep complete traces and failed attempts. Before publishing an evaluation, check source/dataset/prompt hashes, all case denominators, tool errors and malformed outputs, citation existence and claim support, review independence, and deployment identifiers. A successful process exit is not a product-quality verdict. Exact commands and observed configurations are retained in the dated records.
