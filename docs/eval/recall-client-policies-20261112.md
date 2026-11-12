# Client instructions versus automatic recall, 2026-11-12

## Conclusion

Client-side prefetch reliably executed recall for the tested architecture requests, but did not reliably produce acceptable answers. An added client instruction improved English recall and failed on the Japanese equivalent; it also broke capture in a separate test. None of the three treatments passes the complete memory outcome.

This supports testing client-controlled retrieval as an integration mechanism. It does not establish that prompts can never work, that client-origin text is inherently superior to server-origin text, or that prefetch alone solves memory use. The added instruction is experimental and should not be shipped based on these results.

[Complete evidence](recall-client-policies-20261112.json) includes the frozen inputs and rubrics, source hashes, all 75 recall-task conversations, ten capture conversations, actual tool arguments and errors, provider usage metadata, answers and review notes. No production behavior was changed by this experiment.

## Question and experiment

The question follows the [full MCP reevaluation](situational-recall-mcp-20261112.md): should automatic recall come from MCP instructions, client prompts or client execution control?

Three treatments use the same real HTTP/MCP server, full tool schemas and Vertex gemini-2.5-flash at temperature 0 with thinking budget 0:

1. **server-only:** the current MCP server instructions, placed in the model system instruction by the evaluation host.
2. **client-policy:** a short fixed client instruction prepended to those same server instructions. It requests recall before advice or clarification, applicable constraint reuse, supporting references, no unmeasured cost claims, direct handling of translation, and confirmation of successful capture.
3. **orchestrated:** the same server instructions as the baseline, with host-issued `get_access` and `recall` before the model answers. The host forwards the complete authorized recall result as explicitly untrusted evidence. It does not select gold observation IDs, rewrite the returned evidence or restrict the model's normal tools. A narrow deterministic rule skips prefetch for prompts beginning with `Translate`; otherwise it queries with the complete task, contextual intent and a limit of five. This is an experimental routing rule, not a general intent classifier.

The precise prompts and policy were saved before the run in the evidence manifest. No instructions were tuned after observing this experiment. The host still gives all three treatments actual server schemas and forwards model calls unchanged; missing required arguments fail real MCP validation.

Each treatment receives five repeated fresh conversations for each of five tasks: architecture in English, architecture in Japanese, translation, an unknown personal preference, and a new reporting incident resembling a previous incident. Each case and treatment has its own synthetic tenant so incidental writes cannot contaminate another conversation. All receive the same three controlled fixture observations through MCP: a sole-operator constraint, a no-increased-recurring-spend constraint with no cost estimates, and a Juniper atomic-publication lesson whose restart cause applies to Juniper only. Constraints explicitly apply to new services, removing cross-project ambiguity from the architecture test.

These fixtures isolate recall from capture. Ten separate conversations then test capture without a remember request: five baseline and five with the added client policy. They do not form an end-to-end capture-to-recall trial. Capture under prefetch was not separately tested; the experimental prefetch rule itself has no capture handler.

## Measured results

Architecture denominators contain five English and five Japanese questions per treatment.

| Measure | Server only | Added client policy | Host prefetch |
| --- | --- | --- | --- |
| Architecture recall executed | 0/10 | 5/10 | 10/10 |
| English architecture recall | 0/5 | 5/5 | 5/5 |
| Japanese architecture recall | 0/5 | 0/5 | 5/5 |
| Both constraints actually retrieved | 0/10 | 5/10 | 10/10 |
| Both constraints acknowledged in final answer | 0/10 | 5/10 | 9/10 |
| Translation correct, no memory calls | 5/5 | 5/5 | 5/5 |
| Unknown seat preference not invented | 5/5 | 5/5 | 5/5 |
| Successful capture in separate conversations | 5/5 | 0/5 | Not tested |
| Capture validation errors | 0 | 15 | Not tested |
| Median architecture elapsed time | 661 ms | 1,478 ms | 4,793 ms |

Prefetch calls are host-controlled, not spontaneous model tool selections. No model-initiated architecture recall occurred in that arm. This is still a valid user-facing automatic-retrieval mechanism; its execution must be attributed honestly.

Elapsed times include local MCP, remote model calls and any embedding cache misses, but exclude fixture setup. Three treatments ran concurrently within each trial. They are observations of this harness, not hosted latency guarantees or controlled performance comparisons. Real gemini-embedding-001 embeddings at 768 dimensions were cached and reused. Model token counts are preserved in the JSON; no billing estimate was inferred.

## Answer failures and capture regression

