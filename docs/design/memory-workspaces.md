# Memory workspaces design

Status: accepted design. U1 (workspaces, connections and the operator tool), U2 (labels and visibility), the routing of U3 (`/mcp/c/<id>` and its fail-closed resolution) U4 (projects, `list_projects` and `manage_project`), U5 (placement on write, protected widening, `derived_from`, labels on aliases and links, result fields with origin hiding, `get_access` and server instructions) U6 (`where`, `context` and `usable`, `list_observations`, topic views within a query), U7 (`classify` and its batch form), U8 (label keys, their backfill and prefiltered term search, vector search, subject and topic visibility, link traversal and the pending-index note) and U9 are implemented and verified against the Firestore emulator only. A reader with more than 30 label keys, or a scope whose backfill has not finished, reads a bounded number of documents and filters them. Not done: U10's hosted rollout, and hosted gateway and Access coverage of `/mcp/c/*`. A subject or topic counts as visible when one of the first 50 observations that name it is visible. It turns [ADR 0012](../adr/0012-grant-workspaces-per-connection-and-classify-by-project.md) into contracts on the [observation ledger](observation-ledger.md). It was written directly in the main session on 2026-11-14 because the dev-skills design runtime could not reach its execution server; no design gate or independent review has run.

## Outcome

One person keeps memories for several companies and their businesses in one Lore. Each connection reaches only the company workspaces it is granted. Inside a workspace, facts are used in the business they belong to; lessons travel to every workspace; information whose place is unknown waits in the Inbox or as Unclassified inside a workspace and is classified later. A caller searches what its task needs and knows, for every result, where it belongs, how far it may travel and whether it may be used in the work at hand.

| ID | Observable outcome |
| --- | --- |
| WS-O1 | An AI records an unsettled negotiation in Northwind / Retail; a query for what is usable in Retail returns it, and one for Logistics does not |
| WS-O2 | A connection granted only Cedar receives nothing of Northwind and no sign that it exists, whatever it sends |
| WS-O3 | A lesson generalized from the negotiation and written as Shared is usable in Cedar, without revealing to a Cedar-only connection where it came from |
| WS-O4 | Inbox and Unclassified observations can be listed, searched and classified |
| WS-O5 | A query combining workspaces and projects with `or`, `and` and `not`, with or without unassigned items, returns exactly the matching items with workspace, project, scope and usability |
| WS-O6 | Renaming, moving or deleting an unused project takes effect in the next query without rewriting observations |

## Terms

| Term | Meaning |
| --- | --- |
| Workspace | One company or another domain of confidentiality, with an opaque ID (`wsp_…`), a private name unique in the scope and a description. The enforced boundary |
| Inbox | Where an observation without a workspace is kept. Visible only to connections granted it |
| Project | A node of a workspace's hierarchy with an opaque ID (`prj_…`), a parent (another project of the same workspace, or none), a name unique under the parent and a description. At most four levels |
| Unclassified | An observation in a workspace without a project |
| Scope | How far an observation may travel: `project` (its project or an ancestor), `workspace`, `shared`, or `inbox` for an observation without a workspace |
| Usable in X | For a project X: Shared, or in X's workspace with scope `workspace`, or with a project scope that is X or one of its current ancestors. For a workspace X: Shared, or in X with scope `workspace` |
| Lesson | An observation generalized from others, without their confidential particulars, with a wider scope and `derived_from` references |
| Connection | An endpoint with a grant: a set of workspaces, or all of them, and whether the Inbox is included. `/mcp` is the default connection; others are served at `/mcp/c/<id>` with an opaque ID (`con_…`) |
| Label | The compartment set derived from workspace and scope that the ledger checks: `[workspaceId]`, `["inbox"]`, or `[]` for Shared |

Synthetic example used below:

```text
Workspace Northwind      company A
  Retail                 business X
  Logistics              business Y
Workspace Cedar          company B
Workspace Personal

Connection /mcp          all workspaces and the Inbox
Connection C             Cedar only
```

| Example observation | Workspace | Project | Scope | Usable in | Visible to C |
| --- | --- | --- | --- | --- | --- |
| Quoted price in an open negotiation | Northwind | Retail | project Retail | Retail | No |
| Northwind's contract approval rule | Northwind | Retail | workspace | Northwind and all its projects | No |
| Northwind memo with no business yet | Northwind | none | workspace | Northwind and all its projects | No |
| "Confirm data-licensing terms before quoting" | Northwind | Retail | shared | Everywhere | Yes, without its origin |
| A note whose company is unknown | none | none | inbox | Only an explicit Inbox query | No |

## Current state

