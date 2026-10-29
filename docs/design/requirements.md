# Syntoria Lore product requirements

This document is the product contract for Release 1: the functional requirements, end-to-end acceptance contracts and service targets that implementation and verification are measured against. Positioning and claim boundaries are in [product design](product.md); the user-facing product explanation is in [PRODUCT](../../PRODUCT.md). These requirements are targets, not evidence that the targets have been met. Dated local and hosted results are in the [evaluation records](../eval/), and delivery status is summarized in the [development plan](../DEVELOPMENT_PLAN.md). Requirement IDs are stable and are referenced by the [local acceptance record](../eval/local-acceptance.md).

## Product principles

1. **Outcome first**: the service exists to reduce re-explanation and mistakes, not to evaluate technologies. Architecture follows the finished product's requirements and operating load.
2. **AI-first, human-controlled**: routine extraction and organization are automatic; user confirmation, correction and Forget take precedence.
3. **Evidence before confidence**: source, speaker, authenticated principal, applicability and time outrank a model's self-assessment.
4. **History without confusion**: past and current facts, claims and decisions, and proposals and implementations stay distinct.
5. **Multi-agent and provider-neutral**: no dependency on a particular model, AI product or source system.
6. **Privacy by design**: only explicitly connected and authorized sources are captured, without unnecessary copies.
7. **Low management overhead**: no daily manual curation by people and no always-on infrastructure to operate.

## Functional requirements

**Capture (FR-CAP)**

- FR-CAP-01: Accept authenticated conversations, documents, tool results and work episodes as sources and observations.
- FR-CAP-02: Keep the original ID, revision, location, speaker, occurrence time, capture time, rights and scope.
- FR-CAP-03: Treat identical input, resends and retries idempotently without multiplying evidence.
- FR-CAP-04: Require explicit enablement and a sync range per integration, and allow it to be stopped.
- FR-CAP-05: Confirm explicit remembers and corrections synchronously; other capture may be processed asynchronously.

**Curation and consolidation (FR-CUR)**

- FR-CUR-01: Extract useful facts, decisions, preferences, hypotheses, experiences and procedures.
- FR-CUR-02: Detect subject identity and aliases, and memory duplication, refinement, replacement and contradiction.
- FR-CUR-03: Maintain attribution, applicability, valid time and recorded time.
- FR-CUR-04: Choose automatic commit, candidate retention, human review or rejection based on evidence and policy.
- FR-CUR-05: Never count repetitions of a self-generated summary as independent evidence.
- FR-CUR-06: Never reverse a current explicit decision without authorization when evidence is reprocessed.

**Recall and context (FR-REC)**

- FR-REC-01: Support precise, contextual, historical, exploratory and changes intents.
- FR-REC-02: Combine structured, lexical and semantic retrieval, and expand the relations that are needed.
- FR-REC-03: Build a Context Pack within a token budget, with priority, evidence, freshness and uncertainty.
- FR-REC-04: Guarantee visibility of the latest changes from the source of truth, so index lag never hides an explicit remember.
- FR-REC-05: Report missing information, contradictions and possible staleness; never generate fictitious memories.
- FR-REC-06: Enforce scope and source rights from the candidate-selection stage onward.

**Revision, time and forgetting (FR-LIFE)**

- FR-LIFE-01: Distinguish supersede (valid at the time), retract (withdrawn as wrong) and forget (use stopped and content deleted).
- FR-LIFE-02: Commit changes consistently as change sets and revisions; never silently overwrite a conflicting update.
- FR-LIFE-03: Keep immutable audit metadata and the necessary content history, while erasing content that is forgotten.
- FR-LIFE-04: Provide a change cursor that delivers updates, replacements and deletions without gaps.
- FR-LIFE-05: Re-evaluate memories on source changes, expiry, user corrections and usage results.
- FR-LIFE-06: Separate immediate suppression from asynchronous physical deletion of forgotten content, and prevent reappearance after a backup restore.

**Security, operations and portability (FR-GOV)**

- FR-GOV-01: Authorize delegated OAuth access per user, scope and operation.
- FR-GOV-02: Provide read-only and write-capable MCP entry points with separate authorization policies.
- FR-GOV-03: Instrument and audit capture, curation, recall and forget without logging content or secrets.
- FR-GOV-04: Re-evaluate or block rights-dependent derived memories when source access is stopped or deleted.
- FR-GOV-05: Export memories, relations, evidence and history in a portable format.
- FR-GOV-06: Allow LLM and embedding models to be switched, and record model versions.

