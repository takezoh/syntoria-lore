# Build an agent or workflow on Syntoria Lore

Lore is long-term memory with evidence for the user's authorized AIs. An agent remembers and recalls through REST or Remote MCP; Lore attributes, versions and governs what it stores. Your agent decides when to remember or recall, how to interpret a Context Pack and what to do next. Start with the existing tools and a clear permission boundary; Lore does not need an agent-specific integration.

## Find tools and schemas

| You need | Start here |
| --- | --- |
| Tools available to a connection | MCP `initialize` followed by `tools/list` on `/mcp/read` or `/mcp/write` |
| Input JSON Schema | Each discovered tool's `inputSchema` |
| REST request and response shapes | The served `/openapi.json`, or the checked-in [OpenAPI document](../api/openapi.json) |
| Operation semantics, errors and recovery | [MCP and HTTP API contract](../technical/mcp-api.md) |
| Memory kinds, authority, time and lifecycle | [Data model](../technical/data-model.md) |

The checked-in documents describe this source version. Before execution, inspect the connected deployment's tool list and reconcile any difference. Documentation is not evidence of a connection, a grant or a successful operation.

## Connect and authorize access

Connecting AI clients to the hosted service is not open yet. Gate-only API and worker revisions are deployed, and authorization initiation reaches GitHub, but the TLS certificate and explicit public API invocation approval are pending. A real user login, consent and authenticated hosted API/MCP access have not been accepted. Develop and test against the [local stack](../technical/local-operations.md) with operator-supplied Gate tokens or the actual local Gate integration harness; the repository does not issue local bearer tokens. See the [production release record](../eval/gate-production-release-20261018.md).

When enabled, a client obtains an opaque Gate OAuth access token for exactly one resource—the REST API, `/mcp/read` or `/mcp/write`—through authorization code with PKCE S256, using an explicitly registered client and exact redirect URI. Dynamic client registration and password grants are not offered. An operator separately maps the exact Gate issuer, immutable subject and client ID to an existing user/principal, scope list and capability ceiling. Current local grants further limit access on every request. A read-only connection has no write tools; a token for one resource is rejected by the others. Never pass a user or scope you were not granted, and never put tokens in URLs or logs.

| Capability | Typical use |
| --- | --- |
| read | Recall, get a memory, follow the change feed, read job, Forget and export status |
| write | Remember, capture, propose and commit change sets, submit feedback |
| admin (user) | Enable sources, list and decide reviews, Forget, change source rights and grants, set retention, export and import |

## Compose a workflow

Decide what triggers the workflow, which scopes it may read, which writes are authorized and what the user receives. Execution timing, external-source access and notifications belong to your agent's environment.

**Remember what the user states.** When the user explicitly asks to remember or correct something, call `remember_memory` (or a change set for a correction) with the user's words as evidence. It commits synchronously, and the next recall sees it. Do not label your own inference as the user's decision; Lore derives authority from the authenticated principal and evidence, not from your arguments.

**Capture conversations and work.** For ongoing material, the user first enables the source with consent. Then send observations with `capture`, a stable `operation_id` and an `Idempotency-Key`. Capture returns a job ID; poll `capture_status`. Safe facts may be committed automatically; preferences, decisions, conflicts and anything requiring reconciliation are held for the user's review. Keep an episode's condition, action and outcome together in one observation.

**Recall before you answer.** Call `recall_memories` with the user's question, a mode and a `token_budget` that fits your context. Use `precise` for names, decisions and IDs, `contextual` for current policy and background, `historical` with `valid_at` or `known_at` for questions about the past, `exploratory` for related experience and hypotheses, and `changes` for what changed. Present memories with their attribution; report contradictions and unknowns instead of filling them in.

**Correct with a change set.** Use `propose_changeset` and `commit_changeset` with the memory's `expected_revision`: SUPERSEDE when something changed, RETRACT when it was wrong, CORROBORATE or REFINE when new evidence supports or sharpens it, CONTEST or RELATE to record conflicts and links. A client cannot rewrite an user-attributed memory; propose instead and let the user decide.

**Forget on request.** Forget is an user operation. Call `forget_memory` with a selector and reason, then follow `forget_status` until purge completes. Do not keep your own copy of forgotten content.

## Continue from memory

Each conversation or workflow may hold an older view of the memory. Before relying on retained context, recall again or follow the change feed. To follow changes, keep the cursor from `get_changes` with your agent's own state and advance it only after you have applied a page. The cursor is opaque and bound to your principal, scopes and their authorization epochs; when your grant changes or the cursor expires (`cursor_expired`), recall afresh and restart from a new cursor. Deleted memories appear as content-free tombstones: drop any cached copy you hold.

Reading a memory does not confirm it, mark it as read by the user or make it true. Usage feedback (`submit_feedback`: useful, incorrect, stale, not relevant) queues the memory for reassessment; it never promotes a memory to truth.

## Recover safely

- Keep the exact tool name, `operation_id`, idempotency key and full arguments of every write until you have its result. On a lost response, resend the identical request or look up the job; never retry with a fresh ID.
- A `revision_conflict` means someone changed the memory: recall it again, reconcile, and propose against the new revision.
- `idempotency_conflict` means the same key was used with a different body; it is a bug in the caller, not a transient error.
- `restore_not_ready` and `503` responses are retryable after a delay; protected reads stay closed while a restored database reconciles deletions.

These patterns describe workflow designs, not installed schedules or evidence that a particular host is connected.
