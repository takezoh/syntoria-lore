import { readFile } from 'node:fs/promises';
import { createApiServer } from '../apps/api/src/server.js';
import { openApiDocument } from '../apps/api/src/openapi.js';
import { createWorkerServer } from '../apps/worker/src/server.js';
import { connect } from 'node:net';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';

const services = [
  { name: 'API', createServer: createApiServer, exposesOpenApi: true },
  { name: 'worker', createServer: createWorkerServer, exposesOpenApi: false },
];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to bind to a TCP port');
  }

  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function sendMalformedRequest(server: Server): Promise<string> {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to bind to a TCP port');
  }

  return new Promise((resolve, reject) => {
    const socket = connect(address.port, '127.0.0.1');
    let response = '';

    socket.setTimeout(2_000, () => socket.destroy(new Error('Timed out waiting for HTTP 400')));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
    socket.once('connect', () => {
      socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    });
  });
}

describe.each(services)('$name bootstrap', ({ createServer, exposesOpenApi }) => {
  it('serves the documented minimal health endpoint', async () => {
    const server = createServer();
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/healthz`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await close(server);
    }
  });

  it('does not expose unimplemented routes', async () => {
    const server = createServer();
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/v1/not-implemented`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    } finally {
      await close(server);
    }
  });

  it('serves OpenAPI only when the service implements the API contract', async () => {
    const server = createServer();
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/openapi.json`);
      if (!exposesOpenApi) {
        expect(response.status).toBe(404);
        return;
      }
      expect(response.status).toBe(200);
      const document = (await response.json()) as { paths: Record<string, unknown> };
      expect(document.paths).toHaveProperty('/v1/memories:remember');
      expect(document.paths).toHaveProperty('/v1/changesets/{change_set_id}:commit');
      expect(document.paths).toHaveProperty('/v1/recall');
    } finally {
      await close(server);
    }
  });

  it('returns 400 for a malformed request target and keeps serving requests', async () => {
    const server = createServer();
    const baseUrl = await listen(server);

    try {
      const malformedResponse = await sendMalformedRequest(server);

      expect(malformedResponse).toMatch(/^HTTP\/1\.1 400\b/);

      const healthResponse = await fetch(`${baseUrl}/healthz`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ status: 'ok' });
    } finally {
      await close(server);
    }
  });
});

describe('port configuration', () => {
  it('uses the supplied default when the environment variable is absent', async () => {
    const { parsePort } = await import('../packages/runtime/src/port.js');

    expect(parsePort(undefined, 'API_PORT', 8080)).toBe(8080);
  });

  it('accepts a valid configured port', async () => {
    const { parsePort } = await import('../packages/runtime/src/port.js');

    expect(parsePort('9000', 'API_PORT', 8080)).toBe(9000);
  });

  it.each(['', '0', '65536', '8080.5', 'abc'])('rejects invalid port %j', async (value) => {
    const { parsePort } = await import('../packages/runtime/src/port.js');

    expect(() => parsePort(value, 'API_PORT', 8080)).toThrow(
      'API_PORT must be an integer between 1 and 65535',
    );
  });
});

describe('published OpenAPI contract', () => {
  it('keeps the checked-in document in sync with the API source', async () => {
    const source = await readFile(new URL('../docs/api/openapi.json', import.meta.url), 'utf8');
    expect(JSON.parse(source) as unknown).toEqual(openApiDocument);
  });
});
