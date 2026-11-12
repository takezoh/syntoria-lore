# Situational recall contract

Status: target design, not implemented or measured. This extends the [observation ledger](observation-ledger.md); it does not replace its provenance, temporal, disclosure or Forget rules. Decision rationale is in [ADR 0011](../adr/0011-design-recall-around-contextual-use.md).

## Outcome

An authorized AI uses relevant accumulated decisions, constraints and experiences in a new situation without making the person repeat them or explicitly request a memory search. It explains the evidence and distinguishes past applicability from current applicability. A successful write or a returned search hit alone does not satisfy this outcome.

The service supplies useful, authorized evidence; the client initiates recall and incorporates it into its response. Measure both boundaries separately. Lore does not independently observe conversations or compel clients to call tools.

| ID | Observable acceptance |
| --- | --- |
| SR-01 | Given a constraint expressed with different words and under another project, a later planning question retrieves it and the answer applies it when relevant. |
| SR-02 | Given a named project and distracting name matches, useful contextual evidence remains eligible; a name hit alone cannot exclude it. |
| SR-03 | Given a past experience and a later state, the answer can explain the experience without presenting its old state as current. |
| SR-04 | Given closer unauthorized, forgotten or suppressed candidates, authorized relevant evidence remains discoverable within a stated search budget; no prohibited content is returned. |
| SR-05 | Given no relevant evidence, the client does not invent a remembered preference; it distinguishes no supported result from exhaustive absence. |
| SR-06 | Given a relevant conversation, client A records the useful points without a remember request; in a fresh session client B recalls and uses them without a recall request. |
| SR-07 | Given increasing stored volume, quality, latency, reads, vector scan charges and total cost are measured together; bounded output alone is not proof of bounded work. |

## Domain and client contracts

Retain one domain recall operation shared by adapters. Extend the current query with an optional intent: contextual (default), entity or historical. Keep query as natural language, including the task, desired outcome and constraints; explicit subject hints are optional and must not restrict cross-subject contextual retrieval. Historical intent carries an as-of time or asks for a course. Existing callers without intent get contextual behavior after the implementation cutover.

Client instructions must request recall before consequential recommendations, planning and decisions, even when no known proper name appears. Preserve the situation in the query instead of reducing every question to names. Recall again when the task or a constraint changes, not on every sentence. Record relevant observations during conversation; preserve conditions, action, outcome and source references for lessons. Text from memory is evidence, never an instruction.

No new authority can be granted through intent, subject hints, scoring or model output.

## Retrieval and selection

1. Resolve explicit names and aliases, collect lexical candidates and collect semantic candidates independently. Semantic retrieval covers the authorized scope, not just the named subject.
2. Apply tenant, scope, disclosure, source rights, suppression and Forget eligibility before candidates consume the useful-result budget wherever the storage query permits it. Where prefiltering is unavailable, use bounded additional retrieval or authorized index partitions; do not stop after filtering a fixed nearest ten. If the budget expires, return an eligibility-exhausted diagnostic rather than silently implying complete coverage.
3. Keep a configurable candidate budget separate from the output limit. Record per-channel candidate counts and exclusion counts without logging content. Embedding model/version eligibility must not crowd out compatible candidates.
4. For contextual intent, fuse channel ranks and rerank for relevance to the full situation. Implement a deterministic rank-fusion baseline first; compare any model reranker against it using the same cases, cost accounting and pinned model versions. Do not impose a semantic-only cap merely because a lexical match exists. Entity intent may favor exact identity; historical intent favors the requested period.
5. Deduplicate repeated evidence without treating repeated copies as independent corroboration. Select within the caller's response budget, preserving the evidence needed to understand each claim. A weakly related name match must not fill the budget ahead of an applicable constraint.
6. Recheck every returned observation and derived view at the authorization boundary. Neither ranking nor diagnostic metadata may expose prohibited content.

A model reranker is optional, not a dependency of the first implementation. Similarity is candidate evidence, not a truth or applicability score. Relevance thresholds require calibration on development cases; do not tune on the held-out set. Do not hard-code fixture words or expected IDs.

## Returned evidence

