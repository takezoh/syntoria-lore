# Connect an AI client to Lore

Lore does not have a sign-in page, browser session or memory-browsing app. Gate handles sign-in, approval, sessions and logout. An MCP client discovers Gate's OAuth metadata, registers its own callback URL dynamically, signs you in and then sends the resulting Gate bearer token to Lore. No fixed public client ID is required.

## Before you connect

The service operator must admit your Gate account to Lore. Admission maps the Gate issuer and your immutable subject to an existing Lore user and principal, and that principal needs a current grant for the requested scopes and capabilities. Gate sign-in or approval alone does not give a client access to memories; Gate approval and Lore admission are separate checks. The repository does not provide a public sign-up flow or create the admission and grant for you, so ask the operator for the REST or single MCP `/mcp` resource and the capabilities available to your account.

End-to-end use with a hosted AI client and a real user has not been verified yet, and no real approval has been made at Gate. The dated [change confirmation](../eval/change-confirmation-release-20261029.md) and [approval policy](../eval/approval-policy-release-20261029.md) release records list what the hosted probes covered.

## Connect to the MCP resource

Lore has a REST resource and one MCP resource at `/mcp`. A token must be issued for the exact resource the client uses, and a browser cookie cannot replace it. MCP read and write operations share the same URL; Lore lists operations according to the mapped principal's current capabilities.

Each connection also receives only some of your memories. You can keep memories apart in compartments, such as an employer, a client or a private matter. A newly connected AI receives General memories only; ask it to request a compartment when it should see one. Under automatic approval the request is applied at once and recorded; with approval at Gate you approve it there. An AI can also create a compartment or give one up. Content an AI already received stays with that AI.

Lore admits your Gate account, not individual clients. Every client you approve with that account acts for you, with the same memories and permissions, but not as you: Lore records the memories it writes as AI proposals and notes which client wrote them. The principal's `read` capability enables read tools; `write` enables write tools. Clients using the same Gate account share those capabilities, so Lore does not make one client read-only by giving it a different MCP URL.

Some changes need you, not your AI: recording your own decision, preference or correction, Forget, review decisions, enabling a capture source, source rights, access and retention. When an AI asks for one, your account's approval policy decides. Under automatic approval, the default, Lore applies the exact change at once and records that the policy approved it and which AI asked. If the operator sets your account to approval at Gate, Lore stores the exact change and gives the AI a Gate link to show you. Open it, sign in to Gate, read the change as Lore describes it and approve or deny it. The AI then completes it; nothing changes before you approve, and an approval is used once. Either way, an AI never acts as you. Export and import are not available to connected AIs.

## Keep access safe

Keep each token private and send it only to its matching HTTPS address. MCP tokens must target the exact `/mcp` resource. Gate checks a token on every request, so revoking the client's approval at Gate stops later calls.

Builders who are developing locally should follow [local operations](../technical/local-operations.md) and the [agent workflow guide](agent-workflows.md).