Verified in code at `66b35b0` on 2026-11-14. The ledger checks observations, index entries, topics, the change feed and Forget targets with `containsOnly(label, actor.compartmentAllowance)`; an empty label is visible to every actor. Every observation has an empty `compartmentIds`. Every Access-mode request maps to the `shared-ai` principal, whose allowance is empty; the worker's allowance is empty too. Nothing creates compartments or sets an allowance. Aliases and links carry no label. Recall returns the stored names of subjects named in the query, and `link` reports whether a subject exists.

## Contracts

### Labels and visibility

- An observation's current label is derived from its workspace and scope: Shared gives `[]`, no workspace gives `["inbox"]`, otherwise `[workspaceId]`. It is stored in a field `label` that only a write or a classification sets.
- One function reads an item's label, treating a missing `label` as `["inbox"]`, and applies the existing rule: visible when every element is in the actor's allowance, so `[]` is visible to every connection. Every current `containsOnly(…, actor.compartmentAllowance)` check moves to it. Existing observations therefore read as Inbox items without a backfill.
- A connection's allowance is its granted workspace IDs, plus `inbox` when the Inbox is granted. An all grant is stored as the reserved entry `workspaces:all`, which covers every workspace ID, including ones created later, and nothing else.
- The worker's allowance is `workspaces:all` and `inbox`.
- A Shared observation's workspace, project and `derived_from` are returned only when the connection is granted that workspace; otherwise the result carries `origin_hidden: true`.

### Data

All documents live under the tenant and scope of the admission.

| Collection | Key | Fields | Written by |
| --- | --- | --- | --- |
| `workspaces` | workspace ID | `id`, `name`, `normalizedName`, `description`, `createdAt` | operator tool |
| `workspaceNames` | digest of normalized name | `workspaceId` | same |
| `connections` | connection ID, or `default` | `id`, `grant` (`workspaces`: `"all"` or IDs, `inbox`, `defaultWorkspace`), `allowance`, `active`, `epoch`, `updatedAt` | operator tool |
| `projects` | project ID | `id`, `workspaceId`, `parentId`, `name`, `normalizedName`, `description`, `createdAt`, `updatedAt` | `manage_project` |
| `projectNames` | digest of workspace, parent and normalized name | `projectId` | `manage_project` |
| `projectState` | workspace ID | `revision`, incremented by every project change in the workspace | `manage_project` |
| `accessHistory` | generated | operation, target, before and after, writer, note, time | every change above |
| `classifications` | generated | `observationId`, previous and new workspace, project and scope, writer, time, approval provenance | ledger |

Observations gain `workspaceId`, `projectId`, `scope` (`{ kind: 'project', projectId }`, `{ kind: 'workspace' }`, `{ kind: 'shared' }` or `{ kind: 'inbox' }`), `label` and `derivedFrom` (up to 5 observation IDs, never changed). Content and `compartmentIds` never change. Index entries, topic documents, aliases and links carry `label`; index entries also carry `workspaceId`, `projectId` and `scope`. No project path is stored.

Invariants:

- A project scope names the observation's project or one of its ancestors at write or classification time; `workspace` and `project` scopes require a workspace; `inbox` scope means no workspace.
- A connection's authorization documents hold exactly its allowance, and their epoch changes whenever it does.
- The worker's allowance and the default connection's allowance are `workspaces:all` and `inbox` once `init` has run; a missing authorization document of either is created with that allowance.

### Connections

- `/mcp` resolves the admission as today and uses the `default` connection, created at migration with an all grant and the Inbox.
- `/mcp/c/<id>` with `<id>` matching `con_[a-f0-9]{32}` resolves the admission the same way and uses that connection if it is active and belongs to the admission.
- Principals are derived from issuer, subject and connection ID. Their authorization documents are written by the operator tool; `resolve` does not create them for a non-default connection.
- An unknown, inactive, foreign or malformed connection returns the same `404 not_found`.
- Only the path selects a connection. No header other than the verified identity, body field, query parameter or tool argument selects or widens one.

`scripts/manage-connections.mjs` follows the conventions of `scripts/admit-subject.mjs`:

| Command | Effect |
| --- | --- |
| `init` | Grants the default connection every workspace and the Inbox and lets the worker read every label; run once per admission when this change is deployed |
| `create-workspace --name --description` | Creates a workspace; all-workspace grants cover it at once |
| `set-connection --connection default\|new\|<id> --workspaces all\|<ids> --inbox --default-workspace` | Creates or replaces a connection's grant; increments the epoch of the connection and its authorization documents in one transaction; prints the path of a new connection |
| `deactivate-connection --connection` | Marks a non-default connection and its authorization documents inactive |
| `show` | Prints workspaces and connections |

