import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  CoreError,
  LEGACY_PORTABILITY_MIME_TYPE,
  uuidSchema,
  timestampSchema,
} from '@memory/contracts';
import { getProductDisplayName } from '@memory/runtime';
import type { Authenticator } from '@memory/auth';
import type { CoreService } from '@memory/domain';
import type { ConnectorService } from '@memory/connectors';
import type { RecallService } from '@memory/recall';
import type { CurationReviewService } from '@memory/jobs';
import type { ForgetService } from '@memory/governance';
import type { PortabilityService } from '@memory/governance';
import type { ChangeConfirmationService, ProtectedChange } from './confirmations.js';
import { handleMcpRequest } from './mcp.js';
import { createOpenApiDocument } from './openapi.js';

const maxBodyBytes = 1_048_576;
const rateWindowMs = 60_000;
const rateLimit = 120;

export interface ApiServerOptions {
  readonly productDisplayName?: string;
  readonly auth: Authenticator;
  readonly core: CoreService;
  readonly connectors?: ConnectorService;
  readonly recall?: RecallService;
  readonly reviews?: CurationReviewService;
  readonly governance?: ForgetService;
  readonly portability?: PortabilityService;
  readonly confirmations?: ChangeConfirmationService;
  readonly mcpReadAuth?: Authenticator;
  readonly mcpWriteAuth?: Authenticator;
  readonly mcpAuthorizationServerUrl?: string;
  readonly mcpResourceBaseUrl?: string;
  readonly mcpAllowedHosts?: readonly string[];
  readonly mcpAllowedOrigins?: readonly string[];
  readonly apiAllowedOrigins?: readonly string[];
  readonly ready?: () => Promise<void>;
  readonly maxBodyBytes?: number;
  readonly rateLimit?: number;
}

