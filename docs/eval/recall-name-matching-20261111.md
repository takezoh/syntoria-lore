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

## Hosted rollout

Commit `e7ec935` was built with Cloud Build from an allowlisted copy of the committed checkout and deployed to the existing Cloud Run API service on 2026-11-11. The new revision first received no traffic and became ready; traffic and the tagged backend address that the gateway calls were then moved to it. The service account, environment and Secret references were kept. The previous revision remains for rollback. Image digest, build and revision identifiers are in ignored local operator evidence under `.local/cloud/releases/`.

Moving service traffic alone did not change responses: authenticated calls kept returning the old response shape until the revision tag was moved, so the gateway reaches the service through that tag.

Read-only authenticated MCP calls after the move, with no memory writes:

- `get_access` succeeded for the existing admission.
- The customer's Latin name alone returned the customer's record first with `matched` of `terms` and `semantic` and a score above 10; the next result was `semantic` only with a score under 1.
- That name with a common Japanese word returned the same record first with `terms`.
- The katakana question returned a `semantic`-only result with the note `semantic-match-only`; the customer's record has no katakana alias.
- A name that no record contains returned a `semantic`-only result with the same note.
- The watermark and latest change stayed at 53.

## Limits

This is one scope with 51 records and a handful of queries. It does not measure recall quality, latency or cost, and it exercised no write, correction or Forget on the new revision. CI has not run for the commit, which is on a local branch. The existing records still lack names and aliases, so a katakana question about that customer will rank its record first only after an alias is added to the record.
