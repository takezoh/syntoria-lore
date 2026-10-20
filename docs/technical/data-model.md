# Data model and consistency

PostgreSQL is the durable store. This document defines the logical model and persistence contract. The [memory-system reference](memory-system.md) explains the flow from observation through recall; migration SQL in [packages/db/migrations](../../packages/db/migrations) is authoritative for exact columns, constraints, grants and policies, and [packages/contracts](../../packages/contracts/src/index.ts) defines request shapes.

## Memory model

A **memory** is a reusable unit of meaning interpreted from observations. Its kind is one of `fact`, `decision`, `preference`, `hypothesis`, `experience` or `procedure`. Each change creates an append-only **memory version** holding the statement, structured `context` (a JSON object, never flattened to a string), valid-time interval, recorded time, epistemic status (`asserted`, `observed`, `inferred`, `proposed`), the contested flag, authority and attribution.

| Concept | Rule |
| --- | --- |
| Observation | What a source said or recorded, with speaker and event time; the fact of assertion, not its truth |
| Evidence | Locator, optional snippet (only when the source permits it) and lineage; `memory_version_evidence` fixes the evidence set of each revision |
| Lineage | Distinguishes independent evidence from duplicates and derived summaries, so repetition cannot inflate support |
| Episode | Condition, action and outcome kept as one experience; a partial fact extracted from an episode is held as invalid |
| Subject | Stable person, project or thing with time-bounded aliases; alias validity is separate from memory validity |
| Relation | Exactly `supersedes`, `supports`, `contradicts`, `related_to`, `same_subject` or `depends_on_context` |
| Authority | `user_decision`, `user_preference`, `user_assertion`, `third_party_claim`, `observed_state` or `ai_proposal` |
| Lifecycle | `candidate`, `active`, `superseded`, `retracted`, `forgotten`; contested is a separate flag |

### Authority and attribution

Speaker metadata and trusted source metadata are preserved as evidence and attribution; they do not determine authority by themselves. Core derives authority from the authenticated actor kind, memory kind and epistemic status. A user-authored decision or preference receives `user_decision` or `user_preference`; other user-authored kinds receive `user_assertion`. A non-user actor, or any proposal with `proposed` status, receives `ai_proposal`. Authority from model output is ignored. Public non-user writes remain candidates; the worker's narrow, validated auto-capture path can activate an eligible fact through a separate internal policy. A client cannot rewrite a user-attributed memory. A controlled user-review operation can record a separate user statement: confirming a third party's technical claim does not turn it into a verified fact or change who originally said it. Imported memories are attributed to the importing principal with `third_party_claim` authority; the original user, actor and authority survive only as provenance.

### Time

