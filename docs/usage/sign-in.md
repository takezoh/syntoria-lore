# Connect an AI client to Lore

Lore does not have a sign-in page, browser session or memory-browsing app. Gate handles sign-in, approval, sessions and logout. An MCP client begins OAuth and handles its own callback, then sends the resulting Gate bearer token to Lore.

The token must be for the exact resource the client uses: the REST API, MCP read or MCP write. A Gate sign-in or approval alone does not give the client access to memories. The service operator must already have a Lore identity binding for the existing user, principal and client, and that principal must have a current grant for the requested scopes and capabilities. A browser cookie cannot replace the bearer token.

To connect, use a compatible MCP or REST client configured by the service operator for its exact Lore resource. Keep each token private and send it only to its matching HTTPS address. Gate checks a token on every request, so revoking the client connection prevents later calls. Read-only and write-capable MCP connections have separate resources and permissions.

The repository does not provide a public sign-up flow or create the identity binding and grant for you. Ask the service operator which client and Lore resource are configured for your account before connecting. Builders who are developing locally should follow [local operations](../technical/local-operations.md) and [agent workflows](agent-workflows.md).
