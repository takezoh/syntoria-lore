import { request as httpRequest, createServer } from 'node:http';
import { resolve } from 'node:path';
import process from 'node:process';
import { URL, pathToFileURL } from 'node:url';

export function isPublicIdentityPathAllowed(pathname, method, realm) {
  if (!isValidRealmSegment(realm)) return false;
  if (typeof pathname !== 'string' || typeof method !== 'string') return false;
  if (pathname.length > 4096 || pathname.includes('\\') || pathname.includes('%')) return false;
  const upperMethod = method.toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(upperMethod)) return false;

  const realmRoot = `/realms/${realm}`;
  const accountRoot = `${realmRoot}/account`;
  const accountRootPaths = new Set([accountRoot, `${accountRoot}/`]);
  const accountReadPaths = new Set([
    `${accountRoot}/index.html`,
    `${accountRoot}/account-security/signing-in`,
    `${accountRoot}/account-security/device-activity`,
    `${accountRoot}/account-security/linked-accounts`,
    `${accountRoot}/applications`,
    `${accountRoot}/groups`,
    `${accountRoot}/supportedLocales`,
    `${accountRoot}/sessions`,
    `${accountRoot}/sessions/devices`,
    `${accountRoot}/credentials`,
    `${accountRoot}/linked-accounts`,
  ]);

  if (accountRootPaths.has(pathname)) {
    return ['GET', 'HEAD', 'POST'].includes(upperMethod);
  }
  if (upperMethod === 'DELETE' && isAllowedAccountDeletePath(pathname, accountRoot)) return true;
  if (accountReadPaths.has(pathname)) return upperMethod === 'GET' || upperMethod === 'HEAD';

  if (pathname === realmRoot || pathname === `${realmRoot}/`) {
    return upperMethod === 'GET' || upperMethod === 'HEAD';
  }
  if (
    pathname === `${realmRoot}/.well-known/openid-configuration` ||
    pathname === `/.well-known/oauth-authorization-server/realms/${realm}` ||
    pathname === `/.well-known/openid-configuration/realms/${realm}`
  ) {
    return upperMethod === 'GET' || upperMethod === 'HEAD';
  }
  if (pathname.startsWith('/resources/')) {
    return upperMethod === 'GET' || upperMethod === 'HEAD';
  }

  const realmPrefix = `${realmRoot}/`;
  if (!pathname.startsWith(realmPrefix)) return false;
  const suffix = pathname.slice(realmPrefix.length);
  if (
    [
      'login-actions/authenticate',
      'login-actions/required-action',
      'login-actions/reset-credentials',
    ].includes(suffix)
  ) {
    return upperMethod === 'GET' || upperMethod === 'POST';
  }
  if (suffix === 'login-actions/consent') return upperMethod === 'POST';
  if (suffix === 'protocol/openid-connect/auth') {
    return upperMethod === 'GET' || upperMethod === 'HEAD';
  }
  if (suffix === 'protocol/openid-connect/token' || suffix === 'protocol/openid-connect/revoke') {
    return upperMethod === 'POST';
  }
  if (suffix === 'protocol/openid-connect/logout') {
    return ['GET', 'HEAD', 'POST'].includes(upperMethod);
  }
  if (
    suffix === 'protocol/openid-connect/certs' ||
    suffix === 'protocol/openid-connect/login-status-iframe.html' ||
    suffix === 'protocol/openid-connect/login-status-iframe.html/init' ||
    suffix === 'protocol/openid-connect/3p-cookies/step1.html' ||
    suffix === 'protocol/openid-connect/3p-cookies/step2.html' ||
    suffix === 'protocol/openid-connect/3p-cookies/step1' ||
    suffix === 'protocol/openid-connect/3p-cookies/step2'
  ) {
    return upperMethod === 'GET' || upperMethod === 'HEAD';
  }
  return false;
}

export function createIdentityProxy({
  publicUrl: configuredPublicUrl,
  backendUrl: configuredBackendUrl,
  realm: configuredRealm,
}) {
  const realm = validateRealmSegment(configuredRealm);
  const accountRoot = `/realms/${realm}/account`;
  const external = readPublicUrl(configuredPublicUrl);
  const backend = readBackendUrl(configuredBackendUrl);

  return createServer((incoming, outgoing) => {
    const method = incoming.method ?? 'GET';
    const rawUrl = incoming.url ?? '/';
    if (containsUnsafeRawPath(rawUrl)) {
      sendDenied(outgoing);
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawUrl, external);
    } catch {
      sendDenied(outgoing);
      return;
    }
    if (
      targetUrl.host !== external.host ||
      (incoming.headers.host ?? '').toLowerCase() !== external.host.toLowerCase()
    ) {
      sendDenied(outgoing);
      return;
    }

    if (targetUrl.pathname === '/') {
      if (['GET', 'HEAD'].includes(method.toUpperCase())) {
        sendAccountRedirect(outgoing, external, accountRoot);
      } else {
        sendDenied(outgoing);
      }
      return;
    }

    if (!isPublicIdentityPathAllowed(targetUrl.pathname, method, realm)) {
      sendDenied(outgoing);
      return;
    }

    const headers = upstreamRequestHeaders(incoming.headers, external);
    const upstream = httpRequest(
      {
        hostname: backend.hostname,
        port: backend.port,
        method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
        agent: false,
      },
      (upstreamResponse) => {
        outgoing.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponseHeaders(upstreamResponse.headers, external, backend),
        );
        upstreamResponse.pipe(outgoing);
      },
    );
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')));
    incoming.once('aborted', () => upstream.destroy());
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) upstream.destroy();
    });
    upstream.once('error', () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
      }
      outgoing.end('Identity service unavailable');
    });
    incoming.pipe(upstream);
  });
}