## Acceptance contracts

- **AC-01 Decision provenance:** An AI recommendation is never stored or returned as an user decision unless it was approved, and every approval records whether the person approved it at Gate or the account's `auto` approval policy approved it ([ADR 0004](../adr/0004-approve-protected-changes-by-policy.md)).
- **AC-02 Temporal correctness:** Renames and policy changes are distinguished from three viewpoints: current, past and what was known at the time.
- **AC-03 Consolidation:** Resending the same information does not multiply records, and independent evidence from another source is not lost.
- **AC-04 Multi-client:** An explicit change by client A is correctly visible to client B's recall and change feed.
- **AC-05 Source ACL:** Content whose scope or source rights have been revoked is not returned.
- **AC-06 Concurrent writes:** Conflicting revisions are detected and no update is lost.
- **AC-07 Forget:** Forgotten content is immediately unsearchable, eventually deleted from the source of truth and derived data, and does not reappear after a restore.
- **AC-08 Poisoning:** Instructions embedded in sources or search results cannot change policy or reach another scope.
- **AC-09 Reprocessing:** Reprocessing an old episode does not break the current explicit decision.
- **AC-10 Limited context:** A Context Pack within the budget keeps its evidence and uncertainty.
- **AC-11 Failure recovery:** Reprocessing after LLM, queue or index failures leaves the committed state consistent.
- **AC-12 Portability:** An export imported into another environment reproduces the same memories, evidence and history.
- **AC-13 Outcome:** Comparing no memory, a simple summary and Lore on representative tasks measures success rate and cost, and explains the service's usefulness.

## Service targets

These are acceptance targets for the standard workload, to be measured with the environment, sample size and method recorded. They are not observed values or an SLA.

| Metric | Target |
| --- | --- |
| Recall p95, ordinary (without complex LLM reconstruction) | ≤ 1.5 s |
| Recall p95, complex | ≤ 5 s |
| Explicit remember commit p95 | ≤ 2 s |
| Asynchronous capture commit | 95% within 5 minutes |
| Change feed p95 | ≤ 1 s |
| Availability | 99.9% target, distinct from provider SLAs |
| Recall@5 | ≥ 95% on the fixed evaluation set |
| Task QA accuracy | ≥ 90% on the fixed evaluation set |
| Unknown and abstention correctness | ≥ 95% |
| Outdated information used as current | < 1% |
| Evidence attribution completeness | 100% for evidence-backed memories |
| Cross-scope leaks and forgotten-content resurrection | 0 in security regression tests |

| Planning workload (not observed usage) | Standard | Stress |
| --- | ---: | ---: |
| AI clients | 5 | 20 |
| Capture events per day | 100 | 1,000 |
| Recalls per day | 200 | 2,000 |
| Active memories | 100,000 | 1,000,000 |
| Evidence references | 500,000 | 5,000,000 |
| Historical retention | 5+ years | 5+ years |

The provisional monthly cost target for the standard workload is $20–$50, counting only external AI usage billed directly to this service. Neon compute, storage and backup, Cloud Run, Cloud Tasks, Cloud Scheduler, GCP–Neon traffic, embedding, curator inference and monitoring are measured separately. When over budget, batching, model choice and avoided recomputation come first; evidence and Forget guarantees are never relaxed to meet a cost target.

Quality metrics state their denominator and pass condition. Recall@5 compares each question with its expected memory set; the false-current rate counts outdated information presented as current in time-dependent questions. Zero-count requirements mean every case passes; they are not statistical safety guarantees.

## Release policy

Release 1 is service-complete: every requirement above at operational quality. Delivery may be staged by dependency order, but the product is not cut down to fit an intermediate milestone. The platform choice—Cloud Run, Cloud Tasks, Cloud Scheduler and Neon PostgreSQL with pgvector and pg_trgm—does not narrow these requirements, and choosing it does not demonstrate the targets: provider SLAs, region availability, cost and cold start are verified in the real environment.

The figures here are acceptance targets. When measurement exposes a constraint or trade-off, the requirement, the benchmark result and the reason for change are reviewed and this document is updated. Technology selection does not become an open-ended proof of concept.
