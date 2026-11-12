# Lore response selection, applicability and recovery, 2026-11-12

## Conclusion

There is measurable work left at Lore's response boundary. With the same question, answer model and answer instructions, selecting relevant memories removed irrelevant incident material, and explicit applicability assessments helped the model distinguish another incident's cause and another project's constraints. These are promising server-side responsibilities, not a production-ready implementation or full outcome acceptance.

The specific actionable-error prototype did not repair capture. Temporal answers and unsupported cost reasoning also remain unresolved. The results do not establish that a model reranker is the best implementation, that all error-contract improvements are ineffective, or that client execution control is unnecessary.

[Full evidence](lore-response-quality-20261112.json) preserves the final 72 answer runs, six selector outputs, ten actual MCP capture conversations, input and source hashes, per-case review notes, and incomplete attempts. The experiment changes evaluation scripts only; production ranking, schemas, instructions and storage behavior are unchanged.

## Response experiment

Six inspected development questions were taken from the [client-policy experiment](recall-client-policies-20261112.md) and [MCP reevaluation](situational-recall-mcp-20261112.md): architecture in English and Japanese, an unknown airline-seat preference, a new reporting incident, a historical review schedule, and a named-project architecture decision involving another project's constraints.

Each question reuses the complete, previously recorded synthetic MCP response. This isolates response selection and presentation from retrieval initiation, embeddings and candidate generation. It is an answer-only replay, not fresh MCP retrieval or spontaneous client behavior. The answer model is gemini-2.5-flash, temperature 0, thinking budget 0, with identical server instructions plus the same answer-only instruction in every arm. The model has no tools in this stage.

A separate model call receives the question and the authorized candidate items, but no gold labels or expected answers. It assigns each candidate one role: direct, conditional, transferable lesson or irrelevant, with evidence-grounded reasons and limits. Structured output is validated for complete, unique, in-range candidate indices and allowed roles. The selector runs once per question; its output is reused in all three repeats. Conditional candidates remain included so pruning does not remove a potentially useful constraint merely because applicability needs confirmation.

Four arms isolate two factors:

| Arm | Selection | Applicability assessment |
| --- | --- | --- |
| raw | All original items | None |
| filtered | Remove model-labeled irrelevant items | None |
| annotated | All original items | Add role, reason and limits |
| filtered-annotated | Remove model-labeled irrelevant items | Add role, reason and limits |

Original evidence fields, authority, sources and time are not rewritten. Added assessments are explicitly marked unverified model interpretations, and the same answer instruction in every arm says to check them against original evidence. They are not promoted into source facts or authorization decisions. A model annotation could still be wrong; this experiment does not establish the safety of arbitrary annotations.

There were three fresh answer calls per question and arm, for 72 final answers. All three answers within each case/arm were identical. These repeats demonstrate reproducibility for these inputs, not independent statistical evidence. The primary agent reviewed the answers and candidate applicability; there was no blinded or independent reviewer.

## Observations

| Diagnostic | Raw | Filtered | Annotated | Filtered + annotated |
| --- | --- | --- | --- | --- |
| Unnecessary Juniper incident in architecture answers | 6/6 | 0/6 | 0/6 | 0/6 |
| New incident's cause explicitly identified as unknown | 0/3 | 0/3 | 3/3 | 3/3 |
| Prior-project constraints explicitly conditional on Cedar sharing them | 0/3 | 0/3 | 3/3 | 3/3 |
| Unknown seat preference correctly left unknown | 3/3 | 3/3 | 3/3 | 3/3 |
| Temporal schedule rubric fully met | 0/3 | 0/3 | 0/3 | 0/3 |

Selection kept eight of 22 candidate items across the six questions. Post-run diagnostic review found no dropped potentially useful item in this small set: both architecture constraints, the incident lesson, the relevant historical state, and both conditional prior-project constraints remained. The unknown-preference question correctly retained none. These are item-level diagnostic judgments, not an independently measured production precision score.

The architecture answers retained both relevant constraints in all four arms. Filtering removed the unrelated file-export material. Annotation alone also suppressed its use despite leaving it in the response. This supports both selection and explicit applicability as possible Lore-side improvements; it does not show that both are always required.

For the new incident, raw and filtered answers named Juniper and gave the atomic-publication lesson but did not explicitly answer whether the current cause was known. Annotated answers explicitly said the new cause was unknown while retaining the useful lesson. This is an improvement in completeness and applicability clarity, not evidence that every original answer asserted a false current cause.

For Cedar, raw and filtered answers reasoned from prior-project constraints without clearly checking whether Cedar shared them. Annotated answers conditioned their advice on that check. The combined arm explicitly asked whether the same maintenance and cost constraints applied.

