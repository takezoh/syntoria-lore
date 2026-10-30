# Memory compartments design

This document turns [ADR 0006](../adr/0006-enforce-disclosure-with-compartments-and-connection-allowances.md) into contracts for Lore. It is for the people who implement and review the change. It was written directly on 2026-10-30 because the dev-skills design runtime could not reach its cross-host transport. No formal design gate or independent review has run. The owner accepted the ADR and the [recommended decisions](#decisions) on 2026-10-30; implementation is tracked in [Implementation units](#implementation-units).

## Outcome

One person keeps memories across private life, several companies, businesses and activities. A newly connected AI can save and recall General memories at once, without UUIDs. A memory that is confidential to a company, a client engagement or a private matter reaches only the AI connections allowed to receive it, and anything derived from it carries the same restriction.

## Terms

| Term | Meaning |
| --- | --- |
| Compartment | A named confidentiality obligation of the user: an employer, a client engagement, a friend's confidence, health. Compartments belong to the user and span scopes |
| Label | The set of compartments on a record. A recipient needs every compartment in it. The empty label is General |
| General | Records with an empty label. Every admitted connection with `read` can receive them |
| Unclassified | A reserved compartment that labels every record created before compartments existed |
| Allowance | The compartments one Gate connection may receive and write. Keyed on issuer, subject and `connection_id` ([O1](#decisions)) |
| Effective set | The allowance, intersected with the compartments a request names to narrow it |
| Effective label | For a memory version: its own label united with the memory's current label |
| Narrowing | Removing compartments from an allowance, or adding compartments to a record's label |
| Widening | Adding compartments to an allowance |
| Relaxation | Removing compartments from a record's label; for a version, a declassification |
| Context | What a memory is about. Not enforced; expressed by subjects and the memory's `context` |

Scopes keep their current meaning: storage, grant, retention, export and change-feed partitions. A single-user deployment can use one scope.

## Disclosure model

A record reaches a connection only if its scope is among the actor's effective scopes and its effective label is a subset of the effective set:

```text
visible(record) = record.scope_id ∈ effective_scopes
              AND effective_label(record) ⊆ allowance(connection) ∩ narrowing(request)
```

Labels are canonical: sorted, without duplicates, with General as the empty array. Because a label is a conjunction, adding a compartment always restricts and removing one always widens. This makes the safe default for an uncertain write the larger label.

### Labels on records

| Record | Label rule |
| --- | --- |
| Source | Set when the source is configured, within the configuring connection's allowance. Narrowing applies to later observations; relaxation is protected |
| Observation, episode, evidence | Copied from the source when accepted; immutable |
| Memory version | Immutable. Contains the label of every cited evidence item and of the previous version, unless the version is an approved relaxation |
| Memory | The current version's label. Its effective label applies to all earlier versions |
| Subject, alias | Set at creation; names are unique per scope, label and normalized name ([O4](#decisions)) |
| Memory–subject link | Visible when both the memory and the subject are visible |
| Relation | Visible when both endpoint memories are visible |
| Changeset, change operation | The union of the labels its operations read or write |
| Change-feed event | The effective label at commit time, and while the memory exists, its current label |
| Curation review, user confirmation | The union of the labels of the cited observations and targets |
| Change confirmation | The union of the labels of what its summary shows |
| Stored idempotent response | The union of the labels of the records it contains |
| Embedding, feedback | Visible when the memory version it derives from is visible |
| Audit event, deletion records | Content-free; not labeled. Forget tombstones carry the label snapshot of the forgotten memory |

Every table that stores memory, observation or source text, or identifiers derived from them, carries a label or derives visibility from a labeled parent. The migration review lists each table and its rule.

### Narrowing and relaxing a memory

`RECLASSIFY` is a new change operation. It creates a revision with the same statement, context, interval and evidence and a different label.

- A `RECLASSIFY` that only adds compartments within the writer's allowance commits like any other change. Because the memory's current label joins every earlier version's effective label, narrowing hides the whole history from connections that lack the added compartment.
- A `RECLASSIFY` that removes a compartment is a relaxation. Committing it is a protected change under the binding's approval policy. Earlier versions keep their own labels, so a relaxation exposes only the relaxed version and later ones.
- A relaxed version may cite evidence whose label is outside the relaxed label. A reader whose effective set does not cover that evidence does not receive it; the memory view reports its count as `withheld_evidence`.

### Writes

| Request | Applied label |
| --- | --- |
| Explicit label within the allowance, not General | That label |
| Explicit label outside the allowance | Rejected with `compartment_not_available` |
| Label omitted, allowance has no compartments | General |
| Label omitted, allowance has compartments | The effective set's compartments, or the allowance's when the narrowing leaves none |
| General, explicit or by the rule above, from a connection whose allowance has compartments | Held: stored with the allowance's compartments, returned with the relaxation request the connection can submit |

Every resulting label then joins the labels of cited evidence and of the previous version. Each version records how its label was set (`explicit`, `default`, `held`, `reclassified` or `relaxed`) and the requesting connection.

Under `auto`, the relaxation that releases a held write is applied once requested and recorded as approved by policy. The hold makes the release a separate, attributed step; it does not stop a misled AI.

### Allowances

- A connection without a recorded allowance has General only.
- `create_compartment` creates a compartment with a unique normalized name and adds it to the creating connection's allowance. It discloses nothing, because a new compartment holds no records.
- `narrow_access` removes compartments from the calling connection's own allowance at once.
- `request_compartment_access` names compartments to add to the calling connection's allowance. It is a protected change under the binding's approval policy: applied at once and recorded as `policy` under `auto`, or returned as `confirmation_required` under `gate`.
- A compartment name that does not exist and one that cannot be granted return the same error. Creating a compartment whose name already exists fails, which reveals that the name exists; the user should prefer neutral names.
- A connection manages only its own allowance. Revoking the connection at Gate ends it; a new approval starts from General.
- Every allowance change advances the allowance epoch, records the requesting connection and its approval, and invalidates cursors and replays bound to the old epoch.
- Authentication reads the allowance with the grants. Before every commit, Lore rereads it under a share lock and refuses the commit with `stale_authorization` if its epoch changed since authentication.
- An actor that applies an approved protected change as the user keeps the requesting connection's allowance, so a change approved by policy or by the person never reaches records the connection could not see (GOV-1).

### Reads

- Recall, memory reads, the change feed, reviews, confirmations and idempotent replays apply the effective set before ranking and again before returning.
- Lore does not list, count or hint at records, compartments, subjects or relations outside the effective set, in results, coverage, insufficiencies, conflicts or errors. Existing `404` semantics are kept.
- An evidence item outside the effective set, cited by a visible relaxed version, is omitted, and the memory view reports `withheld_evidence` with the number omitted; no locator, snippet, speaker or source identity is returned. Source-rights and Forget checks still include it through a lookup function that does not depend on the reader's context.
- A change-feed event that narrows a memory out of the reader's allowance is returned once as a content-free `WITHDRAWN` event with the memory ID.
- `get_access` returns the connection's visible scopes and compartments by name and ID, its write default, whether a General write would be held, and the binding's approval policy.
- A read that omits scopes uses every effective scope. A write that omits the scope uses the only writable scope, or returns the visible choices.

### Database enforcement

The application layer decides the effective set and every label it writes, filters change-feed events, and implements what RLS cannot express: withheld evidence, `WITHDRAWN` events and hidden existence. Each transaction sets `app.compartment_ids` to the effective set, beside the existing `app.user_id`, `app.scope_ids` and `app.principal_id`, and the restrictive policies then enforce row visibility for every query; writes use the allowance, and only reads are narrowed by a request.

- Restrictive policies named `compartment_visibility` are added to labeled tables for the application and worker roles only. They are combined with the existing permissive `tenant_scope` policies. Executor policies for purge, maintenance, export and the ledger are not changed.
- An unset `app.compartment_ids` is read as the empty set, so a missed context exposes at most General records, and an unset scope context still exposes nothing.
- Policies for derived tables check their labeled parents through `EXISTS`, which is itself subject to the parent's policies.
- The worker sets the user's full compartment list explicitly; there is no unrestricted flag.

Today `app.scope_ids` is set in nine places: `packages/auth/src/index.ts`, `packages/domain/src/authorized-transaction.ts`, two in `packages/domain/src/core-service.ts`, two in `packages/governance/src/forget-service.ts`, `packages/governance/src/portability-service.ts`, `packages/jobs/src/index.ts` and `apps/api/src/confirmations.ts`. All of them must move to one helper that also sets the compartment context, and a lint or test must reject a new direct setter.

### Governance and portability

- Forget, the deletion ledger, purge, retention and restore reconciliation keep their semantics. A Forget requested over a connection reaches only records visible to it.
- Cursors move to payload version 2, which binds the allowance epoch and compartments. A version 1 cursor reads as General only at epoch 0, so it stays valid for a connection that never had compartments and otherwise returns `410 cursor_expired`.
- Export moves to payload version 2 and includes the compartments used and every row's label. It covers every compartment in the scope and is available only to the user principal acting directly, which no Gate connection can be. Import maps version 2 compartments by name to compartments the importer holds and fails with `compartment_not_available` otherwise; a version 1 bundle imports as Unclassified, which the importer must hold.

### Gate

No Gate change is required: Lore already receives `connection_id`. Letting the person choose compartments on Gate's approval page, for example with RFC 9396 `authorization_details`, is a possible later Gate change.

## Requirements

Compartments and allowances:

- **CMP-1** Lore shall store compartments per user with a unique normalized name and shall treat a record with an empty label as General.
- **CMP-2** Lore shall create one reserved Unclassified compartment per user and label every record that existed before this change with it.
- **CMP-3** When a connection creates a compartment, Lore shall add it to that connection's allowance and record the connection.
- **ALW-1** While a connection has no recorded allowance, Lore shall use General only.
- **ALW-2** When a connection narrows its own allowance, Lore shall apply it at once and advance the allowance epoch.
- **ALW-3** When a connection requests a compartment outside its allowance, Lore shall treat the request as a protected change under the binding's approval policy.
- **ALW-4** If a requested compartment does not exist or cannot be granted, Lore shall return the same error in both cases.
- **ALW-5** When an allowance changes, Lore shall reject cursors and idempotent replays bound to the previous allowance epoch.

Reads:

- **RD-1** Lore shall return a record over a connection only if its scope is effective and its effective label is a subset of the effective set.
- **RD-2** Before any query, Lore shall set the transaction's compartment context to the effective set.
- **RD-3** Lore shall not list, count or signal records, compartments, subjects or relations outside the effective set in any response or error.
- **RD-4** When a visible relaxed version cites evidence outside the effective set, Lore shall omit that evidence, report how many items it withheld, and return none of their locators, snippets, speakers or sources.
- **RD-5** When a change-feed event narrows a memory out of the reader's effective set, Lore shall return it once as a content-free `WITHDRAWN` event.
- **RD-6** Lore shall replay a stored response, show a confirmation or list a review only to a connection whose effective set covers its label.
- **RD-7** When a client calls `get_access`, Lore shall return its visible scopes and compartments by name and ID, its write default, whether a General write would be held, and the approval policy.
- **RD-8** When a read omits scopes, Lore shall use every effective scope; when a write omits the scope, Lore shall use the only writable scope or return the visible choices.

Writes:

- **WR-1** If a write's explicit label is not a subset of the allowance, Lore shall reject it with `compartment_not_available`.
- **WR-2** When a write omits its label, Lore shall apply the effective set's compartments, or the allowance's when the narrowing leaves none, or General when the allowance has none.
- **WR-3** When a connection whose allowance has compartments writes with a General label, Lore shall store the write with the allowance's compartments, mark it held and return the relaxation request it can submit.
- **WR-4** Lore shall give each new version a label that contains the labels of its cited evidence and of the previous version, unless the version is an approved relaxation.
- **WR-5** When a `RECLASSIFY` only adds compartments within the allowance, Lore shall commit it like any change; when it removes a compartment, Lore shall treat its commit as a protected change under the binding's approval policy.
- **WR-6** Lore shall record with each version how its label was set and which connection requested it.

Derived content:

- **DRV-1** Lore shall copy a source's label to each observation, episode and evidence item when it is accepted.
- **DRV-2** Lore shall label a curator proposal and the memory it creates with the union of its cited observations' labels.
- **DRV-3** Lore shall return a relation only when both endpoints are visible, and a memory–subject link only when both the memory and the subject are visible.
- **DRV-4** Lore shall keep subject names unique per scope, label and normalized name.
- **DRV-5** Lore shall return embeddings, feedback, reviews, confirmations and stored responses only when the records they derive from are visible.
- **DRV-6** When a memory is narrowed, Lore shall hide all its earlier versions from connections lacking the added compartments; when it is relaxed, Lore shall expose only the relaxed version and later ones.

Governance and migration:

- **GOV-1** A Forget requested over a connection shall reach only records visible to it; purge and maintenance executors shall remain outside compartment policies.
- **GOV-2** Export shall include compartments and labels in payload version 2; import shall map them to compartments the importer holds, and importing a version 1 bundle shall label its records Unclassified.
- **GOV-3** The worker shall set the user's full compartment list explicitly.
- **MIG-1** The migrations shall label existing rows with a constant Unclassified default and, once the write path sets labels, require an explicit label on every new row.
- **MIG-2** Restrictive compartment policies shall be added for the application and worker roles without changing existing permissive or executor policies.

Invariants:

- **I-1** No record leaves Lore over a connection unless its effective label is within that connection's effective set.
- **I-2** No request field, tool argument or model output widens an allowance or relaxes a label; only a protected change approved under the binding's policy does.
- **I-3** A derived record's label contains the labels of everything it was derived from, except a version created by an approved relaxation.
- **I-4** A transaction without compartment context exposes at most General records, and one without scope context exposes none.

Non-functional:

- **NFR-1** The compartment policies shall keep the existing recall and remember targets in [product requirements](requirements.md); their overhead shall be measured locally and recorded, not assumed.
- **NFR-2** Logs and audit events shall not contain compartment names that the event's reader could not see; they record IDs only.

## Scenarios

| Scenario | Expected behavior | Requirements |
| --- | --- | --- |
| 1. A general preference | General; every connection receives it | CMP-1, RD-1 |
| 2. A private health memory | Labeled Health; only connections with Health receive it | RD-1, I-1 |
| 3. A company A decision | Labeled A; a private connection without A never receives it, its relations or its subjects | RD-1, RD-3, DRV-3 |
| 4. Businesses A and B | A connection with B only never receives A records, and receives General lessons | RD-1 |
| 5. Confidential to A and client B | Labeled {A, B}; only connections with both receive it | RD-1, WR-4 |
| 6. A sanitized lesson from A | The person approves a relaxation to General; A's evidence is withheld from others | WR-5, RD-4, DRV-6 |
| 7. A new ChatGPT connection | `get_access` shows General; save and recall work without UUIDs | ALW-1, RD-7, RD-8 |
| 8. A write without a label from a connection with General and A | Labeled A, recorded as `default` | WR-2, WR-6 |
| 9. A document tells the AI to request every compartment | Under `gate`, nothing widens without the person; under `auto`, the widening is applied and recorded with the requesting connection | ALW-3, I-2 |
| 10. The person left company A | A memories stay labeled A; current-state questions prefer current contexts; Weave keeps current work state | RD-1 |
| 11. A is removed from a connection | The next recall excludes A; the cursor must restart | ALW-2, ALW-5 |
| 12. A General write from a connection with A | Held at {A}; released only by a relaxation | WR-3 |
| 13. An application query that forgets the label filter | RLS returns no restricted rows | RD-2, I-4, MIG-2 |

## Verification

| Requirement | Check |
| --- | --- |
| RD-1, RD-3, I-1 | PostgreSQL tests: two connections of one subject with different allowances; recall in every mode, `get_memory` current and historical, relation expansion, subject and alias matching, reviews and confirmations never return the other's records or reveal them in coverage or errors |
| RD-2, I-4, MIG-2 | Tests that run the same queries with the application filter removed and with the compartment context unset; executor roles still purge labeled rows |
| RD-4, DRV-6, WR-5 | Relax a memory under `auto` and under `gate`; earlier versions stay hidden; withheld evidence carries no locator, snippet, speaker or source |
| RD-5, ALW-2, ALW-5 | Narrow a memory and an allowance during a feed; `WITHDRAWN` appears once; old cursors and replays are rejected |
| RD-6 | Replay an idempotency key and read a confirmation from a second connection without the label |
| WR-1 to WR-4, WR-6 | Write matrix: explicit, omitted, narrowed, held, evidence from another compartment, refine of a labeled memory |
| ALW-1, ALW-3, ALW-4, CMP-3 | New connection defaults; widening under `auto` records `policy`; under `gate` returns `confirmation_required`; unknown and ungranted names return the same error |
| DRV-1, DRV-2, GOV-3 | Capture from a labeled source; curator proposals and auto-captured facts carry the union of cited observation labels |
| GOV-1, GOV-2 | Forget over a connection; export and import round trip with labels; a version 1 bundle imports as Unclassified |
| CMP-2, MIG-1 | Migration test on a populated database: existing rows labeled Unclassified, inserts without a label fail |
| NFR-1 | Local measurement of recall and remember with and without the policies, recorded as an evaluation note |

Scenario 9 under `auto` documents accepted behavior; it is not a protection test.

## Implementation units

Ordered by dependency. Each unit is reviewable and reversible on its own until U6.

| Unit | Content | Depends on |
| --- | --- | --- |
| U1 Schema | Migration 0049: `compartments`, `connection_allowances` and an append-only allowance history; the reserved Unclassified compartment for existing and new users; label columns whose constant default is Unclassified; label canonical-form checks. No policies and no behavior change: until U3, every new row is Unclassified. Migration review | — |
| U2 Context | Migration 0050: an allowance lookup function owned by the lookup role, so commit revalidation does not depend on tenant context; allowance resolution in `packages/auth`; effective set on `ActorContext`; one helper that sets `app.compartment_ids` and replaces the nine current scope-context setters; a check that rejects new direct setters; the worker's full list | U1 |
| U3 Write path | Label rules for remember, changesets and `RECLASSIFY`; relaxation through the protected-change path; held writes; source, observation and evidence labels; curator unions; a migration that makes subject names unique per label and drops the label defaults so that every new row needs an explicit label | U2 |
| U4 Read path | Recall, memory reads, relation and subject expansion, withheld evidence, `WITHDRAWN` events, cursor version 2, filtering of reviews, confirmations and replays | U2 |
| U5 Operations and adapters | `get_access`, `create_compartment`, `narrow_access`, `request_compartment_access`; optional scopes and compartment narrowing on existing tools; REST and MCP adapters over domain services; OpenAPI regeneration | U3, U4 |
| U6 Database enforcement | A migration with restrictive `compartment_visibility` policies; the bypass and unset-context tests | U2–U5 deployed |
| U7 Portability | Export and import payload version 2 | U3 |
| U8 Documentation and release | Data model, MCP and API contract, memory system, security, client access, agent workflows, README and Product claims; release record with hosted checks | U1–U7 |

U1 to U8 were implemented and verified locally on 2026-10-30 ([U1 migration review](../eval/memory-compartments-schema-20261030.md), [U2 record](../eval/memory-compartments-context-20261030.md), [U3 to U8 record](../eval/memory-compartments-enforcement-20261030.md)) and deployed the same day in one fenced rollout ([release record](../eval/memory-compartments-release-20261030.md)). U3 is migration 0051 (label origin, the narrowed-from label on feed events, subject keys per label, the allowance transaction marker, the context-independent lookup functions and the new protected operation) and U6 is migration 0052. U3 and U4 can proceed in parallel. U1 can be deployed alone: its defaults keep the previous service working, and its new rows are Unclassified, the restrictive side. The U3 migration that drops the defaults deploys with the U3 service behind the existing write fence. U6 must follow a deployment in which every service sets the compartment context, or the previous service would see only General records.

## Decisions

The owner accepted the recommended answer to every open question on 2026-10-30:

- **O1** Allowances are keyed on Gate issuer, subject and `connection_id`; a re-approval starts from General.
- **O2** Records that exist before this change are labeled Unclassified; no connection receives them until granted.
- **O3** An explicit non-empty label that omits some of the allowance's compartments, such as {A} from a connection with {A, B}, is accepted and recorded as `explicit`.
- **O4** Subject names are unique per scope, label and normalized name; the same person can exist in General and in A, linked by `same_subject` where both are visible.
- **O5** Every admitted connection can receive General.
- **O6** A connection manages only its own allowance.

## Prerequisites and limits

- Under `auto`, allowances and holds record widening but do not stop a misled AI; protection against prompt injection needs `gate`, and real Gate approvals have not yet been exercised in production.
- Content already returned to a client cannot be withdrawn, including from the client's own memory feature.
- Compartment names can be inferred by trying to create the same name.
- Recall quality and extraction quality are unchanged by this design and are not claimed by it.
- A widening applies to the requesting connection's allowance as it is when the change is applied; creating a compartment and narrowing require the allowance the connection authenticated with.
- Relabeling a source applies only to observations captured afterwards and goes through `configure_source`, a protected change.
- Two connections of one subject share a principal, so a stored idempotent response whose label the second connection cannot see is not replayed to it; reusing that key from the second connection fails instead of running again.
- Compartment names are user content that Forget does not remove yet. Before an operation writes names (U5), the design needs a way to remove a compartment and its name.
- Context tags with their own valid time, and current-state questions that prefer current contexts, rely on existing subjects and recall ranking; no new enforced structure is added.
