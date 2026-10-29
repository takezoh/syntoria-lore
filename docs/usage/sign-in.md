# Connect an AI client to Lore

Lore does not have a sign-in page, browser session or memory-browsing app. Gate handles sign-in, approval, sessions and logout. An MCP client discovers Gate's OAuth metadata, registers its own callback URL dynamically, signs you in and then sends the resulting Gate bearer token to Lore. No fixed public client ID is required.

## Before you connect

The service operator must admit your Gate account to Lore. Admission maps the Gate issuer and your immutable subject to an existing Lore user and principal, and that principal needs a current grant for the requested scopes and capabilities. Gate sign-in or approval alone does not give a client access to memories; Gate approval and Lore admission are separate checks. The repository does not provide a public sign-up flow or create the admission and grant for you, so ask the operator which Lore resources and permissions are available.

End-to-end use with a hosted AI client and a real user has not been verified yet. The dated [DCR production release record](../eval/dcr-production-release-20261020.md) lists what the hosted probes covered.

## Choose what each client can do

Lore has three resources: the REST API, MCP read and MCP write. A token must be issued for the exact resource the client uses, and a browser cookie cannot replace it.

Lore admits your Gate account, not individual clients. Every client you approve with that account acts for you, with the same memories and permissions, but not as you: Lore records the memories it writes as AI proposals and notes which client wrote them. To keep a client read-only, connect it only to MCP read, which can recall memories, follow changes and show what waits for your review. Connect a client to MCP write only if it should save, correct or request changes.

Some changes need you, not your AI: recording your own decision, preference or correction, Forget, review decisions, enabling a capture source, source rights, access and retention. When an AI asks for one, Lore stores the exact change and gives the AI a Gate link to show you. Open it, sign in to Gate, read the change as Lore describes it and approve or deny it. The AI then completes it; nothing changes before you approve, and an approval is used once. The operator turns this separation on for your account. Export and import are not available to connected AIs.

## Keep access safe

Keep each token private and send it only to its matching HTTPS address. Gate checks a token on every request, so revoking the client's approval at Gate stops later calls.

Builders who are developing locally should follow [local operations](../technical/local-operations.md) and the [agent workflow guide](agent-workflows.md).