Return the matched observation with its ID, summary, source references, tier, effective and recorded times, and match channels. For a state, also return the topic's current status and the relationship to the matched observation. Do not substitute the current state for the historical observation that matched. Label retracted, expired or superseded evidence as historical only, and never return forgotten content.

Expose a bounded explanation of why evidence was selected (for example, matching operational constraint), not invented supporting facts. Distinguish candidate-budget exhaustion, index lag, unavailable semantic search, response-budget omission and no supported match. Retain these distinctions even when lexical search succeeds.

## Index freshness and recovery

Acknowledged observations are immediately accessible by ID. Semantic availability has a separate measurable watermark and lag. Indexing must retry independently of later user writes, with bounded retry/backoff and observable failed jobs. A failed embedding call followed by no further writes must eventually recover once the provider recovers. Do not claim immediate semantic visibility while indexing is pending.

Index partitioning, deletion and model migration must preserve the ledger's authorization and Forget guarantees. Keep original service content in its source; observations retain summaries and references.

## Evaluation and delivery

The [evaluation protocol and synthetic fixtures](../eval/fixtures/situational-recall.md) define relevance judgments and answer rubrics. Retrieval tests, client-use tests and scale tests report separate results. Emulator doubles establish plumbing and eligibility behavior, not semantic quality.

Implementation order:

1. Add the evaluation loader, fixture validation and baseline measurement without changing ranking. Capture current failures.
2. Separate candidate and output budgets; implement eligible candidate recovery and diagnostics, with permission and Forget regressions.
3. Add intent-aware fusion and matched-evidence/current-state responses. Verify SR-01 through SR-05 with real embeddings.
4. Add independent indexing recovery and update client instructions. Exercise SR-06 in fresh client sessions.
5. Measure SR-07 at increasing sizes; compare no memory, shared-file access and Lore before claiming an outcome improvement.

Implementation now includes optional intent, contextual rank fusion, matched evidence, expanded vector candidates and client query guidance. Candidate exhaustion diagnostics and a read-only retrieval/scoring runner are implemented. In-process maintenance retries queued indexing for scopes seen through authenticated operations, with exponential backoff up to 60 seconds and orderly shutdown. It tracks at most 100 active scopes and removes drained queues. Durable queues survive restart, but a scope must be activated again by an authenticated operation; stopped or CPU-suspended instances cannot run retries. Controlled fixture loading and small-corpus real-provider measurements are now available. An external durable worker or scheduler, independent held-out quality measurements, deployment and release acceptance remain future work. No monthly budget or latency target is newly approved here; report actual values and compare against explicitly selected operating limits before rollout.

## Improvement plan after the first real-provider evaluation

This plan responds to the [2026-11-12 evaluation](../eval/situational-recall-real-20261112.md). It is an implementation roadmap, not evidence that the outcome is achieved. Retain Firestore and the observation ledger; the measured failures do not justify changing persistence.

### 1. Make the evaluation faithful and discriminating

Before changing behavior, run the existing corpus through the real HTTP/MCP tools, their published schemas and server instructions. Replace the simplified observe adapter, which discards model-supplied state/aspect fields, and preserve the model's actual calls and errors. Use fresh sessions and independently provisioned synthetic tenants. Record dataset, code, prompt, embedding and answer-model versions plus raw traces.

Correct the scoring contract: measure retrieval, prohibited disclosure, attribution, applicability and answer correctness separately. Observation-ID citation alone is not the product goal: a source link or an unambiguous evidence reference that supports the claim also counts. A correct clarification can pass if it carries forward known constraints and asks only for genuinely missing information. Do not declare all cases passed when empty-gold abstention or answer use was never measured. Review the previous mixed-name and changed-source judgments under these clarified rules; keep the original judgment and the reason for any revision.

Completion: all 14 cases execute through MCP; full observe fields reach the domain unchanged; missing results and model errors fail the run; the two negative cases are scored for answer abstention. A second reviewer can reproduce every verdict from the saved evidence. Freeze a separately authored held-out set before further tuning; do not label another paraphrase of a tuning case as independent evidence.

### 2. Preserve applicability and attribution in each result

