# Memory Records design

This document turns [ADR 0007](../adr/0007-store-memories-as-firestore-memory-records.md) and [ADR 0008](../adr/0008-keep-a-generative-baseline-and-enable-decision-models-per-point.md) into contracts. It is for the people who implement and review the move to Memory Records in Firestore and the evaluation of decision models. It is step 1 of the owner's Memory Records plan v2.0 (contracts and evaluation conditions) and lists the step 2 units. It was produced on 2026-11-08 by the dev-skills design loop. An independent review found that a Forget could be lost across a restore, and the design was revised. The caller then found gaps in the requirement mapping and the evaluation contract, and a second revision closed them. A second independent review approved the result the same day, with one minor finding about duplicated evaluation text that this document resolves by stating the evaluation once. The owner fixed the [evaluation values](#decisions) the same day and accepted both ADRs on 2026-11-09.

These are logical contracts and an implementation plan written on 2026-11-08. The PostgreSQL service described by the then-current [data model](../technical/data-model.md) was removed on 2026-11-09. The current Firestore implementation and deployed service status are described in the [architecture](../../ARCHITECTURE.md) and the [2026-11-09 release record](../eval/memory-records-firestore-release-20261109.md). This page's S2 verification summary below describes the package-only state at that time; it does not describe the current service or hosted status of changes made after that record.

## Outcome

Several AIs create, use and correct the same memories without Lore copying the originals, and never confuse a decision with a proposal, a change with a mistake, what applied then with what Lore knew then, or what a connection may see. A generative LLM writes memories; a decision model helps only where it was shown to help; code decides what is committed.

## Terms

| Term | Meaning |
| --- | --- |
| Memory Record | One reusable memory: its current state is one document, each revision another |
| Revision | An immutable state of a record with its own number, change kind, reason, writer, approval and source references |
| Source reference | Provider, account or tenant, resource ID, URI, optional title, locator and available version of an original kept in its own service, with speaker, times, rights and lineage |
| Baseline A | The path where a generative LLM proposes memories and labels and code validates and commits; always available |
| Decision model | A model or API that returns a typed label, a true-or-false judgment or a score for one bounded question; not a decision record or ADR |
| Decision point | A place in capture or recall where a decision model may replace a bounded judgment of A |
| B | Evaluation configuration with decision models at every candidate point; not a production system |
| C | The adopted configuration: decision models only at points that passed evaluation |

## Memory Record

### Unit and kinds

One record holds one reusable content: not a whole meeting or project, and not split so far that it loses its reason or condition. A decision keeps what was decided, about what and why; an experience keeps the condition, action and outcome.

| Kind | Content | Kind-specific details |
| --- | --- | --- |
| `decision` | A decision or adopted policy | Question, choice, reason, decider, decision time; optionally alternatives and when to reconsider |
| `fact` | Reported or observed information | Subject, claim, speaker or observer, observation time |
| `preference` | A lasting preference | Whose preference, where it applies |
| `hypothesis` | An unverified guess | Hypothesis, assumptions, how to verify |
| `experience` | A lesson | Condition, action, outcome, where it can be reused |
| `procedure` | How to do something | Purpose, prerequisites, steps, cautions |

`fact` does not mean verified truth. The user's own statement, a third party's report, a direct observation and an AI inference stay distinct.

### Common fields

