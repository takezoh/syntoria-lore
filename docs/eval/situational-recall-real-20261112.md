# Situational recall with real embeddings and model conversations, 2026-11-12

> Superseded for client-path conclusions by the [full HTTP/MCP reevaluation](situational-recall-mcp-20261112.md). The simplified-adapter 5/5 recall result below did not reproduce through actual MCP.

## Conclusion

Real embeddings retrieved all required evidence in this small disclosed development corpus. End-to-end answer use did not pass every rubric. The result supports semantic candidate retrieval for these cases, not product acceptance.

[Machine-readable results and model answers](situational-recall-real-20261112.json) retain the per-case observations. No production memories, identities or persistence were modified.

## Method

The [22 synthetic observations and 14 cases](fixtures/situational-recall.json) were loaded into a fresh synthetic demo- Firestore emulator project. Vertex AI gemini-embedding-001 produced actual 768-dimensional vectors. Cached vectors were reused for repeated runs; embeddings were not deterministic test doubles. Retractions, Forget and source changes used domain operations. A synthetic fixture writer and worker had private access; the evaluated reader had General-only access. The twelve private records shared the evaluated scope and remained indexed.

The runner exercised the current ObservationService and Firestore repository directly. It did not traverse hosted MCP, managed indexes or hosted identity. The fixed candidate-order seam was not used. Corpus and queries were disclosed development data, with no held-out or load corpus.

Fourteen questions were also answered by gemini-2.5-flash with the actual returned evidence supplied as context. This stage measured answer use after retrieval, not whether the model would initiate retrieval. The primary agent applied the disclosed rubrics; this was not independent or blinded review.

Five further trials each used a fresh, separate synthetic tenant. Model conversation A was told that the person is the sole operator and recurring infrastructure spending must not increase, without a remember instruction. Fresh model conversation B received only the architecture task. The actual exported MCP SERVER_INSTRUCTIONS were used, with domain-backed simplified observe, recall and get_access functions. The observe adapter stored summaries as events; full MCP validation and state/aspect mapping were not exercised. Both conversations used the same pinned model name; this is a separate-session experiment, not a Claude-to-another-provider interoperability test.

## Observed retrieval

| Measure | Result |
| --- | --- |
| Macro Recall@5, 12 nonempty-gold cases | 100% |
| All-required-hit rate, 12 nonempty-gold cases | 12/12 |
| Explicit prohibited-content cases | 0 |
| Japanese paraphrase and cross-language required evidence | 2/2 |
| Empty-gold questions | 2, excluded from Recall@5 |

This corpus is small: only ten observations are General-visible before lifecycle effects, and vector retrieval can consider the whole corpus. These figures do not establish ranking quality at scale. Empty-gold searches still returned irrelevant candidates; the answer stage had to abstain.

## Observed answer use

Eleven of fourteen answers met the disclosed rubrics on primary-agent inspection. Both empty-gold questions answered unknown. Failures were:

- mixed-name: the answer cited the single-operator constraint but declined to apply it to the named-project recommendation.
- cross-language: the Japanese answer gave the relevant idempotency lesson, then presented another project's missing-deadline cause as the cause of the current timeout.
- changed-source: the answer reported that the endpoint was removed but did not recommend the verification required by the rubric.

The first two are substantive transfer/application problems. The third is a stricter rubric failure, rather than an invented fact.

## Observed autonomous client behavior

| Measure | Result |
| --- | --- |
| A saved without a remember request | 5/5 |
| B recalled without a recall request | 5/5 |
| B obtained A's saved observation | 5/5 |
| B explicitly acknowledged both constraints | 4/5 |
| B cited observation IDs | 0/5 |

A combined both constraints into one saved summary in all five trials. Some B answers asserted that a proposed managed-service architecture would avoid additional recurring spend without enough cost information. Recall and mentioning a constraint do not establish that advice satisfies it.

An earlier exploratory run with abbreviated instructions yielded no B recall in five trials. It is a different treatment, not a failure rate for the current server instructions; the actual-instruction trials above are the reported product-path approximation.

## Remaining acceptance

Improve evidence attribution and cross-project applicability handling, then use independent held-out questions and a full MCP client. Measure irrelevant inclusions, repeated client trials, realistic memory volume, managed indexes, latency and billing. The unrelated-task client scenario has not been run. No claim is made for hosted acceptance, scale, stable provider behavior or reduced repeated explanation in ordinary use.

## Reproduction

Build first. Start a loopback Firestore emulator, then run:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 LORE_EVAL_CONFIG=/path/to/ignored-config.json LORE_EVAL_TOKEN_FILE=/path/to/short-lived-token LORE_EVAL_CLIENTS=1 node scripts/run-situational-recall.mjs
node scripts/evaluate-situational-answers.mjs
```

The ignored config contains projectId, location, model and dimension for the embedding request only. Never use that real project as the persistence target. The runner itself fixes persistence to a fresh demo- project and requires a loopback emulator. The answer-stage helper reads the ignored local config and raw results under .local/recall-eval. Token contents are never printed. Outputs and embedding caches remain under .local until sanitized results are deliberately copied into an evaluation record.
