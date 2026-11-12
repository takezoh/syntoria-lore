# Optional recall assessment implementation, 2026-11-12

## Conclusion

Contextual candidate selection and applicability annotations are implemented in the domain service, with an opt-in Vertex transport. Actual HTTP/MCP evaluation retained required evidence in all 12 positive development cases and all six positive challenge cases. Every one of the 22 questions exercised assessment successfully; none used the failure fallback.

This establishes an implemented and locally verified capability, not overall memory-outcome acceptance or production enablement. Answer quality still has irrelevant inclusions, a temporal interpretation failure and one misspelled citation. Configuration remains disabled unless the operator sets `RECALL_ASSESSMENT_MODEL`.

[Machine-readable evidence](recall-assessment-implementation-20261112.json) contains source hashes, complete returned evidence, retrieval scores, answers, citation checks and case judgments. It follows the [response-quality experiment](lore-response-quality-20261112.md); unlike that replay, this run uses the integrated domain and provider path through actual MCP recall.

## Implemented contract

The [domain contract](../design/situational-recall.md#optional-applicability-assessment-contract) governs candidate eligibility, assessment validation, filtering, fallback and visibility rechecks. The model labels existing candidates only; it cannot replace observations, source references, authority or timestamps. Direct, conditional and lesson candidates remain in original rank order; only irrelevant candidates are removed. Returned annotations explicitly say `unverified-model-interpretation`.

Assessment is bounded to at most 30 candidates and three times the caller's limit, 65,536 serialized input bytes and ten seconds. Each candidate must receive exactly one valid assessment; explanations are limited to 600 characters per field. Missing, duplicate, unknown-role, oversized or failed output falls back to unannotated retrieval with `recall-assessment-unavailable`. A valid empty selection is distinguished from provider failure. Entity and historical intents bypass assessment.

The domain sends a detached copy to the provider. After inference it rechecks every input observation, including historical states and conflicts. If any input became invisible, all annotations are discarded because an annotation for another candidate could mention it, and affected candidates are removed. The Forget regression test exercises this case. This extends existing visibility checks across the inference delay; it does not promise a transactionally consistent snapshot of concurrent changes.

`RECALL_ASSESSMENT_MODEL` selects an explicitly configured model, using the existing Vertex project/location and authentication configuration. The variable is absent by default. Empty or incompatible configuration fails startup. The provider transport uses structured output, bounded HTTP response reading, cancellation and strict completion checks. No deployment or production configuration was changed.

## Evaluation

The existing synthetic development and challenge fixtures were loaded into fresh demo- Firestore emulator projects. Vertex gemini-embedding-001 provided real 768-dimensional embeddings, with existing cached vectors reused. The integrated assessor used gemini-2.5-flash. Questions traversed real loopback HTTP/MCP with synthetic verified principals; hosted OAuth and managed indexes were not exercised.

The final candidate pool differs from the earlier response replay: assessment can examine up to three times the requested output count before choosing the final bounded result. This allows lower-ranked useful evidence to fill slots vacated by irrelevant candidates. It also means the replay and this integrated evaluation are not identical treatments.

| Measure | Development | Challenge |
| --- | --- | --- |
| Questions | 14 | 8 |
| Positive required-evidence cases passed | 12/12 | 6/6 |
| Explicit prohibited-evidence violations | 0 | 0 |
| Assessment applied | 14/14 | 8/8 |
| Assessment fallback | 0 | 0 |
| Returned items, previous recorded baseline | 70 | 40 |
| Returned items, current run | 27 | 8 |
| Median recall elapsed time | 4,149 ms | 3,408 ms |

The previous counts come from the earlier full MCP evaluation, not a concurrent randomized control. Fewer items do not by themselves demonstrate greater precision; required evidence stayed present in this small, inspected corpus, but irrelevant retained lessons remain. The elapsed time includes candidate retrieval and model assessment in the local harness, not hosted latency. No billing or large-corpus performance claim is made.

A separate answer-only stage supplied the actual returned evidence to gemini-2.5-flash. The model was not asked to initiate recall in this stage. Primary-agent review found:

- Mixed-name recommendations now make prior-project constraints conditional, but still add an irrelevant payment-retry lesson.
- Cross-project answers conditionally apply prior constraints and distinguish the old cause. One observation ID is misspelled, so attribution is not fully correct.
- The as-of answer still confuses a schedule effective on a date with a meeting occurrence. The original question wording is ambiguous and needs a newly frozen, clarified temporal test.
- The no-match seat-preference query selects no evidence and correctly answers unknown. Forget does not expose the removed address, but its answer adds irrelevant endpoint information.
- Current state, state transition, corrected cause and cross-language idempotency cases retain useful answers. Generic architecture questions still receive some overly broad lesson or technology suggestions.
- All eight challenge rubrics were met on this run, including an ordinary translation after selection returned no relevant memory. The challenge was previously inspected and is not independent holdout evidence.

The citation check finds one absent observation ID in the development answer set and none in the challenge set. It checks ID existence, not whether every associated claim is supported. No aggregate overall answer-success claim is made.

## Verification

`npm run verify:local` passed on Node 24.22.2 with the loopback emulator: build, typecheck, lint, formatting, 62 unit tests, 71 Firestore tests, secret scanning and the high-severity audit gate. The dependency audit still reports 15 moderate findings.

Added tests cover complete/unique assessment validation, bounds, cancellation even when a provider ignores abort, structured provider completion, opt-in configuration, selection before the output count, preservation against provider mutation, invalid-output fallback, valid empty selection, entity bypass, and Forget during inference. Existing tests cover the unchanged default path and ledger permissions. These tests do not prove model quality or arbitrary adversarial-prompt resistance.

The dev-docs graph lint could not run because this repository has no `docs/.docs-config.yaml`. No repository-wide documentation migration was introduced. Changed documentation passed English-prose and local-link checks, secret scanning and whitespace checks instead. This is not represented as graph conformance.

## Reproduction and release boundary

Build, start the loopback emulator and provide ignored Vertex configuration plus a short-lived provider token. Run the integrated assessment path:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 LORE_EVAL_CONFIG=.local/recall-eval-config.json LORE_EVAL_TOKEN_FILE=.local/recall-eval-token.txt LORE_EVAL_ASSESSMENT_MODEL=gemini-2.5-flash LORE_EVAL_OUTPUT=.local/assessment-development node scripts/run-situational-recall.mjs
LORE_EVAL_OUTPUT=.local/assessment-development node scripts/evaluate-situational-answers.mjs
```

For the challenge, set `LORE_EVAL_DATASET=docs/eval/fixtures/situational-recall-challenge.json` in both stages and use a separate output directory. The runner's `LORE_EVAL_ASSESSMENT_MODEL` enables the same provider used by the application's `RECALL_ASSESSMENT_MODEL` configuration. Delete the token afterward. Neither variable enables anything on a hosted deployment automatically.

Before production enablement, measure independent multilingual tasks, irrelevant inclusions, citation fidelity, temporal questions, latency and cost at realistic scale, and at least one additional actual client/model configuration. Capture recovery and durable indexing remain separate unresolved work. The richer capture-error prototype was not adopted because the previous experiment showed no recovery benefit.