| Group | Contract |
| --- | --- |
| Identity | Stable record ID, tenant and scope, schema version |
| Content | Kind, title, statement, kind-specific details as structured data |
| Subject and conditions | Stable subject IDs, time-bounded aliases, applicability and assumptions |
| Source references | As defined in [Terms](#terms); never the original document |
| Attribution | The original speaker or decider, separate from the AI or connection that wrote it to Lore |
| Approval provenance | User authority only from an approved protected change, recorded as `person` (approved at Gate) or `policy` (the binding's `auto` policy), as in [ADR 0004](../adr/0004-approve-protected-changes-by-policy.md) |
| Lifecycle | `candidate`, `active`, `superseded`, `retracted`; `contested` and needs-recheck are independent flags |
| Suppression | Forget is an overriding suppression over every lifecycle value |
| Time | Valid interval (when the content applies) separate from recorded time (when Lore learned this revision) |
| Relations | Supersedes and superseded-by, related record IDs; supports, contradicts and depends-on where needed |
| Revision | Monotonic revision number, change kind, reason, writer, approval |
| Disclosure | The compartment label of [ADR 0006](../adr/0006-enforce-disclosure-with-compartments-and-connection-allowances.md), joined from everything the record derives from |

The schema separates required, optional and system-set fields. Unknown times and speakers stay unknown instead of being filled in. Model output never sets IDs, authority, approval, labels or recorded time.

**Forgotten.** The current model has a `forgotten` lifecycle value; here Forget is a suppression that applies whatever the lifecycle is, so a forgotten candidate and a forgotten active record are treated alike. The observable rule is unchanged: suppressed content is never returned by a current or historical read, and prior lifecycle metadata is kept only without the forgotten content.

MCP clients may attach up to ten declared HTTPS source references with a provider and optional title, locator, version and sensitivity. Lore stores their metadata on the revision and does not fetch the URI. `confidential` is a descriptive rights marker, not an access grant or a substitute for compartment allowances and source-revocation checks.

### Operations

| Operation | Meaning | Storage effect |
| --- | --- | --- |
| Create | A new memory | New record ID |
| Refine | The same memory, sharper or corrected in detail | New revision of the same ID |
| Corroborate | New independent evidence for the same content | New revision with the added source reference |
| Supersede | What applied then has changed | New record; the old record's valid interval closes at the replacement's start, with the supersede relation |
| Retract | The memory was wrong from the start | Retracted with its reason; not a closed valid interval |
| Contest | An unresolved disagreement | Both claims kept and flagged |
| Forget | Stop using and delete | Immediate suppression, then purge of revisions and derived data |

A change is never an overwrite of a mistake, and a mistake is never recorded as a change. A future-effective decision, or two decisions with different conditions, are not collapsed by update time. AI attribution never confers user authority; a non-user writer cannot supersede or retract, or refine a user-attributed record.

## Persistence and consistency

- **Commit.** One Firestore transaction reads the current authorization epochs, suppression state, the target's `expected_revision` and the idempotency record (principal, scope, key and request digest) before writing. It then writes the revisions, current-record pointers, change-log entry with its sequence, and durable job intent together, or nothing.
- **Conflicts.** A stale expected revision returns a conflict with no effect; the AI re-reads and reconsiders. A transaction retry never applies an old decision to a newer state. Conflicting decisions for the same question and applicability are also rejected by a check over the shared subject, not only by revision checks on one record.
- **Idempotency.** The same key and digest replays the committed response, subject to current disclosure checks; a different digest conflicts.
- **Change feed.** A per-scope sequence is allocated in the same transaction as the change. Cursors bind scope, principal, authorization epoch and the allowance digest, and require an explicit resync on mismatch. A page advances only over a committed, ordered range and includes content-free deletion markers. Notifications are only a prompt to fetch.
- **Outside the transaction.** Model calls, embedding generation and source fetches never run inside a transaction function, which Firestore can run more than once.
- **Size.** Records, source lists, relations and search terms have application limits under the 1 MiB document limit. A change too large for one transaction is rejected as a whole, never split silently; over-limit content is split explicitly.
- **Derived data.** Index and embedding entries carry the record revision and model ID and dimension. A late or stale job never replaces a newer entry. Firestore triggers, if used, are treated as duplicated and reordered.

## Access boundary

Firestore server access bypasses Security Rules, so application enforcement is the trusted boundary:

- Only one shared repository boundary holds the Firestore client and receives a verified actor capability. REST, MCP and worker adapters cannot construct authority from request fields, and domain code cannot use a raw client.
- Grants, scope epochs, the connection's allowance, source rights and suppression are checked at candidate selection and again before a response or commit. Unknown or unavailable authorization denies.
- Labels must be within the allowance; derived records join all input labels; a General write from a confidential connection is held, as today. Relaxing a label or widening an allowance follows the approval policy.
- Direct reads, recall, relations, history, evidence, idempotent replay, change feed, confirmations and exports use the same boundary.
- Source text and model output are untrusted data and never change policy, rights, approvals or other records.

Losing the database backstop is an explicit migration risk; see [ADR 0007](../adr/0007-store-memories-as-firestore-memory-records.md#consequences).

## Capture and decision points

Baseline A: authorize the input and check whether it can be fetched again; a versioned generative LLM proposes memories with kind, attribution and relation proposals, in one call where possible; candidate records are searched; code validates evidence against the cited source span, applies the existing review and automatic-commit policy, and commits through the shared path. A connected AI's ready-made proposal is not regenerated, and it does not count as verified evidence or as the person's approval.

Explicit remember, correction, approval and Forget never pass through salience selection. Background capture still requires consent and a sync range.

| Point | Question | Inputs | Outputs | Error impact | Fallback | Can a model replace code here? |
| --- | --- | --- | --- | --- | --- | --- |
| Salience | Is this automatic input worth extracting? | Source metadata, retrievability, the disclosable span | keep, skip, unknown | Important input lost | Unknown or out of scope goes to A extraction; input that cannot be fetched again is never skipped | No; a skip only saves extraction cost for re-fetchable input |
| Kind and attribution | Which kind, and who said it? | Grounded spans | Typed label or unknown | Misattribution, a proposal read as a decision | A's same-call labels; unknown is held | No; authority stays derived by code |
| Relation | Same subject, same question, same applicability, new evidence, compatible? | Candidate plus existing record revision, subject and valid time | Relation label or unknown | Destructive merge or replacement | Unknown never merges; the case is held or A decides | No; ID, time and revision comparisons are code, and no ADD/UPDATE/DELETE verdict is executed directly |
| Evidence support | Does the cited span support the claim? | Claim plus source span with needed context | supported, unsupported, unknown | Unsupported claim committed | A's validation; unknown is held | No; it is never proof that the source was checked or that the person approved |
| Recall rerank | How relevant is each candidate? | Authorized, lifecycle- and time-filtered candidates plus the query | Order or unknown | Relevant memory pushed down | The baseline order | No; it only reorders, never removes on a low score |

Not decision points: combined conclusions and prose stay with the generative LLM; grants, approvals, update and delete permission, concurrency, suppression and restore stay with code and the approval path; ID and clear attribute searches skip reranking.

Limits for every point: only records and source spans the connection may see; shortening never drops negation, quotation, speaker or date; bounded candidates, context length and retries, fixed per point before it is enabled. Independent questions about one input may be batched; a question that needs another's answer runs after it.

Uncertainty and failure: unknown, out-of-scope, malformed, refused, timed-out or rate-limited results return to A within one bounded budget, otherwise the work is held with its reason. They never mean skip or approved. Each judgment records its typed result, any provider probability or score, model, question and threshold versions and the outcome, without a persisted copy of source text; no confidence is invented for a model that returns none. A cached judgment is reused only when source, revision, question, policy, model and threshold versions all match. Agreement between two models is not proof. Changing a model or threshold never rewrites committed records; reprocessing goes through the normal checks, and a bad committed record is corrected by an authorized revision.

## Recall

Recall combines IDs, subjects and aliases, normalized terms, vector search, the relations that are needed and an overlay of recently committed records. It filters by current authorization, lifecycle, suppression, valid time and known time before returning, and reads committed records for direct ID access and changes. When the embedding of a new revision is missing, recall says so and the overlay still returns explicit remembers; an index result is never the authority. A Context Pack fits the caller's budget with provenance, approval, uncertainty, freshness and index-lag notes, and an empty result never means that nothing was ever said.

Firestore Standard has no general full-text search. Term matching is not presented as full-text search. If acceptance fails for exact names, aliases, keywords, Japanese or Recall@5, a search decision is made for those failures, with Enterprise text search as the first candidate. No external search service is implied.

## Forget and restore

1. Forget commits the local suppression and a content-free deletion intent, then appends the intent to the independent deletion ledger.
2. The response says that use has stopped only after both are durable. A ledger timeout or ambiguous delivery returns pending or unconfirmed, while the local suppression still applies to the live database. A retry uses the same request identity and verifies inclusion instead of appending a second entry. The current service already reports `ledger_durable` on a Forget; this contract makes the success claim depend on it.
3. Every read, write, export and derived job checks suppression. Purge removes revisions, embeddings, caches and queued payloads, and verifies that no subcollection documents remain; minimal content-free audit and deletion identity stay.
4. A restored database stays closed while the ledger cannot be read and validated, and until every durable ledger entry is applied to suppression and purge intent, repeating if the head moves. A matching old checkpoint alone never opens it.
5. Source changes, deletions and rights revocations hold or re-evaluate dependent records; one remaining source does not widen disclosure. A fetch failure is distinct from an explicit revocation.

Backups may keep deleted bytes until they expire; API use stops immediately.

## Requirement mapping

Every functional requirement and acceptance contract in the [product requirements](requirements.md) is kept or changed as follows. The requirements document changes when the first Firestore service release is designed.

| Requirement | Status | New obligation or reason |
| --- | --- | --- |
| FR-CAP-01 | Changed | Observation bodies are accepted and processed transiently; only source metadata and curated records persist |
| FR-CAP-02 | Changed | Source identity, locator, revision, speaker, occurrence and capture times, rights, scope and lineage persist; bodies do not |
| FR-CAP-03 | Kept | Idempotency keys and source identity still prevent multiplied records and evidence |
| FR-CAP-04 | Kept | Background capture still needs consent and a sync range, and can be stopped |
| FR-CAP-05 | Kept | Explicit remember and correction commit synchronously through the transaction |
| FR-CUR-01 | Kept | The six kinds remain; baseline A extracts them |
| FR-CUR-02 | Kept | Subjects, aliases and relation judgments remain, with decision models only at evaluated points |
| FR-CUR-03 | Kept | Attribution, applicability, valid time and recorded time are record fields |
| FR-CUR-04 | Kept | The existing commit, candidate, review and rejection policy applies after validation |
| FR-CUR-05 | Kept | Lineage keeps repeated summaries from counting as independent evidence |
| FR-CUR-06 | Kept | Reprocessing goes through the normal checks and cannot reverse a current explicit decision |
| FR-REC-01 | Kept | All five intents remain; term matching is bounded and is not full-text search |
| FR-REC-02 | Changed | Structured, bounded term and vector candidates with the direct references that are needed; graph expansion is no longer the center of retrieval |
| FR-REC-03 | Kept | Context Packs keep budget, priority, evidence, authority, lifecycle, writer attribution, freshness and uncertainty; recall includes proposals by default and supports an explicit opt-out |
| FR-REC-04 | Kept | Committed records, including candidates, and the recent-change overlay keep new remembers visible during index lag |
| FR-REC-05 | Kept | Missing information, contradictions and staleness are reported; nothing is invented |
| FR-REC-06 | Kept | The repository boundary checks rights from candidate selection onward |
| FR-LIFE-01 | Kept | Supersede, retract and Forget stay distinct operations |
| FR-LIFE-02 | Kept | Transactions with expected revisions replace change-set commits; conflicts are never overwritten |
| FR-LIFE-03 | Kept | Revisions and content-free audit remain; forgotten content is erased |
| FR-LIFE-04 | Kept | The per-scope sequence and cursor deliver updates, replacements and deletions without gaps |
| FR-LIFE-05 | Kept | Source changes, expiry, corrections and use results trigger re-evaluation of the affected records |
| FR-LIFE-06 | Kept | Suppression first, purge later, and restore closed until the ledger is applied |
| FR-GOV-01 | Kept | Gate tokens, bindings and grants are unchanged |
| FR-GOV-02 | Kept | One MCP entry point with capability-based operations is unchanged |
| FR-GOV-03 | Kept | Logs and metrics carry IDs, status and latency, never content or secrets |
| FR-GOV-04 | Kept | Revoked or deleted sources hold or block dependent records |
| FR-GOV-05 | Changed | Exports carry records, relations, history and source references with permitted excerpts only, never original documents |
| FR-GOV-06 | Changed | Generative, embedding and per-point decision models can be switched, with model, question, policy and threshold versions recorded per point |
| AC-01 | Kept | Approval provenance keeps `person` and `policy` distinct; a proposal is never returned as a decision |
| AC-02 | Kept | Valid time, recorded time and aliases give the current, past and known-then views |
| AC-03 | Kept | Idempotency and lineage stop duplicates while keeping independent sources |
| AC-04 | Kept | One commit path and the change feed serve every client |
| AC-05 | Kept | Rights are checked at selection and before return |
| AC-06 | Kept | Expected revisions and the subject check detect every conflict |
| AC-07 | Kept | Suppression, purge and the ledger-gated restore keep forgotten content out |
| AC-08 | Kept | Source text and model output cannot change policy or reach another scope |
| AC-09 | Kept | Reprocessing cannot override the current explicit decision |
| AC-10 | Kept | Context Packs within budget keep evidence and uncertainty |
| AC-11 | Kept | Retries after LLM, task or index failures leave committed state consistent |
| AC-12 | Changed | Import reproduces records, history, source identity, revision and location and permitted excerpts; it preserves references and provenance, not access to or copies of an unavailable original |
| AC-13 | Changed | Compare no memory, a summary and Lore, then A, B and C and an optimized low-cost A, reporting quality, total cost, latency and complexity with versioned per-point settings |

Outside the numbered requirements:

- **Release policy (changed).** Neon PostgreSQL with pgvector and pg_trgm is replaced by Firestore and the repository boundary; Cloud Run, Cloud Tasks and Cloud Scheduler remain.
- **Cost target (changed).** Neon compute, storage, backup and cross-provider traffic are replaced in the separately measured costs by Firestore reads, writes, storage and indexes and actual network costs. The USD 20–50 external AI target for the standard workload is unchanged. Regional prices and hosted performance are measured on deployment.
- **Service targets and planning workload (kept).** They are measured on Firestore in a real environment; the planning workload is not observed usage.

## Evaluation contract

The comparison isolates the effect of decision models inside Memory Records; it is separate from the acceptance of the storage move, which compares a simple summary, the new records and the existing Lore.

**Fixed across A, B and C:** input and input order, record schema, storage, embeddings, candidate search, source access, the final answering model and the evaluation conditions. A also runs with a common generative model and, separately, as an optimized low-cost A.

**Order:** replace one point at a time, then measure the combination of the points that passed. Capture comparisons answer questions from the memories each mode produced; recall comparisons use one frozen record snapshot.

**Dataset:** 240 conversation or source groups, stratified across [MR-01 to MR-18](#acceptance-scenarios) and [DM-01 to DM-10](#decision-model-scenarios), with at least 20 cases in each critical safety category and overlaps declared. Cases cover extraction, cross-session reasoning, temporal reasoning, knowledge updates and abstention as in LongMemEval, plus Japanese (ellipsis, negation, quotation, short corrections), several AIs, the person's decisions versus AI proposals, rights and Forget. Tuning and final sets are split by conversation or source group, with no near-duplicate leakage.

**Labels:** from the person's explicit statements, cited source locations and adopted operations, with independent adjudication; never from a model majority vote. Only data permitted for evaluation is used, and the evaluation never becomes a reason to copy originals into Lore.

**Trials and budget:** 3 matched trials per mode. The total external API spend (generative models, decision models and embeddings) is capped at USD 50; when it is reached, evaluation stops and every unfinished point is inconclusive and stays on A.

| Axis | Metric (numerator / denominator) | Pass condition |
| --- | --- | --- |
| Memory quality | Important items adopted / labeled important items; correct adoptions / all adoptions; correctly attributed and grounded outputs / assessed outputs; wrong merges, replacements and losses per labeled opportunity | Not worse than A beyond the quality margin |
| Use quality | Recall@5 = expected memories in the top five / expected memories; Task QA = correct answers / labeled questions; abstention = correct abstentions / unanswerable questions; false-current = outdated facts used as current / time-dependent questions; the person's corrections | Recall@5 ≥ 95%, Task QA ≥ 90%, abstention ≥ 95%, false-current < 1%, as in the requirements |
| Decision quality | Confusion matrix per class; skip rate and return-to-LLM rate / point calls; high-confidence errors / high-confidence calls; calibration where probabilities exist | Reported per point and category |
| Safety | Rights leaks, approval mix-ups, lost updates, resurrection after Forget in the defined tests | Zero failures |
| Cost | All model, retry, database, index and post-processing dollars and tokens; dollars per correctly completed operation; total dollars | Cost-motivated points: at least 20% lower total cost |
| Latency | p50 and p95 for save and recall, external calls in series, including fallback and held paths | Existing targets (ordinary recall ≤ 1.5 s, complex ≤ 5 s, explicit commit ≤ 2 s, feed ≤ 1 s) and p95 ≤ 1.2 × A |
| Complexity | Added dependencies, serial stages, branches, thresholds and questions, maintenance and verification burden | Each addition justified by a measured benefit |

The quality margin: general quality may be at most 2 percentage points below A, judged with a paired 95% interval; an interval too wide to decide is inconclusive.

**Cost model for a replaced judgment.** With `C_L` the average cost of the A judgment it replaces, `C_D` the decision model's cost, `f` the fraction returned to the LLM, `C_F` the LLM cost on those returns and `C_extra` any added search, management, post-processing or retry cost, all in USD per attempted operation on a matched workload including failures:

```text
C_D + f × C_F + C_extra ≤ 0.8 × C_L
```

`C_F` is measured, not assumed equal to `C_L`, because hard inputs return more often. For a salience gate that skips a fraction `d` of extractions, the approximation is `C_gate + C_extra < d × C_extract`, with per-input costs aggregated in the measurement. Prices are recorded with the measurement date, contract and tier; raw token counts across providers are not compared as prices. Points added to improve quality may cost more, with the cost reported separately from the quality gain. When the absolute savings at personal-use volume are small, the point is not enabled.

**Outcomes per point:**

- **Adopt** only when every safety case passes, the absolute targets and the margins hold with sufficient evidence, and the added complexity is justified.
- **Reject** on an observed failure or insufficient savings.
- **Inconclusive** on insufficient data, an interval too wide or an exhausted budget; the point stays on A.
- A combination that regresses is rejected even when each point passed alone.
- **Disable** a running point on a quality violation, more missed important input, high-confidence errors, budget breach or a failing dependency, without data migration or history rollback (DM-10).

Margins, case counts and the budget are fixed before any run and are not relaxed after seeing results. Results are reported by category and input volume with paired uncertainty. Public benchmark numbers alone never qualify Lore.

## Acceptance scenarios

| ID | Scenario | Pass condition |
| --- | --- | --- |
| MR-01 | AI A remembers, AI B uses | B reads the same committed revision, state and sources |
| MR-02 | An AI proposes A, the person adopts B | A is never returned as the person's decision; B returns with its approval kind |
| MR-03 | B changes to C | C is current; B and the reason for the change remain |
| MR-04 | An earlier memory was wrong from the start | Retraction is distinguished from a change of policy |
| MR-05 | A decision learned later, or effective in the future | Valid time and recorded time are not confused |
| MR-06 | Resent originals, summaries captured again | No extra records or extra independent evidence |
| MR-07 | Several AIs update or decide at once | No inconsistency, and no update is silently lost |
| MR-08 | Renames and paraphrases | The record is found by subject ID, alias and vector search |
| MR-09 | Names and IDs versus natural-language queries | Each query category meets its acceptance target |
| MR-10 | Index delay, failure and reordering | Old index entries are never used; direct reads and status work |
| MR-11 | Original changed, deleted or access revoked | State changes apply; unreturnable and unchecked memories are marked |
| MR-12 | Connections with different allowances | Nothing outside the allowance leaks through content, history, changes, indexes or exports |
| MR-13 | PDF, image, video and mail references | The original is reachable through its authorized path, or Lore says it is not supported |
| MR-14 | Malicious instructions in an original | They change no policy, rights, approval or other memory |
| MR-15 | Forget and backup restore | Use stops at once, derived data is deleted, nothing returns after restore |
| MR-16 | Migration and export or import | Records, sources, time, approval, rights, history and deletion state keep their meaning |
| MR-17 | Nothing stored, or search too weak | No invented memory; unknown is distinguished from a search shortfall |
| MR-18 | Long use without manual curation | Corrections, duplicates, stale use and held items are recorded so degradation is detected |

For Google Drive, Notion and Gmail, fetching, locating, versions, rights checks and automatic re-evaluation are recorded separately for each; not every service supports every medium.

### Decision model scenarios

| ID | Scenario | Pass condition |
| --- | --- | --- |
| DM-01 | Explicit remember, correction, approval and Forget | Never skipped by salience; they reach the common authorization and approval path |
| DM-02 | Short, negated, quoted or elliptical Japanese input with important content | Misses and misattributions are measured apart from averages and meet the critical-category gate |
| DM-03 | Same words, different subject, period or condition | No wrong merge or replacement; uncertain cases are not merged |
| DM-04 | High-confidence errors and input drift | Detected and counted; a threshold breach disables that point |
| DM-05 | Timeout, refusal, malformed output, rate limit | Fallback or hold within budget; never read as skip or approval |
| DM-06 | An original that cannot be fetched again | Not lost at the salience step; normal extraction without copying the original |
| DM-07 | Old judgments after model or threshold changes | A judgment whose source, revision, question or policy version differs is never reused for a commit |
| DM-08 | Old and new recall judgments disagree | Rights, time and state hold; reranking never removes an important candidate |
| DM-09 | Frequent returns to the LLM or multi-stage judgments | Total cost and p95 are measured; over budget stops or holds without looping |
| DM-10 | Disable decision models | Back to A with the same records, APIs and rights, no migration or history rollback |

## Verification

Each contract has a discriminating witness. Pure value-model checks run as unit tests; persistence and access witnesses run against the Firestore emulator; IAM, managed transactions, restore, latency, cost and recall or extraction quality need a real project and the evaluation above. The existing PostgreSQL cases in `tests/core.postgres.test.ts` show the intended behavior but say nothing about Firestore.

| Contract | Witness |
| --- | --- |
| Record | An AI proposal, an approved decision, a future-effective replacement, a mistaken record and a renamed subject: the proposal stays a proposal, the decision keeps its approval kind, the replacement applies only from its valid start, a known-at read excludes later revisions, the mistake is retracted rather than superseded, aliases resolve; corroboration keeps independent sources without counting a repeated summary twice |
| Commit | Two clients hold the same revision and one transaction fails after staging a later write: one update commits, the other conflicts, nothing partial commits; a retry with the same key yields one change; cursor traversal delivers every committed change once, deletions included |
| Access | Two tenants and two connections with different compartments, and a source revoked after candidate selection: direct reads, recall, relations, history, replay, feed and export reveal nothing restricted, revocation before return denies, source text cannot change approval policy |
| Capture | Explicit corrections, an injected source, a repeated summary, an old episode and a malformed decision-model response, with each point on and off: explicit requests reach authorization, the summary adds no independent evidence, the old episode cannot reverse the current decision, errors stay unknown and bounded, disabling changes no stored identity or history |
| Recall | A remember committed while indexing is down and an older index job that finishes last: direct read and feed include it, recall returns it and reports index insufficiency, the stale job does not replace the current entry, the pack stays within budget with evidence and uncertainty |
| Forget | A backup from before a Forget and an unavailable ledger: no use-stopped success for local-only suppression, restore stays closed, retry records the deletion and it is applied before reopening; when the ledger append was durable but the response was lost, the ledger entry alone suppresses the record after restore |

## Implementation units

Ordered by dependency. This table records the original step 2 plan, whose first units were built beside the PostgreSQL implementation that the owner later removed (see [Decisions](#decisions)). Its unit boundaries and prerequisites describe that plan, not a current inventory; see the [architecture](../../ARCHITECTURE.md) for current component ownership and remaining work.

| Unit | Content | Depends on | Prerequisites |
| --- | --- | --- | --- |
| S1 Contracts | This design and ADRs 0007 and 0008 | — | Documentation checks |
| S2-1 Value model | A new isolated package with Memory Record types, validation of the current shape, and deterministic lifecycle, approval and time selectors: a proposal is never a decision, supersede and retract stay distinct and need the person as writer with an approved protected change, valid-at and known-at are selected independently. This planned unit adds no Firestore client, provider API, REST or MCP wiring, migration or deployed state | S1 | Build, typecheck, lint, format and unit tests; the PostgreSQL integration suite was not affected and could not run without `TEST_ADMIN_URL` and `TEST_APP_URL` |
| S2-2a Firestore repository: commits and reads | The repository boundary with transactions, idempotency, per-scope sequence and signed cursors, conflicting-decision checks and a lint rule against direct client use. Revisions record the requesting connection and Gate client next to the approval, because S2-1 applies an approved protected change as the person and has no field for which AI asked. The Firestore SDK is added here | S2-1 | Java 25 and the Firestore emulator; a real project later for IAM, managed transactions and restore |
| S2-2b Forget, restore and rights | Forget with suppression, a content-free deletion intent and an independent deletion-ledger port; purge; the restore checkpoint; source-rights revocation on every read surface; writes authorized against the stored record (label, identity, and for connections only their own unapproved candidates); relaxation only through an approved protected change | S2-2a | At the time of the plan, a production ledger adapter and application or worker wiring remained later work |
| S2-3a Baseline A capture | Explicit remember and background capture through an extractor port and an authorized source-fetcher port (test doubles), with labels and attribution taken from trusted source metadata, durable capture jobs, held results for failures and malformed output, consent rechecked on retry, and no persisted source text | S2-2b | Real models and source providers later; automatic activation of facts is not implemented, so AI proposals stay held candidates |
| S2-3b Derived recall | Revision-fenced term and embedding entries per revision, recall from ID, subject, alias, term and vector candidates plus an unindexed-change overlay, every result rechecked against the committed record, and a byte-bounded Context Pack with insufficiency notes | S2-3a | Real embeddings and search-quality measurements later; candidate retrieval scans at most 1,000 index entries and computes vector similarity in memory, which is not Firestore vector search |

S2-1 to S2-3b were implemented and verified locally on 2026-11-08 and 2026-11-09 ([local record](../eval/memory-records-s2-local-20261109.md)). That record captures the package-only state before service wiring and deployment: at that point these units were not wired into REST, MCP or the worker, and nothing was deployed. Since then, `apps/api` with Remote MCP over `packages/memory-records` has been deployed; see the [current architecture](../../ARCHITECTURE.md) and [release record](../eval/memory-records-firestore-release-20261109.md). The release checked readiness and the authentication boundary only. Proposal recall and structured source references in the current repository have not been verified against the hosted service.

The original plan listed database provisioning and access, REST and MCP service wiring, a worker on Memory Records, a production deletion-ledger adapter, source re-fetch contracts, decision-model evaluation, enabling C and operational quality as later steps. Remote MCP service wiring and the initial deployment have since been completed; the REST adapter and other current remaining implementation work are listed in the [architecture](../../ARCHITECTURE.md). The initial release did not verify authenticated MCP operations, remember, recall, correction or Forget against the hosted service, and this page does not establish hosted acceptance or recall quality.

## Decisions

The owner decided on 2026-11-08:

- Proceed with the Memory Records plan v2.0, covering step 1 and the start of step 2.
- Evaluate with 240 labeled conversation or source groups and 3 trials per mode.
- Cap the evaluation's external API spend at USD 50.
- Use the standard adoption margins: at most 2 percentage points below A on a paired 95% interval, at least 20% lower total cost for cost-motivated points, latency within the existing targets and at most 1.2 × A's p95. Safety-critical cases need zero failures.

The owner accepted ADRs 0007 and 0008 on 2026-11-09, and decided the same day that Memory Records use the GCP project that already hosts the other Syntoria services.

That project's Gate service keeps its data in its own named Firestore Native database, and an IAM condition limits Gate's runtime identity to that database. Memory Records follow the same pattern:

- A dedicated named database, `lore-memory-records`, in Native mode, not collections in another service's database.
- Its location is `asia-southeast1`, the region of Lore's Cloud Run services and of Gate's database, because a database location cannot be changed after creation and recall latency depends on it.
- Lore's API and worker service accounts, which are in the same project, are granted access only to that database through an IAM condition on its resource name; Gate's identity gets none, and Lore's gets none on Gate's database.
- Deletion protection is enabled, and backups are configured as the restore contract in [Forget and restore](#forget-and-restore) requires.
- The project ID and number stay in the ignored local deployment profile, as for every other production identifier.

On 2026-11-09 the owner also replaced the PostgreSQL deployment instead of migrating it:

- The owner deleted the Lore Cloud Run services and the Neon databases. With the owner's approval, the remaining cloud resources that served only them were deleted the same day, including the last database dump and that database's deletion ledger. No data is migrated; Memory Records start empty.
- The PostgreSQL implementation was removed from the repository before the Firestore service is built. It remains in Git history, and pages that describe it are marked historical.

Not yet decided: the scope of the first Firestore service release, and which decision-model providers to evaluate.

## Prerequisites and limits

- Firestore behavior has been checked only against the emulator ([local record](../eval/memory-records-s2-local-20261109.md)). The emulator does not show managed IAM, latency, cost, restore or vector and text search quality, and the database above has not been provisioned.
- Moving enforcement into the application removes the backstop that PostgreSQL row-level security gave; the access contract and its tests are the only protection.
- Recall and extraction quality, and any saving from decision models, are unmeasured; the evaluation decides them.
- Background workers may not have the connectors an AI client used. Each source records whose authorization, which runtime and which API can fetch it again; one without such a path is not shown as automatically re-evaluable.
