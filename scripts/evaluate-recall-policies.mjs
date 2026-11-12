import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMemoryRecordsRuntime, ObservationService } from '@memory/memory-records';
import { VertexEmbeddingProvider } from '../apps/api/dist/embeddings.js';
import { evaluationMcp } from './evaluation-mcp.mjs';
import { clientConversation } from './evaluate-situational-clients.mjs';

const host = process.env['FIRESTORE_EMULATOR_HOST'];
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('A loopback Firestore emulator is required');
const configPath = process.env['LORE_EVAL_CONFIG'];
const tokenPath = process.env['LORE_EVAL_TOKEN_FILE'];
if (!configPath || !tokenPath) throw new Error('Evaluation config and token paths are required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const outputDir = process.env['LORE_EVAL_OUTPUT'] ?? '.local/recall-policies';
await mkdir(outputDir, { recursive: true });
const projectId = 'demo-recall-policy-' + process.pid;
const databaseId = 'lore-eval';
const issuer = 'https://example.test';
const policy =
  'For a request for advice, planning, architecture or a decision, call recall with the current task before answering or asking for background. Carry forward applicable remembered constraints, cite their evidence, and ask only for missing details. Do not assume another project has the same facts. Do not claim a cost limit is met without cost evidence. For translation or other self-contained transformations, answer directly without memory. For new reusable facts stated by the user, follow the server capture instructions and verify tool success before claiming they were saved.';
const cases = [
  { id: 'architecture-en', prompt: 'Propose an architecture for a new service.' },
  { id: 'architecture-ja', prompt: '新しいサービスの構成を提案して。' },
  { id: 'translation', prompt: 'Translate the word apple into French.' },
  { id: 'unknown', prompt: 'Which airline seat do I prefer?' },
  {
    id: 'cause',
    prompt:
      'Did a host restart cause the new reporting job to stop? How can it avoid exposing unfinished output?',
  },
];
const seeds = [
  {
    title: 'Operating constraint',
    summary:
      'I am the only person operating our software, including new services. Avoid routine manual administration.',
    subjects: ['Evaluation owner'],
  },
  {
    title: 'Recurring cost constraint',
    summary:
      'For our software, including new services, recurring infrastructure spending must not increase beyond the current baseline. No measured cost estimates are available yet.',
    subjects: ['Evaluation owner'],
  },
  {
    title: 'Juniper export lesson',
    summary:
      'Juniper exposed an incomplete file after a host restart. Writing to a temporary file and atomically renaming it after completion prevented partial reads. The host restart cause was established for Juniper only.',
    subjects: ['Juniper'],
  },
];
const arms = ['server-only', 'client-policy', 'orchestrated'];
const manifest = {
  trials: 5,
  arms,
  cases,
  seeds,
  policy,
  routing:
    'Orchestrated arm skips prompts beginning with Translate; otherwise calls recall with the entire prompt, contextual intent, limit 5. This narrow rule is experimental, not a general intent classifier.',
  model: 'gemini-2.5-flash',
  temperature: 0,
  thinking_budget: 0,
  rubrics: {
    architecture:
      'Use both solo-operator and no-increased-spend constraints; cite supporting evidence; ask only missing details, not these constraints; do not assert the proposal meets the spending cap without measurements.',
    translation: 'Answer pomme, no irrelevant memory and no memory tool calls.',
    unknown: 'Say the seat preference is unknown; do not infer it from unrelated facts.',
    cause:
      'Current cause is unknown; attribute restart to Juniper only; transfer atomic-publication lesson.',
    capture:
      'Both constraints actually saved without a remember request; no claim of saved content after only failed writes.',
  },
};
await writeFile(outputDir + '/manifest.json', JSON.stringify(manifest, null, 2));
const cachePath = '.local/recall-eval/embedding-cache.json';
let cache = {};
try {
  cache = JSON.parse(await readFile(cachePath, 'utf8'));
} catch {
  /* No cache yet. */
}
const vertex = new VertexEmbeddingProvider({
  ...config,
  timeoutMs: 30000,
  accessToken: async () => (await readFile(tokenPath, 'utf8')).trim(),
});
const pending = new Map();
const embeddings = {
  async embed(text) {
    const key = createHash('sha256')
      .update(JSON.stringify(config) + text)
      .digest('hex');
    if (cache[key]) return cache[key];
    if (!pending.has(key))
      pending.set(
        key,
        vertex.embed(text).then((value) => {
          cache[key] = value;
          return value;
        }),
      );
    return pending.get(key);
  },
};
const runtime = createMemoryRecordsRuntime({
  projectId,
  databaseId,
  ledgerDatabaseId: 'lore-eval-deletions',
  cursorSecret: Buffer.alloc(32, 8),
});
const service = new ObservationService({
  ledger: runtime.observations,
  access: runtime.access,
  embeddings,
  now: () => new Date('2026-11-12T12:00:00Z'),
  log: () => {},
});
const mcp = await evaluationMcp(service);
const runs = [];
async function clientFor(subject, connectionId) {
  await promisify(execFile)(
    process.execPath,
    [
      'scripts/admit-subject.mjs',
      '--project',
      projectId,
      '--database',
      databaseId,
      '--issuer',
      issuer,
      '--subject',
      subject,
      '--tenant',
      subject,
      '--scope',
      'personal',
    ],
    { env: process.env },
  );
  return mcp.client(
    await runtime.access.resolve({ issuer, subject, connectionId, clientId: 'eval-model' }),
  );
}
try {
  for (let trial = 0; trial < 5; trial++) {
    // Separate tenants prevent model writes in one arm or case from affecting another.
    const settled = await Promise.allSettled(
      arms.map(async (arm) => {
        const rows = [];
        for (const item of cases) {
          const client = await clientFor(`synthetic-${trial}-${arm}-${item.id}`, 'reader');
          const receipts = [];
          for (const [index, seed] of seeds.entries()) {
            const result = await client.callTool({
              name: 'observe',
              arguments: {
                ...seed,
                nature: 'event',
                as_user: true,
                idempotency_key: 'seed-' + index,
              },
            });
            if (result.isError) throw new Error('Controlled fixture write failed');
            receipts.push(result.structuredContent);
          }
          const hostCalls = [];
          const started = performance.now();
          let context;
          if (arm === 'orchestrated' && !/^translate\b/i.test(item.prompt)) {
            for (const call of [
              { name: 'get_access', arguments: {} },
              { name: 'recall', arguments: { query: item.prompt, intent: 'contextual', limit: 5 } },
            ]) {
              const result = await client.callTool(call);
              hostCalls.push({
                ...call,
                result: result.structuredContent ?? result,
                isError: result.isError === true,
              });
              if (result.isError) throw new Error('Host prefetch failed');
            }
            context = hostCalls.at(-1).result;
          }
          const result = await clientConversation(client, item.prompt, config, tokenPath, {
            clientInstructions: arm === 'client-policy' ? policy : undefined,
            context,
          });
          rows.push({
            trial,
            arm,
            case: item.id,
            receipts,
            hostCalls,
            ...result,
            latency_ms: performance.now() - started,
          });
        }
        return rows;
      }),
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') runs.push(...result.value);
      else runs.push({ trial, failure: String(result.reason) });
    }
    await writeFile(outputDir + '/runs.json', JSON.stringify(runs, null, 2));
    console.log('Completed recall comparison trial ' + trial);
  }
  const capture = [];
  for (let trial = 0; trial < 5; trial++) {
    for (const arm of ['server-only', 'client-policy']) {
      const client = await clientFor(`synthetic-capture-${trial}-${arm}`, 'writer');
      const result = await clientConversation(
        client,
        'I am the only person operating our software. Recurring infrastructure spending must not increase. We are starting a new project.',
        config,
        tokenPath,
        { clientInstructions: arm === 'client-policy' ? policy : undefined },
      );
      capture.push({ trial, arm, ...result });
      await writeFile(outputDir + '/capture.json', JSON.stringify(capture, null, 2));
    }
    console.log('Completed capture comparison trial ' + trial);
  }
  if (runs.some((row) => row.failure) || capture.some((row) => row.failure)) process.exitCode = 1;
} finally {
  await writeFile(cachePath, JSON.stringify(cache), { mode: 0o600 });
  await mcp.close();
  await service.close();
  await runtime.close();
}
