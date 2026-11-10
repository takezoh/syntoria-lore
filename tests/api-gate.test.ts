import { describe, expect, it } from 'vitest';
import { createGateVerifier, GateVerificationError } from '../apps/api/src/gate.js';

const issuer = 'https://gate.example.test';
const audience = 'https://lore.example.test/mcp';
const clientId = 'lore-mcp-resource';
const clientSecret = 'synthetic-resource-secret';
const token = 'opaque-gate-token';
const now = 1_800_000_000_000;

function verifier(fetch: typeof globalThis.fetch, timeoutMs = 100) {
  return createGateVerifier(
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

const introspection = {
  active: true,
  token_type: 'Bearer',
  gate_approved: true,
  iss: issuer,
  sub: 'github:12345',
  connection_id: 'connection-1',
  client_id: 'dynamic-registration-arbitrary-id',
  aud: audience,
  exp: now / 1000 + 60,
};

function gate(change: Record<string, unknown> = {}): typeof fetch {
  return async (input) =>
    String(input).endsWith('openid-configuration')
      ? json({ issuer, introspection_endpoint: `${issuer}/oauth/introspect` })
      : json({ ...introspection, ...change });
}

describe('Gate token verification', () => {
  it('discovers once and introspects every request with the resource credentials', async () => {
    const requests: Array<{ url: string; authorization?: string; body?: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: init?.body?.toString() ?? '',
      });
      return gate()(input, init);
    };
    const auth = verifier(fetcher);

    await expect(auth.authenticate(`Bearer ${token}`)).resolves.toEqual({
      issuer,
      subject: 'github:12345',
      connectionId: 'connection-1',
      clientId: 'dynamic-registration-arbitrary-id',
    });
    await expect(auth.verifyToken(token)).resolves.toMatchObject({ subject: 'github:12345' });
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

  it('rejects inactive, unapproved, expired, foreign and cross-resource tokens as 401', async () => {
    const cases: Record<string, unknown>[] = [
      { active: false },
      { gate_approved: false },
      { gate_approved: undefined },
      { exp: now / 1000 },
      { iss: 'https://other.example.test' },
      { token_type: 'DPoP' },
      { sub: '' },
      { connection_id: undefined },
      { client_id: '' },
      { client_id: undefined, azp: 'mcp' },
      { azp: 'different' },
      { aud: 'https://lore.example.test/' },
      { aud: [audience, 'https://other.example.test/mcp'] },
      { aud: undefined },
    ];
    for (const change of cases) {
      await expect(verifier(gate(change)).verifyToken(token)).rejects.toMatchObject({
        status: 401,
      });
    }
  });

  it('accepts only an exact scalar or singleton audience', async () => {
    for (const aud of [audience, [audience]]) {
      await expect(verifier(gate({ aud })).verifyToken(token)).resolves.toMatchObject({
        subject: 'github:12345',
      });
    }
  });

  it('requires same-origin discovery and reports Gate failures as 503', async () => {
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

    await expect(verifier(gate({ active: 'yes' })).verifyToken(token)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('bounds token format, response size and verification time', async () => {
    const auth = verifier(
      async () =>
        new Response('x'.repeat(65_537), { headers: { 'content-type': 'application/json' } }),
    );
    await expect(auth.authenticate('Bearer malformed token')).rejects.toMatchObject({
      status: 401,
    });
    await expect(auth.authenticate(undefined)).rejects.toMatchObject({ status: 401 });
    await expect(auth.verifyToken('x'.repeat(16_385))).rejects.toMatchObject({ status: 401 });
    await expect(auth.verifyToken(token)).rejects.toMatchObject({ status: 503 });

    const slow = verifier(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
      10,
    );
    await expect(slow.verifyToken(token)).rejects.toBeInstanceOf(GateVerificationError);
    await expect(slow.verifyToken(token)).rejects.toMatchObject({ status: 503 });
  });

  it('refuses plain HTTP issuers unless loopback HTTP is allowed for a local test', () => {
    expect(() =>
      createGateVerifier({ issuer: 'http://127.0.0.1:9000', audience, clientId, clientSecret }),
    ).toThrow(TypeError);
    expect(() =>
      createGateVerifier({
        issuer: 'http://127.0.0.1:9000',
        audience,
        clientId,
        clientSecret,
        allowLoopbackHttp: true,
      }),
    ).not.toThrow();
  });
});
