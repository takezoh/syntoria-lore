# Situational recall evaluation protocol

Status: synthetic development fixtures, not an evaluation result. The [JSON dataset](situational-recall.json) supports the [target contract](../../design/situational-recall.md). English is used for documentation and annotations; two Japanese query strings are intentional language test inputs. All people, projects and source URLs are synthetic.

## Dataset contract

The file contains 22 observations, 14 retrieval cases, two client scenarios and one indexing recovery scenario. IDs are fixture labels, not production observation IDs. A future loader must map labels to returned service IDs and create provenance and permissions through controlled test setup; it must not let an ordinary observe request set tier, writer or status.

Observation fields describe seeds. Missing status means active. Retracted and forgotten seeds require the real lifecycle operations after creation. Source-status changes require a source report. Compartments require separately provisioned authorized actors. Never provision production identities or change live permissions for this evaluation. Use a loopback emulator with a synthetic demo- project for deterministic tests.

Case fields:
- required_evidence: relevant labels that must be represented within top_k, including matched historical evidence where specified.
- forbidden_evidence: labels whose content must never be returned.
- answer_rubric, answer_must and answer_must_not: independent answer-use judgments, not exact-string checks.
- expected_abstention: no supported personal-memory answer is justified.
- as_of: the state-effective cutoff, not a claim about what was recorded at that time.
- candidate_order_override: a deterministic test seam for eligibility recovery only. Never use it in real-embedding quality measurements.
- split: development. None of these disclosed cases is held out.

Unlisted observations are distractors, not automatically prohibited. Old evidence may support a historical explanation but must not become current advice. The eligibility-crowding case separates hard confidentiality failure from insufficient recovery: budget exhaustion is a diagnostic success but still a retrieval miss.

## Execution and scoring

1. Freeze dataset digest, implementation revision, embedding model/version, ranking configuration, candidate/output budgets and run timestamp.
2. Seed all observations and lifecycle changes. Wait for the indexing watermark except in the explicit recovery scenario. Use the same corpus and permissions for every compared system.
3. Run each query with real embeddings for semantic quality. Separately run the deterministic candidate-order test for eligibility behavior.
4. Report macro Recall@5 as the mean of returned required labels divided by required labels for nonempty gold cases. Report all-required-hit rate separately. Empty-gold cases are excluded from recall and scored for abstention. Report irrelevant inclusion rate using reviewed relevance labels, not merely absence from the required list.
5. Score answers for evidence use, attribution, temporal correctness and abstention using the rubric. A reviewer must be able to inspect returned evidence and the answer; a model judge alone does not establish truth.
6. Run fresh client sessions without injecting the expected memory or requiring a recall call in the task prompt. Record whether recall happened before the answer, whether relevant evidence returned, whether it was used, and whether the user had to repeat it.
7. Repeat each client scenario at least five times per pinned client configuration; report every run and the denominator, not just the best trace.

All fixture cases are discriminating regression expectations. Target: every required-evidence case passes, all answer rubrics pass, and zero prohibited content, fabricated personal memories or stale-as-current answers. These small synthetic targets are not statistical guarantees or representative product-quality estimates. Do not weaken rights or Forget to improve recall.

Before claiming product benefit, freeze a separate held-out set of realistic, consented or independently authored synthetic questions, with gold judgments made before observing results. Include Japanese paraphrases, cross-project lessons, multiple constraints and negative cases. Keep the held-out set out of ranking calibration.

## Baselines and load

Compare (a) no memory, (b) a shared summary/file collection with keyword search, and (c) Lore, using equal source information, client model, task prompts and response budgets. State the exact file-search implementation; a simulated keyword baseline is not a Google Drive MCP experiment. If evaluating Drive, record the actual connector and available search functions.

Measure at 100, 1,000, 10,000 and 100,000 observations, then extend only when the intended workload requires it. Generate reproducible synthetic distractors with a recorded seed, including near-semantic distractors, name collisions, old versions and unauthorized records. Preserve the gold evidence unchanged. These load corpora are a future runner requirement, not provided measurements.

Record per-stage and end-to-end p50/p95, errors, cold/warm behavior, returned and scanned candidates, document reads, indexing delay, embedding/reranking calls and billed cost. Use at least 100 timed queries per size and report sample count. Emulator timing cannot establish managed-service latency, indexes, IAM or billing.

## Deliverable boundary

Run `node scripts/evaluate-situational-recall.mjs --validate` to validate the dataset. The runner also scores recorded retrieval output:

```sh
node scripts/evaluate-situational-recall.mjs --results /tmp/recall-results.json --output /tmp/recall-report.json
```

Recorded input is an array of `{id, items, notes, latency_ms}`, one entry per case. Each item is an array of fixture evidence labels represented in that result. Missing or duplicate cases fail; prohibited evidence is checked across all returned items, including beyond top_k. A report with retrieval failures exits nonzero.

For read-only live retrieval, set `LORE_EVAL_MCP_URL` to a loopback MCP service and `LORE_EVAL_TOKEN` to a synthetic admitted token, then run:

```sh
node scripts/evaluate-situational-recall.mjs --mapping /tmp/fixture-ids.json --output /tmp/recall-report.json
```

The mapping is an object from every fixture label to its observation ID. A separate controlled setup must seed observations, rights, retractions, source reports and Forget; the runner never mutates admissions or lifecycle state. Do not seed prohibited observations as ordinary visible events. Caller setup must use the case's allowed compartments; these cases all use General-only access. The runner does not execute candidate_order_override: that seam belongs to repository tests.

The runner supplies retrieval measurements and a dataset digest, not answer-quality or abstention results. Fresh-client experiments, real-provider runs, controlled fixture loading and generated load corpora remain separate work. Dataset validation establishes only structural integrity.
