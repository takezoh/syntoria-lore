import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMemoryRecordsRuntime, ObservationService } from '@memory/memory-records';
import { VertexEmbeddingProvider } from '../apps/api/dist/embeddings.js';
import { evaluationMcp } from './evaluation-mcp.mjs';
import { clientConversation } from './evaluate-situational-clients.mjs';
const host = process.env['FIRESTORE_EMULATOR_HOST'];
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Loopback emulator required');
const config = JSON.parse(
  await readFile(process.env['LORE_EVAL_CONFIG'] ?? '.local/recall-eval-config.json', 'utf8'),
);
const tokenPath = process.env['LORE_EVAL_TOKEN_FILE'] ?? '.local/recall-eval-token.txt';
const output = process.env['LORE_EVAL_OUTPUT'] ?? '.local/lore-capture-recovery';
await mkdir(output, { recursive: true });
const previous = JSON.parse(
  await readFile('docs/eval/recall-client-policies-20261112.json', 'utf8'),
);
const prompt =
  'I am the only person operating our software. Recurring infrastructure spending must not increase. We are starting a new project.';
const recovery =
  'No observation was saved by this failed call. Supply every missing required field from the published tool schema and retry. For a state, supply its aspect and a concise value. Preserve the user-stated facts and provenance; do not invent facts. Do not report successful storage unless a later tool response returns an observation_id.';
await writeFile(
  output + '/manifest.json',
  JSON.stringify(
    {
      trials: 5,
      arms: ['original-error', 'actionable-error'],
      prompt,
      policy: previous.manifest.policy,
      recovery,
      boundary:
        'Evaluation-only error-response decoration after actual MCP validation. Original errors preserved; arguments are never filled or rewritten.',
    },
    null,
    2,
  ),
);
const projectId = 'demo-capture-recovery-' + process.pid;
const databaseId = 'lore-eval';
const runtime = createMemoryRecordsRuntime({
  projectId,
  databaseId,
  ledgerDatabaseId: 'lore-eval-deletions',
  cursorSecret: Buffer.alloc(32, 9),
});
const embeddings = new VertexEmbeddingProvider({
  ...config,
  timeoutMs: 30000,
  accessToken: async () => (await readFile(tokenPath, 'utf8')).trim(),
});
const service = new ObservationService({
  ledger: runtime.observations,
  access: runtime.access,
  embeddings,
  now: () => new Date('2026-11-12T12:00:00Z'),
  log: () => {},
});
const mcp = await evaluationMcp(service);
const results = [];
try {
  for (let trial = 0; trial < 5; trial++) {
    for (const arm of ['original-error', 'actionable-error']) {
      const subject = `synthetic-${trial}-${arm}`;
      await promisify(execFile)(
        process.execPath,
        [
          'scripts/admit-subject.mjs',
          '--project',
          projectId,
          '--database',
          databaseId,
          '--issuer',
          'https://example.test',
          '--subject',
          subject,
          '--tenant',
          subject,
          '--scope',
          'personal',
        ],
        { env: process.env },
      );
      const client = await mcp.client(
        await runtime.access.resolve({
          issuer: 'https://example.test',
          subject,
          connectionId: 'writer',
          clientId: 'eval-model',
        }),
      );
      const schema = (await client.listTools()).tools.find((x) => x.name === 'observe').inputSchema;
      const proxy = {
        listTools: () => client.listTools(),
        getInstructions: () => client.getInstructions(),
        async callTool(call) {
          const result = await client.callTool(call);
          if (arm !== 'actionable-error' || call.name !== 'observe' || !result.isError)
            return result;
          return {
            ...result,
            structuredContent: {
              error: {
                code: 'observe_rejected',
                saved: false,
                missing_required_fields: (schema.required ?? []).filter(
                  (key) => call.arguments?.[key] === undefined,
                ),
                recovery,
                original: result,
              },
            },
          };
        },
      };
      const result = await clientConversation(proxy, prompt, config, tokenPath, {
        clientInstructions: previous.manifest.policy,
      });
      results.push({ trial, arm, ...result });
      await writeFile(output + '/results.json', JSON.stringify(results, null, 2));
    }
    console.log('Completed capture recovery trial ' + trial);
  }
  if (results.some((x) => x.failure)) process.exitCode = 1;
} finally {
  await mcp.close();
  await service.close();
  await runtime.close();
}
