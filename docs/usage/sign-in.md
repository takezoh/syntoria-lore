# Connect an AI client to Lore

Lore does not have a sign-in page, browser session or memory-browsing app. Gate handles sign-in, approval, sessions and logout. An MCP client discovers Gate's OAuth metadata, registers its own callback URL dynamically, signs you in and then sends the resulting Gate bearer token to Lore. No fixed public client ID is required.

## Before you connect

The service operator must admit your Gate account to Lore. Admission maps the Gate issuer and your immutable subject to an existing Lore user and principal, and that principal needs a current grant for the requested scopes and capabilities. Gate sign-in or approval alone does not give a client access to memories; Gate approval and Lore admission are separate checks. The repository does not provide a public sign-up flow or create the admission and grant for you, so ask the operator which Lore resources and permissions are available.

End-to-end use with a hosted AI client and a real user has not been verified yet. The dated [DCR production release record](../eval/dcr-production-release-20261020.md) lists what the hosted probes covered.

## Choose what each client can do

Lore has three resources: the REST API, MCP read and MCP write. A token must be issued for the exact resource the client uses, and a browser cookie cannot replace it.

Lore admits your Gate account, not individual clients. Every client you approve with that account acts as you, with the same memories and permissions. To keep a client read-only, connect it only to MCP read, which can recall memories and follow changes. Connect a client to MCP write only if it should save, correct or forget memories. Because a client on MCP write writes as you, it should save its own suggestions as proposals rather than as your statements.

A workflow that must never act as you needs its own Gate identity, admitted by the operator as a separate non-user principal. Lore then saves the memories it writes only as AI proposals waiting for review, and does not let it supersede, retract or refine your memories.

## Keep access safe

Keep each token private and send it only to its matching HTTPS address. Gate checks a token on every request, so revoking the client's approval at Gate stops later calls.

Builders who are developing locally should follow [local operations](../technical/local-operations.md) and the [agent workflow guide](agent-workflows.md).
