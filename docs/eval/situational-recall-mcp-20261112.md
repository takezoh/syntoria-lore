# Situational recall through HTTP/MCP, 2026-11-12

## Conclusion

The situational-recall outcome is not accepted. Real embeddings and actual MCP recall retrieved the required evidence in all 12 positive development cases and all six positive challenge cases. In five fresh conversation pairs, the retained implementation saved both constraints but the second conversation never initiated recall. This supersedes the earlier simplified-adapter result of five successful recalls; it does not reproduce that result through full MCP validation.

[Machine-readable evidence](situational-recall-mcp-20261112.json) contains final retrieval responses, model answers, per-case judgments, every completed autonomous experimental trace, and source/dataset hashes. The earlier [direct-service evaluation](situational-recall-real-20261112.md) remains a historical observation under different conditions.

## Changes retained

Observation views now preserve `subject_names` and `effective_until` alongside existing time, aspect, provenance and source fields. MCP guidance asks clients to recall before requesting repeated context, retain a memory's original subject and conditions, cite source links or observation IDs, distinguish previous causes from present hypotheses, and avoid unsupported cost claims. Ranking was not changed in this iteration: the measured misses occurred after retrieval or before the client called it.

The evaluator initializes a real MCP client over loopback HTTP, obtains the published instructions and tools, and forwards model arguments unchanged to the actual MCP handler. Missing required fields fail server validation; the evaluator never fills them in or silently converts states to events. Errors are returned to the model and retained, including failed attempts followed by repair. Retrieval reports distinguish `retrieval_passed` from overall `passed: null`; an unmeasured answer stage is not a pass.

## Method and boundary

Persistence used fresh synthetic demo- Firestore emulator projects. Vertex gemini-embedding-001 produced 768-dimensional embeddings, with cached vectors reused. gemini-2.5-flash answered with temperature 0 and thinking budget 0. The final tool client converted published JSON Schema to Vertex's OpenAPI `parameters` representation while retaining required fields, enums and nullable timestamps. JSON-Schema-only constraints omitted from the provider representation remained enforced by the actual MCP server. Earlier experiments used `parametersJsonSchema`; these are different client configurations and do not establish a causal prompt improvement or a provider defect.

The loopback server maps synthetic bearer tokens to already verified principals. This exercises MCP initialization, tool discovery, argument validation and domain operations, not hosted OAuth. Fixture loading uses controlled domain operations. No production memories, admissions or identity bindings were changed.

The 22-observation development corpus has 14 questions, including two empty-gold questions. The [seven-observation challenge](fixtures/situational-recall-challenge.json) adds eight questions with different subjects, a distinct failure cause, units, temporal updates and an unrelated task. It was authored and inspected by the same agent during iteration: it is **not independent holdout evidence**. Challenge retrieval payloads were reused after the final prompt rollback because response construction and ranking were unchanged; its answer stage was rerun with the retained instructions. The fixture's unrelated case has `expected_abstention: true` for memory use, but its answer rubric requires the ordinary translation; refusing the task fails.

## Results by stage

| Stage | Retained result | Interpretation |
| --- | --- | --- |
| Development required evidence at 5 | 12/12 positive cases | Small-corpus retrieval only |
| Challenge required evidence at 5 | 6/6 positive cases | Self-authored challenge only |
| Explicit prohibited-evidence cases | 0 violations | Evaluated authorization/Forget cases, not comprehensive security acceptance |
| Development answer review | 7 pass, 4 partial, 3 fail | Primary-agent review, not independent |
| Challenge answer review | 7 pass, 1 fail | Translation refused in evidence-supplied stage |
| A saves both constraints, no remember request | 5/5 | One successful combined event per trial |
| B initiates recall, no recall request | 0/5 | The decisive outcome failure |
| B retrieves and uses A's saved evidence | 0/5 | B requests background without carrying constraints forward |
| Unrelated fresh conversation translates correctly | 5/5 | No tool calls or unrelated memory in these answers |
| Final autonomous tool errors | 0 | Does not compensate for missing recall |

In the answer stage, the model receives actual returned evidence and cannot call tools. This stage cannot demonstrate spontaneous recall. Every cited observation ID in the final answer sets exists in its supplied response; this syntactic check does not establish that each claim is supported. Source links and unambiguous supported references are also acceptable attribution; an ID-only criterion is not the product outcome.

