# Build an agent or workflow with Lore

Lore gives an authorized AI access to the same versioned, evidence-linked memories through REST and Remote MCP. The client chooses when to remember or recall, interprets the result and decides what to do. Lore checks authority and source rights, preserves revisions and provides the evidence needed to assess a returned memory.

## Connect with the right authority

Gate owns sign-in and OAuth approval. A client needs a bearer token for the exact resource it calls: REST, `/mcp/read` or `/mcp/write`. An operator must also map the Gate issuer and immutable subject to an existing Lore user and principal; current grants further limit scopes and capabilities. Lore has no login page or public self-service registration flow. Its current access path depends on operator-configured resources and identity bindings.

Lore admits a Gate identity, not an individual OAuth client, and keeps the person apart from the AIs that act for them. When the operator turns this on for an account, every client that signs in with that Gate account acts as one non-user connection principal that reads the user's grants. Its writes receive `ai_proposal` authority, and Lore records the introspected client ID on each changeset as provenance. User authority comes only from a change the person approved at Gate, which Lore then applies as the user principal. Separate clients differ only in the resource they connect to and in that recorded client ID: give a client `/mcp/read` alone to keep it read-only.

`admin` is an internal capability attached to a personal-account grant. It is not a separate service administrator account. Some operations also require the authenticated actor to be the user, even when a client has broad `admin` capability. See [client access](sign-in.md) for the user-facing prerequisites and [API authorization](../technical/mcp-api.md#entry-points-and-authorization) for the exact rules.

For hosted use, ask the service operator to configure the exact resource, issuer/subject binding and grant, then verify the configured tool calls in that environment. A source checkout does not establish that a particular client, user or grant is connected. User-facing prerequisites are in the [client access guide](sign-in.md); dated deployment readbacks are in the [change confirmation release record](../eval/change-confirmation-release-20261029.md).

## Discover the available tools

For MCP, send `initialize` and then `tools/list` to the configured endpoint. Use each advertised tool's `inputSchema`; the deployment can expose a different version from this checkout. REST request and response shapes are in the served `/openapi.json` and the checked-in [OpenAPI document](../api/openapi.json).

| Need | Start with |
| --- | --- |
| Read-only workflow | `/mcp/read`: `recall_memories`, `get_memory`, `get_changes` and status tools |
| Write-capable workflow | `/mcp/write`: `remember_memory`, `capture`, ChangeSets, confirmation tools, review decisions, Forget, source and policy changes, and feedback |
| Operation meanings and errors | [MCP and HTTP API contract](../technical/mcp-api.md) |
| Memory evidence, authority and retrieval bounds | [Memory system](../technical/memory-system.md) |

REST and MCP use the same domain services. Do not assume that a connected client has permissions merely because its tool list contains an operation; authorization is checked on each request.

## Remember and capture

For a direct user request, send `remember_memory` with the requested kind, statement, evidence and an idempotency key. An explicit write is synchronous and its response says whether the record committed. Authority and lifecycle are derived from the principal's actor kind, the memory kind and the declared `epistemic_status`; a request cannot set authority directly.

A connection's writes always receive `ai_proposal` authority and start as candidates, whatever `epistemic_status` they declare. To record what the person actually said with their authority, put it in a ChangeSet with `propose_changeset` and call `request_user_decision`. Lore answers `confirmation_required` with a Gate `url` and the summary it will show; give the URL to the person, then call `complete_confirmation` with the `confirmation_id`. It returns `pending` until they act, then `committed`, `denied` or `expired`, or `failed` if what they saw changed meanwhile. An approval is consumed once, and completing again returns the stored outcome. Never present the summary as already approved, and do not convert an inference into the person's words.

If an operator admits an identity without a connection principal, that client acts as the user principal itself. Its writes with the default `asserted` status then receive user authority, so it must send `epistemic_status: "proposed"` for anything the AI suggested or inferred.

For a source workflow, the person must first approve the source: call `configure_source` (REST `POST /v1/connectors`) and complete its confirmation. The client sends observations through `capture` with the source revision, stable `operation_id` and `Idempotency-Key`, then reads `capture_status` for the returned job. Lore processes submitted observations; it does not fetch complete chat histories or crawl external documents itself.

The worker validates each proposal against exact source evidence and checks existing memories. It can commit only a narrow class of uncontested observed or inferred facts that have no unresolved match. Duplicate facts can add evidence to one existing memory. Decisions, preferences, conflicts, uncertain outputs and ambiguous matches can be held for user review. An episode must remain one complete condition/action/outcome experience. These are current server rules, not decisions an agent may bypass by changing its prompt.

When a review is available, read it with `list_reviews` or `get_review` and check its expected revision first. Deciding it goes through a confirmation. The person can accept the curator proposal with its attribution or record a separate user statement; the second choice does not independently verify a technical or third-party claim.

## Recall before answering

Call `recall_memories` with the question, authorized scopes, a mode, a result limit and a budget that fits the caller's context. Use `precise` for exact statements, subject names and aliases; `contextual` for relevant current background; `historical` with `valid_at` or `known_at` for a past view; `exploratory` for related memories including candidates; and `changes` for changed records. `changes` is a separate change-oriented search mode; use `get_changes` with a saved cursor when the workflow needs the ordered feed.

Present a memory with its attribution and evidence, distinguish assertions from observations, and report insufficiencies or contested items. `unknown` means the bounded query found no supported result; it does not prove the information was never stored. Search limits, score fusion, index lag and Context Pack size are detailed in [retrieval and Context Packs](../technical/memory-system.md#retrieval-and-context-packs).

## Correct, give feedback and forget

To revise a known memory, read its current revision and use `propose_changeset` followed by `commit_changeset` with that `expected_revision`. Use `SUPERSEDE` when it changed over time, `RETRACT` when it was wrong, `CORROBORATE` to add evidence, `REFINE` to produce a revision, and `CONTEST` or `RELATE` to record an evidenced dispute or link. A stale revision returns `revision_conflict`; recall again and reconcile before proposing. Only a user principal may supersede or retract, and a non-user principal cannot refine a user-attributed memory, so a connection commits such a ChangeSet through `request_user_decision`.

`submit_feedback` accepts `useful`, `incorrect`, `stale` or `not_relevant` and queues reassessment. It does not change the memory by itself and should not be treated as a truth vote. Forget is a user operation: call `forget_memory`, complete its confirmation after the person approves, keep the request ID from the result and follow `forget_status` until purge completes. Source rights, scope access and retention changes work the same way. Export and import stay unavailable to connections. Suppression takes effect immediately; the worker handles physical deletion. Never retain forgotten content in an agent cache.

## Keep clients in sync and recover safely

Each workflow should keep its own `get_changes` cursor. Advance it only after applying the complete page. If the cursor expires or authorization changes, discard that position, recall current state and start a new feed. Deletion events have no content, so remove any corresponding local copy.

- Keep the exact tool name, idempotency key and full arguments for each write until its outcome is known. After a lost response, resend the same request or read the job status; do not invent a new key.
- `revision_conflict` means re-read and reconcile before writing again.
- `idempotency_conflict` means a key was reused with a different request body; fix the caller.
- `401` means the token is absent, expired or for another resource. Obtain the matching Gate token.
- `403` means the identity or operation is outside its current binding, grant or source rights. Do not retry with broader user arguments.
- Retry a retryable `503` after a delay. `restore_not_ready` means protected reads remain closed while deletion reconciliation is incomplete.

These patterns describe how a client can use the service. They do not install a schedule, create a client registration, issue a grant or prove that a particular hosted client is connected.
