import { Buffer } from 'node:buffer';
import type { GatePrincipal } from '@memory/memory-records';

/** Gate token verification by online introspection; accepted tokens are never cached. */
export interface GateVerifierConfig {
  readonly issuer: string;
  /** The exact resource URL the token must be issued for. */
  readonly audience: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
  /** For isolated local tests only; forbidden when NODE_ENV is production. */
  readonly allowLoopbackHttp?: boolean;
}

export interface GateVerifierDependencies {
  readonly fetch?: typeof globalThis.fetch;
  /** Unix epoch milliseconds, like Date.now. */
  readonly now?: () => number;
}

export interface GateVerifier {
  verifyToken(token: string): Promise<GatePrincipal>;
  authenticate(header: string | undefined | null): Promise<GatePrincipal>;
}

export class GateVerificationError extends Error {
  readonly status: 401 | 503;
  readonly code: 'invalid_token' | 'authorization_unavailable';
  constructor(status: 401 | 503) {
    super(status === 401 ? 'Invalid Gate credential' : 'Gate is unavailable');
    this.name = 'GateVerificationError';
    this.status = status;
    this.code = status === 401 ? 'invalid_token' : 'authorization_unavailable';
  }
}

const MAX_RESPONSE_BYTES = 65_536;
const MAX_TOKEN_LENGTH = 16_384;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*(?![\s\S])/u;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !hasControlCharacter(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function safeUrl(value: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Invalid Gate endpoint URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== 'https:' && !(allowHttp && loopback && url.protocol === 'http:'))
  ) {
    throw new TypeError('Gate endpoints require HTTPS without credentials, query or fragment');
  }
  return url;
}

function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/gu, '+');
}

async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new GateVerificationError(503);
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new GateVerificationError(503);
  }
  if (!response.body) throw new GateVerificationError(503);
  const reader = response.body.getReader();
  const abortReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abortReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new GateVerificationError(503);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isObject(parsed)) throw new GateVerificationError(503);
    return parsed;
  } finally {
    signal.removeEventListener('abort', abortReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Verifies a Gate access token by introspection with the resource's own credentials. The token
 * must be active, Gate-approved, issued by the configured issuer, unexpired, bound to a Gate
 * connection and issued for exactly the configured audience. Gate failures are 503, never 401.
 */
export function createGateVerifier(
  config: GateVerifierConfig,
  dependencies: GateVerifierDependencies = {},
): GateVerifier {
  if (config.allowLoopbackHttp && process.env['NODE_ENV'] === 'production') {
    throw new TypeError('Loopback HTTP is forbidden in production');
  }
  const allowHttp = config.allowLoopbackHttp === true;
  const issuer = config.issuer;
  const issuerUrl = safeUrl(issuer, allowHttp);
  if (![config.audience, config.clientId, config.clientSecret].every(nonempty)) {
    throw new TypeError('Invalid Gate verifier configuration');
  }
  const timeoutMs = config.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Gate timeout');
  }
  const audience = config.audience;
  const authorization = `Basic ${Buffer.from(
    `${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`,
    'utf8',
  ).toString('base64')}`;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  let introspectionEndpoint: string | undefined;

  async function request(url: string, options: RequestInit, signal: AbortSignal) {
    const response = await fetcher(url, { ...options, signal, redirect: 'error' });
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel();
      throw new GateVerificationError(503);
    }
    return readJson(response, signal);
  }

  async function discover(signal: AbortSignal) {
    if (introspectionEndpoint) return introspectionEndpoint;
    const metadata = await request(
      `${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`,
      { headers: { accept: 'application/json' } },
      signal,
    );
    if (metadata['issuer'] !== issuer || !nonempty(metadata['introspection_endpoint'])) {
      throw new GateVerificationError(503);
    }
    let endpoint: URL;
    try {
      endpoint = safeUrl(metadata['introspection_endpoint'], allowHttp);
    } catch {
      throw new GateVerificationError(503);
    }
    if (endpoint.origin !== issuerUrl.origin) throw new GateVerificationError(503);
    introspectionEndpoint = endpoint.href;
    return introspectionEndpoint;
  }

  async function verifyToken(token: string): Promise<GatePrincipal> {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH ||
      !BEARER_TOKEN.test(token)
    ) {
      throw new GateVerificationError(401);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GateVerificationError(503));
      }, timeoutMs);
    });
    async function authorize(): Promise<GatePrincipal> {
      const endpoint = await discover(controller.signal);
      const data = await request(
        endpoint,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            authorization,
          },
          body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
        },
        controller.signal,
      );
      if (typeof data['active'] !== 'boolean') throw new GateVerificationError(503);
      if (!data['active']) throw new GateVerificationError(401);
      const clientId = data['client_id'];
      const authorizedParty = data['azp'];
      const subject = data['sub'];
      const connectionId = data['connection_id'];
      const expiresAt = data['exp'];
      if (
        data['token_type'] !== 'Bearer' ||
        data['gate_approved'] !== true ||
        data['iss'] !== issuer ||
        !nonempty(subject) ||
        !nonempty(connectionId) ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now() / 1000 ||
        !nonempty(clientId) ||
        (authorizedParty !== undefined &&
          (!nonempty(authorizedParty) || clientId !== authorizedParty))
      ) {
        throw new GateVerificationError(401);
      }
      const exactAudience =
        data['aud'] === audience ||
        (Array.isArray(data['aud']) && data['aud'].length === 1 && data['aud'][0] === audience);
      if (!exactAudience) throw new GateVerificationError(401);
      return Object.freeze({ issuer, subject, connectionId, clientId });
    }
    try {
      return await Promise.race([authorize(), timeout]);
    } catch (error) {
      throw error instanceof GateVerificationError ? error : new GateVerificationError(503);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function authenticate(header: string | undefined | null): Promise<GatePrincipal> {
    if (typeof header !== 'string') throw new GateVerificationError(401);
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)(?![\s\S])/iu.exec(header);
    if (!match) throw new GateVerificationError(401);
    return verifyToken(match[1]!);
  }

  return Object.freeze({ verifyToken, authenticate });
}
