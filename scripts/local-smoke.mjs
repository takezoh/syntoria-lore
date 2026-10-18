import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';

const base = 'http://localhost:18080';
const scopeId = '22222222-2222-4222-8222-222222222222';
const restToken = await issue(
  'demo-owner-client',
  'owner-local-fixture-only',
  base,
  'memory:read memory:write memory:admin',
);
const userToken = await issue(
  'demo-owner-client',
  'owner-local-fixture-only',
  `${base}/mcp/write`,
  'memory:read memory:write memory:admin',
);
const readerToken = await issue(
  'demo-reader-client',
  'reader-local-fixture-only',
  `${base}/mcp/read`,
  'memory:read',
);
const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/read`).then((r) =>
  r.json(),
);
if (metadata.resource !== `${base}/mcp/read`)
  throw new Error('MCP metadata resource is not canonical');
const wrongAudience = await fetch(`${base}/mcp/read`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${userToken}`,
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-11-25',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
if (wrongAudience.status !== 401) throw new Error('Audience confusion was not rejected');

const statement = `Local OAuth/MCP acceptance fact ${randomUUID()}`;
const remember = await fetch(`${base}/v1/memories:remember`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${restToken}`,
    'content-type': 'application/json',
    'idempotency-key': randomUUID(),
  },
  body: JSON.stringify({
    scope_id: scopeId,
    memory: {
      kind: 'fact',
      statement,
      context: {},
      subjects: [],
      evidence: [
        {
          source: {
            kind: 'explicit_remember',
            external_id: `local-smoke-${randomUUID()}`,
            revision: '1',
            locator: 'local/smoke',
          },
          snippet: statement,
          snippet_allowed: true,
        },
      ],
    },
  }),
});
if (!remember.ok) throw new Error(`REST Remember failed with HTTP ${remember.status}`);
const remembered = await remember.json();
const memoryId = remembered.operations?.[0]?.memory_ids?.[0];
if (!memoryId) throw new Error('REST Remember returned no memory identifier');

const readerClient = new Client({ name: 'memory-local-reader', version: '1.0.0' });
const readerTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/read`), {
  requestInit: { headers: { authorization: `Bearer ${readerToken}` } },
});
const userClient = new Client({ name: 'memory-local-user', version: '1.0.0' });
const userTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/write`), {
  requestInit: { headers: { authorization: `Bearer ${userToken}` } },
});
try {
  await Promise.all([readerClient.connect(readerTransport), userClient.connect(userTransport)]);
  const readTools = await readerClient.listTools();
  const writeTools = await userClient.listTools();
  if (!readTools.tools.some((tool) => tool.name === 'recall_memories'))
    throw new Error('Read MCP client has no Recall tool');
  if (!writeTools.tools.some((tool) => tool.name === 'remember_memory'))
    throw new Error('Write MCP client has no Remember tool');
  const recall = await readerClient.callTool({
    name: 'recall_memories',
    arguments: { scope_id: scopeId, query: statement, mode: 'precise', limit: 5 },
  });
  if (recall.isError) throw new Error('Reader MCP client could not recall the REST memory');
  const recallJson = recall.structuredContent ?? parseToolJson(recall.content);
  if (!JSON.stringify(recallJson).includes(memoryId))
    throw new Error('MCP Recall did not return the REST memory ID');
  if (readTools.tools.some((tool) => tool.name === 'remember_memory'))
    throw new Error('Read-only MCP client exposes a write tool');
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        distinct_principals: 2,
        canonical_resource: metadata.resource,
        audience_confusion: 'rejected',
        rest_remember_memory_id: memoryId,
        mcp_reader_recalled_rest_memory: true,
        read_only_write: 'not-exposed',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Promise.allSettled([readerClient.close(), userClient.close()]);
}

function parseToolJson(content) {
  const text = Array.isArray(content)
    ? content.find((item) => item.type === 'text')?.text
    : undefined;
  if (!text) throw new Error('MCP Recall returned no structured result');
  return JSON.parse(text);
}

async function issue(clientId, secret, resource, scope) {
  const authorization = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const response = await fetch('http://localhost:19090/oauth/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${authorization}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', resource, scope }),
  });
  if (!response.ok) throw new Error(`Local issuer returned HTTP ${response.status}`);
  const payload = await response.json();
  return payload.access_token;
}