Each command is one Firestore transaction with an `accessHistory` entry.

### Projects

| Operation | Rules |
| --- | --- |
| Create | In a granted workspace; parent in the same workspace or none; name unique under the parent; at most four levels |
| Update name or description | Name unique under the parent |
| Move | Parent in the same workspace or none; not the project or a descendant; the subtree stays within four levels |
| Delete | Only when no observation's current project or project scope is this project and it has no children; otherwise `project_in_use` |

MCP offers `list_projects` (the hierarchies of granted workspaces with descriptions and revisions) and `manage_project`. Each change is one transaction that appends `accessHistory` and increments the workspace's revision. Reads load a workspace's hierarchy once per request, keyed by revision. Merging is done by classifying, then deleting.

### Writing

`observe` gains `workspace` (an ID or `null`), `project` (an ID or `null`), `scope` (`"project"`, an ancestor project ID, `"workspace"` or `"shared"`) and `derived_from`.

| Input | Result |
| --- | --- |
| `workspace` omitted | The connection's default workspace, or the Inbox |
| `project` omitted | No project |
| `scope` omitted | The project when there is one; otherwise `workspace` in a workspace, or `inbox` without one |
| A workspace not granted or unknown; the Inbox without the Inbox grant; a project not in the workspace; a project scope that is not the project or an ancestor | `invalid_input` with one message for all of these, since they depend on stored data; nothing is written |
| A project without a workspace, a workspace scope without a workspace, a project scope without a project, an unknown scope value | `invalid_input` naming the problem, which depends only on the request; nothing is written |

- A write whose scope is wider than the narrowest scope it could have, including any Shared write, is a protected change under the binding's approval policy and records its provenance, bound to the request digest as for `as_user`.
- `derived_from` may name only observations visible to the writer.
- Aliases created by a write and links created by `link` carry the write's label; a link's ID includes its label. Subject resolution and `link` use only visible aliases and links; `link` returns `not_found` for a subject or topic without a visible observation. `retracts` may name only a visible observation.

### Classification

- `classify` takes an observation ID and a new workspace, project and scope, with the write rules above, for an observation the connection can see and whose current workspace, if it has one, the connection is granted. A connection that sees a Shared observation only with `origin_hidden` cannot classify it; it receives the same `invalid_input` as for an unknown ID.
- Every classification is a protected change. One transaction appends a classification record, updates the observation's fields and label, its index entry and topic, and appends a `classify` change-feed entry carrying the new label.
- A batch form classifies up to 50 observations under one idempotency key, each checked and reported separately.

### Queries and context

`recall`, `get_timeline` and a new `list_observations` accept optional `where` and `context`.

| Leaf | Meaning |
| --- | --- |
| `workspace_id` with `eq`, `ne`, `in`, `not_in`; `null` is the Inbox | Where the observation belongs |
| `project_id` with the same operators; `null` is no project; `include_descendants` defaults to true | Where inside a workspace |
| `scope` with `eq` or `in` over `project`, `workspace`, `shared`, `inbox` | How far it may travel |
| `usable_in` with `eq` or `in` over project or workspace IDs | Usable there, as defined above |

- `and`, `or` and `not` combine leaves; at most depth 8, 64 nodes and 64 IDs. Every query is evaluated inside the connection's allowance. An ID that is unknown or outside the allowance returns the same `invalid_input`.
- Without `where`, everything visible is searched.
- `context` names one project or workspace. It does not filter; each result carries `usable` for that context.
- Topic views are computed from visible observations that match the query.
- `list_observations` lists matching observations by recorded time with a signed cursor. `workspace_id eq null` is the Inbox; `project_id eq null` with a workspace is its Unclassified queue.

### Results

Every returned observation carries `workspace` (`{ id, name }` or `null`), `project` (`{ id, name, path }` from the current hierarchy, or `null`), `scope`, `derived_from` limited to visible references, `origin_hidden` where it applies, and `usable` when a context was given. Topic results list the workspaces, projects and scopes they are computed from. `get_access` returns the connection, its granted workspaces with descriptions, whether the Inbox is granted, the default workspace and the approval policy.

Server instructions tell the caller to:

- name the project or workspace of the task as `context` and query with `usable_in` for it, adding the Inbox or Unclassified when relevant;
- record facts in their workspace and project with the default scope, and leave the project or workspace unassigned when unsure;
- write a lesson separately, generalized without names, amounts or other particulars, with the widest scope its content allows and `derived_from` set;
- use only items marked `usable` as facts for the task, and present others only as lessons stated as such;
- classify unassigned items when their place becomes clear, and create projects as businesses appear.

