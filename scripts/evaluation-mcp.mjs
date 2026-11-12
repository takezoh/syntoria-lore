import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcpRequest } from '../apps/api/dist/mcp.js';

/** Real loopback HTTP/MCP with already-verified synthetic principals; no hosted OAuth claim. */
export async function evaluationMcp(service) {
  const accesses = new Map();
  const clients = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const access = accesses.get(incoming.headers.authorization);
      if (!access) {
        outgoing.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = new globalThis.Request('http://127.0.0.1/mcp', {
        method: incoming.method,
        headers: incoming.headers,
        ...(incoming.method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
      });
      const response = await handleMcpRequest(
        { service, maxBodyBytes: 1_000_000, log: () => {} },
        access,
        request,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    })().catch(() => {
      outgoing.writeHead(500).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    async client(access) {
      const token = 'Bearer ' + randomUUID();
      accesses.set(token, access);
      const client = new Client({ name: 'lore-evaluation', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://127.0.0.1:' + server.address().port + '/mcp'),
          { requestInit: { headers: { authorization: token } } },
        ),
      );
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