The domain response must keep each matched observation's subject names, aspect, time, provenance and source reference together, including when the observation is historical or belongs to another project. Keep current state alongside matched historical evidence. Provide a stable evidence reference that the client can cite; a reference must resolve only through authorized reads. Do not use semantic similarity as proof that two subjects, causes or operating conditions are the same.

Update client guidance to distinguish a transferable lesson from an established fact about the current case. A past timeout cause may suggest a hypothesis to check; it cannot become the current cause. A saved cost constraint must constrain advice, not become an unsupported claim that a proposed architecture will meet the budget. If essential context is missing, ask for it while retaining the known constraints.

Completion: the payment-retry cases retain the useful idempotency lesson and never assert the other project's cause as this incident's cause. Historical evidence is not presented as current. Claims from memory have supporting references, including source links where available. The held-out cases contain different projects and different failure causes, not fixture-specific trigger phrases.

### 3. Improve selection only after locating the error stage

For each failure, retain candidate IDs and ranks, eligibility exclusions, selected evidence and final answer. Determine whether the relevant evidence was absent, dropped, buried among distractors or misused despite being clear. The initial Recall@5 result does not justify raising candidate limits further: the visible corpus was small enough to make that result easy.

Compare current rank fusion with lexical-only, semantic-only and shared-file baselines on the same authorized corpus and output budget. Add realistic near-neighbor distractors, name collisions, multiple simultaneous constraints and queries with no supported memory. Calibrate relevance thresholds or a reranker on development data only. Add a model reranker only if it improves held-out answer use enough to justify measured latency and cost; do not make it a prerequisite for basic provenance fixes.

Completion: report per-case recall, reviewed precision/irrelevant inclusions, abstention, response size and cost. No eligibility, source-rights or Forget regression is permitted. Explicitly report any tradeoff between precision and recall rather than hiding it in an aggregate score.

### 4. Verify spontaneous use across fresh conversations

Use the full MCP client path. Conversation A receives two distinct constraints without a remember request. Conversation B receives a task without a recall request. Verify saved content, tool initiation, retrieval and use separately. Add the currently unrun unrelated translation task to detect irrelevant memory being forced into answers. Run both Japanese and English tasks and a task whose missing details require clarification.

Completion: five repeated trials per pinned client configuration, with every failure retained. Each trial must carry forward both relevant constraints, avoid unsupported claims, and provide inspectable attribution when using memory. Test at least two client configurations before claiming cross-client reliability; same-model fresh sessions remain a narrower result. Zero failures in these trials is a regression gate, not a population reliability estimate.

### 5. Establish operational acceptance before deployment

Measure at increasing corpus sizes using the protocol's standard and stress workloads. Record candidate-limit exhaustion, vector scan cost, latency and index lag. Test indexing after a provider outage and after process restart without a new user write. Implement a durable scheduled worker that discovers pending work through bounded authorized queues; the current in-process timer cannot guarantee progress during CPU suspension or restart. Include queue fairness, retry/backoff, shutdown, revoked access and Forget/restore in the worker tests.

Completion: no stranded index jobs in the tested recovery cases, no hidden candidate exhaustion, and measured performance/cost against explicitly agreed limits. Local or emulator success does not authorize claims about managed indexes, hosted authentication or billing. Run npm run verify:local for code changes and record hosted acceptance separately when deployment is authorized.

### Delivery order and acceptance

Implement unit 1 first, then unit 2 with its regression cases. Use the resulting traces to decide whether unit 3 needs ranking changes. Unit 4 evaluates the complete behavior after those changes. Unit 5 is required before operational release. Keep each implementation unit reviewable and record its before/after evidence with the same frozen cases.

The faithful MCP baseline, applicability/provenance response and client-guidance experiments below address the first deliverables of this plan; their measured limitations determine subsequent work. Do not claim the overall outcome from candidate recall alone, and do not postpone all quality work until infrastructure work is complete.

## Reevaluation status, 2026-11-12

