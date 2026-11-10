import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  AccessDeniedError,
  type ConnectionAccess,
  type GatePrincipal,
  type MemoryService,
} from '@memory/memory-records';
import { AccessVerificationError } from './access.js';
import { GateVerificationError, type GateVerifier } from './gate.js';
import { handleMcpRequest } from './mcp.js';
import { RequestLimits } from './request-limits.js';

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_RATE_LIMIT = 120;
const METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

export interface ApiServerOptions {
  /** The exact public `/mcp` URL, also the token audience. */
  readonly mcpResourceUrl: string;
  readonly gateIssuer: string;
  /** Hosts accepted in the Host header of `/mcp` requests. */
  readonly mcpAllowedHosts: readonly string[];
  readonly verifier: GateVerifier;
  /** Access mode consumes only this header; Authorization is the gateway's IAM token. */
  readonly authenticateAssertion?: (assertion: string | undefined) => Promise<GatePrincipal>;
  readonly resolveAccess: (principal: GatePrincipal) => Promise<ConnectionAccess>;
  readonly service: MemoryService;
  /** Fails unless every backing store answers. */
  readonly ready: () => Promise<void>;
  readonly maxBodyBytes?: number;
  /** Requests per minute for one Gate connection, and failed authentications per address. */
  readonly rateLimit?: number;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** The HTTP listener: health and readiness, protected-resource metadata and Remote MCP. */
export function createRequestListener(options: ApiServerOptions): RequestListener {
  const limits = new RequestLimits({
    connectionLimit: options.rateLimit ?? DEFAULT_RATE_LIMIT,
    unauthenticatedLimit: options.rateLimit ?? DEFAULT_RATE_LIMIT,
  });
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const resource = new URL(options.mcpResourceUrl);
  const metadataUrl = new URL(METADATA_PATH, resource.origin).toString();
  const allowedHosts = new Set(options.mcpAllowedHosts.map((host) => host.toLowerCase()));
  return (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendError(response, new HttpError(500, 'internal_error', 'Request failed', true));
      } else response.destroy();
    });
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const requestId = randomUUID();
    let route = 'unmatched';
    response.once('finish', () => {
      log({
        event: 'api.request',
        request_id: requestId,
        method: request.method ?? 'UNKNOWN',
        route,
        status: response.statusCode,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    });
    response.setHeader('x-request-id', requestId);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('strict-transport-security', 'max-age=31536000');
    let path: string;
    try {
      path = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendError(response, new HttpError(400, 'bad_request', 'Invalid request target'));
      return;
    }
    const method = request.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      route = 'GET /healthz';
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (method === 'GET' && path === '/readyz') {
      route = 'GET /readyz';
      try {
        await options.ready();
        sendJson(response, 200, { status: 'ready' });
      } catch {
        sendJson(response, 503, { status: 'unavailable' });
      }
      return;
    }
    if (options.authenticateAssertion === undefined && method === 'GET' && path === METADATA_PATH) {
      route = 'GET /.well-known/*';
      sendJson(response, 200, {
        resource: options.mcpResourceUrl,
        authorization_servers: [options.gateIssuer],
        scopes_supported: ['openid'],
        bearer_methods_supported: ['header'],
      });
      return;
    }
    if (path !== resource.pathname) {
      sendError(response, new HttpError(404, 'not_found', 'Not found'));
      return;
    }

    route = `${method} /mcp`;
    const host = (request.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      sendError(response, new HttpError(403, 'mcp_host_forbidden', 'MCP Host is not allowed'));
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !sameOrigin(origin, host)) {
      sendError(response, new HttpError(403, 'mcp_origin_forbidden', 'MCP Origin is not allowed'));
      return;
    }
    if (method === 'OPTIONS') {
      response.writeHead(204, {
        ...(origin === undefined ? {} : { 'access-control-allow-origin': origin, vary: 'Origin' }),
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers':
          'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id',
        'access-control-max-age': '300',
      });
      response.end();
      return;
    }
    if (method !== 'POST') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
      response.end('Method Not Allowed');
      return;
    }
    try {
      if (
        countHeader(
          request,
          options.authenticateAssertion === undefined ? 'authorization' : 'cf-access-jwt-assertion',
        ) > 1
      ) {
        throw new HttpError(401, 'unauthorized', 'Duplicate Authorization headers are not allowed');
      }
      const principal = await authenticate(request);
      if (!limits.admitConnection(`${principal.subject}\u0000${principal.connectionId}`)) {
        throw rateLimited();
      }
      let access: ConnectionAccess;
      try {
        access = await options.resolveAccess(principal);
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          throw new HttpError(403, 'forbidden', 'This account is not admitted to Lore');
        }
        throw new HttpError(503, 'unavailable', 'Access could not be checked', true);
      }
      const webRequest = await toWebRequest(
        request,
        options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      );
      const webResponse = await handleMcpRequest(
        {
          service: options.service,
          maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
          log,
        },
        access,
        webRequest,
      );
      const headers = Object.fromEntries(webResponse.headers.entries());
      if (origin !== undefined) {
        headers['access-control-allow-origin'] = origin;
        headers['vary'] = 'Origin';
      }
      response.writeHead(webResponse.status, headers);
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
      const failure =
        error instanceof HttpError
          ? error
          : new HttpError(500, 'internal_error', 'MCP request could not be completed', true);
      if (failure.status === 429) response.setHeader('retry-after', '60');
      if (failure.status === 401) {
        response.setHeader('www-authenticate', `Bearer resource_metadata="${metadataUrl}"`);
      }
      sendError(response, failure);
    }
  }

  /**
   * Verifies the bearer within the request budgets: a failed verification counts against the
   * client address, so unauthenticated traffic cannot spend an authenticated connection's budget.
   */
  async function authenticate(request: IncomingMessage): Promise<GatePrincipal> {
    const address = request.socket.remoteAddress ?? 'unknown';
    const rawAssertion = request.headers['cf-access-jwt-assertion'];
    const assertion = typeof rawAssertion === 'string' ? rawAssertion : undefined;
    const credential =
      options.authenticateAssertion === undefined
        ? /^Bearer (\S+)$/iu.exec(request.headers.authorization ?? '')?.[1]
        : assertion;
    if (!limits.admitCredential(address, credential)) throw rateLimited();
    try {
      const principal =
        options.authenticateAssertion === undefined
          ? await options.verifier.authenticate(request.headers.authorization)
          : await options.authenticateAssertion(assertion);
      if (credential !== undefined) limits.recordVerified(credential);
      return principal;
    } catch (error) {
      if (
        (error instanceof GateVerificationError || error instanceof AccessVerificationError) &&
        error.status === 503
      ) {
        throw new HttpError(503, 'authorization_unavailable', 'Authorization is unavailable', true);
      }
      if (error instanceof AccessVerificationError && error.status === 403) {
        throw new HttpError(403, 'forbidden', 'This identity is not admitted');
      }
      limits.recordFailure(address);
      throw new HttpError(401, 'unauthorized', 'A valid access credential is required');
    }
  }
}

function rateLimited(): HttpError {
  return new HttpError(429, 'rate_limited', 'Request rate limit exceeded', true);
}

async function toWebRequest(request: IncomingMessage, maxBytes: number): Promise<Request> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  const headers = new Headers();
  const hopByHop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
  ]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (hopByHop.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.byteLength;
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks, size);
  return new Request(new URL(request.url ?? '/', 'http://localhost'), {
    method: request.method ?? 'POST',
    headers,
    ...(body.byteLength === 0 ? {} : { body }),
  });
}

function countHeader(request: IncomingMessage, target: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === target) count += 1;
  }
  return count;
}

function sameOrigin(origin: string, host: string): boolean {
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function sendError(response: ServerResponse, error: HttpError): void {
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      request_id: response.getHeader('x-request-id') ?? null,
      retryable: error.retryable,
    },
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
