import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { CoreError, uuidSchema } from '@memory/contracts';
import type { CaptureJobProcessor } from '@memory/jobs';

const maxTaskBodyBytes = 16_384;

export interface WorkerServerOptions {
  readonly processor: Pick<CaptureJobProcessor, 'process'>;
  readonly taskToken?: string;
  readonly authorizeInternal?: (
    request: import('node:http').IncomingMessage,
  ) => boolean | Promise<boolean>;
  readonly allowLocalGovernanceSweep?: boolean;
  readonly ready?: () => Promise<void>;
  readonly runDispatchSweep?: () => Promise<unknown>;
  readonly runGovernanceSweep?: () => Promise<{
    purged: number;
    pending: number;
    retention_queued?: number;
    retention_pending?: number;
    feedback_held?: number;
    reindexed?: number;
    indexing_pending?: number;
  }>;
  readonly runPortabilitySweep?: () => Promise<{
    exports: number;
    failed: number;
    expired: number;
    deleted_files: number;
    file_deletions_pending: number;
  }>;
}

export function createWorkerServer(options?: WorkerServerOptions): Server {
  return createServer((request, response) => {
    void handleWorkerRequest(request, response, options).catch((error: unknown) => {
      const coreError =
        error instanceof CoreError
          ? error
          : new CoreError(500, 'internal_error', 'The worker request could not be completed', true);
      if (!response.headersSent) {
        response.writeHead(coreError.status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(coreError.toBody(randomUUID())));
      } else {
        response.destroy();
      }
    });
  });
}

async function handleWorkerRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  options: WorkerServerOptions | undefined,
): Promise<void> {
  const startedAt = performance.now();
  const traceId = safeTraceId(request.headers['x-request-id']) ?? randomUUID();
  let route = 'unmatched';
  response.once('finish', () => {
    console.log(
      JSON.stringify({
        event: 'worker.request',
        trace_id: traceId,
        method: request.method ?? 'UNKNOWN',
        route,
        status: response.statusCode,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      }),
    );
  });
  let pathname: string;
  try {
    pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad Request');
    return;
  }
  route = request.method === 'POST' ? pathname : `${request.method ?? 'UNKNOWN'} ${pathname}`;
  if (request.method === 'GET' && pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && pathname === '/readyz') {
    try {
      await options?.ready?.();
      sendJson(response, 200, { status: 'ready' });
    } catch {
      sendJson(response, 503, { status: 'unavailable' });
    }
    return;
  }
  if (
    request.method !== 'POST' ||
    (pathname !== '/internal/jobs/run' &&
      pathname !== '/internal/governance/sweep' &&
      pathname !== '/internal/dispatch/sweep') ||
    (pathname === '/internal/governance/sweep' && options?.allowLocalGovernanceSweep !== true)
  ) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }
  if (options === undefined)
    throw new CoreError(503, 'worker_unavailable', 'Capture processing is not configured', true);
  const authorized = options.authorizeInternal
    ? await options.authorizeInternal(request)
    : options.taskToken !== undefined &&
      validBearer(request.headers.authorization, options.taskToken);
  if (!authorized) {
    throw new CoreError(401, 'unauthorized', 'An authorized internal caller is required');
  }
  if (pathname === '/internal/dispatch/sweep') {
    if (options.runDispatchSweep === undefined)
      throw new CoreError(
        503,
        'worker_unavailable',
        'Scheduled processing is not configured',
        true,
      );
    sendJson(response, 200, await options.runDispatchSweep());
    return;
  }
  if (pathname === '/internal/governance/sweep') {
    if (options.runGovernanceSweep === undefined)
      throw new CoreError(
        503,
        'worker_unavailable',
        'Governance processing is not configured',
        true,
      );
    const first = await options.runGovernanceSweep();
    const portability = (await options.runPortabilitySweep?.()) ?? {
      exports: 0,
      failed: 0,
      expired: 0,
      deleted_files: 0,
      file_deletions_pending: 0,
    };
    const final =
      options.runPortabilitySweep === undefined ? first : await options.runGovernanceSweep();
    sendJson(response, 200, {
      purged: first.purged + (final === first ? 0 : final.purged),
      pending: final.pending,
      retention_queued:
        (first.retention_queued ?? 0) + (final === first ? 0 : (final.retention_queued ?? 0)),
      retention_pending: final.retention_pending ?? 0,
      feedback_held:
        (first.feedback_held ?? 0) + (final === first ? 0 : (final.feedback_held ?? 0)),
      reindexed: (first.reindexed ?? 0) + (final === first ? 0 : (final.reindexed ?? 0)),
      indexing_pending: final.indexing_pending ?? 0,
      ...portability,
    });
    return;
  }
  const body = await readTaskBody(request);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CoreError(400, 'invalid_request', 'Task body must contain only job_id');
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record['job_id'] !== 'string' ||
    !uuidSchema.safeParse(record['job_id']).success
  ) {
    throw new CoreError(400, 'invalid_request', 'Task body must contain only a UUID job_id');
  }
  const jobId = record['job_id'];
  const result = await options.processor.process(jobId);
  sendJson(response, 200, result);
}

function validBearer(value: string | undefined, expected: string): boolean {
  if (expected.length < 32 || value === undefined || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice('Bearer '.length));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function safeTraceId(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== undefined && /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : undefined;
}

async function readTaskBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new CoreError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxTaskBodyBytes) {
    throw new CoreError(413, 'request_too_large', 'Task body is too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.byteLength;
    if (total > maxTaskBodyBytes)
      throw new CoreError(413, 'request_too_large', 'Task body is too large');
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CoreError(400, 'invalid_json', 'Task body must contain valid JSON');
  }
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}
