---
id: adr-0012-grant-workspaces-per-connection-and-classify-by-project
kind: adr
title: Grant workspaces per connection and classify memories inside them by project and scope
status: accepted
created: '2026-11-14'
decision_makers:
- owner
relations:
- {type: references, target: adr-0006-enforce-disclosure-with-compartments-and-connection-allowances}
- {type: references, target: adr-0010-record-observations-and-derive-the-current-state}
summary: A workspace per company is the enforced boundary, granted per connection endpoint; inside a workspace, observations belong to a project of an editable hierarchy and carry a scope saying how far they may travel; Shared lessons cross every workspace; an Inbox holds what has no workspace yet; callers query and receive workspace, project, scope and usability with every result.
---

# Grant workspaces per connection and classify memories inside them by project and scope

## Decision

Proposed on 2026-11-14 from the owner's direction that day, and accepted by the owner the same day together with the design's remaining decisions:

- the owner works for several companies, and inside one company information is confidential by business;
- information whose place is not determined is registered and managed as Unclassified;
- a search can combine places with OR and AND and include Unclassified, and the caller receives each item's place and handles it;
- Syntoria Weave's data layer is the reference, and businesses are projects, not tags;
- know-how must be recallable across projects and workspaces, so how far an item may travel is classified separately from where it belongs;
- projects can be changed;
- a workspace per company may be useful, and each connection can be granted several workspaces;
- connections are told apart by their endpoint URL.

The [memory workspaces design](../design/memory-workspaces.md) turns this into contracts.

1. **A workspace per company is the enforced boundary.** A connection reads and writes only the workspaces it is granted. Each connection is an endpoint: `/mcp` is the default connection, granted every workspace and the Inbox; further connections are served at `/mcp/c/<id>` with an opaque ID. Only an operator tool creates connections and changes grants.
2. **Projects classify inside a workspace.** Each workspace has an editable project hierarchy of up to four levels: a business, and deeper levels where needed. Projects can be renamed, moved within their workspace and deleted when unused. A project is not a boundary.
3. **Scope says how far an observation may travel.** An observation in a workspace has a scope: its project, an ancestor project, the whole workspace, or Shared. Shared lessons are visible to every connection; their origin is shown only to connections granted the origin workspace. Facts default to the narrowest scope; a lesson is written separately, generalized, with a wider scope and references to its sources, and widening is recorded as a protected change.
4. **Unclassified at two levels.** An observation without a workspace is in the Inbox, which a connection reads only when granted. An observation with a workspace but no project is Unclassified inside that workspace. Both can be listed, searched and classified.
5. **Callers query, Lore labels.** The query follows Weave's perspective query version 2 for classification leaves (`and`, `or`, `not`; `eq`, `ne`, `in`, `not_in`; `null` for unassigned; `include_descendants` defaulting to true) over workspace, project and scope, plus `usable_in`. A request may name the project or workspace it works in; each result then states whether it is usable there. Every result states its workspace, project, path and scope where the connection may see them.
6. **Classification is appended.** Changing an observation's workspace, project or scope appends a classification record and updates its current values; content is never rewritten. Each change is a protected change limited to workspaces the connection is granted.

This applies ADR 0006 with a workspace as the compartment: an observation's current label is its workspace, the reserved Inbox compartment, or empty for Shared, and per-connection allowances decide visibility. ADR 0006's label sets with several compartments and its held General writes are not used.

## Requirements and rationale

On 2026-11-14 an AI declined to record a company negotiation in Lore because its connection could write only General. Code inspection the same day found that the ledger already filters observations, index entries, topics, the change feed and Forget targets with `containsOnly(label, actor.compartmentAllowance)`, which treats an empty label as visible to all; that no tool creates compartments or sets an allowance; that every Access-mode request maps to one `shared-ai` principal, so connections cannot be told apart by authentication; that the worker's empty allowance keeps labeled observations out of the index; that aliases and links carry no label; and that recall and `link` reveal whether a named subject exists.

In Weave (`db/schema.ts`, `lib/domain/perspective-query.ts`), projects are a hierarchical catalog, an action has at most one project, and a perspective query combines classification leaves with `and`, `or` and `not`, matching unassigned with `null` and including descendants by default.

Companies are where confidentiality obligations end; businesses inside a company are where the owner's work is organized. Enforcing at the company and classifying below it keeps the boundary small and stable while allowing projects to change freely. The endpoint URL is the cheapest way to tell connections apart under Access; separate Access applications per connection can be added later on the same model.

| Alternative | Decision basis |
| --- | --- |
| Everything in General with naming conventions | Rejected: nothing to search, handle or enforce |
| Project as the boundary, or no boundary (drafts, 2026-11-14) | Superseded: the owner wants per-connection access to several company workspaces |
| Compartment label sets | Rejected: one workspace per observation is enough, and labeling was left to the model |
| Shared by default with confidential material extracted | Rejected: a missed extraction spreads a fact |
| A separate Access application per connection | Deferred by the owner: stronger but needs Cloudflare configuration and several audiences; it can be added without changing the model |
| Workspace per company granted per endpoint, projects and scope inside (chosen) | Meets every requirement above with the enforcement the ledger already has |

## Consequences

- **Security and authorization.** The workspace grant holds against anything the model sends. It does not hold against a client given another connection's URL: any client authenticated as the owner can use any endpoint. Inside a workspace, keeping a business's facts out of another business's work depends on the caller's queries and the returned scope and `usable` mark. A generalized lesson that still contains a particular spreads to every connection; with the current `automatic` policy, widening is recorded but not reviewed first.
- **Cross-company information.** One observation cannot belong to two workspaces; it is recorded in each, or kept in the Inbox.
- **Behavior change.** Existing observations, written as General, are read as Inbox items. `/mcp` keeps reading them.
- **Data.** New collections hold workspaces, connections, projects, their history and classification records. Observations gain a current label, workspace, project, scope and derivation references; index entries, topics, aliases and links carry the label.
- **Writer identity.** Each connection has its own connection and person principals.
- **Forget and restore.** Unchanged. Forget acts on what the calling connection can see.
- **Operations.** The API gateway and the Access application must cover `/mcp/c/*`. Workspace and project names and connection IDs are private and stay out of the repository.

## Confirmation

Against the Firestore emulator, the design's acceptance scenarios must show that a connection never receives or detects anything from an ungranted workspace or the Inbox without a grant; that Shared lessons reach every connection without revealing an ungranted origin; that queries, `usable_in` and `context` return and mark exactly the matching items; that project changes take effect without rewriting observations; that classification and scope widening are appended and recorded; and that every visible observation is found by term and vector search. Hosted routing and client setup need a dated evaluation record. This ADR is not evidence of implemented or deployed behavior.

## Sources

- Owner direction on 2026-11-14, as listed under Decision
- [ADR 0006](0006-enforce-disclosure-with-compartments-and-connection-allowances.md), [ADR 0010](0010-record-observations-and-derive-the-current-state.md)
- [Memory workspaces design](../design/memory-workspaces.md), [observation ledger design](../design/observation-ledger.md), [situational recall contract](../design/situational-recall.md)
- Lore code at commit `66b35b0`: `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/mcp.ts`, `packages/memory-records/src/access.ts`, `packages/memory-records/src/firestore-observation-ledger.ts`, `packages/memory-records/src/firestore-repository.ts`, `packages/memory-records/src/observation-service.ts`
- Syntoria Weave at commit `e50ece0`: `db/schema.ts`, `lib/data/types.ts`, `lib/domain/perspective-query.ts`, `docs/design/design-action-state-and-perspectives.md`
