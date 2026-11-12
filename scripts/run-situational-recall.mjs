import { evaluationMcp } from './evaluation-mcp.mjs';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import {
  createMemoryRecordsRuntime,
  ObservationService,
  authorizationDocumentId,
  MEMORY_AUTHORIZATION_COLLECTION,
} from '@memory/memory-records';
import { VertexEmbeddingProvider } from '../apps/api/dist/embeddings.js';
import { VertexRecallAssessor } from '../apps/api/dist/recall-assessment.js';
import { clientConversation } from './evaluate-situational-clients.mjs';
import { score, validateDataset } from './evaluate-situational-recall.mjs';

const trials = Number(process.env['LORE_EVAL_TRIALS'] ?? 5);
if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20)
  throw new Error('LORE_EVAL_TRIALS must be 1 to 20');
const host = process.env['FIRESTORE_EMULATOR_HOST'];
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('A loopback Firestore emulator is required');
const configPath = process.env['LORE_EVAL_CONFIG'];
const tokenPath = process.env['LORE_EVAL_TOKEN_FILE'];
if (!configPath || !tokenPath)
  throw new Error('LORE_EVAL_CONFIG and LORE_EVAL_TOKEN_FILE are required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const datasetBytes = await readFile(
  process.env['LORE_EVAL_DATASET'] ?? 'docs/eval/fixtures/situational-recall.json',
);
const dataset = JSON.parse(datasetBytes);
validateDataset(dataset);
const projectId = 'demo-situational-' + process.pid;
const databaseId = 'lore-eval';
const issuer = 'https://example.test';
const outputDir = process.env['LORE_EVAL_OUTPUT'] ?? '.local/recall-eval';
await mkdir(outputDir, { recursive: true });
const cachePath = '.local/recall-eval/embedding-cache.json';
let cache;
try {
  cache = JSON.parse(await readFile(cachePath, 'utf8'));
} catch {
  cache = {};
}
const vertex = new VertexEmbeddingProvider({
  ...config,
  timeoutMs: 30000,
  accessToken: async () => (await readFile(tokenPath, 'utf8')).trim(),
});
let calls = 0;
const embeddings = {
  async embed(text) {
    const key = createHash('sha256')
      .update(JSON.stringify(config) + text)
      .digest('hex');
    if (!cache[key]) {
      cache[key] = await vertex.embed(text);
      calls++;
      await writeFile(cachePath, JSON.stringify(cache), { mode: 0o600 });
    }
    return cache[key];
  },
};
const runtime = createMemoryRecordsRuntime({
  projectId,
  databaseId,
  ledgerDatabaseId: 'lore-eval-deletions',
  cursorSecret: Buffer.alloc(32, 7),
});
const firestore = new Firestore({ projectId, databaseId });
const service = new ObservationService({
  ledger: runtime.observations,
  access: runtime.access,
  embeddings,
  ...(process.env['LORE_EVAL_ASSESSMENT_MODEL']
    ? {
        recallAssessor: new VertexRecallAssessor({
          ...config,
          model: process.env['LORE_EVAL_ASSESSMENT_MODEL'],
          accessToken: async () => (await readFile(tokenPath, 'utf8')).trim(),
        }),
      }
    : {}),
  now: () => new Date(dataset.as_of),
  log: () => {},
});
const mcp = await evaluationMcp(service);
try {
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
      'synthetic-eval-owner',
      '--tenant',
      'evaluation',
      '--scope',
      'personal',
    ],
    { env: process.env },
  );
  const principal = {
    issuer,
    subject: 'synthetic-eval-owner',
    connectionId: 'writer',
    clientId: 'eval',
  };
  let writer = await runtime.access.resolve(principal);
  const worker = await runtime.access.worker(writer);
  // Only synthetic fixture authorizations in a demo- emulator project are provisioned here.
  for (const actor of [writer.actor, worker]) {
    await firestore
      .collection(MEMORY_AUTHORIZATION_COLLECTION)
      .doc(authorizationDocumentId('evaluation', actor.principalId, 'personal'))
      .update({ compartmentAllowance: ['private'] });
  }
  writer = await runtime.access.resolve(principal);
  const reader = await runtime.access.resolve({ ...principal, connectionId: 'reader' });
  const mapping = {};
  for (const seed of dataset.observations) {
    const result = await service.observe(writer, {
      title: seed.title,
      summary: seed.summary,
      nature: seed.nature,
      kind: seed.kind,
      subjects: seed.subjects,
      ...(seed.aspect ? { aspect: seed.aspect } : {}),
      ...(seed.value ? { value: seed.value } : {}),
      effectiveAt: seed.effective_at,
      compartmentIds: seed.compartments,
      sources: seed.sources.map((source) => ({
        provider: source.provider,
        ids: { resource_id: source.resource_id },
        uri: source.url,
      })),
      asUser: false,
      idempotencyKey: 'fixture-' + seed.id,
    });
    mapping[seed.id] = result.observation_id;
    if (seed.status === 'retracted') {
      await service.observe(writer, {
        title: 'Retraction',
        summary: 'Withdraw the mistaken database cause.',
        nature: 'event',
        subjects: seed.subjects,
        retracts: result.observation_id,
        asUser: false,
        idempotencyKey: 'retract-' + seed.id,
      });
    }
    if (seed.status === 'forgotten')
      await service.forget(writer, {
        target: { observationId: result.observation_id },
        idempotencyKey: 'forget-' + seed.id,
      });
    if (seed.source_status)
      await service.reportSource(writer, {
        observationId: result.observation_id,
        sourceIndex: 0,
        status: seed.source_status,
      });
  }
  const readerClient = await mcp.client(reader);
  const reverse = new Map(Object.entries(mapping).map(([label, id]) => [id, label]));
  const results = [];
  const raw = [];
  for (const item of dataset.cases) {
    const started = performance.now();
    const mcpResponse = await readerClient.callTool({
      name: 'recall',
      arguments: {
        query: item.query,
        intent: item.intent,
        limit: item.top_k,
        ...(item.as_of ? { at: item.as_of } : {}),
      },
    });
    if (mcpResponse.isError) throw new Error('Recall failed');
    const response = mcpResponse.structuredContent;
    const items = response.items.map((hit) => {
      const evidence =
        hit.type === 'event' ? [hit.observation] : [hit.topic.current, ...(hit.evidence ?? [])];
      return [...new Set(evidence.map((entry) => reverse.get(entry.observation_id) ?? 'unmapped'))];
    });
    results.push({
      id: item.id,
      items,
      notes: response.notes,
      latency_ms: performance.now() - started,
    });
    raw.push({ id: item.id, response });
  }
  const clientRuns = [];
  if (process.env['LORE_EVAL_CLIENTS'] === '1') {
    for (let run = 0; run < trials; run++) {
      const subject = 'synthetic-client-owner-' + run;
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
          'client-evaluation-' + run,
          '--scope',
          'personal',
        ],
        { env: process.env },
      );
      const base = { issuer, subject, clientId: 'eval-model' };
      const accessA = await runtime.access.resolve({ ...base, connectionId: 'client-a' });
      const accessB = await runtime.access.resolve({ ...base, connectionId: 'client-b' });
      const a = await clientConversation(
        await mcp.client(accessA),
        'I am the only person operating our software. Recurring infrastructure spending must not increase. We are starting a new project.',
        config,
        tokenPath,
      );
      const b = await clientConversation(
        await mcp.client(accessB),
        'Propose an architecture for a new service.',
        config,
        tokenPath,
      );
      const unrelated = await clientConversation(
        await mcp.client(accessB),
        'Translate the word apple into French.',
        config,
        tokenPath,
      );
      clientRuns.push({ run, a, b, unrelated });
      await writeFile(outputDir + '/client-runs.json', JSON.stringify(clientRuns, null, 2));
    }
    await writeFile(outputDir + '/client-runs.json', JSON.stringify(clientRuns, null, 2));
  }
  const report = {
    server_instructions_sha256: createHash('sha256')
      .update(readerClient.getInstructions() ?? '')
      .digest('hex'),
    tool_schemas_sha256: createHash('sha256')
      .update(JSON.stringify((await readerClient.listTools()).tools))
      .digest('hex'),
    client_flow: clientRuns.map(({ run, a, b, unrelated }) => {
      const saved = a.calls
        .filter((call) => call.name === 'observe' && !call.isError)
        .map((call) => call.result.observation_id);
      const recalled = b.calls.filter((call) => call.name === 'recall' && !call.isError);
      const serialized = JSON.stringify(recalled.map((call) => call.result));
      return {
        run,
        successful_writes: saved.length,
        recall_calls: recalled.length,
        saved_evidence_retrieved: saved.length > 0 && saved.every((id) => serialized.includes(id)),
        tool_errors: [...a.calls, ...b.calls, ...unrelated.calls].filter((call) => call.isError)
          .length,
        answer_use: 'requires-rubric-review',
      };
    }),
    assessment_model: process.env['LORE_EVAL_ASSESSMENT_MODEL'] ?? null,
    answer_model: 'gemini-2.5-flash',
    generation: { temperature: 0, thinking_budget: 0 },
    dataset_sha256: createHash('sha256').update(datasetBytes).digest('hex'),
    embedding: { model: config.model, dimension: config.dimension, new_calls: calls },
    storage: 'loopback-firestore-emulator',
    evaluated_at: new Date().toISOString(),
    boundary:
      'Loopback HTTP/MCP tools and schemas with real Vertex embeddings; synthetic verified identities, not hosted OAuth.',
    ...score(dataset, results),
  };
  await writeFile(outputDir + '/results.json', JSON.stringify(results, null, 2));
  await writeFile(outputDir + '/raw.json', JSON.stringify(raw, null, 2));
  await writeFile(outputDir + '/report.json', JSON.stringify(report, null, 2));
  await chmod(outputDir + '/report.json', 0o600);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await mcp.close();
  await service.close();
  await runtime.close();
  await firestore.terminate();
}
