import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { page } from './page.mjs';
const random = () => randomBytes(32).toString('base64url');

export async function startPersonalLogin({
  config,
  oidcFactory,
  port = 18970,
  now = Date.now,
  attemptMs = 600_000,
}) {
  let origin;
  let session;
  const server = createServer(async (req, res) => {
    const styleNonce = random();
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader(
      'content-security-policy',
      `default-src 'none'; style-src 'nonce-${styleNonce}'; form-action 'self' ${new URL(config.issuer).origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    const redirect = (target = '/') => {
      res.writeHead(303, { location: target });
      res.end();
    };
    const deny = () => {
      res.writeHead(400);
      res.end('操作を確認できません。入口を開き直してください。');
    };
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        !req.url?.startsWith('/') ||
        req.url.startsWith('//')
      )
        return deny();
      const url = new URL(req.url, origin);
      const cookie = req.headers.cookie
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith('memory_login='))
        ?.slice('memory_login='.length);
      if (req.method === 'GET' && url.pathname === '/') {
        if (!session || now() >= session.deadline)
          session = { id: random(), csrf: random(), status: 'ready', deadline: now() + 3_600_000 };
        res.setHeader('set-cookie', `memory_login=${session.id}; HttpOnly; SameSite=Lax; Path=/`);
        if (session.attempt && now() >= session.attempt.deadline) {
          session.attempt = undefined;
          session.status = 'expired';
        }
        if (session.expiresAt && now() >= session.expiresAt) {
          session.status = 'expired';
          session.expiresAt = undefined;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          page({
            status: session.status,
            csrf: session.csrf,
            styleNonce,
            productDisplayName: config.productDisplayName,
            userInitialPasswordUrl: config.userInitialPasswordUrl,
            cloudProject: config.cloudProject,
          }),
        );
        return;
      }
      if (!session || cookie !== session.id || now() >= session.deadline) return deny();
      if (req.method === 'GET' && url.pathname === '/callback') {
        const attempt = session.attempt;
        // Consume before any await, including on invalid callbacks.
        session.attempt = undefined;
        session.status = 'error';
        if (!attempt || now() >= attempt.deadline) {
          session.status = 'expired';
          return redirect();
        }
        for (const key of ['state', 'code', 'error', 'iss'])
          if (url.searchParams.getAll(key).length > 1) return redirect();
        if (
          url.searchParams.get('state') !== attempt.state ||
          (url.searchParams.has('iss') && url.searchParams.get('iss') !== config.issuer)
        )
          return redirect();
        if (url.searchParams.has('error')) {
          session.status =
            url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'error';
          return redirect();
        }
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) return redirect();
        const current = session;
        const generation = current.generation;
        const result = await attempt.oidc.exchange({
          code,
          nonce: attempt.nonce,
          verifier: attempt.verifier,
          redirectUri: `${origin}/callback`,
        });
        if (
          session === current &&
          generation === current.generation &&
          now() < attempt.deadline &&
          now() < result.expiresAt
        ) {
          current.status = 'success';
          current.expiresAt = result.expiresAt;
        }
        return redirect();
      }
      if (req.method !== 'POST' || !['/login', '/cancel', '/logout'].includes(url.pathname)) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (
        req.headers.origin !== origin ||
        req.headers['content-type'] !== 'application/x-www-form-urlencoded'
      )
        return deny();
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return deny();
      }
      const params = new URLSearchParams(body);
      if (params.getAll('csrf').length !== 1 || params.get('csrf') !== session.csrf) return deny();
      session.generation = random();
      session.attempt = undefined;
      session.expiresAt = undefined;
      if (url.pathname === '/cancel') {
        session.status = 'cancelled';
        return redirect();
      }
      if (url.pathname === '/logout') {
        session.status = 'logout';
        const oidc = await oidcFactory(config);
        const target = new URL(oidc.logoutEndpoint);
        target.searchParams.set('client_id', config.clientId);
        return redirect(target.href);
      }
      session.status = 'waiting';
      const current = session;
      const generation = current.generation;
      const oidc = await oidcFactory(config);
      if (session !== current || generation !== current.generation) return redirect();
      const attempt = {
        state: random(),
        nonce: random(),
        verifier: random(),
        deadline: now() + attemptMs,
        oidc,
      };
      session.attempt = attempt;
      const target = new URL(oidc.authorizationEndpoint);
      target.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${origin}/callback`,
        response_type: 'code',
        scope: 'openid',
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'login',
        login_hint: 'user',
      }).toString();
      redirect(target.href);
    } catch {
      // Provider responses can contain secrets: never render or log exceptions.
      if (session) {
        session.attempt = undefined;
        session.status = 'error';
      }
      if (!res.headersSent) redirect();
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    url: origin,
    close: () =>
      new Promise((resolve, reject) => {
        session = undefined;
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
