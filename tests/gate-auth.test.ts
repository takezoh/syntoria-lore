import { describe, expect, it } from 'vitest';
import {
  createIdentityProviderVerifier,
  IdentityProviderError,
} from '../packages/auth/src/connection-verifier.js';

const issuer = 'https://gate.example.test';
const audience = 'https://api.example.test';
const clientId = 'api-resource';
const clientSecret = 'synthetic-resource-secret';
const token = 'opaque-gate-token';
const now = 1_800_000_000_000;

function verifier(fetch: typeof globalThis.fetch, timeoutMs = 100) {
  return createIdentityProviderVerifier(
    { issuer, audience, clientId, clientSecret, timeoutMs },
    { fetch, now: () => now },
  );
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Gate online credential verification', () => {
  it('discovers once and introspects every request without positive token caching', async () => {
    const requests: Array<{
      url: string;
      authorization?: string | undefined;
      body?: string | undefined;
    }> = [];
    let calls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        body: init?.body?.toString(),
      });
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return json({ issuer, introspection_endpoint: `${issuer}/oauth/introspect` });
      }
      if (url === `${issuer}/oauth/introspect`) {
        calls += 1;
        return json({
          active: true,
          token_type: 'Bearer',
          gate_approved: true,
          iss: issuer,
          sub: 'github:12345',
          connection_id: 'connection-1',
          client_id: 'dynamic-registration-arbitrary-id',
          aud: audience,
          exp: now / 1000 + 60,
        });
      }
      throw new Error(`Unexpected Gate URL ${url}`);
    };
    const auth = verifier(fetcher);

    await expect(auth.authenticate(`Bearer ${token}`)).resolves.toMatchObject({
      issuer,
      subject: 'github:12345',
      connectionId: 'connection-1',
      clientId: 'dynamic-registration-arbitrary-id',
    });
    await expect(auth.verifyToken(token)).resolves.toMatchObject({ subject: 'github:12345' });
    expect(calls).toBe(2);
    expect(requests.filter((request) => request.url.endsWith('openid-configuration'))).toHaveLength(
      1,
    );
    expect(requests.filter((request) => request.url.endsWith('oauth/introspect'))).toHaveLength(2);
    expect(requests[1]?.authorization).toBe(
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    );
    expect(new URLSearchParams(requests[1]?.body).get('token')).toBe(token);
    expect(requests[1]?.body).not.toContain(clientSecret);
  });

  it('rejects inactive, expired, malformed-client and cross-resource credentials as 401', async () => {
    const cases = [
      { active: false },
      { active: true, exp: now / 1000 },
      { active: true, client_id: '' },
      { active: true, client_id: undefined, azp: 'mcp' },
      { active: true, azp: 'different' },
      { active: true, aud: ['https://other.example.test'] },
    ];
    for (const change of cases) {
      const fetcher: typeof fetch = async (input) =>
        String(input).endsWith('openid-configuration')
          ? json({ issuer, introspection_endpoint: `${issuer}/oauth/introspect` })
          : json(
              Object.assign(
                {
                  active: true,
                  token_type: 'Bearer',
                  gate_approved: true,
                  iss: issuer,
                  sub: 'github:12345',
                  connection_id: 'connection-1',
                  client_id: 'dynamic-registration-arbitrary-id',
                  aud: audience,
                  exp: now / 1000 + 60,
                },
                change,
              ),
            );
      await expect(verifier(fetcher).verifyToken(token)).rejects.toMatchObject({
        status: 401,
      });
    }
  });

  it('accepts only an exact scalar or singleton resource audience', async () => {
    for (const aud of [audience, [audience]]) {
      const fetcher: typeof fetch = async (input) =>
        String(input).endsWith('openid-configuration')
          ? json({ issuer, introspection_endpoint: `${issuer}/oauth/introspect` })
          : json({
              active: true,
              token_type: 'Bearer',
              gate_approved: true,
              iss: issuer,
              sub: 'immutable-subject',
              connection_id: 'connection-1',
              client_id: 'mcp',
              aud,
              exp: now / 1000 + 60,
            });
      await expect(verifier(fetcher).verifyToken(token)).resolves.toMatchObject({
        issuer,
        subject: 'immutable-subject',
        clientId: 'mcp',
      });
    }

    const mixedAudience: typeof fetch = async (input) =>
      String(input).endsWith('openid-configuration')
        ? json({ issuer, introspection_endpoint: `${issuer}/oauth/introspect` })
        : json({
            active: true,
            token_type: 'Bearer',
            gate_approved: true,
            iss: issuer,
            sub: 'immutable-subject',
            connection_id: 'connection-1',
            client_id: 'mcp',
            aud: [audience, 'https://mcp.example.test/mcp/read'],
            exp: now / 1000 + 60,
          });
    await expect(verifier(mixedAudience).verifyToken(token)).rejects.toBeInstanceOf(
      IdentityProviderError,
    );
    await expect(verifier(mixedAudience).verifyToken(token)).rejects.toMatchObject({ status: 401 });
  });

  it('requires canonical same-origin discovery and reports upstream failures as 503', async () => {
    const wrongIssuer: typeof fetch = async () =>
      json({ issuer: `${issuer}/different`, introspection_endpoint: `${issuer}/oauth/introspect` });
    await expect(verifier(wrongIssuer).verifyToken(token)).rejects.toMatchObject({ status: 503 });

    const wrongOrigin: typeof fetch = async () =>
      json({ issuer, introspection_endpoint: 'https://other.example.test/introspect' });
    await expect(verifier(wrongOrigin).verifyToken(token)).rejects.toMatchObject({ status: 503 });

    const unavailable: typeof fetch = async () => {
      throw new Error('synthetic network outage');
    };
    await expect(verifier(unavailable).verifyToken(token)).rejects.toMatchObject({ status: 503 });
  });

  it('bounds token format, response size and verification time', async () => {
    const auth = verifier(
      async () =>
        new Response('x'.repeat(65_537), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(auth.authenticate('Bearer malformed token')).rejects.toMatchObject({
      status: 401,
    });
    await expect(auth.verifyToken('x'.repeat(16_385))).rejects.toMatchObject({ status: 401 });

    const slow = verifier(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
      10,
    );
    await expect(slow.verifyToken(token)).rejects.toBeInstanceOf(IdentityProviderError);
    await expect(slow.verifyToken(token)).rejects.toMatchObject({ status: 503 });
  });
});