function isAllowedAccountDeletePath(pathname, accountRoot) {
  const prefix = `${accountRoot}/`;
  if (!pathname.startsWith(prefix)) return false;

  const segments = pathname.slice(prefix.length).split('/');
  if (segments.length === 1) return segments[0] === 'sessions';
  if (segments.length === 2) {
    return segments[0] === 'sessions' && isAccountId(segments[1]);
  }
  if (segments.length === 3) {
    return (
      segments[0] === 'applications' &&
      isAccountId(segments[1]) &&
      ['sessions', 'consent'].includes(segments[2])
    );
  }
  return false;
}

function isAccountId(value) {
  return /^[A-Za-z0-9_-]{1,255}$/.test(value);
}

function sendAccountRedirect(response, external, accountRoot) {
  response.writeHead(302, {
    location: new URL(`${accountRoot}/`, external).toString(),
    'cache-control': 'no-store',
    'content-length': '0',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end();
}

function isValidRealmSegment(value) {
  return (
    typeof value === 'string' &&
    value.toLowerCase() !== 'master' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  );
}

function validateRealmSegment(value) {
  if (!isValidRealmSegment(value)) {
    throw new Error('IDENTITY_REALM must be one safe path segment');
  }
  return value;
}

function upstreamRequestHeaders(incoming, external) {
  const headers = {};
  const connectionTokens = new Set(
    (incoming.connection ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value === undefined ||
      isHopByHop(name) ||
      isForwardingHeader(name) ||
      connectionTokens.has(name.toLowerCase())
    ) {
      continue;
    }
    headers[name] = value;
  }
  headers['host'] = external.host;
  headers['x-forwarded-host'] = external.host;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-port'] = '443';
  return headers;
}

function upstreamResponseHeaders(incoming, external, backend) {
  const headers = {};
  const connectionTokens = new Set(
    (incoming.connection ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value === undefined ||
      isHopByHop(name) ||
      connectionTokens.has(name.toLowerCase()) ||
      name === 'server' ||
      name === 'x-powered-by'
    ) {
      continue;
    }
    headers[name] = name === 'location' ? rewriteInternalLocation(value, external, backend) : value;
  }
  headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  headers['x-content-type-options'] = 'nosniff';
  headers['referrer-policy'] = 'no-referrer';
  return headers;
}

function rewriteInternalLocation(value, external, backend) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    try {
      const location = new URL(item, external);
      if (location.origin === backend.origin) {
        return new URL(
          `${location.pathname}${location.search}${location.hash}`,
          external,
        ).toString();
      }
    } catch {
      return item;
    }
    return item;
  });
}

function readPublicUrl(value) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('IDENTITY_PUBLIC_URL is required');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('IDENTITY_PUBLIC_URL must be an HTTPS origin');
  }
  return url;
}

function readBackendUrl(value) {
  const url = new URL(value ?? 'http://127.0.0.1:8081');
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('IDENTITY_BACKEND_URL must be a local HTTP origin');
  }
  return url;
}

function containsUnsafeRawPath(rawUrl) {
  const rawPath = rawUrl.split('?', 1)[0] ?? '';
  return (
    rawPath.includes('\\') ||
    rawPath.includes('%') ||
    rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

function isHopByHop(name) {
  return new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]).has(name.toLowerCase());
}

function isForwardingHeader(name) {
  return name.toLowerCase() === 'forwarded' || name.toLowerCase().startsWith('x-forwarded-');
}

function sendDenied(response) {
  response.writeHead(404, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end('Not Found');
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('PORT is invalid');
  return parsed;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const server = createIdentityProxy({
    publicUrl: process.env['IDENTITY_PUBLIC_URL'],
    backendUrl: process.env['IDENTITY_BACKEND_URL'],
    realm: process.env['IDENTITY_REALM'],
  });
  const port = parsePort(process.env['PORT'] ?? '8080');
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
