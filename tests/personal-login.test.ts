import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { startPersonalLogin, type Exchange } from '../scripts/personal-login/server.mjs';
import { createOidc, verifyIdentity } from '../scripts/personal-login/oidc.mjs';

const config = {
  issuer: 'https://identity.example/realms/memory',
  clientId: 'memory-public-app',
  subject: 'personal-subject',
  productDisplayName: 'Syntoria Lore',
  ownerInitialPasswordUrl:
    'https://console.cloud.google.com/secret-manager/secret/lore-owner-initial-password/versions?project=syntoria',
  cloudProject: 'syntoria',
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function setup(
  options: {
    now?: () => number;
    exchange?: (input: Exchange) => Promise<{ expiresAt: number }>;
  } = {},
) {
  const exchanges: Exchange[] = [];
  const helper = await startPersonalLogin({
    config,
    port: 0,
    ...options,
    oidcFactory: async () => ({
      authorizationEndpoint: `${config.issuer}/protocol/openid-connect/auth`,
      logoutEndpoint: `${config.issuer}/protocol/openid-connect/logout`,
      exchange: async (input) => {
        exchanges.push(input);
        return options.exchange ? options.exchange(input) : { expiresAt: Date.now() + 60_000 };
      },
    }),
  });
  cleanup.push(helper.close);
  const root = await fetch(helper.url);
  const html = await root.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const cookie = root.headers.get('set-cookie')!.split(';')[0]!;
  const get = (path: string) =>
    fetch(`${helper.url}${path}`, { headers: { cookie }, redirect: 'manual' });
  const post = (
    path: string,
    origin = helper.url,
    body = new URLSearchParams({ csrf }).toString(),
  ) =>
    fetch(`${helper.url}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  const login = async () => new URL((await post('/login')).headers.get('location')!);
  const callback = (url: URL, extra = '') =>
    get(`/callback?state=${url.searchParams.get('state')}&code=sensitive-code${extra}`);
  return { ...helper, root, html, cookie, post, get, login, callback, exchanges };
}

describe('personal browser HTTP boundary', () => {
  it('binds only loopback, returns protected Japanese UI and requires a same-origin form', async () => {
    const app = await setup();
    expect(app.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(app.html).toContain('本人の初期設定');
    expect(app.html).toContain('Syntoria Lore');
    expect(app.html).toContain('lore-owner-initial-password');
    expect(app.html).toContain('サービス接続：未確認');
    expect(app.root.headers.get('cache-control')).toBe('no-store');
    expect(app.root.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(app.root.headers.get('content-security-policy')).toContain(
      "form-action 'self' https://identity.example",
    );
    expect(app.root.headers.get('referrer-policy')).toBe('same-origin');
    expect(app.root.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
    expect((await app.post('/login', 'https://attacker.example')).status).toBe(400);
    expect((await app.post('/login', 'null')).status).toBe(400);
    expect(app.html).toContain('target="_blank" rel="noopener"');
    expect((await app.post('/login', app.url, 'csrf=wrong')).status).toBe(400);
    const status = await new Promise<number>((resolve) => {
      const req = request(app.url, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.end();
    });
    expect(status).toBe(400);
  });
  it('uses PKCE, nonce, fresh login and a one-time callback without leaking exchanged secrets', async () => {
    const app = await setup();
    const auth = await app.login();
    expect(auth.searchParams.get('prompt')).toBe('login');
    expect(auth.searchParams.get('scope')).toBe('openid');
    expect(auth.searchParams.get('redirect_uri')).toBe(`${app.url}/callback`);
    const response = await app.callback(auth);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(app.exchanges).toHaveLength(1);
    expect(createHash('sha256').update(app.exchanges[0]!.verifier).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge'),
    );
    expect(app.exchanges[0]!.nonce).toBe(auth.searchParams.get('nonce'));
    const body = await (await app.get('/')).text();
    expect(body).toContain('あなたのログインを確認しました');
    expect(body).not.toContain('sensitive-code');
    expect(body).not.toContain(app.exchanges[0]!.verifier);
    await app.callback(auth);
    expect(app.exchanges).toHaveLength(1);
    expect(await (await app.get('/')).text()).not.toContain('あなたのログインを確認しました');
  });
  it('rejects wrong state, wrong response issuer, duplicate parameters and missing browser binding', async () => {
    const app = await setup();
    await app.login();
    await app.get('/callback?state=wrong&code=secret');
    expect(app.exchanges).toHaveLength(0);
    const auth = await app.login();
    await app.callback(auth, '&iss=https://evil.example');
    expect(app.exchanges).toHaveLength(0);
    const next = await app.login();
    await app.callback(next, '&state=duplicate');
    expect(app.exchanges).toHaveLength(0);
    expect((await fetch(`${app.url}/callback?state=x&code=x`, { redirect: 'manual' })).status).toBe(
      400,
    );
  });
  it('supports denial, cancellation, retry and expiry without accepting old callbacks', async () => {
    let now = Date.now();
    const app = await setup({ now: () => now });
    const first = await app.login();
    await app.get(
      `/callback?state=${first.searchParams.get('state')}&error=access_denied&error_description=SECRET`,
    );
    expect(await (await app.get('/')).text()).toContain('取り消しました');
    expect(await (await app.get('/')).text()).not.toContain('SECRET');
    const second = await app.login();
    await app.post('/cancel');
    await app.callback(second);
    expect(app.exchanges).toHaveLength(0);
    const third = await app.login();
    now += 600_001;
    await app.callback(third);
    expect(await (await app.get('/')).text()).toContain('有効期限が切れました');
    expect(app.exchanges).toHaveLength(0);
    const fourth = await app.login();
    expect(fourth.searchParams.get('state')).not.toBe(third.searchParams.get('state'));
  });
  it('masks provider exceptions and expires confirmed state', async () => {
    const bad = await setup({
      exchange: async () => {
        throw new Error('TOKEN_PASSWORD_SECRET');
      },
    });
    await bad.callback(await bad.login());
    const html = await (await bad.get('/')).text();
    expect(html).toContain('ログインを確認できませんでした');
    expect(html).not.toContain('TOKEN_PASSWORD_SECRET');
    let now = Date.now();
    const app = await setup({ now: () => now, exchange: async () => ({ expiresAt: now + 100 }) });
    await app.callback(await app.login());
    now += 101;
    expect(await (await app.get('/')).text()).toContain('有効期限が切れました');
  });
  it('does not resurrect confirmation when cancelled during exchange; logout has no token or redirect registration', async () => {
    let finish!: (result: { expiresAt: number }) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await setup({
      exchange: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const auth = await app.login();
    const callback = app.callback(auth);
    await waiting;
    await app.post('/cancel');
    finish({ expiresAt: Date.now() + 60_000 });
    await callback;
    expect(await (await app.get('/')).text()).not.toContain('あなたのログインを確認しました');
    const logout = await app.post('/logout');
    expect(logout.headers.get('location')).toBe(
      `${config.issuer}/protocol/openid-connect/logout?client_id=memory-public-app`,
    );
    expect(await (await app.get('/')).text()).toContain('ここでは完了を確認していません');
  });
  it('rejects bind conflict before exposing an entry URL', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => occupied.close(() => resolve())));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    await expect(
      startPersonalLogin({
        config,
        port: address.port,
        oidcFactory: () => Promise.reject(new Error('unused')),
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('OIDC cryptographic identity boundary', () => {
  it('accepts only the configured signed identity, nonce, issuer, audience and expiry', async () => {
    const key = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(key.publicKey)), kid: 'test' }],
    });
    const claims = {
      sub: config.subject,
      iss: config.issuer,
      aud: config.clientId,
      nonce: 'nonce',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const sign = (change: Record<string, unknown> = {}, privateKey = key.privateKey) =>
      new SignJWT({ ...claims, ...change })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .sign(privateKey);
    const verify = async (change: Record<string, unknown> = {}) =>
      verifyIdentity(await sign(change), keys, { ...config, nonce: 'nonce' });
    await expect(verify()).resolves.toHaveProperty('expiresAt');
    for (const change of [
      { sub: 'smoke-subject' },
      { nonce: 'wrong' },
      { iss: 'https://wrong.example' },
      { aud: 'other-client' },
      { exp: 1 },
      { azp: 'other-client' },
      { aud: [config.clientId, 'extra'] },
      { nonce: undefined },
      { exp: undefined },
    ])
      await expect(verify(change)).rejects.toThrow();
    await expect(
      verifyIdentity(await sign({}, other.privateKey), keys, { ...config, nonce: 'nonce' }),
    ).rejects.toThrow();
    await expect(
      verifyIdentity('not.a.token', keys, { ...config, nonce: 'nonce' }),
    ).rejects.toThrow();
  });
  it('rejects discovery issuer and endpoints outside the configured HTTPS issuer boundary', async () => {
    const metadata = {
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/auth`,
      token_endpoint: `${config.issuer}/token`,
      jwks_uri: `${config.issuer}/certs`,
      end_session_endpoint: `${config.issuer}/logout`,
    };
    for (const change of [
      { issuer: 'https://other.example' },
      { token_endpoint: 'https://evil.example/token' },
      { jwks_uri: 'http://identity.example/realms/memory/certs' },
      { authorization_endpoint: 'https://identity.example/other' },
    ]) {
      await expect(
        createOidc(config, async () => Response.json({ ...metadata, ...change })),
      ).rejects.toThrow();
    }
    await expect(createOidc(config, async () => Response.json(metadata))).resolves.toHaveProperty(
      'authorizationEndpoint',
    );
  });
});
