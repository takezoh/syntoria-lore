const [client = 'owner', resource = 'http://localhost:18080', requestedScope] =
  process.argv.slice(2);
const profiles = {
  owner: {
    id: 'demo-owner-client',
    secret: 'owner-local-fixture-only',
    defaultScope: 'memory:read memory:write memory:admin',
  },
  reader: {
    id: 'demo-reader-client',
    secret: 'reader-local-fixture-only',
    defaultScope: 'memory:read',
  },
};
const selected = profiles[client];
if (!selected) throw new Error('Use owner or reader as the client profile');
const body = new URLSearchParams({
  grant_type: 'client_credentials',
  resource,
  scope: requestedScope ?? selected.defaultScope,
});
const authorization = Buffer.from(`${selected.id}:${selected.secret}`).toString('base64');
const response = await fetch('http://localhost:19090/oauth/token', {
  method: 'POST',
  headers: {
    authorization: `Basic ${authorization}`,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body,
  signal: AbortSignal.timeout(5_000),
});
if (!response.ok) throw new Error(`Local issuer denied token request (HTTP ${response.status})`);
const token = await response.json();
process.stdout.write(`${token.access_token}\n`);
