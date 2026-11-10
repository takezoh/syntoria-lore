---
id: adr-0008-keep-a-generative-baseline-and-enable-decision-models-per-point
kind: adr
title: Keep a generative-LLM baseline and enable decision models per evaluated point
status: accepted
created: '2026-11-08'
decision_makers:
- owner
relations:
- {type: references, target: adr-0007-store-memories-as-firestore-memory-records}
- {type: references, target: adr-0004-approve-protected-changes-by-policy}
summary: A generative LLM builds memories on an always-available baseline path; a decision model replaces a bounded judgment only at a point that passed the fixed evaluation, and code keeps authority, approval, concurrency and Forget.
---

# Keep a generative-LLM baseline and enable decision models per evaluated point

## Decision

On 2026-11-08 the owner directed work to proceed on the Memory Records plan v2.0, which adopts a selective hybrid, and fixed its evaluation values. The [Memory Records design](../design/memory-records.md) defines the paths and the evaluation contract. The owner accepted this record on 2026-11-09.

Here a **decision model** is a model or API that returns a typed classification, a true-or-false judgment or a score for a bounded question, such as Jev or OpenAI Decisions, or a low-cost generative model asked for a typed verdict. It is not a decision record, not an ADR and not the `decision` memory kind.

1. **Baseline A is always available.** A generative LLM extracts and writes memory proposals, attribution, relation proposals and hard interpretations, returning kind and other labels in the same call where it can. Code then validates, grounds evidence, authorizes and commits. A must be optimized before it is compared, so that a weak multi-step prompt does not inflate a decision model's savings.
2. **Decision models only where evaluation passed.** Five candidate points may be evaluated: salience of automatic input, kind and attribution, relation to an existing memory, support of a claim by its source span, and recall reranking. A point is enabled only after it passes the fixed safety gates and adoption margins. Points that do not pass stay on A, and the product is complete without any decision model.
3. **Code keeps what models cannot decide.** Grants, approvals and the `auto`/`gate` policy, update and delete permission, expected-revision checks, idempotency, suppression, Forget and restore are deterministic code. A high-confidence output does not change that. Model output never sets authority.
4. **Uncertainty is not a verdict.** An unknown, out-of-scope, malformed, refused, timed-out or rate-limited result returns to A within one bounded budget, or is held with its reason. It never means "do not keep" or "approved". There are no unbounded retries and no loops between models.
5. **Explicit requests bypass selection.** An explicit remember, correction, approval or Forget never passes through the salience filter. Input whose original cannot be fetched again is never discarded by it.
6. **Disabling is safe.** Turning a point off routes it to A with the same records, IDs, APIs and authority, without data migration or history rollback. A wrong memory already committed is corrected through the normal authorized operations.

The research comparator B (decision models at every candidate point) is an evaluation configuration only, not a production system.

## Requirements and rationale

The plan seeks lower total cost or better quality where a decision model helps, without making the service depend on one. Published work supports the direction but does not measure Lore:

- A vendor guide (TypeSafe, "Don't Call It a Decision Model") recommends giving small judgments to models and composing known rules in code.
- The OpenAI Decisions guide recommends typed outputs, separating dependent questions and tuning thresholds on real data; its probabilities are not known to be calibrated for Lore.
- SLICE-Mem (preprint) reports salience-gated curation with a small classifier, but it also changed extraction and consolidation, and it reports lower answer accuracy than a baseline on LongMemEval-S. Its savings are not carried over as a target.
- JevAgentHarness (preprint) evaluates per-point thresholds and whole-agent outcomes for agent control, not long-term memory.
- LongMemEval evaluates extraction, cross-session reasoning, time, knowledge updates and abstention, but not Lore's authority, approval, compartments or Japanese cases.

| Alternative | Decision basis |
| --- | --- |
| A only, no decision models | Fewest dependencies and branches; stays the fallback and the comparison baseline |
| B, decision models at every point | Rejected for production: errors at the entry can compound, and serial calls, thresholds and monitoring multiply without measured benefit |
| C, decision models only at points that passed evaluation (chosen) | Replaces only judgments that measurably improve quality or total cost, and keeps hard interpretation with the generative LLM |

## Consequences

- **Security and authorization.** None of the decision points can grant, approve or delete. A decision model receives only records and source spans the connection may see, within bounded candidates, context and retries.
- **Data.** Each judgment records its typed result, any probability or score the provider returns, the model version, question version, threshold and outcome, but no persisted copy of source text. A cached judgment is reused only when source, record revision, question, policy, model and threshold versions all match.
- **Cost.** Total cost is measured, not the size of a decision model's output: context resent, candidate comparisons, caching, retries, returns to the LLM, embeddings, reads and post-processing. A cost-motivated point must cut total cost by at least 20%.
- **Operations.** Enabled points add monitoring of rejection rate, missed important input, return-to-LLM rate, type errors, refusals, failures, input drift and cost per point. Each point can be disabled on its own.
- **Forget and restore.** Unchanged; judgment logs hold no content that Forget would have to find.

## Confirmation

The evaluation contract in the [design](../design/memory-records.md#evaluation-contract) is fixed before any run: 240 labeled conversation or source groups, 3 trials per mode, a USD 50 external spend cap and the standard adoption margins. A point is enabled only when its comparison passes; the combination is measured again after single-point results. Scenarios DM-01 to DM-10 must pass, including disabling every point with no data change. No decision model has been contracted, implemented or measured as of 2026-11-08.

## Sources

- The owner's direction of 2026-11-08 to proceed with the Memory Records plan v2.0, and the owner's answers on evaluation size, spend cap and adoption margins the same day
- [Memory Records design](../design/memory-records.md), [ADR 0007](0007-store-memories-as-firestore-memory-records.md), [product requirements](../design/requirements.md)
- https://typesafe.ai/blog/dont-call-it-a-decision-model
- https://developers.openai.com/api/docs/guides/decisions
- https://arxiv.org/abs/2610.33015 (SLICE-Mem, preprint)
- https://arxiv.org/abs/2610.21412 (JevAgentHarness, preprint)
- https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html (LongMemEval, ICLR 2025)
