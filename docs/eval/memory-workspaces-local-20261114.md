# Memory workspaces: local verification, 2026-11-14

This record states what was observed when [ADR 0012](../adr/0012-grant-workspaces-per-connection-and-classify-by-project.md) and the [memory workspaces design](../design/memory-workspaces.md) were implemented on branch `workspaces-and-projects`, commits `6e06a0f` to `1169d8d` and the documentation commit that adds this record. It is a dated observation, not a product guarantee, and it establishes nothing about a hosted service.

## What was run

`npm run verify:local` steps with Node.js 24 against a loopback Firestore emulator in synthetic `demo-` projects: build, typecheck, lint (the untracked `.local/` directory excluded), formatting, unit tests (69), the emulator suite (101), dependency audit at high severity, and the secret scan on a copy of the tracked files. All passed on the final commit. Deterministic embeddings were used; no real model, Access application, gateway, Cloud Run revision or managed index was involved.

## What the tests establish locally

| Concern | Observed |
| --- | --- |
| Connections and grants | The operator tool creates workspaces and connections, records each change, and bumps the epoch; a changed or deactivated grant applies on the next request; an unprovisioned, inactive, malformed or foreign connection path returns the same `404` and creates no authorization |
| Boundary | A connection granted one workspace does not read, find by term or meaning, receive in the change feed, resolve by alias, follow by link, or learn the name of anything in another workspace or the Inbox, and cannot write there |
| Existing data | Observations, index entries, topics and feed entries stored before labels read as Inbox items without a rewrite |
| Projects | Hierarchy of at most four levels, unique names under a parent, no cycles, no moves across workspaces, no delete while in use, paths from the current hierarchy |
| Placement | Narrowest scope by default; a wider scope approved by the `automatic` policy and refused with `user_required` otherwise; Shared lessons reach other workspaces with their origin and derivation hidden |
| Queries | `where` with `and`, `or`, `not`, `null` and descendant expansion; `usable_in`; `context` and `usable`; topics computed within a query; listing with a cursor bound to reader and query |
| Classification | Content unchanged, record and feed entry appended, search and listings updated, replay and conflict by key, item-level refusals, policy required |
| Crowding | With 1,050 documents of another workspace naming the same subject and nearer to the query, the reader still finds its observation, subject name and link once label keys are complete; the filter-after-read path loses all three |
| Reviews | Each finding of the automated reviews on these commits has a regression test that fails when the fix is removed |

## What is not established

- Behavior of the hosted service, Cloudflare Access coverage of `/mcp/c/*`, the API gateway route, or the managed composite and vector indexes.
- Whether client products can use several MCP connections per project or workspace.
- Search quality or latency with real embeddings and realistic volume, and the cost of querying per label.
- That the AI keeps one business's facts out of another's work inside one connection, or generalizes lessons without particulars; Lore supplies places and scopes but does not enforce their use.
- Backfill duration and behavior on the production corpus.
