---
id: adr-0005-use-one-mcp-resource
kind: adr
title: Use one MCP resource and authorize each operation by capability
status: accepted
created: '2026-10-29'
decision_makers:
- owner
relations:
- {type: references, target: adr-0003-attribute-ai-clients-and-confirm-user-decisions}
- {type: references, target: adr-0004-approve-protected-changes-by-policy}
summary: One exact MCP OAuth resource serves the `/mcp` endpoint, and Lore selects operations from the authenticated principal's current capabilities.
---

# Use one MCP resource and authorize each operation by capability

## Decision

On 2026-10-29 the service owner decided to replace the split MCP read and write resources with one exact OAuth MCP resource at `/mcp`. Lore exposes each operation according to the authenticated principal's current capabilities: read tools require `read`, write tools require `write`, and domain services continue to enforce scope grants and higher authority requirements.

The `/mcp` protected-resource metadata names the exact `/mcp` audience. Gate introspection still uses a dedicated MCP resource client credential, separate from the REST API resource credential. The MCP resource does not grant Lore permissions by itself.

Connections under the same Gate subject resolve to the same Lore principal and capability set. The introspected OAuth client ID remains provenance and does not select grants. There are no legacy `/mcp/read` or `/mcp/write` aliases or audience fallbacks.

## Requirements and rationale

The user requested one MCP connection URL for read and write and per-operation authorization. The existing authenticated actor already carries capabilities derived from the binding ceiling intersected with live grants; `admin` includes both `read` and `write`. Selecting MCP tools from those capabilities keeps authorization attached to the principal and lets a single authorized connection use both operation groups. Shared services and PostgreSQL RLS continue to enforce scope-specific access.

| Alternative | Decision basis |
| --- | --- |
| Keep separate read and write paths, audiences and tool sets | Rejected because it preserves the resource split the owner asked to remove. |
| Use one MCP URL but keep a single all-or-nothing MCP permission | Rejected because it would ignore the existing per-principal read/write capability model. |
| Use one exact MCP resource and select each tool group by its required capability | Chosen because it provides one OAuth resource and keeps operation authorization tied to current Lore grants. |

## Consequences

- MCP clients connect to one URL and request a Gate token for the exact `https://<api-origin>/mcp` audience. The REST API remains a separate resource.
- A principal with only `read` sees read and status tools; one with only `write` sees write tools; a principal with both sees both on the same connection. Every operation still checks scope access, current grants and its domain-specific authority rules.
- The API needs one dedicated MCP introspection client ID and secret, plus `AUTH_MCP_AUDIENCE`. The ignored deployment profile and Secret Manager reference must be updated before a rollout. Existing MCP clients must reconnect and obtain a token for the new audience; tokens for either old MCP audience will fail exact-audience verification.
- A pending confirmation stays bound to the OAuth resource credential that created it. It cannot be transferred from an old read/write resource credential to the new MCP resource. Coordinate any rollout with pending confirmations.
- No database, identity-binding, grant, memory or deletion-ledger migration is required. The REST and MCP adapters continue to use the same domain packages. Forget suppression and restore reconciliation do not change.
- The source change does not deploy the new Gate resource or update hosted secrets. Hosted acceptance remains separate.

## Confirmation

The implementation must demonstrate that a read-only token on `/mcp` sees read tools and cannot call a write tool, a write-only token sees write tools, and a token with both capabilities can read and write through one official MCP client connection. Tests must also verify that the API audience is rejected at `/mcp`, the MCP audience is rejected by the API verifier, metadata names the exact `/mcp` resource, and old split paths return 404. PostgreSQL scope and RLS checks must continue to pass.

This ADR records the decision; it is not evidence that the Gate registration or hosted clients have been updated. Local verification and hosted rollout evidence are recorded separately.

## Sources

- Owner direction: replace split MCP read/write configuration with one `/mcp` endpoint and per-operation permissions.
- [MCP and HTTP API contract](../technical/mcp-api.md)
- [Gate capability derivation](../../packages/auth/src/index.ts)
- [Identity and authority decision](0003-attribute-ai-clients-and-confirm-user-decisions.md)
- [Protected-change approval policy](0004-approve-protected-changes-by-policy.md)