Development failures are mixed-name (no useful conditional application), cross-project (imports another project's single-operator constraint as fact), and as-of (declines an answer despite the Monday state). Partial cases are paraphrase and Japanese paraphrase (unconfirmed budget transfer), Forget (correct abstention with irrelevant details), and changed-source (correct removed-endpoint warning without the rubric's explicit verification step). The last is a process omission, not a fabricated fact. The two negative development questions do not invent the requested personal facts. The cross-language answer now scopes the previous timeout cause correctly in this run; that single observation is not a general guarantee.

The prior mixed-name failure remains a failure under the clarified rubric: acknowledging prior constraints is insufficient without either conditional application or a targeted clarification. The prior changed-source judgment is now classified as partial because its factual warning is correct. The old aggregate 11/14 is not directly comparable to this stricter applicability review.

## Failed experiments retained

| Variant in evidence JSON | Trials | Successful writes per A | B recall | Observation |
| --- | --- | --- | --- | --- |
| baseline | 5 | 1 | 0/5 | Actual MCP already fails to reproduce simplified-adapter recall |
| improved | 5 | 3 | 0/5 | Provenance guidance alone did not trigger recall |
| final-complete | 5 | 0 | 5/5 | Routing instruction triggers recall of empty memory; three invalid writes per A |
| revised | 5 | 0 | 5/5 | Required-field reminder still leaves invalid writes |
| validated-client | 5 | 0 | 5/5 | OpenAPI schema form; A reads rather than saves |
| workflow-probe | 1 | 3 | 0/1 | Three failed writes followed by repair; B still does not recall |
| reevaluation | 5 | 0 | 5/5 | Conditional workflow again produces three invalid writes per A |
| retained | 5 | 1 | 0/5 | Reverted routing experiments; preservation works, spontaneous recall does not |

Two incomplete attempts are excluded from these denominators: an initial routing run stopped on invalid `observe` arguments before error feedback was added; an initial OpenAPI conversion received HTTP 400 for a missing nullable timestamp type. The conversion was corrected and covered by a regression test. These failures are not successes or additional completed trials. Intermediate prompts were exploratory, not a frozen randomized experiment; source hashes identify the retained configuration, not a reproducible snapshot of every abandoned prompt.

## Verification and next decision

`FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npm run verify:local` passed after the final rollback: build, typecheck, lint, formatting, 57 unit tests, 70 Firestore tests, secret scan and high-severity audit gate. The audit still reports 15 moderate dependency findings. Local tests cover response fields and schema conversion; they do not establish model quality. Documentation links, English prose and whitespace are checked separately.

The next acceptance work belongs at the client boundary: define an explicit, testable orchestration contract for when context-sensitive tasks trigger recall and for verifying successful capture before claiming it was saved. Compare that contract against advisory MCP instructions on frozen, independently authored tasks and a second client configuration. For clients Lore does not control, capability disclosure and acceptance must acknowledge that server instructions are advisory. Evaluate capture, initiation, retrieved evidence and answer use separately; neither forcing calls in this autonomous benchmark nor filling missing arguments is an acceptable shortcut.

Applicability and temporal-answer failures still need discriminating cases and independent review. Precision, lexical/vector/file baselines, realistic volume, durable scheduled indexing, managed-index latency and billing remain unmeasured or unimplemented. Nothing here establishes that Firestore must be replaced. No hosted deployment or overall outcome acceptance is claimed.

## Reproduction

Build the repository and start the loopback emulator. Keep embedding configuration and the short-lived provider token in ignored local files. Run the retained configuration:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 LORE_EVAL_CONFIG=.local/recall-eval-config.json LORE_EVAL_TOKEN_FILE=.local/recall-eval-token.txt LORE_EVAL_CLIENTS=1 LORE_EVAL_OUTPUT=.local/recall-eval/reproduction node scripts/run-situational-recall.mjs
LORE_EVAL_OUTPUT=.local/recall-eval/reproduction node scripts/evaluate-situational-answers.mjs
```

For the challenge, set `LORE_EVAL_DATASET=docs/eval/fixtures/situational-recall-challenge.json` in both stages and use a separate output directory. Five autonomous trials are the default; `LORE_EVAL_TRIALS` can change that count. The answer helper reads the fixed ignored configuration/token paths shown above. Preserve all traces and failures. Exit success means the runner completed, not that the outcome passed; apply and record the disclosed answer/client rubrics. Delete the token after evaluation.

## Follow-up

The [client-policy comparison](recall-client-policies-20261112.md) tests server instructions, an additional client instruction and host-controlled prefetch under fixed conditions. It does not replace the distinct historical observations above.
