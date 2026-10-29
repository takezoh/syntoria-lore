# Change confirmation design

This document turns [ADR 0003](../adr/0003-attribute-ai-clients-and-confirm-user-decisions.md) into contracts for Gate and Lore. It is for the people who implement and review both services. It was written directly on 2026-10-28, because the dev-skills design runtime was unavailable (`production-design-source-unavailable`). Units U1 to U5 were implemented on 2026-10-28 and 2026-10-29 and released to production on 2026-10-29, when the switch was also set (see [Implementation units](#implementation-units)). Nothing is accepted, and no formal design gate or independent review has run.

## Outcome

Any AI the person connected can read and propose. Only the person can make a change carry user authority or change governance, and only by approving that exact change at Gate. Lore records which AI client asked for each change, but no permission depends on it.

## Terms

| Term | Meaning |
| --- | --- |
| Connection | One Gate approval of one AI client registration (`connection_id`, `client_id`). It is active while it is approved, not revoked and its grant has not expired. The existing `hasActiveOAuthConnection` check does not read grant expiry, so the confirmation checks must add it |
| User principal | The person's existing Lore principal, actor kind `user`, named by the binding's `principal_id` |
| Connection principal | One principal per admitted subject, actor kind `client`, that every connection of that person acts as |
| Protected operation | An operation that requires actor kind `user` (listed under [Protected operations](#protected-operations)) |
| Confirmation | A Gate record that one exact protected change was approved or denied by the signed-in person |

## Flow

1. An AI calls a protected operation over its connection. Lore authenticates it as the connection principal, so the operation would fail with `user_required`.
2. Instead, Lore stores the exact operation as a pending confirmation, renders a plain-text summary from the stored data and computes a change hash.
3. Lore creates a Gate confirmation with its resource credentials and returns `confirmation_required` with the Gate URL.
4. The AI shows the URL. The person signs in at Gate, reads the summary and approves or denies.
5. The AI calls `complete_confirmation`. Inside the commit transaction, Lore re-verifies the connection and binding, consumes the Gate approval online, marks the local record committed and runs the stored operation as the user principal.

The AI never supplies the summary, never sees an approval secret and cannot complete a change that the person did not approve.

## Gate contract

### Resource API

Every endpoint authenticates the calling resource with its existing introspection credentials (HTTP Basic, as `/browser/session/introspect` does). A record belongs to the resource that created it; any other resource receives the same response as for a missing record.

**`POST /confirmations`** creates a pending confirmation. The JSON body has exactly these fields:

| Field | Rule |
| --- | --- |
| `subject` | Must equal the configured account and the connection's subject |
| `connection_id` | Must name an active, approved OAuth connection of that subject |
| `reference` | The resource's own record ID, 1–128 visible ASCII characters, unique per resource |
| `change_hash` | `sha256:` followed by 64 lowercase hex characters |
| `summary` | `{ "title": string, "lines": string[] }`; plain text without control characters; title at most 120 characters; at most 64 lines and 4000 characters in total |

It returns 201 with `{ "id", "url" }`. `id` is 32 random bytes in base64url; `url` is `<issuer>/confirm?id=<id>`. Errors: 400 invalid body, 401 resource credential, 403 subject or connection mismatch, 409 duplicate reference, 413 body over 16 KiB, 503 storage.

A confirmation has no timer of its own. It stays valid while the requesting connection is active; Gate connections last at most 30 days. Once that connection is revoked or expires, Gate treats the confirmation as expired.

**`POST /confirmations/consume`** takes `{ "id", "reference", "change_hash" }`. In one Firestore transaction it checks that the record belongs to the caller and matches the reference and hash, then:

| Stored state | Response `status` | Effect |
| --- | --- | --- |
| Approved, connection active | `consumed` | State becomes `used`; summary deleted |
| Pending, connection active | `pending` | None |
| Denied | `denied` | None |
| Used | `used` | None |
| Connection inactive, cancelled or missing | `expired` | None |

A `consumed` response also returns `subject`, `connection_id` and `decided_at`. Only `consumed` authorizes a change.

**`POST /confirmations/cancel`** takes `{ "id", "reference" }`, moves a pending or approved record to `cancelled` and deletes its summary. It is idempotent.

### Approval page

- `GET /confirm?id=<id>` requires the Gate identity session. Without it, Gate shows a sign-in page that is identical for every well-formed ID; continuing starts the GitHub sign-in, which returns to the same confirmation. An unknown ID, or one whose subject differs from the signed-in identity, receives 404.
- The page shows the resource audience, the requesting client as `Unverified name` from Gate's own connection record, and the title and every summary line (HTML-escaped). It uses the shared page headers: `frame-ancestors 'none'`, a `form-action 'self'` restriction, a stylesheet admitted by hash, `no-store` and `nosniff`.
- `POST /confirm` accepts exactly the form fields `id`, `csrf` and `decision` (`approve` or `deny`). It requires `Origin` equal to the issuer and the identity session's CSRF value. It re-checks the subject, that the record is pending and that the requesting connection is still active.
- Approval records `decided_at`. The approval stays consumable while the connection is active. Denial deletes the summary. After a decision, Gate redirects only to the same confirmation on Gate, which tells the person to return to their AI, so the page cannot be used as an open redirect.

### Storage

- Records live in `<namespace>_confirmations`, keyed by a SHA-256 hash of `id`. Each record's `expiresAt` is the requesting connection's grant expiry and is covered by the Firestore TTL policy. Validity is decided at read time from the connection's current state, regardless of TTL timing.
- Gate sets no limit on the number of pending records. Only an authenticated resource can create them, on behalf of an active connection, and the person sees only the URLs an AI shows them. Lore returns an existing pending confirmation for an identical change instead of creating another.
- Summaries contain memory text. Gate keeps a summary only while the record is pending or approved, deletes it on decision, consumption or cancellation, and otherwise loses it to TTL after the connection ends.

### SDK

`@syntoria/gate-sdk` gains `createGateConfirmations(config)` with `create`, `consume` and `cancel`. It reuses the verifier's issuer, credentials, timeout, response size limit and fail-closed `GateError(503)` behavior.

## Lore contract

### Principals and binding

- `principals.acts_for_principal_id` names the user principal that a connection principal acts for. Only a non-user principal may have it, and the target must be an active user principal of the same user.
- `external_identity_bindings.connection_principal_id` names the connection principal. While it is null, connections act as the binding's principal, which was the only behavior before 2026-10-29. The production binding has named a connection principal since then. Setting or clearing it is the stage 3 switch and is done only through the reviewed identity-mapping tool (`--connection-principal enable|disable`), which creates or reuses the connection principal and refuses a binding whose principal is not an active user principal.
- `app.lock_actor_access` reads grants through `coalesce(acts_for_principal_id, id)` and requires the parent to be active. Revoking or expiring the user's grant therefore removes the connection principal's access at the next check.
- The connection principal's issuer is `urn:syntoria:lore:connection` and its subject is a value unique to its binding. The authenticator selects principals only through bindings, so no Gate token can resolve to it directly.
- `app.lock_external_identity_binding` returns the acting principal (the connection principal when one is named) and the binding's user principal. It returns no row when a named connection principal is inactive, a user, or acts for a different principal.

### Provenance

`ActorContext` carries the verified `clientId`. Each changeset records `client_id`; memory versions already reference their changeset. No authorization rule reads `client_id`.

### Protected operations

The first iteration covers:

- committing a proposed changeset with user authority, through the new `request_user_decision` tool and REST route
- `decide_review`
- Forget, by memory, source or subject selector
- `change_source_rights`, `change_scope_grant` and `set_retention_policy`
- `configure_source`, which enables or disables capture from a source and records the person's consent (migration 0047, added on 2026-10-29 after the switch showed that no connection could enable a source otherwise)

Export and import are not offered through confirmations and keep refusing non-user actors with `user_required`. Lore runs as one shared environment, so moving data between environments through an AI is not a use case.

Reading is not a change. A connection principal (`ActorContext.actsForUser`) may list and read curation reviews, so an AI can show the person what waits for their decision. A separately admitted non-user principal still cannot.

### Pending confirmations

A `change_confirmations` table, with forced row-level security like the other tenant tables, stores:

- the confirmation ID, user, scope and requesting principal
- the Gate subject, `client_id` and `connection_id`
- the requesting endpoint's audience
- the operation name and its exact payload
- the rendered summary and the change hash
- the Gate confirmation ID and URL
- the status (`pending`, `approved`, `committed`, `denied`, `expired`, `cancelled` or `failed`)
- the approval and resolution times and the response

The existing `user_confirmations` table records statements made during curation review and is unrelated. Resolution clears the payload and summary, so no finished row keeps memory text.

The change hash is SHA-256 over the RFC 8785 canonical JSON of `{v: 1, confirmation_id, user_id, scope_id, operation, payload, summary}`. Including the summary binds what the person saw to what Lore executes.

Lore renders the statements, kinds, statuses, subjects, validity, context, targets and reasons of the change into the summary, together with the scope name. Evidence appears by source kind, external ID and locator; evidence snippets and spans are not shown. Lore never truncates a summary: if a summary exceeds Gate's limits, Lore refuses with 413 and the AI must split the change.

### Tool and API behavior

- A protected operation called by a non-user actor returns HTTP 202 (MCP: a successful result) with `{ "status": "confirmation_required", "confirmation": { "confirmation_id", "url", "summary", … } }`, not `user_required`. The same idempotency key returns the same confirmation, and reusing it for a different change returns 409. A pending confirmation for the same operation and payload from the same principal is returned instead of creating another. Operations without an idempotency key use the request's content hash as one.
- `get_confirmation` (MCP read endpoint) and `GET /v1/confirmations/{id}` return the local state without changing anything.
- `complete_confirmation` (MCP write endpoint) and `POST /v1/confirmations/{id}:complete` apply an approved change once. They return `committed` with the change's normal response, or `pending`, `denied`, `expired`, `cancelled` or `failed` without applying anything. A confirmation completes only through the endpoint that requested it, because Gate consumes it only for that resource's credentials; another endpoint receives 409.
- A User actor keeps calling the same tools and routes and is never asked for a confirmation.

### Commit

Existing operations use several transactions, so the Gate consumption cannot share the operation's own commit. Completion therefore has two phases:

1. **Approve.** In one transaction under the connection actor, Lore locks the pending row and consumes the Gate confirmation online. On `consumed` with the row's subject and connection, the row becomes `approved`. Denied and expired results end the row; a mismatch fails it. The connection actor's guard re-checks the binding and token before this commit.
2. **Apply.** Lore derives an actor for the binding's user principal, refuses with `confirmation_stale` if the changeset proposal or a shown memory revision changed, and runs the stored operation under the idempotency key `confirmation:<id>`. Every commit inside the operation re-checks the connection and binding. On success the row becomes `committed`; a permanent client error makes it `failed`.

If applying fails transiently, or the connection is revoked first, the row stays `approved` and nothing is applied. A later completion retries the same idempotent operation without a second approval. If the approval transaction fails after Gate reported `consumed`, the row stays pending and Gate answers `used`, so the person must approve again: fail-closed. The outcome is recorded under row-level security without re-checking grants, because Forget advances the scope's authorization epoch.

### Interaction with Forget

A trigger on memory suppressions, which covers Forget and retention, cancels pending confirmations that show the memory and fails approved ones other than the Forget being applied. Both clear the stored payload and summary. After a Forget through the API, Lore also cancels those confirmations at Gate as a best effort, for confirmations created through the same endpoint. A failed Gate cancel leaves the summary bounded by the requesting connection's lifetime and TTL.

## Requirements

Gate:

- **G-1** When a resource creates a confirmation, Gate shall store it only if the subject is the configured account and the connection is an active approved OAuth connection of that subject.
- **G-2** Gate shall return a confirmation's state only to the resource that created it.
- **G-3** When `GET /confirm` is requested without an identity session, Gate shall start sign-in and return to that confirmation.
- **G-4** If the signed-in identity is not the confirmation's subject, Gate shall refuse to display or decide it.
- **G-5** When a decision is posted, Gate shall accept it only with the issuer Origin, the identity CSRF value, exactly the expected fields, a pending record and an active requesting connection.
- **G-6** When an approved confirmation is consumed with matching reference and hash while its connection is active, Gate shall mark it used in the same transaction and report `consumed` exactly once.
- **G-7** While the requesting connection is revoked or expired, Gate shall treat its confirmations as expired.
- **G-8** Gate shall delete a confirmation's summary when it is decided, consumed or cancelled.
- **G-9** If storage or validation fails, Gate shall create, approve or consume nothing.

Lore:

- **L-1** Lore shall record the verified `client_id` with every changeset written over a connection.
- **L-2** While a binding names a connection principal, Lore shall authenticate every connection of that subject as that principal.
- **L-3** When a non-user actor requests a protected operation, Lore shall store the exact operation, or reuse the pending confirmation for an identical operation, and return `confirmation_required` without executing it.
- **L-4** Lore shall render the summary only from the stored payload and shall reject, not truncate, a summary that exceeds Gate's limits.
- **L-5** When completing a confirmation, Lore shall execute the stored operation as the user principal only after a `consumed` Gate response with matching subject and connection has been recorded as `approved`, and only while every commit of the operation re-verifies the connection and binding.
- **L-6** Lore shall commit each confirmation at most once.
- **L-7** If the confirmation is pending, denied, expired, cancelled or used, Lore shall execute nothing.
- **L-8** When the user principal's grant, the binding or the connection is revoked or expires before commit, Lore shall execute nothing.
- **L-9** When Forget or retention suppresses a memory, Lore shall cancel pending confirmations that reference it and fail approved ones other than the Forget being applied.
- **L-10** If a shown changeset proposal or memory revision changed after the request, Lore shall refuse to apply the confirmation.

Invariant:

- **I-1** No path other than a completed confirmation shall produce user authority or a protected operation from a request over a Gate connection while the binding names a connection principal.

## Verification

| Requirement | Check |
| --- | --- |
| G-1, G-2, G-9 | Gate unit and Firestore Emulator tests: wrong subject, inactive connection, other resource, storage fault |
| G-3 to G-5, G-7, G-8 | Provider integration test through sign-in, approval page headers, CSRF, Origin, field set, subject mismatch, revoked or expired connection before approval and before consumption, and summary removal |
| G-6, L-6 | Concurrent consume test: one `consumed`, every other call `used` |
| L-1 | PostgreSQL test: changeset rows carry the verified `client_id` |
| L-2, I-1 | Two clients of one subject act as the same `client` principal; an asserted decision they write is `ai_proposal`; a protected route returns `confirmation_required` |
| L-3, L-4 | The Gate request carries the stored summary and reference; the same key returns the same confirmation and a reused key with another change returns 409; an oversized summary returns 413 |
| L-5, L-6, L-7, L-8 | Pending, approved once, completed again, denied, hash-modified and other-subject confirmations; a connection revoked after approval; completion through another endpoint |
| L-9 | A direct Forget cancels a pending confirmation locally and at Gate and clears its stored content |
| L-10 | A memory refined after the request makes the approved Forget fail with `confirmation_stale` |

Implemented checks: the Lore cases above run in `tests/core.postgres.test.ts` against a synthetic Gate. The Gate cases run against the Firestore Emulator. Removing the subject and connection check, the Forget trigger or the staleness check each made a Lore test fail. On the Gate side, removing the hash comparison, the `used` transition, the CSRF check or the connection check each made a Gate test fail.

## Implementation units

Ordered by dependency. Each unit is reviewable and reversible on its own.

| Unit | Repository | Content | Depends on | Local status |
| --- | --- | --- | --- | --- |
| U1 Provenance | Lore | `ActorContext.clientId`; migration 0044 adding `changesets.client_id`; tests; data-model doc | — | Implemented |
| U2 Confirmation service | Gate | Storage model, resource API, approval page, sign-in return, TTL policies, tests, API/security/integration docs | — | Implemented |
| U3 SDK | Gate | `createGateConfirmations` with tests | U2 | Implemented |
| U4 Confirmation flow | Lore | Migration 0045 for `change_confirmations` and the suppression trigger; summary renderer and hash; confirmation service; tools and REST routes; protected-operation routing; tests; MCP/data-model/security docs | U3 | Implemented |
| U5 Connection principal | Lore | Migration 0046 for `acts_for_principal_id`, `connection_principal_id` and both lock functions; authenticator and user-actor derivation; identity-mapping tool support; tests; identity and runbook docs | U4 | Implemented |
| U6 Release and switch | Operations | Deploy Gate, then Lore; hosted readback; set `connection_principal_id` for the admitted subject; clearing it reverts | U1–U5, owner approval | Released and switch set on 2026-10-29 ([change confirmation release record](../eval/change-confirmation-release-20261029.md)) |

U1 and U2 can proceed in parallel. U5 can be written alongside U4, but U6 must not set the switch before U4 is deployed, or the person loses user authority entirely. The switch is set only with the identity-mapping tool's reviewed baseline, never by hand.

## Decisions

Decided by the owner on 2026-10-28:

- Approval needs the Gate sign-in only; no passkey or other user verification is required.
- Lore is one environment shared by every AI and device, so export and import are not offered through confirmations.
- A confirmation and its approval have no timer and remain valid while the requesting connection is active, and there is no limit on pending confirmations. Neither is needed for security: only the signed-in person can open a confirmation, revision checks reject changes whose targets moved, and the person sees only the URLs an AI shows them.

## Prerequisites and limits

- U6 requires the production binding's principal to be a user principal. It has not been read, and must be read before U6.
- A person who approves without reading is not detected. An AI that controls the person's signed-in browser can approve; the owner accepted this by not requiring user verification.
- Reads remain authorized by connection approval alone, so a misused connection can still read the admitted scopes.
- An undecided summary, which contains memory text, can remain in Gate until the requesting connection ends, up to 30 days, if Lore's cancellation after Forget fails.
- A confirmation requested near the end of a connection's life expires with that connection; the person must reconnect the AI and request again.