These are instructions, not enforcement.

### Hidden existence

Across workspaces and the Inbox, relative to the connection's allowance: no observation, topic, alias, link, subject name, workspace or project name, count, note, error, cursor or timing difference distinguishes "nothing written" from "written where the connection is not granted". `index-pending` and `term-search-partial` are computed over visible entries. Recall and timeline name a subject only when a visible observation names it.

### Indexing and retrieval

- The worker indexes every observation with its label, workspace, project and scope, and reindexes it on classification. Project changes need no reindexing.
- Term and vector search must keep [SR-04](situational-recall.md) under the allowance and the query: relevant matching evidence stays discoverable when closer entries are invisible or do not match. A nearest-1000 scan filtered afterward does not meet this when such entries dominate. Acceptable approaches are a prefilter on `label` (`array-contains-any` over the allowance, which bounds a prefiltered connection to 30 workspaces) and on workspace, project and scope, bounded additional retrieval with an exhausted diagnostic, or both; the unit chooses and measures.

### Deployment

The API gateway configuration and the Access application must cover `/mcp/c/*` as they cover `/mcp`. Workspace and project names and connection IDs stay in Firestore and the person's client settings, never in tracked files.

## Requirements

- **WS-1** Lore shall store workspaces and connections per tenant and scope, and only the operator tool shall create connections or change grants, with an `accessHistory` entry in the same transaction.
- **WS-2** Lore shall decide visibility of observations, aliases, links, topics, index entries and change-feed entries from their current label and the connection's allowance, reading a missing label as the Inbox.
- **WS-3** When a request arrives at `/mcp` or `/mcp/c/<id>`, Lore shall use the corresponding active connection of the authenticated admission, and shall return the same `404 not_found` for any other connection path.
- **WS-4** Lore shall not select or widen a connection or allowance from any request field, tool argument or model output.
- **WS-5** Lore shall store an editable project hierarchy per workspace of at most four levels, reject cycles and moves across workspaces, refuse to delete a project in use, and compute paths, ancestors and descendants from the current hierarchy.
- **WS-6** When a write omits workspace, project or scope, Lore shall apply the connection's default workspace or the Inbox, no project and the narrowest scope; when any of them is not permitted, Lore shall write nothing and return one `invalid_input`.
- **WS-7** When a write or classification gives a scope wider than the narrowest it could have, Lore shall treat it as a protected change and record its provenance.
- **WS-8** When `classify` is applied, Lore shall append a classification record and update fields, label, index entry, topic and change feed in one transaction without changing content.
- **WS-9** When a request carries `where`, Lore shall return only visible items that match it; when it carries `context`, Lore shall mark each result `usable` exactly as defined.
- **WS-10** Lore shall return workspace, project, path, scope and visible `derived_from` with every observation, and shall replace a Shared observation's origin with `origin_hidden` for a connection not granted its workspace.
- **WS-11** Lore shall not reveal anything outside the allowance through any result, count, note, error or cursor.
- **WS-12** The worker shall index every observation, and term and vector search shall satisfy SR-04 under the allowance and query.
- **WS-13** When an allowance changes, Lore shall reject in-flight actors and cursors bound to the old allowance.
- **WS-14** After migration, `/mcp` shall read and write as before, with existing observations in the Inbox.

## Acceptance scenarios

All run against the Firestore emulator through HTTP and MCP with signed synthetic Access assertions and the synthetic example above.

