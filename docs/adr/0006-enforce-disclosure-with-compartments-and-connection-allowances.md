---
id: adr-0006-enforce-disclosure-with-compartments-and-connection-allowances
kind: adr
title: Enforce memory disclosure with compartments and per-connection allowances
status: accepted
created: '2026-10-30'
decision_makers:
- owner
relations:
- {type: references, target: adr-0003-attribute-ai-clients-and-confirm-user-decisions}
- {type: references, target: adr-0004-approve-protected-changes-by-policy}
- {type: references, target: adr-0005-use-one-mcp-resource}
summary: Each record carries a set of confidentiality compartments, each Gate connection has an allowance of compartments, and Lore returns a record only when its label is within the allowance; PostgreSQL RLS stays as the fail-closed backstop.
---

# Enforce memory disclosure with compartments and per-connection allowances

## Decision

On 2026-10-30 the owner decided the following, after a design discussion recorded in the session handoff:

1. **Separate disclosure from context.** A compartment is a confidentiality obligation, such as an employer, a client engagement, a friend's confidence or health. Each memory version, source, observation, evidence item and subject carries a label: a set of compartments. An empty label is General. What a memory is about (organizations, projects, activities, relationships) stays non-enforced context, expressed by subjects and the memory's `context`.
2. **Label sets on each record (option C).** A record can belong to several compartments at once. A label means that a recipient needs every compartment in it.
3. **Per-connection allowances.** Each Gate connection has an allowance: the compartments it may receive and write. A connection without a recorded allowance has General only.
4. **Narrow freely, widen by policy.** A connection, a request or the person may narrow an allowance or add compartments to a record at once. Widening an allowance or removing a compartment from a record is a protected change that follows the binding's approval policy ([ADR 0004](0004-approve-protected-changes-by-policy.md)); the owner chose not to exempt it from `auto`.
5. **Hold a General write from a confidential connection.** When a connection whose allowance includes a compartment labels its own write General, Lore stores the write with that connection's compartments and returns the relaxation it can request.
6. **Keep RLS.** The application layer remains the primary check. PostgreSQL row-level security remains the fail-closed backstop, extended with restrictive compartment policies.
7. **Out of scope.** Delivering memories to other people through Lore.
8. **Resolved details.** Allowances are keyed on Gate issuer, subject and `connection_id`, so a re-approval starts from General. Records that exist before this change are labeled with a reserved Unclassified compartment. An explicit non-empty label that omits some of the allowance's compartments is accepted. Subject names are unique per scope, label and normalized name. Every admitted connection can receive General. A connection manages only its own allowance.

Scopes remain as they are: storage, grant, retention, export and change-feed partitions. The [memory compartments design](../design/memory-compartments.md) turns this decision into requirements and implementation units.

The owner accepted the recommended answer to every open question in the design on 2026-10-30. The implementation was completed and verified locally the same day ([U3 to U8 record](../eval/memory-compartments-enforcement-20261030.md)); it has not been deployed.

## Requirements and rationale

The owner keeps one person's memories across private life and several companies, businesses and activities. Memories can be company-confidential, can span contexts and can involve other people. Every client of one Gate account currently acts as one connection principal with the same scopes, so every connected AI can read every admitted memory.

Measured or documented facts that shaped the decision:

- Memories, versions, evidence, sources, subjects and relations each belong to exactly one scope through composite foreign keys, so a scope cannot represent a memory that belongs to two confidentiality domains.
- Gate introspection returns a `connection_id` for each approval and a stable `client_id` for each installation; Gate offers no consent-time choice of data.
- Published evaluations report that language models disclose contextually inappropriate information even when prompted not to, and that a single context-hijacking message can defeat model-side protection. Information-flow control systems and commercial labeling systems label combined or generated content with the most restrictive label of its inputs.
- The existing RLS policies check `scope_id = ANY(app.scope_ids)`, and about 140 raw SQL call sites across seven packages share no common query gate.

| Alternative | Decision basis |
| --- | --- |
| Discovery and defaults only, keeping every connection on every scope | Rejected: leaves no disclosure boundary between connections |
| Scope as compartment with per-connection allowances over scopes | Rejected by the owner in favor of option C: cannot represent a memory confidential to two domains or a declassified memory that keeps its evidence |
| Compartment label sets on records with per-connection allowances (chosen) | Represents cross-context and declassified memories, and keeps scopes and their per-scope guarantees unchanged |
| Exempt widening from `auto` and always require Gate approval | Rejected by the owner: keeps the approval behavior of ADR 0004 for every protected change |
| Enforce compartments only in the application layer | Rejected: an omitted application filter fails open, while an unset RLS context returns no restricted rows |

## Consequences

- **Security and authorization.** Under `auto`, an allowance limits accidental over-disclosure and records every widening, but it does not stop a misled AI from requesting a wider allowance or a relaxation; it becomes a barrier only under `gate`. Content already returned to a client, including into the client's own memory feature, cannot be recalled by narrowing later.
- **Data.** New tables hold compartments and allowances. Label columns are added to content tables; existing rows are labeled with a reserved Unclassified compartment, which no connection has until it is granted. Subject names become unique per scope, label and name. A new change operation, `RECLASSIFY`, records label changes as revisions.
- **Migration.** Additive and forward-only. Label columns use a constant default for existing rows and then require explicit labels. Restrictive RLS policies are added in a later migration, after every service sets the compartment context.
- **Forget and restore.** Forget semantics, the deletion ledger and restore reconciliation do not change. Purge and maintenance executors stay outside the compartment policies.
- **Portability.** The cursor and export payloads gain a new version that binds or carries labels. A version 1 cursor reads as General only, so it stays valid only for a connection without compartments. Export covers every compartment of a scope and stays available only to the user principal acting directly; import maps compartments by name and refuses ones the importer does not hold.
- **Operations.** Gate needs no change. Existing connections lose access to Unclassified memories until the person or an AI requests it, which `auto` applies at once.

## Confirmation

The implementation must show, against real PostgreSQL, that a connection never receives a record whose label is outside its allowance through recall, memory reads, the change feed, reviews, confirmations, idempotent replays or relation and subject expansion; that the same queries return no restricted rows when the application filter is bypassed; that narrowing applies on the next request; that widening and relaxation follow the binding's approval policy; and that the scenarios in the design pass. This ADR is not evidence of implemented or deployed behavior.

## Sources

- Owner decisions on 2026-10-30, recorded in the session handoff, including acceptance of every recommended answer to the design's open questions
- [Memory compartments design](../design/memory-compartments.md)
- [Data model](../technical/data-model.md), [MCP and HTTP API contract](../technical/mcp-api.md), [change confirmation design](../design/change-confirmation.md)
- Nissenbaum, "Privacy as Contextual Integrity", Washington Law Review 79 (2004); ConfAIde and PrivacyLens benchmarks; Bagdasarian et al., "AirGapAgent" (CCS 2024); Denning, "A Lattice Model of Secure Information Flow" (1976); Microsoft Research, FIDES (2025); Microsoft Purview sensitivity-label inheritance for Microsoft 365 Copilot
