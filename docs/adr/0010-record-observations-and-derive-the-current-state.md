---
id: adr-0010-record-observations-and-derive-the-current-state
kind: adr
title: Record observations that are never rewritten and derive the current state from them, on Firestore
status: proposed
created: '2026-11-12'
decision_makers:
- owner
relations:
- {type: references, target: adr-0007-store-memories-as-firestore-memory-records}
- {type: references, target: adr-0009-keep-firestore-and-repair-in-process-term-matching}
summary: A memory stops being one claim that is revised and becomes a series of immutable observations about a subject, with the current state, the change and the search indexes derived from them; trust comes from who wrote an observation and from what, not from a person approving it; sources are kept as references with a summary, never as copies; Firestore Standard stays and what it lacks is built in Lore.
---

# Record observations that are never rewritten and derive the current state from them, on Firestore

## Decision

On 2026-11-12 the owner stated the conditions Lore must meet and directed the work: other AIs observe and Lore is only written to; writes are many and keep growing; no person reviews individual memories; things change, and the course of a change must be kept and readable, which is not the same as rewriting a memory; and originals in services such as Slack, Gmail and Notion are not copied, only summarized and referenced. The owner also decided that Firestore stays and that what it lacks is built, and that a later shortfall is not to be blamed on the infrastructure. This record is proposed until the owner accepts it; the [observation ledger design](../design/observation-ledger.md) turns it into contracts.

1. **The unit is an observation.** One write by an AI is one observation: a short summary of what matters, the subjects it is about, what aspect of them, when it was the case, who wrote it and from what. An observation is never changed after it is written.
2. **Change is kept as a course, not as a rewrite.** Observations about the same aspect of the same subject form one topic, ordered in time. A later state does not replace or hide an earlier one. How two observations relate (follows, restates, conflicts with, retracts) is its own appended record, which can be revoked.
3. **The current state is derived.** For each topic Lore keeps a view with the latest state, the one before it, when it changed, who else observed the same and any open conflict. Views, the subject and alias tables and the search indexes can all be rebuilt from observations and relations.
4. **Trust comes from provenance.** No observation waits for approval. Each carries a writer that the server sets from the authenticated connection and a tier derived from how it came to be: stated by the person, derived from a referenced source, or inferred by an AI. A lower tier never closes a state of a higher tier; the two are kept as an open conflict. The person's authority remains, as the highest tier, for what the person states.
5. **Sources are references.** An observation stores the provider's own identifiers for the original, a link, the version it saw and when it was read. It does not store the body of a message or document.
6. **Nothing is read in full to answer a question.** Reads go through the subject, topic and time keys and through bounded index queries, so the cost of a question does not grow with the size of the memory.
7. **Firestore Standard stays.** Joins, aggregates, Japanese term search and ranking are built in Lore, with their limits stated and measured. Where a limit of the database shapes a contract, the design says so; a shortfall is fixed in Lore's code.

This replaces the record-and-revision model of [ADR 0007](0007-store-memories-as-firestore-memory-records.md) and the proposal and approval lifecycle built on it. The repository boundary, compartments, source references, Forget with its independent ledger, the change feed and the choice of Firestore carry over. The current index of [ADR 0009](0009-keep-firestore-and-repair-in-process-term-matching.md) is replaced by the topic views and bounded index queries; its term rule carries over.

## Requirements and rationale

The model of ADR 0007 was taken over from the earlier PostgreSQL service and was never compared with other ways to hold memory. Its centre is one correct claim per record, changed by an operation the writer declares, with a person's approval separating a memory from a proposal. On the hosted service every record written by an AI stayed a proposal, replacement was refused for proposals, validity times were empty, and two states of one matter could only sit side by side as unrelated records or inside one record's prose.