export function createApiServer(options?: ApiServerOptions): Server {
  const requests = new Map<string, { start: number; count: number }>();
  return createServer((request, response) => {
    void handleRequest(request, response, options, requests).catch(() => {
      if (!response.headersSent)
        sendJson(response, 500, {
          error: {
            code: 'internal_error',
            message: 'The request could not be completed',
            request_id: randomUUID(),
            retryable: true,
          },
        });
      else response.destroy();
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiServerOptions | undefined,
  requests: Map<string, { start: number; count: number }>,
): Promise<void> {
  const startedAt = performance.now();
  const requestId = randomUUID();
  let route = 'unmatched';
  response.once('finish', () => {
    console.log(
      JSON.stringify({
        event: 'api.request',
        request_id: requestId,
        trace_id: requestId,
        method: request.method ?? 'UNKNOWN',
        route,
        status: response.statusCode,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      }),
    );
  });
  response.setHeader('x-request-id', requestId);
  response.setHeader('cache-control', 'no-store');
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad Request');
    return;
  }
  route = telemetryRoute(request.method ?? 'UNKNOWN', url.pathname);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/readyz') {
    try {
      await options?.ready?.();
      sendJson(response, 200, { status: 'ready' });
    } catch {
      sendJson(response, 503, { status: 'unavailable' });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/openapi.json') {
    sendJson(response, 200, createOpenApiDocument(options?.productDisplayName));
    return;
  }
  if (url.pathname === '/v1/session') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }
  if (
    request.method === 'GET' &&
    /^\/\.well-known\/oauth-protected-resource\/mcp\/(read|write)$/.test(url.pathname)
  ) {
    const endpoint = url.pathname.endsWith('/read') ? 'read' : 'write';
    if (options?.mcpAuthorizationServerUrl === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    if (
      options.mcpResourceBaseUrl === undefined &&
      !mcpHostAllowed(
        request.headers.host ?? '',
        options.mcpAllowedHosts ?? ['localhost', '127.0.0.1', '::1'],
      )
    ) {
      sendError(
        response,
        new CoreError(403, 'mcp_host_forbidden', 'MCP Host is not allowed'),
        requestId,
      );
      return;
    }
    const origin = options.mcpResourceBaseUrl ?? requestOrigin(request);
    const resource = new URL(`/mcp/${endpoint}`, origin).toString();
    sendJson(response, 200, {
      resource,
      authorization_servers: [options.mcpAuthorizationServerUrl],
      scopes_supported: ['openid'],
      bearer_methods_supported: ['header'],
    });
    return;
  }
  if (url.pathname.startsWith('/v1/') && request.method === 'OPTIONS') {
    const origin = request.headers.origin;
    if (!isOriginAllowed(origin, options?.apiAllowedOrigins)) {
      sendError(
        response,
        new CoreError(403, 'origin_forbidden', 'Browser Origin is not allowed'),
        requestId,
      );
      return;
    }
    setApiCors(response, origin!);
    response.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
      'access-control-max-age': '300',
    });
    response.end();
    return;
  }
  if (url.pathname.startsWith('/v1/') && request.headers.origin !== undefined) {
    response.setHeader('vary', 'Origin');
    if (isOriginAllowed(request.headers.origin, options?.apiAllowedOrigins)) {
      setApiCors(response, request.headers.origin);
    }
  }
  if (
    options?.ready !== undefined &&
    (url.pathname.startsWith('/v1/') ||
      url.pathname === '/mcp/read' ||
      url.pathname === '/mcp/write')
  ) {
    try {
      await options.ready();
    } catch {
      sendError(
        response,
        new CoreError(503, 'restore_not_ready', 'Protected memory service is not ready', true),
        requestId,
      );
      return;
    }
  }
  if (url.pathname === '/mcp/read' || url.pathname === '/mcp/write') {
    const endpoint = url.pathname === '/mcp/read' ? 'read' : 'write';
    const endpointAuth = endpoint === 'read' ? options?.mcpReadAuth : options?.mcpWriteAuth;
    if (options === undefined || endpointAuth === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    if (hasDuplicateRawHeader(request, 'authorization')) {
      sendError(
        response,
        new CoreError(401, 'unauthorized', 'Duplicate Authorization headers are not allowed'),
        requestId,
      );
      return;
    }
    const host = request.headers.host ?? '';
    if (!mcpHostAllowed(host, options.mcpAllowedHosts ?? ['localhost', '127.0.0.1', '::1'])) {
      sendError(
        response,
        new CoreError(403, 'mcp_host_forbidden', 'MCP Host is not allowed'),
        requestId,
      );
      return;
    }
    const originHeader = request.headers.origin;
    if (
      originHeader !== undefined &&
      !mcpOriginAllowed(originHeader, host, options.mcpAllowedOrigins)
    ) {
      sendError(
        response,
        new CoreError(403, 'mcp_origin_forbidden', 'MCP Origin is not allowed'),
        requestId,
      );
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...(originHeader === undefined
          ? {}
          : { 'access-control-allow-origin': originHeader, vary: 'Origin' }),
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers':
          'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id',
        'access-control-max-age': '300',
      });
      response.end();
      return;
    }
    const address = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let bucket = requests.get(address);
    if (bucket === undefined || now - bucket.start >= rateWindowMs) {
      bucket = { start: now, count: 0 };
      requests.set(address, bucket);
    }
    bucket.count += 1;
    if (bucket.count > (options.rateLimit ?? rateLimit)) {
      response.setHeader('retry-after', '60');
      sendError(
        response,
        new CoreError(429, 'rate_limited', 'Request rate limit exceeded', true),
        requestId,
      );
      return;
    }
    try {
      const webRequest = await toWebRequest(request, options.maxBodyBytes ?? maxBodyBytes);
      const webResponse = await handleMcpRequest(
        endpoint,
        {
          productDisplayName: options.productDisplayName ?? getProductDisplayName(),
          auth: endpointAuth,
          core: options.core,
          ...(options.recall === undefined ? {} : { recall: options.recall }),
          ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
          ...(options.reviews === undefined ? {} : { reviews: options.reviews }),
          ...(options.governance === undefined ? {} : { governance: options.governance }),
          ...(options.portability === undefined ? {} : { portability: options.portability }),
          ...(options.confirmations === undefined ? {} : { confirmations: options.confirmations }),
          maxBodyBytes: options.maxBodyBytes ?? maxBodyBytes,
        },
        webRequest,
      );
      const headers = Object.fromEntries(webResponse.headers.entries());
      if (originHeader !== undefined) {
        headers['access-control-allow-origin'] = originHeader;
        headers['vary'] = 'Origin';
      }
      response.writeHead(webResponse.status, headers);
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
      const coreError =
        error instanceof CoreError
          ? error
          : new CoreError(500, 'internal_error', 'MCP request could not be completed', true);
      if (coreError.status === 401) {
        const metadataBase = options.mcpResourceBaseUrl ?? requestOrigin(request);
        const metadata = new URL(
          '/.well-known/oauth-protected-resource/mcp/' + endpoint,
          metadataBase,
        );
        response.setHeader('www-authenticate', `Bearer resource_metadata="${metadata.toString()}"`);
      }
      sendError(response, coreError, requestId);
    }
    return;
  }
  if (options === undefined || !url.pathname.startsWith('/v1/')) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  const address = request.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  let bucket = requests.get(address);
  if (bucket === undefined || now - bucket.start >= rateWindowMs) {
    bucket = { start: now, count: 0 };
    requests.set(address, bucket);
    if (requests.size > 10_000) {
      for (const [key, value] of requests)
        if (now - value.start >= rateWindowMs) requests.delete(key);
    }
  }
  bucket.count += 1;
  if (bucket.count > (options.rateLimit ?? rateLimit)) {
    response.setHeader('retry-after', '60');
    sendError(
      response,
      new CoreError(429, 'rate_limited', 'Request rate limit exceeded', true),
      requestId,
    );
    return;
  }

  try {
    if (hasDuplicateRawHeader(request, 'authorization')) {
      throw new CoreError(401, 'unauthorized', 'Duplicate Authorization headers are not allowed');
    }
    const actor = await options.auth.authenticateBearer(request.headers.authorization);
    let result: unknown;
    let responseStatus = 200;
    // A protected change runs directly for the User and becomes a Gate confirmation (202) otherwise.
    const protectedChange = async (
      change: ProtectedChange,
      idempotencyKey: string | undefined,
      direct: () => Promise<unknown>,
      directStatus = 200,
    ): Promise<void> => {
      if (options.confirmations === undefined) {
        result = await direct();
        responseStatus = directStatus;
        return;
      }
      const outcome = await options.confirmations.run(
        options.auth,
        actor,
        change,
        idempotencyKey,
        requestId,
      );
      result = outcome.result;
      responseStatus = outcome.confirmationRequired ? 202 : directStatus;
    };
    if (request.method === 'POST' && url.pathname === '/v1/memories:remember') {
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      result = await options.core.remember(actor, body, requestId, idempotencyKey);
    } else if (request.method === 'POST' && url.pathname === '/v1/changesets') {
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      result = await options.core.proposeChangeSet(actor, body, requestId, idempotencyKey);
    } else if (request.method === 'POST' && /^\/v1\/changesets\/[^/]+:commit$/.test(url.pathname)) {
      const changeSetId = url.pathname.slice('/v1/changesets/'.length, -':commit'.length);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      result = await options.core.commitProposedChangeSet(
        actor,
        changeSetId,
        requestId,
        idempotencyKey,
      );
    } else if (
      request.method === 'POST' &&
      /^\/v1\/changesets\/[^/]+:request-user-decision$/.test(url.pathname) &&
      options.confirmations !== undefined
    ) {
      const changeSetId = url.pathname.slice(
        '/v1/changesets/'.length,
        -':request-user-decision'.length,
      );
      assertUuid(changeSetId, 'changeset_id');
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      await protectedChange(
        { operation: 'commit_changeset', changesetId: changeSetId },
        idempotencyKey,
        () => options.core.commitProposedChangeSet(actor, changeSetId, requestId, idempotencyKey),
      );
    } else if (
      request.method === 'GET' &&
      /^\/v1\/confirmations\/[^/:]+$/.test(url.pathname) &&
      options.confirmations !== undefined
    ) {
      const confirmationId = url.pathname.split('/')[3] ?? '';
      assertUuid(confirmationId, 'confirmation_id');
      result = await options.confirmations.get(actor, confirmationId);
    } else if (
      request.method === 'POST' &&
      /^\/v1\/confirmations\/[^/]+:complete$/.test(url.pathname) &&
      options.confirmations !== undefined
    ) {
      const confirmationId = url.pathname.slice('/v1/confirmations/'.length, -':complete'.length);
      assertUuid(confirmationId, 'confirmation_id');
      result = await options.confirmations.complete(options.auth, actor, confirmationId, requestId);
    } else if (request.method === 'POST' && url.pathname === '/v1/recall') {
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      result =
        options.recall === undefined
          ? await options.core.recall(actor, body)
          : await options.recall.recall(actor, body);
    } else if (request.method === 'POST' && url.pathname === '/v1/forget') {
      if (options.governance === undefined) throw unavailableFeature('Forget');
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      const governance = options.governance;
      await protectedChange(
        { operation: 'forget', request: body },
        idempotencyKey,
        () => governance.forget(actor, body, idempotencyKey),
        202,
      );
    } else if (request.method === 'POST' && url.pathname === '/v1/exports') {
      if (options.portability === undefined) throw unavailableFeature('Portability export');
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      result = await options.portability.requestExport(
        actor,
        await readJson(request, options.maxBodyBytes ?? maxBodyBytes),
        idempotencyKey,
      );
      responseStatus = 202;
    } else if (request.method === 'POST' && url.pathname === '/v1/imports') {
      if (options.portability === undefined) throw unavailableFeature('Portability import');
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      result = await options.portability.importBundle(
        actor,
        await readJson(request, options.maxBodyBytes ?? maxBodyBytes),
        idempotencyKey,
      );
    } else if (request.method === 'GET' && /^\/v1\/exports\/[^/:]+$/.test(url.pathname)) {
      if (options.portability === undefined) throw unavailableFeature('Portability export');
      const exportId = url.pathname.split('/')[3] ?? '';
      const scopeId = url.searchParams.get('scope_id') ?? '';
      assertUuid(exportId, 'export_id');
      assertUuid(scopeId, 'scope_id');
      result = await options.portability.exportStatus(actor, scopeId, exportId);
    } else if (request.method === 'GET' && /^\/v1\/exports\/[^/:]+:download$/.test(url.pathname)) {
      if (options.portability === undefined) throw unavailableFeature('Portability export');
      const exportId = url.pathname.split('/')[3]?.replace(/:download$/, '') ?? '';
      const scopeId = url.searchParams.get('scope_id') ?? '';
      assertUuid(exportId, 'export_id');
      assertUuid(scopeId, 'scope_id');
      const download = await options.portability.download(actor, scopeId, exportId);
      response.writeHead(200, {
        'content-type': LEGACY_PORTABILITY_MIME_TYPE,
        'content-disposition': `attachment; filename="${download.filename}"`,
        'cache-control': 'no-store',
      });
      response.end(download.bundle);
      return;
    } else if (request.method === 'GET' && /^\/v1\/forget\/[^/]+$/.test(url.pathname)) {
      if (options.governance === undefined) throw unavailableFeature('Forget status');
      const requestId = url.pathname.split('/')[3] ?? '';
      const scopeId = url.searchParams.get('scope_id') ?? '';
      assertUuid(requestId, 'request_id');
      assertUuid(scopeId, 'scope_id');
      result = await options.governance.status(actor, scopeId, requestId);
    } else if (request.method === 'PUT' && /^\/v1\/sources\/[^/]+:rights$/.test(url.pathname)) {
      if (options.governance === undefined) throw unavailableFeature('Source rights');
      const governance = options.governance;
      const sourceId = url.pathname.split('/')[3]?.replace(/:rights$/, '') ?? '';
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      await protectedChange(
        { operation: 'change_source_rights', sourceId, request: body },
        undefined,
        () => governance.updateSourceRights(actor, sourceId, body),
      );
    } else if (request.method === 'PUT' && /^\/v1\/scopes\/[^/]+\/grants$/.test(url.pathname)) {
      if (options.governance === undefined) throw unavailableFeature('Scope grants');
      const governance = options.governance;
      const scopeId = url.pathname.split('/')[3] ?? '';
      assertUuid(scopeId, 'scope_id');
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      await protectedChange(
        { operation: 'change_scope_grant', scopeId, request: body },
        undefined,
        () => governance.mutateGrant(actor, scopeId, body),
      );
    } else if (request.method === 'PUT' && /^\/v1\/scopes\/[^/]+\/retention$/.test(url.pathname)) {
      if (options.governance === undefined) throw unavailableFeature('Retention policy');
      const governance = options.governance;
      const scopeId = url.pathname.split('/')[3] ?? '';
      assertUuid(scopeId, 'scope_id');
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      await protectedChange(
        { operation: 'set_retention_policy', scopeId, request: body },
        undefined,
        () => governance.updateRetention(actor, scopeId, body),
      );
    } else if (request.method === 'POST' && /^\/v1\/memories\/[^/]+:feedback$/.test(url.pathname)) {
      if (options.governance === undefined) throw unavailableFeature('Memory feedback');
      const memoryId = url.pathname.split('/')[3]?.replace(/:feedback$/, '') ?? '';
      assertUuid(memoryId, 'memory_id');
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      if (typeof body !== 'object' || body === null || Array.isArray(body))
        throw new CoreError(400, 'invalid_request', 'Feedback body must be an object');
      result = await options.governance.submitFeedback(actor, { ...body, memory_id: memoryId });
    } else if (request.method === 'POST' && url.pathname === '/v1/connectors') {
      if (options.connectors === undefined) throw unavailableFeature('Connector capture');
      result = await options.connectors.configure(
        actor,
        await readJson(request, options.maxBodyBytes ?? maxBodyBytes),
      );
    } else if (
      request.method === 'POST' &&
      (url.pathname === '/v1/captures' || url.pathname === '/v1/capture')
    ) {
      if (options.connectors === undefined) throw unavailableFeature('Capture');
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      result = await options.connectors.capture(
        actor,
        await readJson(request, options.maxBodyBytes ?? maxBodyBytes),
        idempotencyKey,
        requestId,
      );
      responseStatus = 202;
    } else if (
      request.method === 'GET' &&
      (url.pathname === '/v1/review' || url.pathname === '/v1/reviews')
    ) {
      if (options.reviews === undefined) throw unavailableFeature('Curation review');
      const scopeId = url.searchParams.get('scope_id');
      if (scopeId === null)
        throw new CoreError(400, 'invalid_request', 'scope_id query parameter is required');
      result = await options.reviews.list(actor, {
        scope_id: scopeId,
        ...(url.searchParams.get('status') === null
          ? {}
          : { status: url.searchParams.get('status') }),
        ...(url.searchParams.get('limit') === null ? {} : { limit: url.searchParams.get('limit') }),
        ...(url.searchParams.get('before') === null
          ? {}
          : { before: url.searchParams.get('before') }),
      });
    } else if (request.method === 'GET' && /^\/v1\/reviews?\/[^/]+$/.test(url.pathname)) {
      if (options.reviews === undefined) throw unavailableFeature('Curation review');
      result = await options.reviews.get(actor, url.pathname.split('/')[3] ?? '');
    } else if (request.method === 'POST' && /^\/v1\/reviews?\/[^/]+:decision$/.test(url.pathname)) {
      if (options.reviews === undefined) throw unavailableFeature('Curation review');
      const reviews = options.reviews;
      const reviewId = url.pathname.split('/')[3]?.replace(/:decision$/, '') ?? '';
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string')
        throw new CoreError(400, 'invalid_request', 'Idempotency-Key header is required');
      const body = await readJson(request, options.maxBodyBytes ?? maxBodyBytes);
      await protectedChange(
        { operation: 'decide_review', reviewId, decision: body },
        idempotencyKey,
        () => reviews.decide(actor, reviewId, body, requestId, idempotencyKey),
      );
    } else if (
      request.method === 'GET' &&
      (/^\/v1\/jobs\/[^/]+$/.test(url.pathname) || /^\/v1\/captures\/[^/]+$/.test(url.pathname))
    ) {
      if (options.reviews === undefined) throw unavailableFeature('Capture job status');
      result = await options.reviews.jobStatus(actor, url.pathname.split('/')[3] ?? '');
    } else if (request.method === 'GET' && /^\/v1\/memories\/[^/]+$/.test(url.pathname)) {
      const memoryId = url.pathname.split('/')[3] ?? '';
      const scopeId = url.searchParams.get('scope_id') ?? '';
      assertUuid(memoryId, 'memory_id');
      assertUuid(scopeId, 'scope_id');
      const validAt = optionalTimestamp(url.searchParams.get('valid_at'), 'valid_at');
      const knownAt = optionalTimestamp(url.searchParams.get('known_at'), 'known_at');
      result = await options.core.getMemory(actor, scopeId, memoryId, {
        ...(validAt === undefined ? {} : { valid_at: validAt }),
        ...(knownAt === undefined ? {} : { known_at: knownAt }),
      });
    } else if (request.method === 'GET' && url.pathname === '/v1/changes') {
      const scopeIds = url.searchParams.getAll('scope_ids');
      const limit = url.searchParams.get('limit');
      const cursor = url.searchParams.get('cursor');
      result = await options.core.getChanges(
        actor,
        {
          scope_ids: scopeIds,
          ...(limit === null ? {} : { limit }),
          ...(cursor === null ? {} : { cursor }),
        },
        requestId,
      );
    } else {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    sendJson(response, responseStatus, withRequestMetadata(result, requestId));
  } catch (error) {
    if (error instanceof CoreError) {
      sendError(response, error, requestId);
      return;
    }
    sendError(
      response,
      new CoreError(500, 'internal_error', 'The request could not be completed', true),
      requestId,
    );
  }
}

function telemetryRoute(method: string, pathname: string): string {
  if (pathname === '/healthz' || pathname === '/readyz' || pathname === '/openapi.json')
    return `${method} ${pathname}`;
  if (pathname.startsWith('/.well-known/')) return `${method} /.well-known/*`;
  return `${method} ${pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')}`;
}

async function toWebRequest(request: IncomingMessage, maxBytes: number): Promise<Request> {
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
  const method = request.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : await readRawBody(request, maxBytes);
  const target = new URL(request.url ?? '/', 'http://localhost');
  return new Request(target, {
    method,
    headers,
    ...(body === undefined || body.byteLength === 0 ? {} : { body }),
  });
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new CoreError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function requestOrigin(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol =
    typeof forwarded === 'string' && (forwarded === 'https' || forwarded === 'http')
      ? forwarded
      : 'http';
  return `${protocol}://${request.headers.host ?? 'localhost'}`;
}

function isOriginAllowed(origin: string | undefined, allowedOrigins?: readonly string[]): boolean {
  return origin !== undefined && allowedOrigins !== undefined && allowedOrigins.includes(origin);
}

function setApiCors(response: ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
}

function hasDuplicateRawHeader(request: IncomingMessage, target: string): boolean {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === target) count += 1;
  }
  return count > 1;
}

function mcpHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  if (host.length === 0 || host.length > 255) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some(
    (candidate) => candidate.replace(/^\[|\]$/g, '').toLowerCase() === hostname,
  );
}

function mcpOriginAllowed(
  origin: string,
  host: string,
  allowedOrigins?: readonly string[],
): boolean {
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return allowedOrigins === undefined
      ? parsed.host.toLowerCase() === host.toLowerCase()
      : allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

function unavailableFeature(feature: string): CoreError {
  return new CoreError(503, 'feature_unavailable', `${feature} service is not configured`, true);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new CoreError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit)
    throw new CoreError(413, 'request_too_large', 'Request body is too large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.byteLength;
    if (total > limit) throw new CoreError(413, 'request_too_large', 'Request body is too large');
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CoreError(400, 'invalid_json', 'Request body must contain valid JSON');
  }
}

function optionalTimestamp(value: string | null, name: string): string | undefined {
  if (value === null) return undefined;
  const parsed = timestampSchema.safeParse(value);
  if (!parsed.success)
    throw new CoreError(400, 'invalid_request', `${name} must be an ISO timestamp`);
  return parsed.data;
}

function assertUuid(value: string, name: string): void {
  if (!uuidSchema.safeParse(value).success)
    throw new CoreError(400, 'invalid_request', `${name} must be a UUID`);
}

function sendError(response: ServerResponse, error: CoreError, requestId: string): void {
  sendJson(response, error.status, error.toBody(requestId));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function withRequestMetadata(value: unknown, requestId: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), request_id: requestId, trace_id: requestId };
}