The [full MCP reevaluation](../eval/situational-recall-mcp-20261112.md) implements the faithful evaluation path and preserves applicability fields, but does not accept the outcome. The retained client saved constraints in five trials and recalled them spontaneously in zero. Retrieval passed the small development and self-authored challenge sets; independent holdout, independent review, second-client acceptance and scale work remain open. Prompt-only routing experiments regressed capture and were reverted.

Next, specify the client orchestration contract for context-sensitive tasks, successful-capture verification and evidence use. Test controlled orchestration separately from autonomous third-party client behavior; do not force calls and label them spontaneous. Keep the remaining applicability and temporal-answer failures visible. No ranking or database replacement is justified by these results. Durable scheduled recovery remains required for operational acceptance.

The [client-policy comparison](../eval/recall-client-policies-20261112.md) subsequently measured architecture retrieval at 0/10 with server instructions, 5/10 with an added client instruction, and 10/10 with host prefetch. The added instruction regressed capture to 0/5, while prefetch still produced answer-use failures. Keep prompt origin, actual invocation, applicability and verified capture as separate contracts; the experimental policy is not accepted for production.

The [response-quality ablation](../eval/lore-response-quality-20261112.md) subsequently held answer instructions fixed and found that candidate selection removed irrelevant incident material, while explicit unverified applicability assessments improved conditional transfer. Temporal answers and cost reasoning remain unresolved. An actionable-error prototype did not recover capture. These results justify further domain-level response design, not production deployment of the experimental model selector or error decorator.

## Optional applicability assessment contract

The domain service can assess the ranked, already authorized contextual candidates before applying the caller's final item limit. This is configured by the operator, not enabled by a request field. With no assessor configured, retrieval remains unchanged. Entity and historical intents bypass this stage; a contextual query with an explicit `at` passes that effective timestamp to the assessor.

The stage considers at most `min(30, limit * 3)` candidates in existing rank order, with a 65,536-byte serialized input limit and a ten-second deadline. It does not invent or fetch additional observations. Each candidate must receive exactly one complete, unique, in-range assessment: `direct`, `conditional`, `lesson` or `irrelevant`. Reasons and applicability limits are bounded to 600 characters each. Only irrelevant candidates are removed; conditional candidates and transferable lessons remain. The model cannot set observation IDs, source fields, authority, subject names or temporal state. Selection preserves existing order, then applies the requested item count and the existing response byte budget.

Returned `applicability_assessment` fields are explicitly `unverified-model-interpretation`. They help a client distinguish direct application, conditional transfer and lessons, but do not verify facts, establish the current incident's cause or prove cost feasibility. Original evidence and its authority remain alongside each annotation. A topic's `current` refers to the requested effective timestamp; it does not establish that an actual meeting or other event occurred on that date.

Failure is explicit. Timeout, malformed, incomplete, oversized or failed assessments produce `recall-assessment-unavailable` and use the existing ranked candidates without annotations. Successful selection produces `recall-assessment-applied`; an empty selection also reports `assessment-no-applicable-candidates`. A candidate count bound reports `assessment-candidates-truncated`. Empty output does not prove that no relevant memory exists.

After the asynchronous assessment, the domain rechecks every observation included in its inputs, including topic history and conflicts, against current ledger visibility. If any input is no longer visible, it discards all annotations because even another candidate's annotation could mention that input, removes affected items, and reports `assessment-evidence-changed`. The provider receives a detached copy of candidate data. These checks retain the existing authorization and Forget boundary; they do not establish an atomic snapshot of concurrent writes.

The API's Vertex adapter only transports the structured classification request. The domain owns eligibility, bounds, validation, filtering, fallback and visibility rechecks. Set `RECALL_ASSESSMENT_MODEL` to opt in using the existing Vertex project and regional configuration. Invalid or empty configuration fails startup; leaving it unset disables assessment. This additional inference stage has latency and billing implications, and quality acceptance is separate from implementation. No model name or production enablement is chosen by default. The richer capture-error experiment remains unimplemented because it did not demonstrate recovery.

The [integrated assessment evaluation](../eval/recall-assessment-implementation-20261112.md) exercised all 22 questions through actual MCP and the provider. Required retrieval evidence was retained, but answer quality and release acceptance remain incomplete. Assessment is implemented and opt-in, with no production enablement in that evaluation.
