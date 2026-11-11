# Recall name matching observation — 2026-11-11

## What was observed

An AI client reported that the hosted service returned nothing useful for a customer it had asked about. Read-only calls through an authenticated MCP connection on 2026-11-11 showed the following. No memory text, name, source URI or identifier is copied here.

- The change feed held 53 changes: 51 creates and one refine within 13 minutes on 2026-11-10, and the source-metadata migration as a single batch later that day. The scope holds 51 records. The index watermark and the latest change were both 53; these are sequence numbers, not a count of memories.
- Every record seen had an empty `aliases` list, and its `subject_ids` named the document collection it came from, not the customer, product or person the claim was about. Some titles were the first characters of the statement.
- A Japanese question that named the customer in katakana returned five records in the default mode. The customer's record was not among them; the top results shared only common words with the question.
- A query of the customer's Latin name alone returned the customer's record first with a score under 1, which the scoring then in force gives only when no term matched. Unrelated records followed within 0.06 of it.
- A query of the collection name returned the collection's records first with scores above 10.

## Cause

Reproduced locally with the stored term rule on synthetic text of the same shape:

- A Latin name written directly before Japanese text stayed inside one long term, so the name alone was never a term.
- The prolonged sound mark ended a katakana run, splitting the name.
- Each matching bigram added two points and similarity at most one, so common words outranked the name.
- Similarity barely separated related from unrelated records, and no result was ever withheld.

## What changed

[ADR 0009](../adr/0009-keep-firestore-and-repair-in-process-term-matching.md) records the decision. The repository now derives terms by script, matches names and terms against the committed record, weights terms by rarity, labels why each result matched, and the MCP guidance asks clients for names in `subject_ids` and other spellings in `aliases`.

## Limits

This is one scope with 51 records and four queries. It does not measure recall quality. The change was verified locally only; the hosted service has not been deployed or checked with it. The existing records still lack names and aliases, so a katakana question about that customer will rank its record first only after an alias is added to the record.
