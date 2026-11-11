---
id: adr-0009-keep-firestore-and-repair-in-process-term-matching
kind: adr
title: Keep Firestore and repair in-process name and term matching before changing how candidates are found
status: proposed
created: '2026-11-11'
decision_makers:
- owner
relations:
- {type: references, target: adr-0007-store-memories-as-firestore-memory-records}
- {type: references, target: adr-0008-keep-a-generative-baseline-and-enable-decision-models-per-point}
summary: Recall failed for names and Japanese questions because of term derivation and scoring in application code, so those are repaired in place on Firestore Standard; replacing the full index read with Firestore vector search is the next step, and neither PostgreSQL, Enterprise text search nor a recall decision model is adopted now.
---

# Keep Firestore and repair in-process name and term matching before changing how candidates are found

## Decision

On 2026-11-11 the owner reviewed a failed recall on the hosted service and directed work to proceed on the plan below. This record is proposed until the owner accepts it.

[ADR 0007](0007-store-memories-as-firestore-memory-records.md) says that if acceptance fails for names, aliases, keywords or Japanese, a search decision is made with Enterprise edition text search as the first candidate. That failure occurred. The decision is:

1. **Stay on Firestore Standard and keep matching in application code.** The failure came from how terms were derived and scored, not from the store.
2. **Derive terms by script.** A run of Japanese characters yields character bigrams and includes the prolonged sound mark; any other run of letters and digits is one term; runs are cut where the script changes.
3. **Match against the committed record.** Recall already reads every candidate's committed record to recheck rights. Names and terms are matched against that record with the current rule, so index entries written under an older rule need no rewrite. Index entries nominate candidates and carry the vector score.
4. **Score by rarity and by name.** Each query term is weighted by how rare it is among the candidates, and a record's term score is the matched share of the query's total weight; a share under 0.15 does not count as a term match. A subject or alias that the query text mentions counts as a name match. Vector similarity only breaks ties among records with the same name and term support.
5. **Say why a record was returned.** Each result lists what matched: record ID, subject, alias, terms or semantic similarity. When every returned result matched by similarity alone, recall adds the note `semantic-match-only`. Such results are still returned; no similarity cutoff is applied, because none has been measured.
6. **Tell clients how to save and query.** The MCP instructions and tool descriptions ask for one claim per record, proper names in `subject_ids`, other spellings in `aliases`, and queries made of names and key terms.
7. **Next, stop reading the whole index.** Recall reads up to 1,000 index entries per request, one per record revision, in no defined order. Past that number an arbitrary part of the index is not searched. The next step keeps one current entry per record and finds candidates with Firestore vector search and term queries. It is not implemented by this record.

Not adopted now: returning to PostgreSQL, Enterprise edition text search, and a decision model in recall. A recall rerank stays a candidate point under [ADR 0008](0008-keep-a-generative-baseline-and-enable-decision-models-per-point.md) and needs its evaluation.

## Requirements and rationale

The owner wants recall to find a memory by the names people actually type, at the lowest running cost.

Observed on the hosted service on 2026-11-11 ([record](../eval/recall-name-matching-20261111.md)): a Japanese question naming a customer did not return that customer's only record in the top five, and a query of the customer's Latin name alone matched it by vector similarity only. Reproduced locally: the old rule kept a Latin name glued to the Japanese text that followed it, cut katakana at the prolonged sound mark, and added two points per matching bigram against at most one point for similarity, so common words outranked the name.

| Alternative | Decision basis |
| --- | --- |
| Repair term derivation and scoring in place (chosen) | Fixes the observed causes with no data migration and no new service |
| Return to PostgreSQL | Hybrid search in one query is a better fit for search alone, but its default text search does not segment Japanese either, and it repeats the storage rebuild finished on 2026-11-09 |
| Enterprise edition text search | Not needed for the observed causes; availability, region, rights filtering, cost and Japanese results are unchecked |
| A generative model or decision model in recall | Would hide a deterministic defect, adds a serial call to every recall, and ADR 0008 requires an evaluation that has not run |
| Rewrite existing index entries with the new terms | Rejected for now: the completed source-metadata migration verifies stored index entries against its receipt |

## Consequences

- **Security and authorization.** Unchanged. Candidates are still rechecked against the committed record, allowance, source rights and suppression before return.
- **Data.** No stored record, revision or existing index entry changes. New index entries record the version of the term rule.
- **Recall results.** Ranking changes for every query. A result supported only by similarity is now labelled instead of looking like a match. Existing records without the relevant name in `subject_ids` or `aliases` are found by that name only when it appears in their title or statement.
- **Cost.** Reads per recall are unchanged: the whole index plus every candidate's record and history. Cost and the 1,000-entry ceiling are addressed only by the next step.
- **Operations.** None added.

## Confirmation

- Local, 2026-11-11: unit tests cover the term rule and the rarity weighting; an emulator test ranks a named record above records that share only common terms, by Latin name and by a katakana alias inside a question, and reports `semantic-match-only` for an unknown name.
- Spike, 2026-11-11: the Firestore emulator served `findNearest` with cosine distance, a distance threshold, and equality, `array-contains` and `array-contains-any` pre-filters. The emulator does not enforce indexes; the composite vector indexes, billing and behavior of the managed service are unverified.
- Not verified: the hosted service after this change, recall quality on a labelled set, and whether the weights and the 0.15 share suit a larger memory.

## Sources

- The owner's direction of 2026-11-11 to proceed with this plan and to keep running cost low
- [Recall name matching observation](../eval/recall-name-matching-20261111.md), [Memory Records design](../design/memory-records.md), [ADR 0007](0007-store-memories-as-firestore-memory-records.md), [ADR 0008](0008-keep-a-generative-baseline-and-enable-decision-models-per-point.md)
- https://firebase.google.com/docs/firestore/vector-search
