# MCP and HTTP API contract

## Service boundary

REST and Remote MCP expose the same application services. Gate credentials establish the principal through online issuer and exact-resource checks with a required client ID followed by an explicit local Gate identity binding. Business arguments and identity headers cannot select a user or widen a scope. MCP tools are thin adapters over the REST services and never reimplement core rules. Callers decide when to remember, recall or catch up and how to interpret results; Lore attributes, validates, versions and governs. See [memory system](memory-system.md) for the capture-to-recall flow, [infrastructure](infrastructure.md) for identity and transport, and the [data model](data-model.md) for persistence semantics.

## Entry points and authorization

| Entry point | Resource / audience | Purpose |
| --- | --- | --- |
| `/v1/*` | API resource | Full REST surface |
| `POST /mcp` | MCP resource | Streamable HTTP MCP; read and write tools selected by current operation capabilities |

Each opaque Gate bearer token is valid for exactly one configured resource: the API or `/mcp`. Lore does not authenticate shared cookies or provide a login/session route. Gate introspection confirms active status, issuer, immutable subject, nonempty client ID and exact audience on every request. An operator-maintained binding maps that immutable issuer/subject to an existing personal-account principal, scope set and capability ceiling; those bounds intersect with live grants. Dynamically registered clients of one subject share that principal and its operation capabilities; the client ID is checked and recorded with each changeset, but it does not select a different principal or grant anything. A binding may instead name a connection principal: a non-user principal that every connection of the subject then acts as, with grants read from the user principal it acts for (see [change confirmations](#change-confirmations)). `admin` includes read and write but is an internal capability, not a separate service-administrator account. Read tools require `read`; write tools require `write`, and domain operations can require `admin` or a user actor as well. Export, download and import require the authenticated actor to be the user (`403 user_required` otherwise). Listing and reading reviews also accept a connection principal, which acts for the user without the user's authority. Enabling or disabling a source, deciding reviews, Forget, source rights, grants, retention and committing a proposal with user authority run directly for the user and return a Gate confirmation to any other actor. Invalid or revoked credentials return 401, a valid but unadmitted identity returns 403, and a Gate outage returns 503. The protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` names the Gate issuer and exact resource. An unauthenticated MCP POST returns 401 and a GET returns 405.

## Tool and schema discovery

Use MCP `initialize` followed by `tools/list` at `/mcp`; each tool advertises its `inputSchema`. Lore lists operations allowed by the authenticated principal's current `read` and `write` capabilities. The REST contract is served at `/openapi.json` and exported to [openapi.json](../api/openapi.json) with `npm run openapi:export`; `npm run openapi:check` fails when they diverge. Input schemas reject unknown keys. The running deployment defines the available tools; this checkout may describe a different version.

| Required operation capability | Tools available at `/mcp` |
| --- | --- |
| `read` | `get_access`, `recall_memories`, `get_memory`, `get_changes`, `capture_status`, `forget_status`, `export_status`, `list_reviews`, `get_review`, `get_confirmation` |
| `write` | `remember_memory`, `configure_source`, `capture`, `propose_changeset`, `commit_changeset`, `request_user_decision`, `complete_confirmation`, `decide_review`, `forget_memory`, `change_source_rights`, `change_scope_grant`, `set_retention_policy`, `submit_feedback`, `request_export`, `import_bundle`, `create_compartment`, `narrow_access`, `request_compartment_access` |

An actor with both capabilities sees both groups. Review reads use `read`; review decisions use `write` and still follow user-authority and confirmation rules. `recall_memories`, `get_memory`, `get_changes` and `remember_memory` accept an omitted `scope_id`: reads then use every authorized scope, and a write uses the only writable scope or fails with `400 scope_required` listing the choices.

## REST operations

| Operation | Endpoint | Notes |
| --- | --- | --- |
| Access | `GET /v1/access` | The connection's scopes, compartments, write default and approval policy |
| Compartments | `POST /v1/compartments`, `POST /v1/access:narrow`, `POST /v1/access:request` | Create a compartment for this connection; narrow its allowance at once; request a wider allowance under the approval policy (202 with a confirmation under `gate`) |
| Remember | `POST /v1/memories:remember` | Synchronous commit of one memory with evidence |
| Get memory | `GET /v1/memories/{id}` | Current or historical (`valid_at`, `known_at`) revision with evidence and relations |
| Feedback | `POST /v1/memories/{id}:feedback` | `useful`, `incorrect`, `stale` or `not_relevant`; queued for reassessment |
| Propose change set | `POST /v1/changesets` | Validated, persisted proposal |
| Commit change set | `POST /v1/changesets/{id}:commit` | Rechecks access, rights and revisions; atomic |
| Request user decision | `POST /v1/changesets/{id}:request-user-decision` | `Idempotency-Key`; commits with user authority for the user, 202 with a confirmation otherwise |
| Confirmation | `GET /v1/confirmations/{id}`, `POST /v1/confirmations/{id}:complete` | State and Gate URL; complete applies an approved change once |
| Recall | `POST /v1/recall` | Mode, budget and time selection; Context Pack |
| Changes | `GET /v1/changes` | Opaque cursor, `limit` 1–200 (default 50) |
| Enable source | `POST /v1/connectors` | User; enabling requires `consent: true` |
| Capture | `POST /v1/captures` | `Idempotency-Key`; 202 with job ID |
| Capture status | `GET /v1/captures/{id}` | `accepted`, `processing`, `committed`, `held`, `failed` |
| Reviews | `GET /v1/review`, `GET /v1/review/{id}`, `POST /v1/review/{id}:decision` | User; decision requires `expected_revision`; 202 with a confirmation for other actors |
| Forget | `POST /v1/forget`, `GET /v1/forget/{id}` | User; immediate suppression, purge progress; 202 with a confirmation for other actors |
| Source rights | `PUT /v1/sources/{id}:rights` | User; `granted` or `revoked`; 202 with a confirmation for other actors |
| Grants | `PUT /v1/scopes/{id}/grants` | User; capabilities, expiry or revocation for a principal; 202 with a confirmation for other actors |
| Retention | `PUT /v1/scopes/{id}/retention` | User; bounded observation and memory ages; 202 with a confirmation for other actors |
| Export | `POST /v1/exports`, `GET /v1/exports/{id}`, `GET /v1/exports/{id}:download` | User for create and download; asynchronous encrypted bundle |
| Import | `POST /v1/imports` | User; `Idempotency-Key`; authenticated bundle |

`/v1/capture`, `/v1/jobs/{id}` and `/v1/reviews` remain as aliases. Every response carries `request_id` and `trace_id`.

## Compartments and allowances

A compartment is one of the user's confidentiality obligations, such as an employer, a client engagement or a private matter. Each memory version, source, observation, evidence item and subject carries a label: a set of compartments, all of which a recipient needs. The empty label is General. Each Gate connection has an allowance, keyed by issuer, subject and `connection_id`; a connection without one receives General only. The [memory compartments design](../design/memory-compartments.md) defines the rules; [ADR 0006](../adr/0006-enforce-disclosure-with-compartments-and-connection-allowances.md) records the decision.

- `get_access` / `GET /v1/access` lists the connection's scopes and compartments by name and ID, the label its writes receive by default, whether a General write would be held, and the binding's approval policy. Compartments outside the allowance are not listed.
- `create_compartment` / `POST /v1/compartments` creates a compartment and adds it to the calling connection's allowance. A name that exists returns `409 compartment_exists`, which reveals that the name exists.
- `narrow_access` / `POST /v1/access:narrow` removes compartments from the calling connection's allowance at once.
- `request_compartment_access` / `POST /v1/access:request` asks for more compartments, named by the caller. It is a protected change (`change_connection_allowance`): under `auto` it applies at once with `approval.by: "policy"`; under `gate` it returns `confirmation_required`. A name that does not exist and one that cannot be granted return the same `403 compartment_not_available`.
- Every allowance change advances the allowance epoch and is recorded with the requesting connection and its approval. A commit after the connection's allowance changed fails with `403 stale_authorization`; a change cursor bound to the old allowance returns `410 cursor_expired`.

A connection can manage only its own allowance. Revoking it at Gate ends it; a new approval starts from General.

## Remember and change sets

`remember_memory` commits one memory—kind, statement, structured context, subjects, valid-time interval, epistemic status and 1–64 evidence items—synchronously and returns its revision. Authority and lifecycle derive from the authenticated actor, kind and epistemic status; the request cannot set authority. Every client admitted under one Gate subject shares that principal's actor kind, so a client acting as the user must send `epistemic_status: "proposed"` for its own suggestions; otherwise the write becomes active with `user_decision`, `user_preference` or `user_assertion` authority. A non-user principal's explicit write starts as a candidate. A separate internal capture path may activate a fact only when it passes the worker's automatic-capture policy. Use this tool for an explicit user request, and do not relabel model inference as the user's words.

`memory.compartments` names the label by ID or name. Omitted, a connection's write receives its allowance's compartments, or General when it has none. An explicit label must be within the allowance (`403 compartment_not_available` otherwise). A General label from a connection whose allowance has compartments is held: the memory is stored with the allowance's compartments and the operation result carries `held: true`; releasing it to General is a relaxation. Every new version also carries the labels of its newly cited evidence and of its previous version, and a SUPERSEDE replacement keeps the label of what it replaces. Operation results for CREATE and RECLASSIFY carry the resulting `compartment_ids`.

A change set holds 1–64 operations (CREATE, CORROBORATE, REFINE, SUPERSEDE, CONTEST, RELATE, RETRACT, NO_OP, RECLASSIFY) for one scope, each with the target's `expected_revision`. Proposal and commit are separate; a commit is all-or-nothing and returns `409 revision_conflict` when any target moved. RECLASSIFY sets a memory's label as a new revision with the same statement and evidence. Adding compartments within the allowance commits directly and hides the memory's whole history from connections without them. Removing a compartment is a relaxation: a direct commit by a connection returns `403 user_confirmation_required`, so propose it and call `request_user_decision`. A relaxed version can cite evidence the reader cannot see; the memory view then omits that evidence and reports `withheld_evidence` with its count. Replaying a committed proposal returns its stored response only to the proposing principal or the user.

## Capture and review

The user first enables a source (`chat`, `document`, `tool_result` or `episode`) with consent. Capture then submits the source revision and 1–256 immutable observations (locator, content up to 32 KiB, speaker, event time) with an `operation_id` and an `Idempotency-Key`. Observations are deduplicated by source, revision, canonical locator and content hash, so replays under another operation ID do not multiply evidence. Capture returns `202` and a job ID.

The worker checkpoints provider output before reconciliation; retries reuse the checkpoint, and a lease token fences every write. Revoking consent revokes the source and advances the scope authorization epoch, so a saved checkpoint cannot commit under the old authorization. Automatic capture is restricted to an uncontested `fact` with `observed` or `inferred` status, valid bounded evidence, read permission for reconciliation and no unresolved match; one sole exact active duplicate can receive corroborating evidence. Preferences, decisions, conflicts, uncertain status and ambiguous matches are held for user review. Episode sources must yield one experience that cites the complete observation with matching condition, action and outcome; otherwise the proposal is held as invalid output.

Review decisions (`approve` or `reject`) require the current `expected_revision`. `accept_candidate` approves under curator attribution; `user_statement` records a separate user confirmation for the user's own policy or preference without rewriting the original speaker or verifying an external claim. A candidate that matches existing memories cannot be approved as a new CREATE: reject it and commit the intended operation, such as CORROBORATE, against the existing memory. Decisions are idempotent per key and principal; replay does not bypass a revoked source.

## Recall

`recall_memories` / `POST /v1/recall` accepts `query`, `scope_ids`, optional `subject_ids` and `memory_ids`, `mode`, `token_budget` (64–32,000, default 4,000), `valid_at`, `known_at`, `limit` (1–100, default 20) and `compartments`, which narrows the search to those compartments of the allowance plus General.

| Mode | Contract |
| --- | --- |
| `precise` (default) | Exact statement, subject and alias matches only; no lexical, semantic or relation candidates |
| `contextual` | Bounded exact, lexical, semantic and related candidates for current background and applicability |
| `historical` | Exact candidates first, then ranked candidates from the revision known at `known_at` and valid at `valid_at` |
| `exploratory` | Related memories, including candidates, through bounded exact, lexical, semantic and relation search |
| `changes` | Changed records matching the query; it uses a change-oriented candidate path rather than semantic search. Use `get_changes` for the ordered change feed |

Candidates are filtered by scope access, the connection's compartments, current source rights and Forget suppression before ranking, then by valid time, lifecycle and evidence. The response contains `matches`, a `context_pack`, `coverage`, `insufficiencies`, `unknown` and `estimated_tokens`. Search is bounded: by default each candidate source is limited to `min(200, limit * 8)`, and relation expansion starts from at most 50 supported roots for at most two hops. Contextual, historical and exploratory ranking uses weighted reciprocal-rank fusion; exact, lexical, semantic and related candidates have weights 4, 1.5, 1.5 and 0.45. The precise mode omits lexical, semantic and relation candidates. These limits mean recall is not an exhaustive scan.

The complete serialized Context Pack, including evidence and uncertainty metadata, must fit the budget. `estimated_tokens` is the UTF-8 byte length of its JSON serialization, not an exact tokenizer count. The `conflicts` field lists returned memories already marked contested; it does not discover every contradictory pair. `coverage.complete` reflects embedding provider/index coverage, not exhaustive search or complete knowledge. `unknown` means no supported candidate was returned under this query and its bounds. Exact and lexical searches can surface an unindexed committed record; a semantically related query may miss that record until indexing catches up. If semantic search is unavailable, the response reports that insufficiency and uses the available signals. See [retrieval and Context Packs](memory-system.md#retrieval-and-context-packs) for the implemented details.

## Changes and cursors

`get_changes` / `GET /v1/changes` returns committed changes in per-scope commit order with `next_cursor` and `has_more`. Events outside the connection's compartments are omitted; when a RECLASSIFY narrows a memory out of them, the event is returned once as a content-free `WITHDRAWN` with the memory ID and no revision. Start without a cursor and keep the returned cursor with your own state; advance only after applying a page. The cursor is signed and bound to the principal, scope set, authorization epochs and the connection's allowance epoch and compartments (payload version 2; a version 1 cursor reads as General only at epoch 0): a tampered or mismatched cursor is rejected, an authorization change requires a fresh start, and an expired cursor returns `410 cursor_expired`. Forgotten memories appear as tombstones with ID and last revision only; imported memories appear as content-free `IMPORT` events. Reading the feed does not mark anything as read or confirmed.

## Forget, source rights and retention

`forget_memory` / `POST /v1/forget` takes a scope, a selector of memory, source or subject IDs, a reason (`user_requested`, `source_revoked`, `retention_expired`, `correction`) and an idempotency key. It commits suppression and content-free `RETRACT` tombstones atomically and appends the deletion instruction to the independent ledger; the response carries `forget_request_id`, distinct from the per-call `request_id`. Poll `forget_status` for progress; status never returns forgotten content. Physical completion is reported only after queued export files are also removed. Protected reads and MCP fail closed while the ledger is unavailable, corrupt or ahead of the database.

Source-rights revocation is separate from Forget. It blocks dependent reads under current rights checks, advances the scope's authorization epoch and invalidates every earlier ready export in that scope. A grant of rights is a current-scope decision and does not rewrite imported provenance or user attribution. Retention policies bound observation and memory ages; expiry goes through the same suppression, ledger and purge path as Forget.

## Change confirmations

A change only the user may make, requested by a connection, is approved according to the binding's approval policy. The [change confirmation design](../design/change-confirmation.md) defines the contract.

Under `auto`, the default, Lore applies the exact change at once as the user principal and returns the change's normal response and status with `approval: { "by": "policy", "confirmation_id": … }`. The record names the requesting connection and has `approval: "policy"`. A repeated request with the same idempotency key returns the stored outcome; reusing it for a different change is `409 idempotency_key_reused`. A permanent failure returns the error and leaves the record `failed`.

Under `gate`:

1. The protected tool or route stores the exact change, renders a plain-text summary from stored data and creates a Gate confirmation. It returns `{ "status": "confirmation_required", "confirmation": { "confirmation_id", "url", "summary", … } }`, with HTTP 202 on REST. A summary over Gate's limits returns `413 summary_too_large`; split the change.
2. Show the `url` to the person. They sign in at Gate and approve or deny. The AI cannot supply the summary or approve.
3. Call `complete_confirmation` or `POST /v1/confirmations/{id}:complete` through the same OAuth resource that requested it. All MCP operations share `/mcp`, so a confirmation requested by an MCP tool can be completed through that MCP resource. REST uses its separate API resource. The call returns `pending`, `denied`, `expired`, `cancelled`, `failed` or `committed` with the change's normal response, and applies the change at most once. A shown proposal or memory that changed meanwhile fails it with `confirmation_stale`.

`request_user_decision` asks for a proposed change set to be committed with user authority. Use it for decisions, preferences and corrections the person actually stated; the person sees every operation before approving. Forgetting a memory cancels pending confirmations that show it.

## Export and import

`request_export` creates an idempotent asynchronous job for a complete scope, including every compartment in it; export is available only to the user principal acting directly, which no Gate connection can be. Payload version 2 carries the compartments used and every row's label. Status and download require current authorization, matching deletion and authorization epochs, a ready artifact and an unexpired job. Expired artifacts receive durable cleanup tombstones and are removed; claim tokens fence stale workers.

`import_bundle` authenticates the encrypted bundle, validates its schema, remaps entity and lineage IDs and commits records and change events atomically. Each version's original `recorded_at` is preserved; the change event uses the import time. An authenticated bundle proves origin and integrity, not ownership: the importer becomes `created_by`, current attribution becomes connector `third_party_claim`, and the previous user's authority is kept only as provenance. Imported sources are not readable in the destination unless `grant_imported_sources` is set. Version 2 labels map by compartment name to compartments the importer holds; a missing one fails with `403 compartment_not_available`, and version 1 records import as Unclassified, which the importer must hold. Reusing a key with a different bundle or option is a conflict.

## Responses and recovery

| Error | Meaning and caller action |
| --- | --- |
| `400 invalid_request`, `invalid_cursor`, `invalid_evidence_anchor` | Fix the request; do not retry unchanged |
| `401 unauthorized` | Obtain a token for this exact resource |
| `403 forbidden`, `user_required`, `source_not_authorized` | Outside the principal's grant or source rights |
| `403 compartment_not_available` | A named compartment does not exist or is outside this connection's allowance |
| `400 scope_required`, `connection_required` | Name the scope; the operation needs an AI connection's allowance |
| `409 compartment_exists`, `already_allowed` | The compartment name exists; the connection already has these compartments |
| `404 not_found` | Missing or not visible; existence of inaccessible records is not revealed |
| `409 revision_conflict` | Re-read and reconcile, then propose against the new revision |
| `409 idempotency_conflict`, `idempotency_key_reused` | Same key, different body or change; a caller bug |
| `409 confirmation_endpoint_mismatch` | Complete the confirmation through the OAuth resource that requested it; all MCP tools share `/mcp` |
| `410 cursor_expired` | Recall afresh and restart the feed |
| `413 payload_too_large`, `summary_too_large` | Request body over 1 MiB, or a change too large to show in full for approval; split it |
| `429 rate_limited` | Retry after the indicated delay. Each Gate connection has its own budget; repeated failed authentications from one address also exhaust a shared budget, during which only a credential that verified recently is accepted for verification |
| `503 restore_not_ready`, `curator_timeout`, `database_error` | Retryable after a delay; protected reads stay closed during restore reconciliation |

Keep the exact operation, `operation_id`, idempotency key and arguments of every write until its result is known. A lost response is an unknown outcome: resend the identical request or read the job status, never retry with a fresh ID.
