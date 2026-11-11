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

## Current index rollout

Commit `8b70478`, which adds the current index and the invalidation of its in-memory copy, was built and deployed the same way later on 2026-11-11, with traffic and the gateway's tag moved together. The previous revisions remain for rollback.

- An authenticated recall of the customer's Latin name returned the same record, score and `matched` values as before, with the watermark at 53.
- A refine without `as_user`, meant to add the customer's name as a subject and its katakana spelling as an alias, was refused as `forbidden`: the record was written by another connection, and a refine without the person's authority may change only the caller's own proposal. The change feed showed no new change afterwards.
- No write has reached the new revision, so the pass that builds the current index has not run on the hosted scope. Recall there still reads the per-revision index. The current index is verified on the emulator only.

## Alias correction with the person's authority

The owner then chose to make the correction with `as_user`. The refine added the customer's name as a subject, its katakana spelling as an alias and a descriptive title, and left the statement unchanged.

- The write succeeded on the new revision as change 54. Under the `automatic` policy the record's new revision carries user authority with policy provenance and the record became active; its statement is still an unverified reading of a source document.
- The service logged one `memory.index.current_advanced` event after the write: 50 entries written and the scope complete. With the entry the index worker wrote for the corrected record, the current index covers all 51 records. No error-level log entry appeared for the revision.
- The katakana question now returned the customer's record first with `matched` of `alias`, `terms` and `semantic` and a score above 80; the second result was `semantic` only with a score under 1. The watermark and latest change were both 54.

## Write operations on the new revision

At the owner's direction the write path was then exercised with one synthetic record that named an invented subject with a katakana alias and carried no real information.

- `remember_memory` saved it as a proposal; a katakana question naming the alias returned it first with `alias`, `terms` and `semantic`, with the watermark caught up.
- A refine without `as_user` succeeded on this connection's own proposal.
- A supersede was refused with `invalid_input` because only an active memory can be superseded; no supersede was exercised.
- A retract with `as_user` succeeded and recorded user authority with policy provenance.
- `forget_memory` reported that use had stopped. Afterwards `get_memory` returned `not_found`, a recall of the subject and its alias returned only an unrelated `semantic` result with `semantic-match-only`, and the change feed showed a content-free deletion entry in place of the record's earlier changes. The service logged one successful purge and no error-level entry.

The deletion ledger holds one entry from this check.

## Limits

This is one scope with 51 records and a handful of queries. It does not measure recall quality, latency or cost. Supersede has not been exercised on the hosted service, and a Forget was checked only on a record written minutes earlier. The other 50 records still lack names and aliases.
