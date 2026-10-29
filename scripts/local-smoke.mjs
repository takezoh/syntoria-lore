import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';

const apiBase = new URL(process.env['LOCAL_API_BASE_URL'] ?? 'https://memory.example.test');
if (
  apiBase.protocol !== 'https:' ||
  apiBase.username !== '' ||
  apiBase.password !== '' ||
  apiBase.pathname !== '/' ||
  apiBase.search !== '' ||
  apiBase.hash !== ''
) {
  throw new Error(
    'LOCAL_API_BASE_URL must be a canonical HTTPS origin served by the configured TLS proxy',
  );
}
const base = apiBase.origin;
const scopeId = '22222222-2222-4222-8222-222222222222';
const restToken = required('LOCAL_API_BEARER_TOKEN');
const mcpToken = required('LOCAL_MCP_BEARER_TOKEN');
const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((r) =>
  r.json(),
);
if (metadata.resource !== `${base}/mcp`) throw new Error('MCP metadata resource is not canonical');
const wrongAudience = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${restToken}`,
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

const client = new Client({ name: 'memory-local-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === 'recall_memories'))
    throw new Error('MCP client has no Recall tool');
  if (!tools.tools.some((tool) => tool.name === 'remember_memory'))
    throw new Error('MCP client has no Remember tool');
  const recall = await client.callTool({
    name: 'recall_memories',
    arguments: { scope_id: scopeId, query: statement, mode: 'precise', limit: 5 },
  });
  if (recall.isError) throw new Error('MCP client could not recall the REST memory');
  const recallJson = recall.structuredContent ?? parseToolJson(recall.content);
  if (!JSON.stringify(recallJson).includes(memoryId))
    throw new Error('MCP Recall did not return the REST memory ID');
  const mcpStatement = `Local OAuth/MCP write ${randomUUID()}`;
  const rememberedThroughMcp = await client.callTool({
    name: 'remember_memory',
    arguments: {
      scope_id: scopeId,
      idempotency_key: randomUUID(),
      memory: {
        kind: 'fact',
        statement: mcpStatement,
        context: {},
        subjects: [],
        evidence: [
          {
            source: {
              kind: 'explicit_remember',
              external_id: `local-smoke-${randomUUID()}`,
              revision: '1',
              locator: 'local/smoke-mcp-write',
            },
            snippet: mcpStatement,
            snippet_allowed: true,
          },
        ],
      },
    },
  });
  if (rememberedThroughMcp.isError) throw new Error('MCP client could not write through /mcp');
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        canonical_resource: metadata.resource,
        audience_confusion: 'rejected',
        rest_remember_memory_id: memoryId,
        mcp_same_connection_read_and_write: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close().catch(() => undefined);
}

function parseToolJson(content) {
  const text = Array.isArray(content)
    ? content.find((item) => item.type === 'text')?.text
    : undefined;
  if (!text) throw new Error('MCP Recall returned no structured result');
  return JSON.parse(text);
}

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} must be supplied by Gate; this script does not issue credentials`);
  return value;
}
