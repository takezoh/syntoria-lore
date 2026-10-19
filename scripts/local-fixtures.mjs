import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const mode = process.argv[2];
if (mode === 'tasks') await runTasks();
else if (mode === 'scheduler') await runScheduler();
else throw new Error('Choose tasks or scheduler fixture mode');

async function runTasks() {
  const workerUrl = required('LOCAL_WORKER_URL');
  const workerToken = required('WORKER_TASK_TOKEN');
  const controlToken = required('LOCAL_CONTROL_TOKEN');
  const artifactDirectory = required('LOCAL_ARTIFACTS_DIR');
  const port = Number(process.env['LOCAL_TASKS_PORT'] ?? '9091');
  let failNext = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', `http://localhost:${port}`).pathname;
    if (request.method === 'GET' && pathname === '/healthz')
      return json(response, 200, { status: 'ok' });
    if (request.method === 'POST' && pathname === '/__fixture/fail-next') {
      if (!authorizedControl(request, controlToken))
        return json(response, 403, { error: 'forbidden' });
      failNext += 1;
      return json(response, 202, { armed: true, pending_failures: failNext });
    }
    if (request.method === 'POST' && pathname.startsWith('/__fixture/provider-fail-next/')) {
      if (!authorizedControl(request, controlToken))
        return json(response, 403, { error: 'forbidden' });
      const provider = pathname.slice('/__fixture/provider-fail-next/'.length);
      if (!['curator', 'embedding'].includes(provider))
        return json(response, 400, { error: 'invalid_provider' });
      const directory = join(artifactDirectory, 'provider-failures');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${provider}.fail`), 'one-shot\n', { mode: 0o600 });
      return json(response, 202, { armed: true, provider });
    }
    if (request.method !== 'POST' || pathname !== '/internal/jobs/run')
      return json(response, 404, { error: 'not_found' });
    if (!safeEqual(request.headers.authorization?.replace(/^Bearer /, '') ?? '', workerToken)) {
      return json(response, 401, { error: 'unauthorized' });
    }
    if (failNext > 0) {
      failNext -= 1;
      return json(response, 503, { error: 'local_task_delivery_failed', retryable: true });
    }
    await proxy(request, response, new URL('/internal/jobs/run', workerUrl), workerToken);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        event: 'local.tasks.started',
        port,
        delivery: 'postgres-outbox-http-adapter',
      }),
    );
  });
  closeOnSignal([server]);
}

async function runScheduler() {
  const workerUrl = required('LOCAL_WORKER_URL');
  const workerToken = required('WORKER_TASK_TOKEN');
  const controlToken = required('LOCAL_CONTROL_TOKEN');
  const port = Number(process.env['LOCAL_SCHEDULER_PORT'] ?? '9092');
  const interval = Number(process.env['LOCAL_SCHEDULER_INTERVAL_MS'] ?? '30000');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', `http://localhost:${port}`).pathname;
    if (request.method === 'GET' && pathname === '/healthz')
      return json(response, 200, { status: 'ok' });
    if (request.method !== 'POST' || pathname !== '/__fixture/trigger')
      return json(response, 404, { error: 'not_found' });
    if (!authorizedControl(request, controlToken))
      return json(response, 403, { error: 'forbidden' });
    try {
      const first = await callWorkerSweep(workerUrl, workerToken);
      const duplicate =
        new URL(request.url ?? '/', `http://localhost:${port}`).searchParams.get('duplicate') ===
        'true';
      const second = duplicate ? await callWorkerSweep(workerUrl, workerToken) : undefined;
      return json(response, 200, {
        status: 'ok',
        first,
        ...(second === undefined ? {} : { duplicate: second }),
      });
    } catch {
      return json(response, 503, { error: 'worker_sweep_unavailable', retryable: true });
    }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'local.scheduler.started', port, interval_ms: interval }));
  });
  const timer = setInterval(
    () => void callWorkerSweep(workerUrl, workerToken).catch(() => undefined),
    interval,
  );
  timer.unref();
  closeOnSignal([server], () => clearInterval(timer));
}

async function callWorkerSweep(workerUrl, token) {
  const response = await fetch(new URL('/internal/governance/sweep', workerUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-request-id': randomUUID() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('worker sweep unavailable');
  return await response.json();
}

async function proxy(request, response, target, workerToken) {
  let body;
  try {
    body = await readBody(request, 16_384);
  } catch {
    return json(response, 413, { error: 'invalid_task_body' });
  }
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerToken}`,
        'content-type': request.headers['content-type'] ?? 'application/json',
        'x-request-id': validTraceId(request.headers['x-request-id']) ?? randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(300_000),
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    response.end(text);
  } catch {
    json(response, 503, { error: 'worker_unavailable', retryable: true });
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function authorizedControl(request, token) {
  const value = request.headers['x-local-control-token'];
  return safeEqual(Array.isArray(value) ? (value[0] ?? '') : (value ?? ''), token);
}

function validTraceId(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== undefined && /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : undefined;
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > limit) {
        reject(new Error('request too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function closeOnSignal(servers, beforeClose = () => {}) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      beforeClose();
      for (const server of servers) server.close();
    });
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
