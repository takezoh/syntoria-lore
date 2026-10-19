# Sign-in and client access

Lore is an API-only resource server. It does not provide a sign-in page, callback page, browser session endpoint, or device logout UI. Gate owns sign-in, approvals, sessions, and logout. An MCP client starts OAuth and handles the callback in its own application, then sends the Gate-issued bearer token to the matching Lore resource.

The REST API, MCP read endpoint, and MCP write endpoint each require a token for their exact resource audience. A browser cookie alone does not authorize a Lore request. Gate approval also does not grant access to Lore data: the exact Gate issuer and subject must already be linked to an existing Lore user and principal, and current Lore grants further limit scopes and capabilities.

To withdraw a client, revoke its connection in Gate. Gate introspection is checked online for each request, so a revoked token is rejected on the next call. Keep bearer tokens private and send them only to their matching HTTPS resource.

The API-only production correction is deployed, and production probes confirm that Lore's old login/session routes are absent and cookie-only or invalid bearer requests are rejected. Gate accepted MCP read and write login initiation and redirected each request to its identity provider. These checks do not establish that a real user can retrieve Lore data through hosted MCP; that remains unverified. See the [deployment record](../eval/api-only-gate-auth-correction-20261019.md).

MCP clients discover Gate OAuth metadata and dynamically register their own exact callback URLs. No fixed public client ID is required. Gate approval and Lore subject admission remain separate checks.
