import process from 'node:process';
import { Buffer } from 'node:buffer';

/** Online authorization: accepted credentials are never cached across requests. */
export interface ExternalIdentityPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly connectionId: string;
  readonly clientId: string;
}

export interface IdentityProviderConfig {
  issuer: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  /** For isolated local tests only; forbidden when NODE_ENV is production. */
  allowLoopbackHttp?: boolean;
}

export interface IdentityProviderDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class IdentityProviderError extends Error {
  readonly status: 401 | 503;
  readonly code: 'invalid_token' | 'authorization_unavailable';
  constructor(status: 401 | 503) {
    super(status === 401 ? 'Invalid external identity credential' : 'Identity provider unavailable');
    this.name = 'IdentityProviderError';
    this.status = status;
    this.code = status === 401 ? 'invalid_token' : 'authorization_unavailable';
  }
}

const MAX_RESPONSE_BYTES = 65_536;
const MAX_TOKEN_LENGTH = 16_384;
const bearerToken = /^[A-Za-z0-9\-._~+/]+=*(?![\s\S])/;
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function safeUrl(value: string, allowHttp: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('Invalid identity provider endpoint URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search ||
      (url.protocol !== 'https:' && !(allowHttp && loopback && url.protocol === 'http:'))) {
    throw new TypeError('Identity provider endpoints require HTTPS without credentials, query or fragment');
  }
  return url;
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
}

async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new IdentityProviderError(503);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new IdentityProviderError(503);
  }
  if (!response.body) throw new IdentityProviderError(503);
  const reader = response.body.getReader();
  const abortReader = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abortReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new IdentityProviderError(503);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(parsed)) throw new IdentityProviderError(503);
    return parsed;
  } finally {
    signal.removeEventListener('abort', abortReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** The clock dependency returns Unix epoch milliseconds, like Date.now. */
export function createIdentityProviderVerifier(
  config: IdentityProviderConfig,
  dependencies: IdentityProviderDependencies = {},
) {
  if (config.allowLoopbackHttp && process.env.NODE_ENV === 'production') {
    throw new TypeError('Loopback HTTP is forbidden in production');
  }
  const allowHttp = config.allowLoopbackHttp === true;
  const issuer = config.issuer;
  const issuerUrl = safeUrl(issuer, allowHttp);
  if (![config.audience, config.clientId, config.clientSecret].every(nonempty)) throw new TypeError('Invalid identity provider verifier configuration');
  const timeoutMs = config.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid Gate timeout');
  const audience = config.audience;
  const authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`, 'utf8').toString('base64')}`;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  let introspectionEndpoint: string | undefined;

  async function request(url: string, options: RequestInit, signal: AbortSignal) {
    const response = await fetcher(url, { ...options, signal, redirect: 'error' });
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel();
      throw new IdentityProviderError(503);
    }
    return readJson(response, signal);
  }

  async function discover(signal: AbortSignal) {
    if (introspectionEndpoint) return introspectionEndpoint;
    const metadata = await request(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      { headers: { accept: 'application/json' } }, signal);
    if (metadata.issuer !== issuer || !nonempty(metadata.introspection_endpoint)) throw new IdentityProviderError(503);
    let endpoint: URL;
    try { endpoint = safeUrl(metadata.introspection_endpoint, allowHttp); }
    catch { throw new IdentityProviderError(503); }
    if (endpoint.origin !== issuerUrl.origin) throw new IdentityProviderError(503);
    introspectionEndpoint = endpoint.href;
    return introspectionEndpoint;
  }

  async function verifyToken(token: string): Promise<ExternalIdentityPrincipal> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH || !bearerToken.test(token)) {
      throw new IdentityProviderError(401);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new IdentityProviderError(503)); }, timeoutMs);
    });
    async function authorize() {
      const endpoint = await discover(controller.signal);
      const data = await request(endpoint, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', authorization },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
      }, controller.signal);
      if (typeof data.active !== 'boolean') throw new IdentityProviderError(503);
      if (!data.active) throw new IdentityProviderError(401);
      const clientId = data.client_id;
      const authorizedParty = data.azp;
      if (data.token_type !== 'Bearer' || data.gate_approved !== true || data.iss !== issuer || !nonempty(data.sub) || !nonempty(data.connection_id) ||
          !Number.isSafeInteger(data.exp) || (data.exp as number) <= now() / 1000 ||
          !nonempty(clientId) || (authorizedParty !== undefined && (!nonempty(authorizedParty) || clientId !== authorizedParty))) throw new IdentityProviderError(401);
      const exactAudience =
        data.aud === audience ||
        (Array.isArray(data.aud) && data.aud.length === 1 && data.aud[0] === audience);
      if (!exactAudience) {
        throw new IdentityProviderError(401);
      }
      return Object.freeze({ issuer, subject: data.sub, connectionId: data.connection_id, clientId });
    }
    try { return await Promise.race([authorize(), timeout]); }
    catch (error) { throw error instanceof IdentityProviderError ? error : new IdentityProviderError(503); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async function authenticate(header: string | undefined | null): Promise<ExternalIdentityPrincipal> {
    if (typeof header !== 'string') throw new IdentityProviderError(401);
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)(?![\s\S])/i.exec(header);
    if (!match) throw new IdentityProviderError(401);
    return verifyToken(match[1]!);
  }

  return Object.freeze({ verifyToken, authenticate });
}

