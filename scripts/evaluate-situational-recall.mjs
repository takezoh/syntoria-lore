import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export function validateDataset(dataset) {
  const ids = new Set(dataset.observations.map((item) => item.id));
  if (ids.size !== dataset.observations.length) throw new Error('Duplicate observation IDs');
  if (new Set(dataset.cases.map((item) => item.id)).size !== dataset.cases.length)
    throw new Error('Duplicate case IDs');
  for (const item of dataset.cases) {
    for (const id of [...item.required_evidence, ...item.forbidden_evidence])
      if (!ids.has(id)) throw new Error('Unknown evidence label');
    if (item.required_evidence.some((id) => item.forbidden_evidence.includes(id)))
      throw new Error('Conflicting evidence judgments');
    if (item.required_evidence.length > item.top_k) throw new Error('Gold exceeds result budget');
  }
}

export function score(dataset, results) {
  validateDataset(dataset);
  const byCase = new Map();
  for (const result of results) {
    if (byCase.has(result.id)) throw new Error('Duplicate case result');
    byCase.set(result.id, result);
  }
  const rows = dataset.cases.map((item) => {
    const result = byCase.get(item.id);
    if (!result) throw new Error('Missing case result: ' + item.id);
    if (!Array.isArray(result.items)) throw new Error('Invalid result items');
    const labels = new Set(result.items.slice(0, item.top_k).flat());
    const allLabels = new Set(result.items.flat());
    const hits = item.required_evidence.filter((id) => labels.has(id)).length;
    const leaks = item.forbidden_evidence.filter((id) => allLabels.has(id));
    return {
      id: item.id,
      recall: item.required_evidence.length ? hits / item.required_evidence.length : null,
      all_required: hits === item.required_evidence.length,
      forbidden: leaks,
      latency_ms: result.latency_ms ?? null,
      notes: result.notes ?? [],
      // Retrieval alone cannot establish whether a client abstained or used evidence.
      answer_use: 'not-measured',
    };
  });
  const positive = rows.filter((row) => row.recall !== null);
  return {
    cases: rows,
    macro_recall_at_5: positive.reduce((sum, row) => sum + row.recall, 0) / positive.length,
    all_required_hit_rate: positive.filter((row) => row.all_required).length / positive.length,
    prohibited_content_cases: rows.filter((row) => row.forbidden.length).length,
    retrieval_passed: rows.every((row) => row.all_required && row.forbidden.length === 0),
    passed: null,
    limitation:
      'Retrieval judgments only; answer quality, abstention and client behavior are unmeasured.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  const datasetBytes = await readFile('docs/eval/fixtures/situational-recall.json');
  const dataset = JSON.parse(datasetBytes);
  validateDataset(dataset);
  if (args.includes('--validate')) {
    console.log(
      JSON.stringify({
        valid: true,
        observations: dataset.observations.length,
        cases: dataset.cases.length,
      }),
    );
    return;
  }
  if (!args.includes('--output')) throw new Error('--output is required');
  let results;
  if (args.includes('--results')) {
    results = JSON.parse(await readFile(option('--results'), 'utf8'));
  } else {
    if (!args.includes('--mapping')) throw new Error('--mapping is required for live recall');
    const url = new URL(process.env['LORE_EVAL_MCP_URL'] ?? '');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('Live fixture evaluation requires a loopback MCP service');
    const mapping = JSON.parse(await readFile(option('--mapping'), 'utf8'));
    for (const observation of dataset.observations)
      if (typeof mapping[observation.id] !== 'string')
        throw new Error('Incomplete fixture mapping');
    const reverse = new Map(Object.entries(mapping).map(([label, id]) => [id, label]));
    const client = new Client({ name: 'lore-situational-evaluation', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: { authorization: 'Bearer ' + (process.env['LORE_EVAL_TOKEN'] ?? '') },
          },
        }),
      );
      results = [];
      for (const item of dataset.cases) {
        const started = performance.now();
        const response = await client.callTool({
          name: 'recall',
          arguments: {
            query: item.query,
            intent: item.intent,
            limit: item.top_k,
            ...(item.as_of ? { at: item.as_of } : {}),
          },
        });
        if (response.isError || !response.structuredContent)
          throw new Error('Recall failed: ' + item.id);
        const body = response.structuredContent;
        const items = body.items.map((hit) => {
          const evidence =
            hit.type === 'event' ? [hit.observation] : [hit.topic.current, ...(hit.evidence ?? [])];
          return [
            ...new Set(evidence.map((entry) => reverse.get(entry.observation_id) ?? 'unmapped')),
          ];
        });
        results.push({
          id: item.id,
          items,
          notes: body.notes,
          latency_ms: performance.now() - started,
        });
      }
    } finally {
      await client.close();
    }
  }
  const report = {
    dataset_sha256: createHash('sha256').update(datasetBytes).digest('hex'),
    generated_at: new Date().toISOString(),
    ...score(dataset, results),
  };
  await writeFile(option('--output'), JSON.stringify(report, null, 2) + '\n');
  if (!report.retrieval_passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