The added policy's English architecture answers retain both constraints while asking for missing service requirements. Its Japanese answers do not recall and ask broadly for budget and constraints again. This is a narrow language/configuration sensitivity finding, not evidence about all multilingual models.

Prefetch delivered both constraints in all ten architecture conversations. However:

- One English conversation wrote an inferred architecture proposal and then only told the user that it had saved it, instead of giving the requested answer. The write succeeded as an inference; it was not a user-confirmed decision.
- Four English answers imply that serverless or managed services align with or satisfy the fixed recurring-cost constraint without a measured estimate. A pay-per-use model does not establish that a new service stays within an existing total-spend baseline.
- Some answers include the Juniper file-export lesson despite no established need for file export, or omit an inspectable reference for the operating and cost constraints. Acknowledging two constraints is not a complete answer-quality pass.
- Across the incident task, answers generally attribute the known restart to Juniper and transfer the atomic-publication lesson, but explicit recognition that the new incident's cause is unknown is inconsistent. Retrieval is not counted as applicability acceptance.

All cited observation IDs in final answers exist in returned recall evidence. That is an existence check, not a claim-support judgment; source links and other unambiguous supporting references would also be acceptable. The primary agent reviewed answers without blinding or an independent reviewer. Per-answer notes are in the evidence; there is no inflated aggregate answer pass rate.

In all five added-policy capture conversations, the model made three invalid `observe` calls. The first missing required field reported by the server was `title`. The model then said it had noted the information despite no successful write. The baseline saved both constraints in one combined event in each trial. The added policy specifically asked for successful-capture verification, yet this instruction was not followed. This is why the prompt must not be adopted merely because English recall improved.

## What this establishes about prompt location

MCP server instructions were already included in the model system instruction. The additional client policy was prepended in the same instruction channel. This experiment measures an additional wording/order treatment, not two different authority levels or transport origins. An MCP server could distribute the same short policy; if the host assembles identical model inputs, the model does not acquire a different execution guarantee from that origin alone.

MCP Prompts invocation and the behavior of actual Claude, ChatGPT or other client products were not tested. A server can supply guidance, but this harness's reliable retrieval initiation came from code issuing the call. Whether the guidance is delivered, retained and acted on must be checked per client integration.

The earlier design claim should therefore be read narrowly: client execution control is a demonstrated way to ensure a retrieval attempt on these tasks, not a proven necessary condition for every model and not sufficient for correct memory use.

## Decision and next gate

Retain the evaluation harness; do not change production instructions to the experimental policy. Define client integration around separate obligations:

- The host decides when an authorized context lookup must run and records whether it succeeded. Routing must be tested on broader tasks, not only the current translation exemption.
- The response preserves applicable constraints, marks missing cost or causal evidence, and uses references the user can inspect. Irrelevant retrieved memories should not become response requirements.
- The capture path validates required arguments and checks the write result before a save claim. It must not silently fabricate missing fields or turn an AI proposal into a user decision.

A next comparison should freeze independently authored tasks, include a second actual client/model configuration, and test the combined retrieval and answer policy without regressing capture. A controlled orchestration run must remain distinct from a model-autonomy benchmark. No database replacement is justified by the failures observed here.

## Verification and reproduction

Persistence was limited to fresh demo- Firestore emulator projects on loopback. Synthetic admissions used the existing operator tool. Hosted authentication, managed indexes, realistic corpus size and operational costs were not tested. Five fixed prompts repeated at temperature zero are not five independent population samples. No production memories or identity bindings were changed.

`npm run verify:local` passed with the emulator: build, typecheck, lint, formatting, 57 unit tests, 70 Firestore tests, secret scan and the high-severity audit gate. The dependency audit still reports 15 moderate findings. Documentation language, local links and whitespace are checked separately. The short-lived provider token was removed after evaluation.

After building and starting the loopback emulator, provision ignored embedding configuration and a short-lived provider token, then run:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 LORE_EVAL_CONFIG=.local/recall-eval-config.json LORE_EVAL_TOKEN_FILE=.local/recall-eval-token.txt LORE_EVAL_OUTPUT=.local/recall-policies node scripts/evaluate-recall-policies.mjs
```

The runner records its manifest before model calls, preserves errors, and saves raw results per completed trial. Completion is not product acceptance: apply the manifest's answer and capture rubrics. Keep provider configuration and tokens out of tracked artifacts and delete the token after the run.

## Follow-up

The [Lore response-quality experiment](lore-response-quality-20261112.md) tests selection, applicability annotations and capture-error recovery while isolating them from client tool initiation.