export interface ConfirmationClientConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  /** For isolated local tests only; forbidden when NODE_ENV is production. */
  allowLoopbackHttp?: boolean;
}

export interface ConfirmationSummary {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface ConfirmationRequest {
  readonly subject: string;
  readonly connectionId: string;
  readonly reference: string;
  readonly changeHash: string;
  readonly summary: ConfirmationSummary;
}

export interface CreatedConfirmation {
  readonly id: string;
  readonly url: string;
}

export type ConsumeResult =
  | { readonly status: 'consumed'; readonly subject: string; readonly connectionId: string; readonly decidedAt: number }
  | { readonly status: 'pending' | 'denied' | 'used' | 'expired' };

const CONFIRMATION_ID = /^[A-Za-z0-9_-]{43}$/u;
const WAITING_STATUSES = new Set(['pending', 'denied', 'used', 'expired']);

/**
 * Creates, consumes and cancels Gate change confirmations with the resource's own credentials.
 * A requesting connection that is no longer active surfaces as 401; every other failure as 503.
 */
export function createConfirmationClient(
  config: ConfirmationClientConfig,
  dependencies: IdentityProviderDependencies = {},
) {
  if (config.allowLoopbackHttp && process.env.NODE_ENV === 'production') {
    throw new TypeError('Loopback HTTP is forbidden in production');
  }
  safeUrl(config.issuer, config.allowLoopbackHttp === true);
  if (![config.clientId, config.clientSecret].every(nonempty)) throw new TypeError('Invalid confirmation client configuration');
  const timeoutMs = config.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid Gate timeout');
  const issuer = config.issuer.replace(/\/$/u, '');
  const authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`, 'utf8').toString('base64')}`;
  const fetcher = dependencies.fetch ?? globalThis.fetch;

  async function call(path: string, body: Record<string, unknown>, expected: 200 | 201 | 204): Promise<Record<string, unknown>> {
    const url = `${issuer}${path}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new IdentityProviderError(503)); }, timeoutMs);
    });
    async function send() {
      const response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization },
        body: JSON.stringify(body),
      });
      const unexpected = response.redirected || (response.url && response.url !== url) || response.status !== expected;
      if (unexpected || expected === 204) {
        await response.body?.cancel();
        if (unexpected) throw new IdentityProviderError(response.status === 403 ? 401 : 503);
        return {};
      }
      return readJson(response, controller.signal);
    }
    try { return await Promise.race([send(), timeout]); }
    catch (error) { throw error instanceof IdentityProviderError ? error : new IdentityProviderError(503); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  async function create(request: ConfirmationRequest): Promise<CreatedConfirmation> {
    const data = await call('/confirmations', {
      subject: request.subject,
      connection_id: request.connectionId,
      reference: request.reference,
      change_hash: request.changeHash,
      summary: { title: request.summary.title, lines: [...request.summary.lines] },
    }, 201);
    const id = data.id;
    if (typeof id !== 'string' || !CONFIRMATION_ID.test(id) || data.url !== `${issuer}/confirm?id=${id}`) throw new IdentityProviderError(503);
    return Object.freeze({ id, url: data.url });
  }

  async function consume(id: string, reference: string, changeHash: string): Promise<ConsumeResult> {
    const data = await call('/confirmations/consume', { id, reference, change_hash: changeHash }, 200);
    if (data.status === 'consumed') {
      if (!nonempty(data.subject) || !nonempty(data.connection_id) || !Number.isSafeInteger(data.decided_at)) throw new IdentityProviderError(503);
      return Object.freeze({ status: 'consumed' as const, subject: data.subject, connectionId: data.connection_id, decidedAt: data.decided_at as number });
    }
    if (typeof data.status !== 'string' || !WAITING_STATUSES.has(data.status)) throw new IdentityProviderError(503);
    return Object.freeze({ status: data.status as 'pending' | 'denied' | 'used' | 'expired' });
  }

  async function cancel(id: string, reference: string): Promise<void> {
    await call('/confirmations/cancel', { id, reference }, 204);
  }

  return Object.freeze({ create, consume, cancel });
}

export function protectedResourceMetadata(resource: string, issuer: string) {
  safeUrl(resource, false);
  safeUrl(issuer, false);
  return Object.freeze({ resource, authorization_servers: Object.freeze([issuer]), bearer_methods_supported: Object.freeze(['header']) });
}
