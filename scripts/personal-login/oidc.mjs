import { createRemoteJWKSet, jwtVerify } from 'jose';

// Discovery is constrained to the already configured issuer, never browser input.
export async function createOidc({ issuer, clientId, subject }, fetcher = fetch) {
  const response = await fetcher(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('discovery unavailable');
  const metadata = await response.json();
  if (metadata.issuer !== issuer) throw new Error('issuer mismatch');
  for (const name of [
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'end_session_endpoint',
  ]) {
    const url = new URL(metadata[name]);
    if (
      url.protocol !== 'https:' ||
      url.origin !== new URL(issuer).origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(`${new URL(issuer).pathname}/`)
    )
      throw new Error('invalid endpoint');
  }
  const keys = createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 10_000 });
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    logoutEndpoint: metadata.end_session_endpoint,
    async exchange({ code, verifier, redirectUri, nonce }) {
      const result = await fetcher(metadata.token_endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });
      if (!result.ok) throw new Error('exchange failed');
      const tokens = await result.json();
      return verifyIdentity(tokens.id_token, keys, { issuer, clientId, subject, nonce });
    },
  };
}

export async function verifyIdentity(token, keys, { issuer, clientId, subject, nonce }) {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: clientId,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
  });
  if (
    payload.sub !== subject ||
    payload.nonce !== nonce ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
  )
    throw new Error('identity mismatch');
  // Only confirmation time survives; tokens never enter UI, cookies, logs or storage.
  return { expiresAt: payload.exp * 1000 };
}