Filtering made unknown-preference answers shorter and removed irrelevant descriptions of software memories. All variants already avoided inventing a seat preference, so this is a relevance improvement rather than a new abstention success.

Temporal responses did not meet the fixture's intended answer, the schedule valid on October 15 being Monday. Some invented an October 12 occurrence; others declined to infer whether a review happened on October 15. The wording "When was the Cedar review on October 15?" is ambiguous between a schedule and an occurrence. That ambiguity must be corrected in a new frozen test before attributing all failures to the server's temporal contract.

Some architecture answers still imply that pay-per-use or managed services satisfy a fixed recurring-cost constraint without actual estimates. Neither pruning nor annotations establish cost feasibility. All cited observation IDs exist in the supplied response, but citation existence alone does not establish that the claim is supported. No overall answer pass rate is inferred from these partial diagnostics.

Selector latency had a median of 1,625 ms in this run, in addition to answer generation. No caching benefit, financial cost, model independence, realistic volume, permission boundary or large-corpus recall tradeoff was measured. A model selector must not become a production prerequisite merely because it helped these six questions.

## Capture error experiment

The separate capture experiment reuses the exact client instruction and initial user statement that failed in the previous comparison. It uses real loopback HTTP/MCP, full tool schemas and fresh demo- emulator tenants. Five conversations receive the original error; five receive an evaluation-only decorator after real MCP rejection. The decorator adds:

- `saved: false`;
- missing required field names derived from the published schema;
- instructions to correct and retry without inventing facts;
- a reminder not to claim successful storage without an observation ID;
- the complete original MCP error.

It never fills arguments, relaxes validation or claims that a write succeeded. This is a prototype of a richer server response, simulated at the evaluator boundary; it is not an implemented production MCP error change.

| Measure | Original error | Actionable error |
| --- | --- | --- |
| Successful capture trials | 0/5 | 0/5 |
| Rejected observe calls | 15 | 15 |
| Conversations subsequently saying information was noted | 5/5 | 5/5 |

The first server-reported missing field was `title`. No successful repair occurred. The richer response alone did not solve this model/configuration's capture failure, so it is not accepted as a sufficient fix. Tool contract simplification, schema presentation and client success gating remain hypotheses requiring separate tests. The existing server correctly rejected malformed writes; rejection is not itself a server correctness bug.

## Incomplete attempts

The first selector run used JSON mode without a response schema. It completed the 12 English-architecture answers, then rejected the Japanese selector result. The invalid selector output was not checkpointed, so its exact defect cannot be diagnosed. Those completed answers and the failure are retained separately, not silently pooled into the final result.

While adding structured output, one harness edit mistakenly passed the schema as the candidate payload. Validation rejected that result before any answers were generated. The argument order was corrected, raw selection responses were saved before validation, and the final complete run restarted in a separate output directory. The final manifest includes the structured-output schema. These failed attempts are not counted as successes or additional completed trials.

## Design consequence

The claim that Lore has no remaining work is contradicted by the response ablation: changing what Lore could select and return changed answer relevance and applicability with the client answer policy held fixed. Prioritize a bounded response-selection contract and explicit conditional-use representation in the domain layer, while preserving provenance and authorization. Compare cheaper deterministic or ranking approaches with model selection on independent tasks before choosing an implementation.

Keep three gates separate: relevant evidence selected, evidence applied under valid conditions, and a truthful answer or save acknowledgement. Response improvements do not make an uncalled server initiate recall, and a client that calls recall still needs to use its results correctly. Error verbosity alone is not an accepted capture fix. Independent multilingual tasks, a second actual client/model, temporal wording repair, operational scale and durable index recovery remain open.

## Verification and reproduction

The API experiment scripts ran on Node 26.13.0. Full repository validation was repeated on the supported Node 24.22.2 runtime with the loopback emulator: build, typecheck, lint, formatting, 57 unit tests, 70 Firestore tests, secret scan and the high-severity audit gate passed. The audit retains 15 moderate dependency findings. Documentation language, local links and whitespace were checked separately. These checks validate the code, not model acceptance.

Build before running. Keep provider configuration and tokens in ignored local files. The response experiment replays tracked synthetic evidence and needs provider access, but no database. Capture recovery also requires the loopback emulator:

```sh
LORE_EVAL_OUTPUT=.local/lore-response-quality-final node scripts/evaluate-lore-response-quality.mjs
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node scripts/evaluate-capture-recovery.mjs
```

Both scripts default to `.local/recall-eval-config.json` and `.local/recall-eval-token.txt`; override with `LORE_EVAL_CONFIG` and `LORE_EVAL_TOKEN_FILE`. Delete the short-lived token afterward. No production memories, identity bindings or deployment settings were changed.
