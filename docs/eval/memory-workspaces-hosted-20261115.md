# Memory workspaces: hosted rollout, 2026-11-14 to 2026-11-15

This record states what was observed when the release introducing [workspaces](../design/memory-workspaces.md) was rolled out to the owner's hosted service, following [Rolling out workspaces](../operations.md#rolling-out-workspaces). It is a dated observation, not a product guarantee. Identifiers of the environment are kept in private release records, not here. The [local verification](memory-workspaces-local-20261114.md) of the same code is recorded separately.

## What was done

| Step | Observed |
| --- | --- |
| Gate settings | The service configuration had no `GATE_*` settings before the release; nothing was removed |
| Indexes | The five label-key composite and vector indexes were created on the memory database and all eight indexes were ready before traffic moved |
| Release | The image was built from commit `04a74c0`, deployed without traffic, then given all traffic and the gateway's revision tag together |
| `init` | The default connection was granted every workspace and the Inbox (epoch 1) |
| Backfill | The label-key backfill ran on the first authenticated requests and recorded completion; no observation lacked a label key afterwards |
| Workspaces | Three workspaces were created with the operator tool |
| Classification | All 130 earlier observations, until then Inbox items, were classified through MCP `classify` in four batches, each item reporting `classified`; 11 owner preferences and general lessons received scope `shared` |

## What the hosted checks establish

Through a client connected to the default connection:

- `get_access` listed the Inbox and all-workspaces allowance and the three workspaces with their descriptions.
- `recall` returned existing memories with their place: `inbox` before classification, and the workspace and scope after it.
- With another workspace as `context`, a fact of a different workspace was returned with `usable: false`.
- `list_observations` for the Inbox returned nothing after classification.
- Requests to `/mcp` on the new revision returned `200`.

## What is not established

- A further connection at `/mcp/c/<id>`: none was created, and gateway and Access coverage of `/mcp/c/*` was not checked.
- Whether a client keeps one business's facts out of another's work inside one connection, beyond the `usable` flag being returned.
- Search quality and latency after classification at realistic volume; the index entries were being rewritten (`index-pending`) when the checks ran.
- Whether the owner's placement of each observation is correct; the classification followed the owner's rules, and items the rules did not decide were placed by the owner.