| ID | Given | When | Then |
| --- | --- | --- | --- |
| WS-A1 | `/mcp` | Observe the five example observations, the lesson with `derived_from` the price | Each has the listed workspace, project, scope and label; the rule and the lesson are recorded as protected changes |
| WS-A2 | WS-A1 | Recall with `usable_in` Retail, then Logistics, then Cedar | Price, rule, memo, lesson; then rule, memo, lesson; then the lesson |
| WS-A3 | WS-A1 | `or` of `usable_in` Cedar and `workspace_id eq null`; `and` of `workspace_id eq Northwind` and `not usable_in` Logistics; `project_id in [Retail]`; `scope eq shared` | Lesson and note; price; price, rule, lesson; lesson |
| WS-A4 | WS-A1 | Recall without `where`, with `context` Logistics | All five, `usable` true on rule, memo and lesson |
| WS-A5 | WS-A1 | List the Inbox, then classify the note into Northwind / Logistics | The note with a working cursor; then a classification record, unchanged content, found by term and vector with `usable_in` Logistics, gone from the Inbox, a `classify` change-feed entry |
| WS-A6 | WS-A1 and connection C | C recalls by name and wording, reads timelines, lists, reads the change feed, links a Northwind subject | Only the lesson, with `origin_hidden`; `link` returns `not_found`; no Northwind name, note or count |
| WS-A7 | Connection C | C queries `workspace_id eq Northwind`, observes into Northwind, observes into the Inbox, classifies the lesson into Cedar | All four return the same `invalid_input` as an unknown ID and change nothing |
| WS-A8 | Connection C | C observes a Cedar fact and a Shared lesson | `/mcp` sees both; the lesson's origin is shown to `/mcp` |
| WS-A9 | Unknown, deactivated and another admission's connection IDs | Each is requested | Identical `404 not_found` |
| WS-A10 | WS-A1 | Rename Logistics; move Retail under Logistics; move Logistics under Retail; move Retail to Cedar; delete Retail; delete an empty project; create a fifth level | Paths change at once without rewriting observations; the cycle, the cross-workspace move, the delete in use and the fifth level fail; the empty project is deleted; history records each |
| WS-A11 | The operator grants C Northwind while C holds a cursor and an actor | C's next read and write; then a new request | `stale_authorization` and `cursor_expired`; then Northwind is visible |
| WS-A12 | 1,200 Cedar observations closer to the query than one Retail observation | `/mcp` recalls with `usable_in` Retail | The Retail observation, or an eligibility-exhausted note |
| WS-A13 | A subject with observations in Cedar and Northwind | C forgets the subject | Only Cedar observations are forgotten |
| WS-A14 | Existing tests after migration | They run | They pass, with existing observations in the Inbox |

## Implementation units

| Unit | Scope | Depends on | Acceptance |
| --- | --- | --- | --- |
| U1 Workspaces, connections and operator tool | `packages/memory-records` workspace and connection repository, `accessHistory`, `scripts/manage-connections.mjs` | none | WS-1; invariants after every command |
| U2 Labels and visibility | current label, one visibility function with the Inbox fallback, worker allowance | U1 | WS-2, WS-14 |
| U3 Connection resolution and routing | `access.ts`, `apps/api/src/server.ts`, `apps/api/src/app.ts` | U1, U2 | WS-3, WS-4; WS-A9, WS-A14 |
| U4 Projects | project repository, history, revisions, `list_projects`, `manage_project` | U1 | WS-5; WS-A10 |
| U5 Writes and results | observe fields, `derived_from`, protected widening, aliases and links, result fields, `get_access`, server instructions | U3, U4 | WS-6, WS-7, WS-10; WS-A1, WS-A8 |
| U6 Queries, context and listing | `where` and `context` on `recall` and `get_timeline`, `list_observations`, topic views within the query | U5 | WS-9; WS-A2 to WS-A4 |
| U7 Classification | `classify` and its batch form | U5 | WS-8; WS-A5 |
| U8 Indexing and retrieval | worker fields, reindexing on classification, prefiltered term and vector search; a label key on observations, links and index entries, backfilled for earlier documents, so that subject and topic visibility checks and link traversal query only labels the reader may see instead of filtering a fixed number of documents | U2, U6, U7 | WS-12; WS-A5 (search side), WS-A12; a subject, topic or link visible to a reader is found even when 1,000 documents of other workspaces name the same member |
| U9 Hidden existence and allowance changes | origin hiding, subject names, `link`, notes, epoch and cursor handling | U3, U5 | WS-11, WS-13; WS-A6, WS-A7, WS-A11, WS-A13 |
| U10 Documents and rollout | ARCHITECTURE, PRODUCT, user guide, operations, gateway and Access path, default connection creation, dated evaluation record | U1 to U9 | Hosted `/mcp` unchanged for existing data; `/mcp/c/*` reachable only through Access |

Each code unit runs `npm run verify:local`. U8 records the vector-scan cost of its approach.

## Owner decisions

Decided on 2026-11-14:

- Existing observations become unassigned, now the Inbox.
- Widening a scope is a protected change applied at once under the `automatic` policy and recorded.
- Without `where`, everything visible is searched.
- Projects can be changed; a project in use cannot be deleted, and the hierarchy has at most four levels.
- A workspace per company is granted per connection, several per connection, and connections are told apart by endpoint URL.
- Shared lessons are visible to every connection.
- Workspaces and grants are changed only by the operator tool; projects are managed through MCP tools.

## Out of scope

- Separate Access applications or other authentication per connection.
- An observation in two workspaces.
- Tags or other cross-cutting classification.
- Checking automatically that a lesson contains no confidential particulars.
- Sharing memories with other people.