Published systems for agent memory have moved to appending and closing instead of rewriting. Graphiti keeps a fact with the period it held and closes that period when a contradicting fact arrives. Mem0 withdrew its write-time update and delete step because it overwrote details that were needed later, and its append-only successor reports old facts returned next to new ones as its main difficulty. Engram and SodaMem add an explicit link from a new fact to the one it replaces and a subject and predicate key that finds most replacements without a model. No published system was found that keeps the past, marks the present and makes the change readable all at once, and none where several different AIs write one person's memory. Measurements of trust without review show that confidence read from the wording and majority counts can be defeated, and that capping trust by provenance holds, at the price that a correct correction from a low tier is not applied on its own.

| Alternative | Decision basis |
| --- | --- |
| Observations, relations and derived views (chosen) | Keeps every earlier state, makes the present and the change readable, needs no review, and reads by key instead of by scan |
| Keep records and revisions and add links between records | Leaves approval as the gate for change and keeps one mutable claim as the unit |
| Let a model update or delete memories at write time | Withdrawn by the system that introduced it; a wrong rewrite cannot be seen or undone |
| Adopt a temporal graph engine | Adds a second store and several model calls per write; its entity attributes have no history and it does not close a fact whose date is missing |
| Move to PostgreSQL | Fits the queries with less custom code, but the owner chose to stay on Firestore and build what is missing |
| Copy source bodies for later verification | Rejected by the owner; a copy also widens what Forget and rights changes must reach |

## Consequences

- **Security and authorization.** Writer and tier are set by the server from the verified actor and the write path, never from request fields. Compartment allowances and source rights are checked at read time as before. Text of observations and sources is data, never instructions. A writer or a period can be suppressed as a whole.
- **Data.** New collections for observations, relations, subjects, aliases, topic views and index entries. A summary is the lowest record Lore has, so it is never rewritten or shortened, and a reference must be good enough to find the original again.
- **Trust.** A state can be current without anyone having confirmed it. Readers receive the writer, the tier, the source and when it was last read, and open conflicts are shown instead of resolved silently.
- **Migration.** The 51 existing records become observations with their text, sources, writers and times. They are not assigned to topics by guessing. The old collections stay read-only until the new path is verified.
- **Clients.** The MCP tools change: a write is an observation, and recall returns topics with their state and change. Clients must fetch the new tool list and instructions.
- **Forget and restore.** Forget applies to an observation, a subject or everything derived from one source, through the same suppression and ledger. Views and indexes are rebuilt for what it touches. Relations that point at a forgotten observation keep no content.
- **Cost.** A write is a bounded number of document writes in one transaction. A question reads a bounded number of documents whatever the size of the memory. Vector queries are billed by what they scan after filtering, so every such query carries a filter.
- **Limits accepted.** Term search on Firestore Standard is a bigram index queried for at most thirty terms and ranked in Lore; it finds names and short terms and is not full-text search. Topics split when writers name the same aspect differently; Lore links such topics and does not merge them.

## Confirmation

Nothing is implemented. The design lists the units and, for each, the check that distinguishes it from the current behaviour. Three measurements decide whether the model works in practice and are part of the work: how often different writers put the same matter under the same topic, whether name and term search finds Japanese and mixed-script names at the sizes tested, and whether a set of the owner's own questions, including what a state was before and what held on a given date, is answered correctly. Composite and vector indexes exist only on the managed service and must be checked there.

## Sources

- The owner's statements and direction of 2026-11-12
- [Observation ledger design](../design/observation-ledger.md), [ADR 0007](0007-store-memories-as-firestore-memory-records.md), [ADR 0009](0009-keep-firestore-and-repair-in-process-term-matching.md), [recall observation record](../eval/recall-name-matching-20261111.md)
- https://arxiv.org/abs/2501.13956 (Zep and Graphiti)
- https://github.com/getzep/graphiti
- https://arxiv.org/abs/2504.19413 (Mem0)
- https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm
- https://arxiv.org/abs/2606.09900 (Engram, preprint)
- https://arxiv.org/abs/2608.08055 (SodaMem, preprint)
- https://arxiv.org/abs/2410.10813 (LongMemEval)
- https://arxiv.org/abs/2606.22030 (provenance-capped trust, preprint)
- https://arxiv.org/abs/2503.03704 (MINJA)
- https://firebase.google.com/docs/firestore/vector-search