`valid_from`/`valid_to` record when an assertion holds; `recorded_at`/`superseded_at` record when Lore learned or replaced it. Unknown times are null or ranges. SUPERSEDE sets the prior revision's `valid_to` to the replacement's `valid_from` (or the transaction's cutover time when omitted), keeping half-open, non-overlapping intervals. A historical read selects the greatest revision recorded by `known_at`, then applies `valid_at`; it never falls back to an older, wider interval. Current source rights and suppressions still apply to historical reads.

## Change operations

A change set contains 1–64 operations on one scope. Each operation that targets an existing memory carries its `expected_revision`.

| Operation | Effect |
| --- | --- |
| CREATE | New memory with at least one evidence item |
| CORROBORATE | Adds supporting evidence to the same memory identity by committing a new revision with its own evidence set |
| REFINE | New revision with a sharper statement, context, interval or status, plus evidence |
| SUPERSEDE | Closes the current interval and creates the replacement |
| CONTEST | Marks a contradiction with a reason and evidence |
| RELATE | Adds a typed relation between two memories at their expected revisions |
| RETRACT | Withdraws a memory as wrong, with a reason |
| NO_OP | Records a deliberate non-change with a reason |

Forget is not a change operation; it has its own authorized flow.

## Tables

Every tenant row carries `user_id` and `scope_id`, protected by forced row-level security against transaction-local context.

| Entities | Purpose | Classification and lifecycle |
| --- | --- | --- |
| `users`, `principals`, `grants`, `scopes` | Tenant identity, OAuth issuer/subject binding, capabilities, grant expiry, authorization epoch | Restricted security data; revoked or expired grants deny immediately |
| `subjects`, `subject_aliases` | Stable identities and time-bounded names | Tenant content metadata; purged with dependent data |
| `sources`, `connector_authorizations` | Source identity, revision, rights, consent and suppression lineage | Restricted provenance; current rights gate every read |
| `observations`, `episodes`, `capture_requests`, `capture_jobs`, `capture_job_observations` | Consented input, grouping, deduplication, durable job and checkpoint state | Potentially sensitive content; capture requires consent |
| `evidence`, `memory_version_evidence` | Evidence locators, snippets, rights and per-revision evidence sets | Sensitive; Forget purges snippets and links |
| `memories`, `memory_versions`, `memory_subjects`, `relations`, `embeddings`, `memory_embeddings` | Memory identity, append-only revisions, subject links, typed relations, model-specific vectors | Sensitive; rights, suppression and retention apply at read time |
| `changesets`, `change_ops`, `change_log`, `scope_offsets` | Proposals, committed operations and the ordered per-scope feed | Change metadata; Forget events are content-free tombstones |
| `outbox`, `idempotency_keys`, `feedback`, `curation_reviews`, `user_confirmations` | Delivery and retry state, request replay, usage feedback, held decisions, explicit user authority | Operational; a proposal is never an user confirmation |
| `deletion_requests`, `suppressions`, `deletion_targets`, `deletion_ledger_checkpoint`, `deletion_ledger_visibility_items` | Immediate denial, purge work and database visibility against the external ledger | Highly restricted and content-free where possible |
| `export_jobs`, `portability_imports`, `governance_file_deletions` | Encrypted bundle jobs, imports and artifact cleanup claims | Encrypted artifacts plus metadata; rights and Forget invalidate exports |
| `scope_retention_policies`, `feedback_reassessments`, `audit_events` | User retention bounds, reassessment queue and content-free audit | Policy and operational data |
| `schema_migrations` | Applied versions and checksums | Operational; no tenant content |

## Roles and row-level security

The API connects as `memory_app`; the worker connects through a separate login that is a member of `memory_worker`. Both are non-superuser and `NOBYPASSRLS`, and the bootstrap checks this before serving. Each operation sets its user, principal and authorized scope context with `SET LOCAL` inside the transaction; session-level settings are never used, so a pooled connection cannot carry one request's scope into another. The runtime role has no `UPDATE` or `DELETE` privilege on `memory_versions`, and the version trigger does not accept caller-settable settings as purge authority. Physical purge runs through a narrowly privileged, receipt-verified governance routine.

Source rows are locked `FOR SHARE` while evidence is validated and while evidence-backed memories are read or changed, so a concurrent revocation either wins before authorization or waits for the authorized transaction.

## Commit contract

Proposal creation and commit are separate endpoints and database states. A commit:

1. Rechecks the principal's grant (holding the grant row stable), scope authorization epoch, source rights and each `expected_revision`.
2. Increments the scope's `scope_offsets.last_seq` with a row lock held until commit.
3. Writes memory versions, version evidence, relations, change operations, `change_log(scope_id, seq)`, outbox rows, the idempotency response and the audit record.
4. Commits all of it atomically or rolls back all of it. Model calls never run inside the transaction.

A stale revision returns `409 revision_conflict`. Idempotency keys bind actor, scope, key and request hash: an identical retry replays the stored response, only to the original principal or the user and only after the same authorization check; a different body returns `409 idempotency_conflict`.

## Change feed and cursors

Because every change in a scope takes the same offset row lock, the per-scope sequence follows commit order without gaps; raw database sequences are never exposed. A cursor is an opaque signed token that binds the user, principal, exact scope vector, per-scope offsets, authorization epochs and format version. Multi-scope readers receive a vector of positions; there is no global order. Tampered or mismatched cursors are rejected, an authorization change requires a fresh start, and an expired cursor returns `410 cursor_expired`. Forget writes content-free tombstones with the memory ID and last revision; imports allocate offsets under the same lock and write one content-free `IMPORT` event per imported memory.

Per-scope serialization costs write throughput; its effect at the planned workload has not been measured.

## Search indexes

Search indexes are derived data. `pg_trgm` supports lexical matching; pgvector stores embeddings per model, version and dimension, and vectors from different models are never compared. A model change uses a new model identifier and index generation. Index updates verify the memory version before applying, so an old embedding never overwrites a newer one. The committed revision and the indexed revision are tracked separately. Exact and lexical searches can surface an unindexed committed record, while a semantically related query may miss it until indexing catches up. Candidate bounds, rank fusion and the Context Pack coverage field are described in [retrieval and Context Packs](memory-system.md#retrieval-and-context-packs).

## Deletion, retention and restore

Forget commits suppression and tombstones before asynchronous cleanup. Reads and exports deny the target as soon as the transaction commits; purge then removes memory versions, evidence, observations and dependent source and artifact data allowed by the deletion plan. The deletion ledger lives outside the database and survives a database restore; readiness stays closed until the database checkpoint has caught up with the ledger head. Retention policies bound observation and memory age per scope and route expiry through the same suppression, ledger and purge path. Exact retention durations are policy data, not hard-coded promises.

## Migrations

Migrations are forward-only. Applied files are never edited; their checksums are verified on every run. New schema changes follow the [migration review template](../templates/migration-review.md): additive deployment order, lock and backfill behavior, RLS and grant impact, mixed-version compatibility and the effect on Forget, export and restore.

## User identity and fixed version 1 formats

The authenticated person is `user`, with `userId` in TypeScript and `user_id`
in SQL and structured identifiers. User-authored provenance uses `user`,
`user_decision`, `user_preference`, `user_assertion` and `user_statement`.
Callers cannot select or override the authenticated user.

Migration `0041_user_identity.sql` renames the table and columns in place,
preserving UUIDs, row identities, effective grants and row-level security.
It updates typed provenance columns and only the defined response/provenance
JSON fields. Memory text, caller context and metadata remain unchanged.
Deploy the migration and service together behind the existing write fence;
the previous service cannot use the renamed schema. Applied migrations remain
immutable. No deployed database is changed by editing the repository.

Cursor payload version 1, deletion-ledger version 1, encrypted portability
payload version 1 and persisted receipt hashes retain their original `owner`
keys and provenance bytes through explicit codecs. These fixed formats are
not public API aliases. Database role ownership, existing login usernames,
prior OAuth subject/client IDs and deployed secret identifiers retain their
external meanings and identities. Gate bindings are additive and point to
those existing rows; they do not rewrite historical identity data.
