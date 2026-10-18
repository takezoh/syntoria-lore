import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const api = (process.env['LOCAL_API_URL'] ?? 'http://localhost:18080').replace(/\/$/, '');
const issuer = (process.env['LOCAL_ISSUER_URL'] ?? 'http://localhost:19090').replace(/\/$/, '');
const scope = process.env['LOCAL_SCOPE_ID'] ?? '22222222-2222-4222-8222-222222222222';
const captureScopes = (process.env['LOCAL_CAPTURE_SCOPE_IDS'] ?? '').split(/\s+/).filter(Boolean);
const runId = randomUUID();
const salt = runId.slice(0, 8);
const cases = [];
const fixtures = [];
const setupErrors = [];
const networkErrors = [];
const caseResults = [];
let ownerToken;
let readerToken;
let wrongAudienceToken;
let activeForgetRequestId;
let activeForgetBody;
let activeForgetIdempotencyKey;
const begunAt = new Date().toISOString();

try {
  if (captureScopes.length !== 6)
    throw new Error('Local evaluation needs six isolated capture scopes');
  ownerToken = await issue(
    'demo-owner-client',
    'owner-local-fixture-only',
    api,
    'memory:read memory:write memory:admin',
    [scope, ...captureScopes],
  );
  readerToken = await issue('demo-reader-client', 'reader-local-fixture-only', api, 'memory:read', [
    scope,
    ...captureScopes,
  ]);
  wrongAudienceToken = await issue(
    'demo-owner-client',
    'owner-local-fixture-only',
    `${api}/mcp/read`,
    'memory:read memory:write',
    [scope, ...captureScopes],
  );
  const temporal = await seedTemporal();
  const authority = await seedAuthority();
  const evidence = await seedEvidence();
  const experience = await seedExperience();
  const security = await seedSecurity();
  const asynchronous = await seedAsyncCaptures();
  addTemporalCases(temporal);
  addAuthorityCases(authority);
  addEvidenceCases(evidence);
  addUnknownCases();
  addExperienceCases(experience);
  addSecurityCases(security);
  addAsyncCases(asynchronous);
  if (cases.length < 220)
    throw new Error(`Evaluation plan produced ${cases.length} cases, expected at least 220`);
  for (const testCase of cases) {
    try {
      const result = await runCase(testCase);
      caseResults.push({ ...testCase, ...result });
    } catch (error) {
      networkErrors.push({
        case_id: testCase.case_id,
        type: error?.name ?? 'Error',
        message: safeMessage(error),
      });
      caseResults.push({
        ...testCase,
        passed: false,
        status: null,
        actual_ids: [],
        actual_authorities: [],
        actual_unknown: null,
        assertions: ['request completed without network or parse exception'],
      });
    }
  }
} catch (error) {
  setupErrors.push({ type: error?.name ?? 'Error', message: safeMessage(error) });
}

const retrievalCases = caseResults.filter((testCase) => testCase.baseline_question === true);
const summaryContext = buildSummaryContext(fixtures);
const summaryContextBytes = (testCase) =>
  Buffer.byteLength(
    (summaryContext.get(testCase.summary_group) ?? []).map((fixture) => fixture.text).join('\n'),
    'utf8',
  );
const noMemoryBaseline = baselineMetrics(
  retrievalCases,
  () => [],
  () => 0,
);
const conversationSummaryBaseline = baselineMetrics(
  retrievalCases,
  (testCase) =>
    deterministicRetriever(testCase.query, summaryContext.get(testCase.summary_group) ?? []),
  summaryContextBytes,
);
const localApiMetrics = baselineMetrics(
  retrievalCases,
  (testCase) => testCase.actual_ids ?? [],
  (testCase) => testCase.actual_context_pack_bytes ?? 0,
  (testCase) => testCase.case_wall_ms ?? 0,
);
const categoryCounts = Object.fromEntries(
  [...new Set(caseResults.map((testCase) => testCase.category))].map((category) => [
    category,
    caseResults.filter((testCase) => testCase.category === category).length,
  ]),
);
const allCasesPassed =
  caseResults.length >= 220 && caseResults.every((testCase) => testCase.passed === true);
const report = {
  schema_version: 'memory.local-evaluation.v1',
  fixture_version: 'local-eval-meaningful-231-v7',
  run_id: runId,
  started_at: begunAt,
  completed_at: new Date().toISOString(),
  status: allCasesPassed && setupErrors.length === 0 ? 'passed' : 'failed',
  fixture_hash: createHash('sha256')
    .update(fixtures.map((fixture) => JSON.stringify(fixture)).join('\n'))
    .digest('hex'),
  provider_configuration: {
    curator: process.env['CURATOR_MODEL_ID'] ?? 'local-deterministic-v1',
    prompt: process.env['CURATOR_PROMPT_VERSION'] ?? 'local-fixture-v1',
    embeddings: 'local-hash-1536-v2',
  },
  resource_cost_proxy: {
    external_provider_calls: 0,
    paid_model_tokens: 0,
    paid_model_cost: null,
    note: 'Only deterministic local providers ran; local CPU time and hardware are not converted to currency.',
  },
  totals: {
    planned_cases: cases.length,
    executed_cases: caseResults.length,
    passed: caseResults.filter((testCase) => testCase.passed).length,
    failed: caseResults.filter((testCase) => !testCase.passed).length,
    authorized_retrieval_denominator: retrievalCases.length,
    fixture_memories: fixtures.length,
    network_exception_count: networkErrors.length,
    setup_error_count: setupErrors.length,
  },
  categories: categoryCounts,
  baselines: {
    no_memory: noMemoryBaseline,
    deterministic_conversation_summary: {
      ...conversationSummaryBaseline,
      definition:
        'Non-LLM control: each synthetic conversation is serialized as its first four fixture facts verbatim. A deterministic lexical retriever searches this text; expected labels are used only after retrieval for scoring.',
    },
    memory_local_api: {
      ...localApiMetrics,
      definition:
        'Real local REST API, PostgreSQL authorization and temporal selection, deterministic local curator/embedding fixtures, and the actual private worker for capture cases.',
    },
  },
  errors: {
    setup: setupErrors,
    network_exceptions: networkErrors.slice(0, 100),
    network_exceptions_truncated: Math.max(0, networkErrors.length - 100),
  },
  limitations: [
    'All content is synthetic and deterministic. There is no human label set or paid/remote model in this run.',
    'The hash embedding and local curator exercise system behavior, not semantic quality of a production model.',
    'Conversation-summary results use a transparent first-four-facts text context and deterministic lexical retriever, not an LLM summary.',
    'Each evaluation uses a new owner scope and two local OAuth principals; this is contract acceptance evidence, not a production quality or capacity claim.',
  ],
  cases: caseResults,
};

await mkdir('var', { recursive: true });
const output = join('var', `eval-${new Date().toISOString().replaceAll(':', '-')}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(
  `${JSON.stringify({ ...report, cases: undefined, report_file: output }, null, 2)}\n`,
);
if (!allCasesPassed || setupErrors.length > 0) process.exitCode = 1;

async function seedTemporal() {
  const rows = [];
  const current = `Aiko Sato ${salt}`;
  const former = `Aiko Mori ${salt}`;
  const renamed = await remember(`${current} keeps the blue field notebook.`, {
    kind: 'fact',
    valid_from: '2020-01-01T00:00:00.000Z',
    valid_to: '2035-01-01T00:00:00.000Z',
    category: 'temporal_rename',
    conversation_order: 0,
    summary_group: 'temporal_rename',
    subjects: [
      {
        name: current,
        aliases: [
          {
            name: former,
            valid_from: '2020-01-01T00:00:00.000Z',
            valid_to: '2025-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
  });
  rows.push({
    scenario: 'subject-rename',
    id: renamed.id,
    statement: renamed.statement,
    authority: renamed.authority,
    tests: [
      {
        name: 'canonical-name-current',
        query: current,
        valid_at: '2026-01-01T00:00:00.000Z',
        expected: [renamed.id],
        selected_valid_from: '2020-01-01T00:00:00.000Z',
      },
      {
        name: 'former-name-before-rename',
        query: former,
        valid_at: '2024-12-31T23:59:59.999Z',
        expected: [renamed.id],
        selected_valid_from: '2020-01-01T00:00:00.000Z',
      },
      {
        name: 'former-name-at-exclusive-end',
        query: former,
        valid_at: '2025-01-01T00:00:00.000Z',
        expected: [],
      },
      {
        name: 'former-name-after-rename',
        query: former,
        valid_at: '2026-01-01T00:00:00.000Z',
        expected: [],
      },
      {
        name: 'former-name-before-alias-start',
        query: former,
        valid_at: '2019-12-31T23:59:59.999Z',
        expected: [],
      },
    ],
  });

  const starts = `Mika Ito ${salt}`;
  const startRow = await remember(`${starts} opens the silver archive on 2024-03-01.`, {
    kind: 'fact',
    valid_from: '2024-03-01T00:00:00.000Z',
    valid_to: '2030-01-01T00:00:00.000Z',
    category: 'temporal_rename',
    conversation_order: 1,
    summary_group: 'temporal_rename',
    subjects: [{ name: starts }],
  });
  rows.push({
    scenario: 'inclusive-valid-start',
    id: startRow.id,
    statement: startRow.statement,
    authority: startRow.authority,
    tests: [
      {
        name: 'one-millisecond-before-start',
        query: starts,
        valid_at: '2024-02-29T23:59:59.999Z',
        expected: [],
      },
      {
        name: 'exact-start-inclusive',
        query: starts,
        valid_at: '2024-03-01T00:00:00.000Z',
        expected: [startRow.id],
        selected_valid_from: '2024-03-01T00:00:00.000Z',
      },
      {
        name: 'after-start',
        query: starts,
        valid_at: '2025-06-01T00:00:00.000Z',
        expected: [startRow.id],
        selected_valid_from: '2024-03-01T00:00:00.000Z',
      },
      {
        name: 'known-before-recorded',
        query: startRow.statement,
        known_at: '2000-01-01T00:00:00.000Z',
        expected: [],
      },
      {
        name: 'current-known-time',
        query: startRow.statement,
        known_at: '2099-01-01T00:00:00.000Z',
        expected: [startRow.id],
        selected_valid_from: '2024-03-01T00:00:00.000Z',
      },
    ],
  });

  const expires = `Rina Kato ${salt}`;
  const endRow = await remember(`${expires} holds the bronze key until 2024-01-01.`, {
    kind: 'fact',
    valid_from: '2016-01-01T00:00:00.000Z',
    valid_to: '2024-01-01T00:00:00.000Z',
    category: 'temporal_rename',
    conversation_order: 2,
    summary_group: 'temporal_rename',
    subjects: [{ name: expires }],
  });
  rows.push({
    scenario: 'exclusive-valid-end',
    id: endRow.id,
    statement: endRow.statement,
    authority: endRow.authority,
    tests: [
      {
        name: 'before-end',
        query: expires,
        valid_at: '2023-12-31T23:59:59.999Z',
        expected: [endRow.id],
        selected_valid_from: '2016-01-01T00:00:00.000Z',
      },
      {
        name: 'exact-end-exclusive',
        query: expires,
        valid_at: '2024-01-01T00:00:00.000Z',
        expected: [],
      },
      { name: 'after-end', query: expires, valid_at: '2025-01-01T00:00:00.000Z', expected: [] },
      {
        name: 'before-valid-start',
        query: expires,
        valid_at: '2015-12-31T23:59:59.999Z',
        expected: [],
      },
      {
        name: 'explicit-current-valid-time',
        query: endRow.statement,
        valid_at: '2026-01-01T00:00:00.000Z',
        expected: [],
      },
    ],
  });

  const retro = `Haruto Chen ${salt}`;
  const retroRow = await remember(`${retro} completed the cedar bridge in 2019.`, {
    kind: 'fact',
    valid_from: '2019-05-01T00:00:00.000Z',
    valid_to: '2020-01-01T00:00:00.000Z',
    category: 'temporal_rename',
    conversation_order: 3,
    summary_group: 'temporal_rename',
    subjects: [{ name: retro }],
  });
  rows.push({
    scenario: 'retrospective-record-time',
    id: retroRow.id,
    statement: retroRow.statement,
    authority: retroRow.authority,
    tests: [
      {
        name: 'valid-during-retrospective-window',
        query: retro,
        valid_at: '2019-08-01T00:00:00.000Z',
        expected: [retroRow.id],
        selected_valid_from: '2019-05-01T00:00:00.000Z',
      },
      {
        name: 'valid-before-retrospective-window',
        query: retro,
        valid_at: '2018-01-01T00:00:00.000Z',
        expected: [],
      },
      {
        name: 'valid-after-retrospective-window',
        query: retro,
        valid_at: '2021-01-01T00:00:00.000Z',
        expected: [],
      },
      {
        name: 'not-yet-known-in-record-time',
        query: retroRow.statement,
        known_at: '2000-01-01T00:00:00.000Z',
        expected: [],
      },
      {
        name: 'retrospective-fact-known-later',
        query: retroRow.statement,
        known_at: '2099-01-01T00:00:00.000Z',
        expected: [retroRow.id],
        selected_valid_from: '2019-05-01T00:00:00.000Z',
      },
    ],
  });

  const recorded = `Noa Patel ${salt}`;
  const recordedRow = await remember(`${recorded} chose the amber route this year.`, {
    kind: 'decision',
    category: 'temporal_rename',
    conversation_order: 4,
    summary_group: 'temporal_rename',
    subjects: [{ name: recorded }],
  });
  rows.push({
    scenario: 'recorded-time-boundary',
    id: recordedRow.id,
    statement: recordedRow.statement,
    authority: recordedRow.authority,
    tests: [
      {
        name: 'known-time-before-record',
        query: recordedRow.statement,
        known_at: '2000-01-01T00:00:00.000Z',
        expected: [],
      },
      {
        name: 'known-time-after-record',
        query: recordedRow.statement,
        known_at: '2099-01-01T00:00:00.000Z',
        expected: [recordedRow.id],
      },
      {
        name: 'valid-time-present',
        query: recorded,
        valid_at: '2026-01-01T00:00:00.000Z',
        expected: [recordedRow.id],
      },
      {
        name: 'valid-time-historical',
        query: recorded,
        valid_at: '2010-01-01T00:00:00.000Z',
        expected: [recordedRow.id],
      },
      {
        name: 'valid-and-known-time-intersection-empty',
        query: recordedRow.statement,
        valid_at: '2010-01-01T00:00:00.000Z',
        known_at: '2000-01-01T00:00:00.000Z',
        expected: [],
      },
    ],
  });

  const shared = `Jordan Lee ${salt}`;
  const overlapA = await remember(`${shared} stores the indigo map.`, {
    kind: 'fact',
    valid_from: '2020-01-01T00:00:00.000Z',
    valid_to: '2030-01-01T00:00:00.000Z',
    category: 'temporal_rename',
    conversation_order: 5,
    summary_group: 'temporal_rename',
    subjects: [{ name: shared }],
  });
  const overlapB = await remember(`${shared} stores the white map.`, {
    kind: 'fact',
    valid_from: '2024-01-01T00:00:00.000Z',
    valid_to: '2035-01-01T00:00:00.000Z',
    category: 'temporal_rename',
    conversation_order: 6,
    summary_group: 'temporal_rename',
    subjects: [{ name: shared }],
  });
  rows.push({
    scenario: 'overlapping-subject-records',
    id: overlapA.id,
    statement: overlapA.statement,
    authority: overlapA.authority,
    tests: [
      {
        name: 'before-any-overlap',
        query: shared,
        valid_at: '2019-01-01T00:00:00.000Z',
        expected: [],
        limit: 20,
      },
      {
        name: 'first-record-only',
        query: shared,
        valid_at: '2022-01-01T00:00:00.000Z',
        expected: [overlapA.id],
        selected_valid_from: '2020-01-01T00:00:00.000Z',
        limit: 20,
      },
      {
        name: 'both-records-overlap',
        query: shared,
        valid_at: '2025-01-01T00:00:00.000Z',
        expected: [overlapA.id, overlapB.id],
        selected_valid_from: ['2020-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'],
        limit: 20,
      },
      {
        name: 'second-record-only',
        query: shared,
        valid_at: '2032-01-01T00:00:00.000Z',
        expected: [overlapB.id],
        selected_valid_from: '2024-01-01T00:00:00.000Z',
        limit: 20,
      },
      {
        name: 'after-all-overlap',
        query: shared,
        valid_at: '2036-01-01T00:00:00.000Z',
        expected: [],
        limit: 20,
      },
    ],
  });
  return rows;
}

async function seedAuthority() {
  const specs = [
    [
      'decision',
      'asserted',
      `Owner Mina decided on the ochre mountain pass during the thaw ${salt}-0.`,
    ],
    ['decision', 'asserted', `Owner Idris chose a low-noise alarm for the observatory ${salt}-1.`],
    [
      'preference',
      'asserted',
      `Owner Sora prefers cedar shelves over steel racks for the archive ${salt}-2.`,
    ],
    [
      'preference',
      'asserted',
      `Owner Kai likes concise labels on alpine equipment lockers ${salt}-3.`,
    ],
    [
      'fact',
      'asserted',
      `Owner Noor asserted that the amber valve stays closed during maintenance ${salt}-4.`,
    ],
    [
      'fact',
      'proposed',
      `AI draft proposal ${salt}-5: the zephyr buoy pulses violet twice before dawn.`,
    ],
  ];
  const rows = [];
  for (let index = 0; index < specs.length; index += 1) {
    const [kind, epistemic_status, statement] = specs[index];
    const result = await remember(statement, {
      kind,
      epistemic_status,
      category: 'authority',
      conversation_order: index,
      summary_group: 'authority',
    });
    rows.push({
      ...result,
      statement,
      kind,
      epistemic_status,
      authority:
        epistemic_status === 'proposed'
          ? 'ai_proposal'
          : kind === 'decision'
            ? 'owner_decision'
            : kind === 'preference'
              ? 'owner_preference'
              : 'owner_assertion',
      conversation_order: index,
    });
  }
  return rows;
}

async function seedEvidence() {
  const rows = [];
  const specs = [
    {
      key: 'three-independent-sources-corroborated',
      kind: 'fact',
      authority: 'owner_assertion',
      statement: `Three field logs independently record the green lantern ${salt}.`,
      evidence: (key) => [
        evidenceCaseInput(`${key}-log-a`, '1', 'field/log-a', 'field team A'),
        evidenceCaseInput(`${key}-log-b`, '1', 'field/log-b', 'field team B'),
      ],
      corroboration: (key) =>
        evidenceCaseInput(`${key}-meeting-minutes`, '1', 'meeting/lantern', 'archive review'),
      expectedEvidenceCount: 3,
      expectedSourceCount: 3,
      expectedLineageCount: 3,
      expectedRevision: 2,
    },
    {
      key: 'one-source-two-distinct-locations',
      kind: 'decision',
      authority: 'owner_decision',
      statement: `The same inspection record places the brass seal in cabinet ${salt}.`,
      evidence: (key) => [
        evidenceCaseInput(`${key}-inspection`, '1', 'inspection/summary', 'inspection summary'),
        evidenceCaseInput(`${key}-inspection`, '1', 'inspection/photo-caption', 'photo caption'),
      ],
      expectedEvidenceCount: 2,
      expectedSourceCount: 1,
      expectedLineageCount: 1,
      expectedRevision: 1,
    },
    {
      key: 'duplicate-evidence-anchor-deduplicates',
      kind: 'preference',
      authority: 'owner_preference',
      statement: `The owner prefers the amber paper labels ${salt}.`,
      evidence: (key) => {
        const same = evidenceCaseInput(`${key}-owner-note`, '1', 'notes/preference', 'owner note');
        return [same, { ...same, source: { ...same.source } }];
      },
      expectedEvidenceCount: 1,
      expectedSourceCount: 1,
      expectedLineageCount: 1,
      expectedRevision: 1,
    },
    {
      key: 'same-source-new-revision',
      kind: 'hypothesis',
      authority: 'owner_assertion',
      statement: `A revised field report still identifies the ridge beacon ${salt}.`,
      evidence: (key) => [
        evidenceCaseInput(`${key}-field-report`, '1', 'report/2026-01', 'January report'),
        evidenceCaseInput(`${key}-field-report`, '2', 'report/2026-03', 'March revision'),
      ],
      expectedEvidenceCount: 2,
      expectedSourceCount: 2,
      expectedLineageCount: 2,
      expectedRevision: 1,
    },
    {
      key: 'snippet-rights-and-speaker-attribution',
      kind: 'experience',
      authority: 'owner_assertion',
      statement: `The frost test kept the sample stable in the insulated sleeve ${salt}.`,
      context: {
        episode: {
          condition: { weather: 'frost' },
          action: 'used insulated sleeve',
          outcome: 'sample stayed stable',
        },
      },
      evidence: (key) => [
        evidenceCaseInput(`${key}-restricted-note`, '1', 'lab/private', 'private-marker-absent', {
          speaker: 'technician',
          snippetAllowed: false,
        }),
        evidenceCaseInput(`${key}-public-result`, '1', 'lab/result', 'public-result-visible', {
          speaker: 'owner',
          snippetAllowed: true,
        }),
      ],
      expectedEvidenceCount: 2,
      expectedSourceCount: 2,
      expectedLineageCount: 2,
      expectedRevision: 1,
      expectedVisibleSnippet: 'public-result-visible',
      expectedHiddenSnippet: 'private-marker-absent',
    },
    {
      key: 'dated-independent-procedure-sources',
      kind: 'procedure',
      authority: 'owner_assertion',
      statement: `During calibration, close the amber valve before pressure testing ${salt}.`,
      context: { procedure: { before: 'pressure test', action: 'close amber valve' } },
      evidence: (key) => [
        evidenceCaseInput(`${key}-manual`, '1', 'manual/step-7', 'manual step', {
          eventTime: '2026-02-01T10:00:00.000Z',
        }),
        evidenceCaseInput(`${key}-shift-log`, '1', 'shift/log-22', 'shift log', {
          eventTime: '2026-02-02T10:00:00.000Z',
        }),
      ],
      expectedEvidenceCount: 2,
      expectedSourceCount: 2,
      expectedLineageCount: 2,
      expectedRevision: 1,
    },
  ];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const statement = spec.statement;
    const idempotencyKey = `eval-evidence-${runId}-${spec.key}`;
    const evidence = spec.evidence(`${runId}-${spec.key}`);
    const memory = {
      kind: spec.kind,
      statement,
      context: spec.context ?? {},
      subjects: [],
      evidence,
    };
    const first = await postJson(
      '/v1/memories:remember',
      ownerToken,
      { scope_id: scope, memory },
      { idempotencyKey },
    );
    assertStatus(first, 200, `seed evidence ${index}`);
    const id = memoryId(first.body);
    let initialChangeSetId = first.body.change_set_id;
    if (spec.corroboration !== undefined) {
      const corroboration = await postJson(
        '/v1/changesets',
        ownerToken,
        {
          scope_id: scope,
          operations: [
            {
              op: 'CORROBORATE',
              memory_id: id,
              expected_revision: 1,
              evidence: [spec.corroboration(`${runId}-${spec.key}`)],
            },
          ],
        },
        { idempotencyKey: `eval-evidence-corroborate-${runId}-${spec.key}` },
      );
      assertStatus(corroboration, 200, `propose evidence corroboration ${spec.key}`);
      const corroborated = await postJson(
        `/v1/changesets/${corroboration.body.change_set_id}:commit`,
        ownerToken,
        {},
        { idempotencyKey: `eval-evidence-corroborate-commit-${runId}-${spec.key}` },
      );
      assertStatus(corroborated, 200, `commit evidence corroboration ${spec.key}`);
      if (corroborated.body.operations?.[0]?.revisions?.[0] !== spec.expectedRevision)
        throw new Error(`Evidence fixture ${spec.key} did not reach its fixed revision`);
    }
    const view = await getMemory(id, ownerToken);
    assertStatus(view, 200, `get evidence fixture ${spec.key}`);
    if (view.body.attribution?.authority !== spec.authority)
      throw new Error(`Evidence fixture ${spec.key} had unexpected authority`);
    fixtures.push({
      category: 'independent_evidence',
      summary_group: 'independent_evidence',
      statement,
      id,
      authority: spec.authority,
      conversation_order: index,
      summary_window_retained: index < 4,
    });
    rows.push({
      id,
      statement,
      authority: spec.authority,
      fixture_key: spec.key,
      evidence_count: spec.expectedEvidenceCount,
      source_count: spec.expectedSourceCount,
      lineage_count: spec.expectedLineageCount,
      expected_revision: spec.expectedRevision,
      expected_visible_snippet: spec.expectedVisibleSnippet,
      expected_hidden_snippet: spec.expectedHiddenSnippet,
      initial_change_set_id: initialChangeSetId,
      replay_key: idempotencyKey,
      replay_body: { scope_id: scope, memory },
      conversation_order: index,
    });
  }
  return rows;
}

async function seedExperience() {
  const rows = [];
  for (let index = 0; index < 6; index += 1) {
    const condition = ['rain', 'wind', 'cold', 'heat', 'fog', 'snow'][index];
    const action = ['packed', 'covered', 'moved', 'cooled', 'paused', 'wrapped'][index];
    const outcome = ['dry', 'stable', 'safe', 'clear', 'ready', 'intact'][index];
    const statement = `Procedure ${salt}-${index}: when ${condition} arrives, ${action} the field kit and the result is ${outcome}.`;
    const context = {
      episode: { condition: { weather: condition }, action, outcome, sequence: index + 1 },
    };
    const result = await remember(statement, {
      kind: 'experience',
      context,
      category: 'experience_procedure',
      conversation_order: index,
      summary_group: 'experience_procedure',
    });
    rows.push({
      ...result,
      statement,
      context,
      authority: 'owner_assertion',
      conversation_order: index,
    });
  }
  return rows;
}

async function seedSecurity() {
  const rows = [];
  const specs = [
    {
      key: 'owner-fact-single-readable-source',
      kind: 'fact',
      authority: 'owner_assertion',
      statement: `Owner records the cedar equipment cabinet near the west entrance ${salt}.`,
      evidence: (key) => [evidenceCaseInput(`${key}-source`, '1', 'notes/fact', 'allowed note')],
    },
    {
      key: 'owner-decision-two-supporting-sources',
      kind: 'decision',
      authority: 'owner_decision',
      statement: `Owner decided to store the brass seal in cabinet ${salt}.`,
      context: { decision: { reason: 'restricted access', status: 'confirmed' } },
      evidence: (key) => [
        evidenceCaseInput(`${key}-owner-note`, '1', 'decision/note', 'owner decision'),
        evidenceCaseInput(`${key}-meeting-record`, '1', 'meeting/item', 'meeting record'),
      ],
    },
    {
      key: 'owner-preference-hidden-source-snippet',
      kind: 'preference',
      authority: 'owner_preference',
      statement: `Owner prefers short labels on archive boxes ${salt}.`,
      context: { preference: { applies_to: 'archive labels', confidence: 1 } },
      evidence: (key) => [
        evidenceCaseInput(`${key}-private-note`, '1', 'private/preference', 'must-not-leak', {
          speaker: 'owner',
          snippetAllowed: false,
        }),
      ],
    },
    {
      key: 'asserted-hypothesis-with-uncertainty-context',
      kind: 'hypothesis',
      authority: 'owner_assertion',
      statement: `The north relay may need a second power check after frost ${salt}.`,
      context: { uncertainty: { confidence: 0.4, reason: 'single field observation' } },
      evidence: (key) => [
        evidenceCaseInput(`${key}-source`, '1', 'field/hypothesis', 'field note'),
      ],
    },
    {
      key: 'experience-retains-condition-action-outcome',
      kind: 'experience',
      authority: 'owner_assertion',
      statement: `After frost, the team wrapped the gauge and it stayed dry ${salt}.`,
      context: {
        episode: {
          condition: { weather: 'frost' },
          action: 'wrapped the gauge',
          outcome: 'stayed dry',
        },
      },
      evidence: (key) => [
        evidenceCaseInput(`${key}-source`, '1', 'episode/result', 'episode result'),
      ],
    },
    {
      key: 'procedure-retains-ordered-steps',
      kind: 'procedure',
      authority: 'owner_assertion',
      statement: `During calibration, close valve A before opening the sample line ${salt}.`,
      context: { procedure: { steps: ['close valve A', 'open sample line'] } },
      evidence: (key) => [
        evidenceCaseInput(`${key}-manual`, '1', 'manual/step-8', 'manual step'),
        evidenceCaseInput(`${key}-shift-log`, '1', 'shift/log-9', 'shift log'),
      ],
    },
    {
      key: 'third-party-speaker-attribution',
      kind: 'fact',
      authority: 'owner_assertion',
      statement: `A field technician reported that the amber gauge was dry ${salt}.`,
      context: { claim: { source_role: 'field technician' } },
      evidence: (key) => [
        evidenceCaseInput(`${key}-technician-report`, '1', 'report/entry', 'technician report', {
          speaker: 'field technician',
        }),
      ],
    },
    {
      key: 'decision-revision-has-separate-evidence-snapshots',
      kind: 'decision',
      authority: 'owner_decision',
      statement: `The owner selected the sealed case for winter transport ${salt}.`,
      context: { decision: { valid_for: 'winter transport', status: 'confirmed' } },
      evidence: (key) => [
        evidenceCaseInput(`${key}-decision-record`, '1', 'record/original', 'original decision'),
        evidenceCaseInput(`${key}-decision-record`, '2', 'record/revised', 'revised decision'),
      ],
    },
  ];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const statement = spec.statement;
    const fixtureKey = `${runId}-${spec.key}`;
    const evidence = spec.evidence(fixtureKey);
    const result = await remember(statement, {
      kind: spec.kind,
      context: spec.context ?? {},
      evidence,
      expected_authority: spec.authority,
      category: 'security_rights',
      conversation_order: index,
      summary_group: 'security_rights',
    });
    if (result.authority !== spec.authority)
      throw new Error(`Security fixture ${spec.key} has unexpected authority`);
    rows.push({
      ...result,
      statement,
      fixture_key: spec.key,
      authority: spec.authority,
      conversation_order: index,
      replay_body: result.replay_body,
      replay_key: result.replay_key,
      source_id: result.view.evidence?.[0]?.source_id,
    });
  }
  return rows;
}

async function seedAsyncCaptures() {
  const rows = [];
  const statements = [
    (key) => `The cobalt rain gauge ${key} is stored in the north archive.`,
    (key) => `During the overnight frost, sample ${key} remained stable in its thermal sleeve.`,
    (key) => `Before calibration, technician ${key} closes the northern pressure valve.`,
    (key) => `強風の日は機材 ${key} を倉庫内で固定して転倒を防ぐ。`,
    (key) => `At ten percent battery, the ridge team ${key} returns to the trail marker.`,
    (key) => `For late night deliveries, the cold box ${key} is sealed after the manifest check.`,
  ];
  for (let index = 0; index < 5; index += 1) {
    const fixtureKey = `${runId}-${index}`;
    const statement = statements[index](fixtureKey);
    const captureScope = captureScopes[index];
    const externalId = `eval-capture-${runId}-${index}`;
    const connector = await postJson('/v1/connectors', ownerToken, {
      scope_id: captureScope,
      source_kind: 'chat',
      external_id: externalId,
      enabled: true,
      consent: true,
      metadata: { fixture: 'meaningful-220-v2' },
    });
    assertStatus(connector, 200, `enable capture connector ${index}`);
    const captureRequest = {
      scope_id: captureScope,
      operation_id: `eval-operation-${runId}-${index}`,
      source: { kind: 'chat', external_id: externalId, revision: '1' },
      observations: [{ locator: `message/${index}`, content: statement, speaker: 'owner' }],
    };
    const captureIdempotencyKey = `eval-capture-key-${runId}-${index}`;
    const capture = await postJson('/v1/captures', ownerToken, captureRequest, {
      idempotencyKey: captureIdempotencyKey,
    });
    assertStatus(capture, 202, `submit capture ${index}`);
    const jobId = capture.body.job_id;
    const terminal = await waitForCapture(jobId, ownerToken);
    if (terminal.status !== 'committed')
      throw new Error(`Local capture ${index} ended in ${terminal.status}`);
    const id = terminal.memory_ids?.[0] ?? terminal.result?.memory_ids?.[0] ?? null;
    const recalled = await postJson('/v1/recall', ownerToken, {
      query: statement,
      scope_ids: [captureScope],
      mode: 'precise',
    });
    assertStatus(recalled, 200, `capture recall ${index}`);
    const memory = recalled.body.matches?.find((candidate) => candidate.statement === statement);
    const memoryId = id ?? memory?.id;
    if (!memoryId) throw new Error(`Committed capture ${index} produced no recallable memory`);
    const expectedAuthority = 'ai_proposal';
    fixtures.push({
      category: 'async_capture',
      summary_group: 'async_capture',
      statement,
      id: memoryId,
      authority: expectedAuthority,
      conversation_order: index,
      summary_window_retained: index < 4,
      scope_id: captureScope,
    });
    rows.push({
      id: memoryId,
      scope_id: captureScope,
      job_id: jobId,
      statement,
      authority: expectedAuthority,
      status: terminal.status,
      conversation_order: index,
      capture_request: captureRequest,
      capture_idempotency_key: captureIdempotencyKey,
    });
  }

  const heldScope = captureScopes[5];
  const preexisting = await remember('The rain gauge rests in the north archive.', {
    kind: 'fact',
    category: 'async_capture_hold_context',
    summary_group: 'async_capture_hold_context',
    scope_id: heldScope,
  });
  const heldStatement = `The cobalt rain gauge ${runId}-held is stored in the north archive.`;
  const heldExternalId = `eval-capture-${runId}-held`;
  const heldConnector = await postJson('/v1/connectors', ownerToken, {
    scope_id: heldScope,
    source_kind: 'chat',
    external_id: heldExternalId,
    enabled: true,
    consent: true,
    metadata: { fixture: 'meaningful-220-v2' },
  });
  assertStatus(heldConnector, 200, 'enable held capture connector');
  const heldRequest = {
    scope_id: heldScope,
    operation_id: `eval-operation-${runId}-held`,
    source: { kind: 'chat', external_id: heldExternalId, revision: '1' },
    observations: [{ locator: 'message/held', content: heldStatement, speaker: 'owner' }],
  };
  const heldKey = `eval-capture-key-${runId}-held`;
  const heldCapture = await postJson('/v1/captures', ownerToken, heldRequest, {
    idempotencyKey: heldKey,
  });
  assertStatus(heldCapture, 202, 'submit candidate-matched chat capture');
  const heldJobId = heldCapture.body.job_id;
  const heldTerminal = await waitForCapture(heldJobId, ownerToken);
  if (heldTerminal.status !== 'held')
    throw new Error(
      `Candidate-matched chat capture ended in ${heldTerminal.status}, expected held`,
    );
  const reviewList = await getJson(
    `/v1/review?scope_id=${encodeURIComponent(heldScope)}&status=held&limit=20`,
    ownerToken,
  );
  assertStatus(reviewList, 200, 'read candidate-matched chat review');
  const review = (reviewList.body.reviews ?? []).find((candidate) => {
    const summary = candidate.candidate_summary;
    return (
      candidate.reason_codes?.includes('existing_memory_requires_reconciliation') === true &&
      summary?.candidates?.some((item) => item.statement === heldStatement) === true
    );
  });
  if (review === undefined)
    throw new Error('Candidate-matched chat capture did not expose its held review reason');
  rows.push({
    held: true,
    scope_id: heldScope,
    id: null,
    existing_id: preexisting.id,
    existing_authority: preexisting.authority,
    job_id: heldJobId,
    statement: heldStatement,
    held_statement: heldStatement,
    authority: 'ai_proposal',
    status: heldTerminal.status,
    conversation_order: 6,
    capture_request: heldRequest,
    capture_idempotency_key: heldKey,
    held_reason_code: 'existing_memory_requires_reconciliation',
  });
  return rows;
}

function addTemporalCases(rows) {
  for (const row of rows)
    for (const test of row.tests)
      addCase('temporal_rename', `temporal-${row.scenario}-${test.name}`, {
        op: 'recall',
        token: ownerToken,
        query: test.query,
        mode: test.known_at === undefined ? 'precise' : 'historical',
        valid_at: test.valid_at,
        known_at: test.known_at,
        limit: test.limit ?? Math.max(1, test.expected.length),
        expected_memory_ids: test.expected,
        expected_authorities: test.expected.map((id) =>
          [row.id].includes(id) ? row.authority : 'owner_assertion',
        ),
        expected_time: {
          valid_at: test.valid_at ?? null,
          known_at: test.known_at ?? null,
          selected_valid_from: test.selected_valid_from ?? null,
        },
        expected_rights: 'granted',
        expected_unknown: test.expected.length === 0,
        fixture_id: row.id,
        conversation_index: row.tests.indexOf(test),
        baseline_question:
          test.name === 'canonical-name-current' || test.name === 'both-records-overlap',
      });
}

function addAuthorityCases(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const candidate = row.epistemic_status === 'proposed';
    const variants = [
      { name: 'owner-precise', token: ownerToken, mode: 'precise', visible: !candidate },
      { name: 'owner-exploratory', token: ownerToken, mode: 'exploratory', visible: true },
      { name: 'reader-precise', token: readerToken, mode: 'precise', visible: !candidate },
      { name: 'reader-exploratory', token: readerToken, mode: 'exploratory', visible: true },
      {
        name: 'known-time-after-record',
        token: ownerToken,
        mode: 'historical',
        known_at: '2099-01-01T00:00:00.000Z',
        visible: !candidate,
      },
    ];
    for (const variant of variants) {
      const expected = variant.visible ? [row.id] : [];
      addCase('authority', `authority-${index + 1}-${variant.name}`, {
        op: 'recall',
        token: variant.token,
        query: row.statement,
        mode: variant.mode,
        known_at: variant.known_at,
        expected_memory_ids: expected,
        expected_authorities: expected.length ? [row.authority] : [],
        expected_time: {
          valid_at: null,
          known_at: variant.known_at ?? null,
          selected_valid_from: null,
        },
        expected_rights: 'granted',
        expected_unknown: expected.length === 0,
        fixture_id: row.id,
        conversation_index: row.conversation_order,
      });
    }
    if (index === 4) {
      addCase('authority', 'authority-5-above-lexical-threshold-contextual', {
        op: 'recall',
        token: ownerToken,
        query: 'amber valve stays closed during maintenance',
        mode: 'contextual',
        expected_memory_ids: [row.id],
        expected_authorities: [row.authority],
        expected_time: { valid_at: null, known_at: null, selected_valid_from: null },
        expected_rights: 'granted',
        expected_unknown: false,
        fixture_id: row.id,
        conversation_index: row.conversation_order,
        baseline_question: true,
      });
    }
  }
}

function addEvidenceCases(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const variants = [
      {
        name: 'precise-independent-sources',
        op: 'recall',
        mode: 'precise',
        baseline_question: true,
      },
      { name: 'get-preserves-source-identity', op: 'get' },
      { name: 'idempotency-replay-stable', op: 'evidence_replay' },
      { name: 'independent-source-count', op: 'evidence_count' },
      { name: 'revision-evidence-snapshot', op: 'evidence_snapshot' },
    ];
    for (const variant of variants)
      addCase('independent_evidence', `evidence-${row.fixture_key}-${variant.name}`, {
        op: variant.op,
        token: ownerToken,
        memory_id: row.id,
        query: row.statement,
        mode: variant.mode,
        replay_body: row.replay_body,
        replay_key: row.replay_key,
        initial_change_set_id: row.initial_change_set_id,
        expected_memory_ids: [row.id],
        expected_authorities: [row.authority],
        expected_time: {
          valid_at: null,
          known_at: null,
          selected_valid_from: null,
        },
        expected_evidence_count: row.evidence_count,
        expected_replay_match: variant.op === 'evidence_replay',
        expected_evidence_source_count: row.source_count,
        expected_evidence_lineage_count: row.lineage_count,
        expected_visible_snippet: row.expected_visible_snippet,
        expected_hidden_snippet: row.expected_hidden_snippet,
        expected_revision: row.expected_revision,
        expected_rights: 'granted',
        expected_unknown: false,
        fixture_id: row.id,
        conversation_index: row.conversation_order,
        baseline_question: variant.baseline_question === true,
      });
  }
}

function addUnknownCases() {
  const variants = [
    [
      'full-sentence',
      (key) => `No record: the ${key} telescope was stored in a hidden observatory.`,
    ],
    ['short-phrase', (key) => `unknown ${key}`],
    ['japanese', (key) => `未記録の観測所には${key}色の望遠鏡がある`],
    ['near-miss', (key) => `The observatory telescope key is ${key}x, not ${key}.`],
    [
      'contradictory-claim',
      (key) => `No owner ever confirmed that the ${key} observatory telescope exists.`,
    ],
  ];
  for (let index = 0; index < 6; index += 1)
    for (const [name, makeQuery] of variants) {
      const key = `qx${salt}${index}${name.replaceAll('-', '')}`;
      const query = makeQuery(key);
      addCase('unknown_abstention', `unknown-${index + 1}-${name}`, {
        op: 'recall',
        token: ownerToken,
        query,
        mode: 'precise',
        expected_memory_ids: [],
        expected_authorities: [],
        expected_time: { valid_at: null, known_at: null, selected_valid_from: null },
        expected_rights: 'granted',
        expected_unknown: true,
        baseline_question: true,
      });
    }
}

function addExperienceCases(rows) {
  const variants = [
    {
      name: 'sufficient-budget-recall',
      op: 'recall',
      mode: 'precise',
      token_budget: 32000,
      baseline_question: true,
    },
    {
      name: 'budget-below-required-envelope-rejected',
      op: 'recall',
      mode: 'precise',
      token_budget: 64,
      expected_status: 400,
      expected_error_code: 'token_budget_too_small',
    },
    {
      name: 'historical-known-time',
      op: 'recall',
      mode: 'historical',
      token_budget: 32000,
      historical: true,
    },
    { name: 'bounded-context-pack', op: 'recall', mode: 'precise', token_budget: 32000 },
    { name: 'get-complete-episode', op: 'get' },
  ];
  for (let index = 0; index < rows.length; index += 1)
    for (const variant of variants) {
      const row = rows[index];
      const expectsEnvelopeRejection = variant.expected_status === 400;
      const expected = expectsEnvelopeRejection ? [] : [row.id];
      addCase('experience_procedure', `experience-${index + 1}-${variant.name}`, {
        op: variant.op,
        token: ownerToken,
        memory_id: row.id,
        query: row.statement,
        mode: variant.mode,
        token_budget: variant.token_budget,
        known_at: variant.historical ? '2099-01-01T00:00:00.000Z' : undefined,
        expected_memory_ids: expected,
        expected_authorities: expected.length ? [row.authority] : [],
        expected_time: {
          valid_at: null,
          known_at: variant.historical ? '2099-01-01T00:00:00.000Z' : null,
          selected_valid_from: null,
        },
        expected_context: expected.length ? row.context : undefined,
        expected_rights: 'granted',
        expected_status: variant.expected_status,
        expected_error_code: variant.expected_error_code,
        expected_unknown: expectsEnvelopeRejection ? null : false,
        fixture_id: row.id,
        conversation_index: row.conversation_order,
        baseline_question: variant.baseline_question === true,
      });
    }
}

function addSecurityCases(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    addCase('security_rights', `security-${row.fixture_key}-reader-recall`, {
      op: 'recall',
      token: readerToken,
      query: row.statement,
      mode: 'precise',
      expected_memory_ids: [row.id],
      expected_authorities: [row.authority],
      expected_time: noTime(),
      expected_rights: 'granted',
      expected_unknown: false,
      fixture_id: row.id,
    });
    addCase('security_rights', `security-${row.fixture_key}-reader-get`, {
      op: 'get',
      token: readerToken,
      memory_id: row.id,
      expected_memory_ids: [row.id],
      expected_authorities: [row.authority],
      expected_time: noTime(),
      expected_rights: 'granted',
      expected_unknown: false,
      fixture_id: row.id,
    });
    addCase('security_rights', `security-${row.fixture_key}-reader-write-denied`, {
      op: 'write_denied',
      token: readerToken,
      statement: `Read-only write probe ${salt}-${index} must not persist.`,
      expected_memory_ids: [],
      expected_authorities: [],
      expected_time: null,
      expected_rights: 'denied',
      expected_unknown: null,
    });
    addCase('security_rights', `security-${row.fixture_key}-ungranted-scope-denied`, {
      op: 'scope_denied',
      token: readerToken,
      query: row.statement,
      other_scope: randomUUID(),
      expected_memory_ids: [],
      expected_authorities: [],
      expected_time: null,
      expected_rights: 'denied',
      expected_unknown: null,
    });
    addCase('security_rights', `security-${row.fixture_key}-wrong-audience-denied`, {
      op: 'audience_denied',
      token: wrongAudienceToken,
      query: row.statement,
      expected_memory_ids: [],
      expected_authorities: [],
      expected_time: null,
      expected_rights: 'denied',
      expected_unknown: null,
    });
  }

  const forget = rows.at(-1);
  const aclProbe = rows[0];
  addCase('security_rights', 'acl-owner-revokes-reader-grant', {
    op: 'revoke_reader',
    token: ownerToken,
    principal_id: '44444444-4444-4444-8444-444444444444',
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: noTime(),
    expected_rights: 'granted',
    expected_unknown: null,
    expected_status: 200,
  });
  addCase('security_rights', 'acl-revoked-reader-cannot-get', {
    op: 'get',
    token: readerToken,
    memory_id: aclProbe.id,
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: null,
    expected_rights: 'denied',
    expected_unknown: null,
    expected_status: 403,
    expected_error_code: 'forbidden',
  });
  addCase('security_rights', 'acl-revoked-reader-cannot-recall', {
    op: 'recall',
    token: readerToken,
    query: aclProbe.statement,
    mode: 'precise',
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: null,
    expected_rights: 'denied',
    expected_unknown: null,
    expected_status: 403,
    expected_error_code: 'forbidden',
  });
  addCase('security_rights', 'forget-immediately-suppresses-memory-and-source', {
    op: 'forget_request',
    token: ownerToken,
    memory_id: forget.id,
    statement: forget.statement,
    source_id: forget.source_id,
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: noTime(),
    expected_rights: 'granted',
    expected_unknown: null,
    expected_status: 202,
  });
  addCase('security_rights', 'forget-target-is-hidden-from-get', {
    op: 'get',
    token: ownerToken,
    memory_id: forget.id,
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: null,
    expected_rights: 'granted',
    expected_unknown: null,
    expected_status: 404,
    expected_error_code: 'not_found',
  });
  addCase('security_rights', 'forget-target-is-unknown-to-recall', {
    op: 'recall',
    token: ownerToken,
    query: forget.statement,
    mode: 'precise',
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: noTime(),
    expected_rights: 'granted',
    expected_unknown: true,
  });
  addCase('security_rights', 'forget-status-does-not-expose-content', {
    op: 'forget_status',
    token: ownerToken,
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: noTime(),
    expected_rights: 'granted',
    expected_unknown: null,
    expected_status: 200,
  });
  addCase('security_rights', 'forget-idempotent-replay-keeps-tombstone', {
    op: 'forget_replay',
    token: ownerToken,
    memory_id: forget.id,
    statement: forget.statement,
    source_id: forget.source_id,
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: noTime(),
    expected_rights: 'granted',
    expected_unknown: null,
    expected_status: 202,
  });
  addCase('security_rights', 'forgotten-remember-replay-does-not-restore-content', {
    op: 'remember_replay_after_forget',
    token: ownerToken,
    memory_id: forget.id,
    replay_body: forget.replay_body,
    replay_key: forget.replay_key,
    expected_memory_ids: [forget.id],
    expected_authorities: [],
    expected_time: noTime(),
    expected_rights: 'granted',
    expected_unknown: null,
    expected_status: 200,
  });
  addCase('security_rights', 'source-reimport-after-forget-is-denied', {
    op: 'remember_denied_after_forget',
    token: ownerToken,
    memory_id: forget.id,
    replay_body: forget.replay_body,
    expected_memory_ids: [],
    expected_authorities: [],
    expected_time: null,
    expected_rights: 'denied',
    expected_unknown: null,
    expected_status: 403,
    expected_error_code: 'source_suppressed',
  });
}

function addAsyncCases(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const variants = row.held
      ? [
          { name: 'candidate-is-held', op: 'capture_status' },
          { name: 'review-explains-match', op: 'capture_review' },
          { name: 'preexisting-memory-unchanged', op: 'get_existing' },
          { name: 'same-key-replays-held-job', op: 'capture_replay' },
          { name: 'change-feed-keeps-existing-memory', op: 'changes' },
        ]
      : [
          { name: 'job-reaches-committed', op: 'capture_status' },
          {
            name: 'committed-memory-readable',
            op: 'recall',
            mode: 'precise',
            baseline_question: true,
          },
          { name: 'captured-evidence-readable', op: 'get' },
          { name: 'same-key-replays-same-job', op: 'capture_replay' },
          { name: 'change-feed-publishes-memory', op: 'changes' },
        ];
    for (const variant of variants) {
      const memoryId = row.held ? row.existing_id : row.id;
      const expectedAuthority = row.held ? row.existing_authority : row.authority;
      const readingMemory = ['recall', 'get', 'get_existing'].includes(variant.op);
      addCase('async_capture', `async-${index + 1}-${variant.name}`, {
        op: variant.op,
        token: ownerToken,
        scope_id: row.scope_id,
        memory_id: memoryId,
        job_id: row.job_id,
        query: row.statement,
        mode: variant.mode,
        capture_request: row.capture_request,
        capture_idempotency_key: row.capture_idempotency_key,
        expected_memory_ids:
          variant.op === 'capture_status' ||
          variant.op === 'capture_review' ||
          variant.op === 'capture_replay'
            ? []
            : [memoryId],
        expected_authorities: readingMemory ? [expectedAuthority] : [],
        expected_time: {
          valid_at: null,
          known_at: null,
          selected_valid_from: null,
        },
        ...(variant.op === 'capture_status' ? { expected_capture_status: row.status } : {}),
        ...(variant.op === 'capture_review'
          ? {
              expected_review_reason: row.held_reason_code,
              expected_review_statement: row.held_statement,
            }
          : {}),
        expected_rights: 'granted',
        expected_unknown: variant.op === 'recall' ? false : null,
        expected_status: variant.op === 'capture_replay' ? 202 : 200,
        fixture_id: variant.op === 'recall' || variant.op === 'get' ? row.id : null,
        conversation_index: row.conversation_order,
        baseline_question: variant.baseline_question === true,
      });
    }
  }
}

async function runCase(testCase) {
  const requestStarted = performance.now();
  let status;
  let actualErrorCode;
  let actualRevision;
  let actualContextPackBytes;
  let estimatedTokens;
  let actualIds = [];
  let authorities = [];
  let actualUnknown = null;
  let evidenceRows = [];
  let contextPacks = [];
  let actualContexts = [];
  let actualTimes = [];
  let captureStatus;
  let reviewReasonMatches;
  let forgetContentAvailable;
  let forgetReplayMatches;
  let rememberedContentAfterForget;
  let revokedGrantState;
  if (testCase.op === 'recall') {
    const requestedScope = testCase.scope_id ?? scope;
    const response = await postJson('/v1/recall', testCase.token, {
      query: testCase.query,
      scope_ids: [requestedScope],
      mode: testCase.mode,
      token_budget: testCase.token_budget ?? 4000,
      limit: testCase.limit ?? 1,
      ...(testCase.valid_at === undefined ? {} : { valid_at: testCase.valid_at }),
      ...(testCase.known_at === undefined ? {} : { known_at: testCase.known_at }),
    });
    status = response.status;
    actualErrorCode = response.body.error?.code;
    actualIds = (response.body.matches ?? []).map((memory) => memory.id).sort();
    authorities = (response.body.matches ?? [])
      .map((memory) => memory.attribution?.authority)
      .filter(Boolean);
    actualTimes = (response.body.matches ?? []).map((memory) => memory.time ?? null);
    actualRevision = response.body.matches?.find(
      (memory) => memory.id === testCase.fixture_id,
    )?.revision;
    actualUnknown = response.body.unknown;
    evidenceRows =
      response.body.matches?.find((memory) => memory.id === testCase.fixture_id)?.evidence ?? [];
    actualContexts =
      response.body.matches
        ?.filter((memory) => memory.id === testCase.fixture_id)
        .map((memory) => memory.context) ?? [];
    contextPacks = [response.body.context_pack ?? {}];
    if (response.body.context_pack !== undefined) {
      actualContextPackBytes = Buffer.byteLength(
        JSON.stringify(response.body.context_pack),
        'utf8',
      );
      estimatedTokens = response.body.estimated_tokens;
    }
  } else if (testCase.op === 'get') {
    const response = await getMemory(
      testCase.memory_id,
      testCase.token,
      testCase.scope_id ?? scope,
    );
    status = response.status;
    actualErrorCode = response.body.error?.code;
    if (response.status === 200) {
      actualRevision = response.body.revision;
      actualIds = [response.body.id];
      authorities = [response.body.attribution?.authority].filter(Boolean);
      actualTimes = [response.body.time ?? null];
      evidenceRows = response.body.evidence ?? [];
      actualContexts = [response.body.context ?? {}];
      actualUnknown = false;
    }
  } else if (testCase.op === 'evidence_replay') {
    const response = await postJson('/v1/memories:remember', testCase.token, testCase.replay_body, {
      idempotencyKey: testCase.replay_key,
    });
    status = response.status;
    if (status === 200) {
      actualIds = [memoryId(response.body)];
      testCase.replayed_same_change_set =
        response.body.change_set_id === testCase.initial_change_set_id;
      const view = await getMemory(testCase.memory_id, testCase.token, testCase.scope_id ?? scope);
      if (view.status === 200) {
        actualRevision = view.body.revision;
        authorities = [view.body.attribution?.authority].filter(Boolean);
        evidenceRows = view.body.evidence ?? [];
        actualTimes = [view.body.time ?? null];
      }
      testCase.replayed_same_change_set = testCase.replayed_same_change_set && view.status === 200;
      actualUnknown = false;
    }
  } else if (testCase.op === 'evidence_count' || testCase.op === 'evidence_snapshot') {
    const response = await getMemory(
      testCase.memory_id,
      testCase.token,
      testCase.scope_id ?? scope,
    );
    status = response.status;
    if (status === 200) {
      actualRevision = response.body.revision;
      actualIds = [response.body.id];
      authorities = [response.body.attribution?.authority].filter(Boolean);
      evidenceRows = response.body.evidence ?? [];
      actualUnknown = false;
      if (testCase.op === 'evidence_snapshot')
        testCase.evidence_snapshot_valid =
          actualRevision === testCase.expected_revision &&
          evidenceRows.length === testCase.expected_evidence_count &&
          new Set(evidenceRows.map((row) => row.source_id)).size ===
            testCase.expected_evidence_source_count &&
          new Set(evidenceRows.map((row) => row.lineage_root ?? row.source_id)).size ===
            testCase.expected_evidence_lineage_count;
    }
  } else if (testCase.op === 'revoke_reader') {
    const response = await fetch(`${api}/v1/scopes/${scope}/grants`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${testCase.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ principal_id: testCase.principal_id, revoke: true }),
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
    const body = await readBody(response);
    revokedGrantState = body.state;
  } else if (testCase.op === 'forget_request') {
    activeForgetBody = {
      scope_id: scope,
      selector: { memory_ids: [testCase.memory_id], source_ids: [testCase.source_id] },
      reason_code: 'user_requested',
    };
    activeForgetIdempotencyKey = `eval-forget-${runId}`;
    const response = await postJson('/v1/forget', testCase.token, activeForgetBody, {
      idempotencyKey: activeForgetIdempotencyKey,
    });
    status = response.status;
    actualErrorCode = response.body.error?.code;
    activeForgetRequestId = response.body.forget_request_id;
  } else if (testCase.op === 'forget_status') {
    const response = await getJson(
      `/v1/forget/${activeForgetRequestId}?scope_id=${encodeURIComponent(scope)}`,
      testCase.token,
    );
    status = response.status;
    actualErrorCode = response.body.error?.code;
    forgetContentAvailable = response.body.content_available;
  } else if (testCase.op === 'forget_replay') {
    const response = await postJson('/v1/forget', testCase.token, activeForgetBody, {
      idempotencyKey: activeForgetIdempotencyKey,
    });
    status = response.status;
    actualErrorCode = response.body.error?.code;
    forgetReplayMatches = response.body.forget_request_id === activeForgetRequestId;
  } else if (testCase.op === 'remember_replay_after_forget') {
    const response = await postJson('/v1/memories:remember', testCase.token, testCase.replay_body, {
      idempotencyKey: testCase.replay_key,
    });
    status = response.status;
    actualErrorCode = response.body.error?.code;
    if (status === 200) {
      actualIds = [memoryId(response.body)];
      const view = await getMemory(testCase.memory_id, testCase.token);
      rememberedContentAfterForget = view.status === 404;
    }
  } else if (testCase.op === 'remember_denied_after_forget') {
    const response = await postJson('/v1/memories:remember', testCase.token, testCase.replay_body, {
      idempotencyKey: `eval-forgotten-reimport-${runId}`,
    });
    status = response.status;
    actualErrorCode = response.body.error?.code;
  } else if (testCase.op === 'capture_status') {
    const response = await fetch(`${api}/v1/captures/${testCase.job_id}`, {
      headers: { authorization: `Bearer ${testCase.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
    const body = await readBody(response);
    captureStatus = body.status;
    actualIds = [];
    actualUnknown = false;
  } else if (testCase.op === 'capture_replay') {
    const response = await postJson('/v1/captures', testCase.token, testCase.capture_request, {
      idempotencyKey: testCase.capture_idempotency_key,
    });
    status = response.status;
    actualIds = [];
    testCase.capture_replay_matches_job = response.body.job_id === testCase.job_id;
    actualUnknown = false;
  } else if (testCase.op === 'capture_review') {
    const response = await getJson(
      `/v1/review?scope_id=${encodeURIComponent(testCase.scope_id)}&status=held&limit=20`,
      testCase.token,
    );
    status = response.status;
    reviewReasonMatches = (response.body.reviews ?? []).some((candidate) => {
      const summary = candidate.candidate_summary;
      return (
        candidate.reason_codes?.includes(testCase.expected_review_reason) === true &&
        summary?.candidates?.some(
          (item) => item.statement === testCase.expected_review_statement,
        ) === true
      );
    });
  } else if (testCase.op === 'get_existing') {
    const response = await getMemory(testCase.memory_id, testCase.token, testCase.scope_id);
    status = response.status;
    if (status === 200) {
      actualIds = [response.body.id];
      authorities = [response.body.attribution?.authority].filter(Boolean);
      actualTimes = [response.body.time ?? null];
      actualUnknown = false;
    }
  } else if (testCase.op === 'changes') {
    const response = await getJson(
      `/v1/changes?scope_ids=${encodeURIComponent(testCase.scope_id ?? scope)}&limit=100`,
      testCase.token,
    );
    status = response.status;
    actualIds = (response.body.changes ?? [])
      .map((change) => change.memory_id)
      .filter((id) => id === testCase.memory_id);
    actualUnknown = false;
  } else if (testCase.op === 'write_denied') {
    const response = await postJson(
      '/v1/memories:remember',
      testCase.token,
      {
        scope_id: scope,
        memory: {
          kind: 'fact',
          statement: testCase.statement,
          context: {},
          subjects: [],
          evidence: [evidenceInput(`security-${runId}-${testCase.case_id}`, testCase.statement)],
        },
      },
      { idempotencyKey: `security-${runId}-${testCase.case_id}` },
    );
    status = response.status;
    actualErrorCode = response.body.error?.code;
  } else if (testCase.op === 'scope_denied') {
    const response = await postJson('/v1/recall', testCase.token, {
      query: testCase.query,
      scope_ids: [testCase.other_scope],
      mode: 'precise',
    });
    status = response.status;
    actualErrorCode = response.body.error?.code;
  } else if (testCase.op === 'audience_denied') {
    const response = await postJson('/v1/recall', testCase.token, {
      query: testCase.query,
      scope_ids: [scope],
      mode: 'precise',
    });
    status = response.status;
    actualErrorCode = response.body.error?.code;
  }

  const expectedStatus =
    testCase.expected_status ??
    (testCase.expected_rights === 'denied' ? (testCase.op === 'audience_denied' ? 401 : 403) : 200);
  const idsEqual = sameStrings(actualIds, [...testCase.expected_memory_ids].sort());
  const unknownEqual = actualUnknown === testCase.expected_unknown;
  const expectedAuthoritySet = new Set(testCase.expected_authorities);
  const actualAuthoritySet = new Set(authorities);
  const authorityEqual =
    expectedAuthoritySet.size === actualAuthoritySet.size &&
    [...expectedAuthoritySet].every((value) => actualAuthoritySet.has(value));
  const rightsEqual = status === expectedStatus;
  const errorCodeEqual =
    testCase.expected_error_code === undefined || actualErrorCode === testCase.expected_error_code;
  const revisionEqual =
    testCase.expected_revision === undefined || actualRevision === testCase.expected_revision;
  const evidenceEqual =
    testCase.expected_evidence_count === undefined ||
    (evidenceRows.length === testCase.expected_evidence_count &&
      new Set(evidenceRows.map((row) => row.source_id)).size ===
        (testCase.expected_evidence_source_count ?? testCase.expected_evidence_count) &&
      new Set(evidenceRows.map((row) => row.lineage_root ?? row.source_id)).size ===
        (testCase.expected_evidence_lineage_count ?? testCase.expected_evidence_count));
  const evidenceSnippets = evidenceRows
    .map((row) => row.snippet)
    .filter((snippet) => typeof snippet === 'string');
  const evidencePrivacyEqual =
    (testCase.expected_visible_snippet === undefined ||
      evidenceSnippets.includes(testCase.expected_visible_snippet)) &&
    (testCase.expected_hidden_snippet === undefined ||
      evidenceSnippets.every((snippet) => !snippet.includes(testCase.expected_hidden_snippet)));
  const contextEqual =
    testCase.expected_context === undefined ||
    actualContexts.some((context) => isDeepStrictEqual(context, testCase.expected_context));
  const insufficiencyEqual =
    testCase.expected_insufficiency === undefined ||
    contextPacks.some((context) =>
      (context.insufficiencies ?? []).includes(testCase.expected_insufficiency),
    );
  const expectedStart = testCase.expected_time?.selected_valid_from;
  const actualStarts = actualTimes.map((time) => time?.valid_from ?? null).sort();
  const timeEqual =
    expectedStart === undefined || expectedStart === null
      ? actualStarts.every((time) => time === null)
      : Array.isArray(expectedStart)
        ? sameStrings(actualStarts, [...expectedStart].sort())
        : actualStarts.includes(expectedStart);
  const pass =
    rightsEqual &&
    errorCodeEqual &&
    revisionEqual &&
    idsEqual &&
    (testCase.expected_unknown === null || unknownEqual) &&
    authorityEqual &&
    evidenceEqual &&
    evidencePrivacyEqual &&
    contextEqual &&
    insufficiencyEqual &&
    testCase.capture_replay_matches_job !== false &&
    (testCase.expected_review_reason === undefined || reviewReasonMatches === true) &&
    (testCase.expected_replay_match !== true || testCase.replayed_same_change_set === true) &&
    (testCase.op !== 'revoke_reader' || revokedGrantState === 'revoked') &&
    (testCase.op !== 'forget_status' || forgetContentAvailable === false) &&
    (testCase.op !== 'forget_replay' || forgetReplayMatches === true) &&
    (testCase.op !== 'remember_replay_after_forget' || rememberedContentAfterForget === true) &&
    (testCase.op !== 'evidence_snapshot' || testCase.evidence_snapshot_valid === true) &&
    (captureStatus === undefined || captureStatus === testCase.expected_capture_status) &&
    timeEqual &&
    true;
  const assertions = [
    `rights/status expected ${testCase.expected_rights}/${expectedStatus}, got ${status}`,
    ...(testCase.expected_error_code === undefined
      ? []
      : [`error code=${actualErrorCode}, expected=${testCase.expected_error_code}`]),
    ...(testCase.expected_revision === undefined
      ? []
      : [`revision=${actualRevision}, expected=${testCase.expected_revision}`]),
    `memory IDs ${idsEqual ? 'match' : 'differ'}`,
    `authority ${authorityEqual ? 'matches' : 'differs'}`,
    `selected valid-time ${timeEqual ? 'matches' : 'differs'}`,
    ...(testCase.expected_unknown === null
      ? []
      : [`unknown=${actualUnknown}, expected=${testCase.expected_unknown}`]),
    ...(testCase.expected_evidence_count === undefined
      ? []
      : [
          `evidence rows=${evidenceRows.length}, sources=${new Set(evidenceRows.map((row) => row.source_id)).size}, lineages=${new Set(evidenceRows.map((row) => row.lineage_root ?? row.source_id)).size}`,
        ]),
    ...(testCase.expected_visible_snippet === undefined &&
    testCase.expected_hidden_snippet === undefined
      ? []
      : [`evidence snippets ${evidencePrivacyEqual ? 'respect' : 'violate'} snippet rights`]),
    ...(testCase.expected_context === undefined
      ? []
      : [`experience context ${contextEqual ? 'matches' : 'differs'}`]),
    ...(testCase.expected_insufficiency === undefined
      ? []
      : [`budget insufficiency ${insufficiencyEqual ? 'reported' : 'missing'}`]),
    ...(testCase.expected_capture_status === undefined
      ? []
      : [`capture status=${captureStatus}, expected=${testCase.expected_capture_status}`]),
    ...(testCase.capture_replay_matches_job === undefined
      ? []
      : [`capture replay same job=${testCase.capture_replay_matches_job}`]),
    ...(testCase.expected_review_reason === undefined
      ? []
      : [`held review reason matches=${reviewReasonMatches}`]),
    ...(testCase.op !== 'evidence_snapshot'
      ? []
      : [`revision evidence snapshot valid=${testCase.evidence_snapshot_valid}`]),
    ...(testCase.replayed_same_change_set === undefined
      ? []
      : [`idempotent replay same commit=${testCase.replayed_same_change_set}`]),
    ...(testCase.op !== 'revoke_reader' ? [] : [`reader grant state=${revokedGrantState}`]),
    ...(testCase.op !== 'forget_status'
      ? []
      : [`forget status content_available=${forgetContentAvailable}`]),
    ...(testCase.op !== 'forget_replay'
      ? []
      : [`forget replay retained request=${forgetReplayMatches}`]),
    ...(testCase.op !== 'remember_replay_after_forget'
      ? []
      : [`remember replay content remained hidden=${rememberedContentAfterForget}`]),
  ];
  return {
    passed: pass,
    status,
    actual_ids: actualIds,
    actual_authorities: [...actualAuthoritySet],
    actual_unknown: actualUnknown,
    actual_rights: rightsEqual ? testCase.expected_rights : status >= 400 ? 'denied' : 'granted',
    actual_time: actualTimes,
    actual_revision: actualRevision,
    actual_evidence_count: evidenceRows.length,
    actual_evidence_source_count: new Set(evidenceRows.map((row) => row.source_id)).size,
    actual_evidence_lineage_count: new Set(
      evidenceRows.map((row) => row.lineage_root ?? row.source_id),
    ).size,
    evidence_privacy_passed: evidencePrivacyEqual,
    actual_error_code: actualErrorCode,
    actual_context_pack_bytes: actualContextPackBytes,
    estimated_context_tokens: estimatedTokens,
    case_wall_ms: Number((performance.now() - requestStarted).toFixed(3)),
    forget_content_available: forgetContentAvailable,
    forget_replay_matches: forgetReplayMatches,
    remembered_content_after_forget: rememberedContentAfterForget,
    revoked_grant_state: revokedGrantState,
    capture_status: captureStatus,
    review_reason_matches: reviewReasonMatches,
    assertions,
  };
}

function addCase(category, caseId, fields) {
  const summaryWindowRetained =
    fields.conversation_index === undefined || fields.conversation_index < 4;
  const { token, ...safeFields } = fields;
  const testCase = {
    case_id: caseId,
    category,
    scope_id: fields.scope_id ?? scope,
    summary_group: fields.summary_group ?? category,
    fixture_id: fields.fixture_id ?? null,
    query: fields.query ?? null,
    operation: fields.op,
    mode: fields.mode ?? null,
    expected_memory_ids: fields.expected_memory_ids,
    expected_authority: fields.expected_authorities,
    expected_time: fields.expected_time,
    expected_rights: fields.expected_rights,
    expected_unknown: fields.expected_unknown,
    ...(fields.expected_evidence_count === undefined
      ? {}
      : { expected_evidence_count: fields.expected_evidence_count }),
    ...(fields.expected_capture_status === undefined
      ? {}
      : { expected_capture_status: fields.expected_capture_status }),
    summary_window_retained: summaryWindowRetained,
    ...safeFields,
  };
  Object.defineProperty(testCase, 'token', { value: token, enumerable: false });
  cases.push(testCase);
}

async function remember(statement, details = {}) {
  const evidence = [evidenceInput(`eval-source-${runId}-${randomUUID()}`, statement)];
  const {
    category: fixtureCategory,
    summary_group: summaryGroup,
    conversation_order: conversationOrder,
    scope_id: requestedScope = scope,
    expected_authority: expectedAuthority,
    evidence: suppliedEvidence,
    ...memoryDetails
  } = details;
  const memory = {
    kind: 'fact',
    statement,
    context: {},
    subjects: [],
    ...memoryDetails,
    evidence: suppliedEvidence ?? evidence,
  };
  const idempotencyKey = `eval-remember-${runId}-${randomUUID()}`;
  const replayBody = { scope_id: requestedScope, memory };
  const response = await postJson('/v1/memories:remember', ownerToken, replayBody, {
    idempotencyKey,
  });
  assertStatus(response, 200, 'Remember fixture');
  const id = memoryId(response.body);
  const view = await getMemory(id, ownerToken, requestedScope);
  assertStatus(view, 200, `Get fixture ${id}`);
  const authority = view.body.attribution?.authority;
  if (expectedAuthority !== undefined && authority !== expectedAuthority)
    throw new Error(
      `Remember fixture expected authority ${expectedAuthority}, received ${authority}`,
    );
  const fixture = {
    category: fixtureCategory ?? 'memory',
    summary_group: summaryGroup ?? fixtureCategory ?? 'memory',
    statement,
    id,
    authority,
    conversation_order: conversationOrder ?? 0,
    summary_window_retained: (conversationOrder ?? 0) < 4,
    scope_id: requestedScope,
  };
  fixtures.push(fixture);
  return {
    id,
    statement,
    authority,
    view: view.body,
    replay_key: idempotencyKey,
    replay_body: replayBody,
  };
}

async function waitForCapture(jobId, token) {
  const deadline = Date.now() + 90_000;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/v1/captures/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readBody(response);
    if (!response.ok) throw new Error(`Capture status returned HTTP ${response.status}`);
    last = body;
    if (['committed', 'held', 'failed'].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Capture ${jobId} did not reach a terminal state; last=${last?.status ?? 'unknown'}`,
  );
}

async function issue(clientId, secret, resource, requestedScope, scopeIds = [scope]) {
  const authorization = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const response = await fetch(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authorization}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource,
      scope: requestedScope,
      scope_ids: scopeIds.join(' '),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readBody(response);
  if (!response.ok || typeof body.access_token !== 'string')
    throw new Error(`Local issuer token request returned HTTP ${response.status}`);
  return body.access_token;
}

async function postJson(path, token, body, options = {}) {
  const response = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await readBody(response) };
}

async function getMemory(id, token, requestedScope = scope) {
  const url = new URL(`${api}/v1/memories/${id}`);
  url.searchParams.set('scope_id', requestedScope);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await readBody(response) };
}

async function getJson(path, token) {
  const response = await fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await readBody(response) };
}

async function readBody(response) {
  const text = await response.text();
  try {
    return text === '' ? {} : JSON.parse(text);
  } catch {
    return { non_json_response: text.slice(0, 200) };
  }
}

function memoryId(body) {
  const id = body.operations?.flatMap((operation) => operation.memory_ids ?? [])[0];
  if (typeof id !== 'string') throw new Error('Remember returned no memory identifier');
  return id;
}

function evidenceInput(externalId, statement) {
  return {
    source: {
      kind: 'explicit_remember',
      external_id: externalId,
      revision: '1',
      locator: `eval/${externalId}`,
    },
    snippet: statement,
    snippet_allowed: true,
  };
}

function evidenceCaseInput(externalId, revision, locator, snippet, options = {}) {
  return {
    source: {
      kind: 'explicit_remember',
      external_id: externalId,
      revision,
      locator,
    },
    ...(options.speaker === undefined ? {} : { speaker: options.speaker }),
    ...(options.eventTime === undefined ? {} : { event_time: options.eventTime }),
    snippet,
    snippet_allowed: options.snippetAllowed ?? true,
  };
}

function assertStatus(response, expected, operation) {
  if (response.status !== expected)
    throw new Error(`${operation} expected HTTP ${expected}, received ${response.status}`);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function noTime() {
  return { valid_at: null, known_at: null, selected_valid_from: null };
}

function baselineMetrics(rows, answer, contextBytes, observedDuration) {
  const candidates = rows;
  const candidateAnswers = [];
  const executionTimes = [];
  const serializedContextBytes = [];
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let correctUnknown = 0;
  let expectedUnknown = 0;
  let returned = 0;
  for (const testCase of candidates) {
    const started = performance.now();
    const expected = testCase.expected_memory_ids;
    const actual = answer(testCase) ?? [];
    executionTimes.push(observedDuration?.(testCase) ?? performance.now() - started);
    serializedContextBytes.push(contextBytes(testCase));
    candidateAnswers.push(actual);
    const shared = actual.filter((id) => expected.includes(id));
    truePositive += shared.length;
    returned += actual.length;
    falsePositive += actual.length - shared.length;
    falseNegative += expected.length - shared.length;
    if (testCase.expected_unknown) {
      expectedUnknown += 1;
      if (actual.length === 0) correctUnknown += 1;
    }
  }
  const expectedIds = candidates.reduce(
    (sum, testCase) => sum + testCase.expected_memory_ids.length,
    0,
  );
  const exactCases = candidates.filter((testCase, index) =>
    sameStrings(
      [...(candidateAnswers[index] ?? [])].sort(),
      [...testCase.expected_memory_ids].sort(),
    ),
  ).length;
  return {
    case_denominator: candidates.length,
    expected_memory_id_denominator: expectedIds,
    exact_case_accuracy: ratio(exactCases, candidates.length),
    memory_id_precision: returned === 0 ? null : ratio(truePositive, returned),
    memory_id_recall: expectedIds === 0 ? null : ratio(truePositive, expectedIds),
    correct_unknown_abstentions: {
      passed: correctUnknown,
      denominator: expectedUnknown,
      accuracy: expectedUnknown === 0 ? null : ratio(correctUnknown, expectedUnknown),
    },
    false_positive_ids: falsePositive,
    false_negative_ids: falseNegative,
    serialized_context_input_bytes: distribution(serializedContextBytes),
    runtime_ms: distribution(executionTimes),
    runtime_source:
      observedDuration === undefined
        ? 'host-side deterministic baseline function; excludes model inference'
        : 'host client wall time for one loopback API recall request',
  };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, total: 0, mean: null, p50: null, p95: null };
  const at = (percentile) => sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    total: Number(total.toFixed(3)),
    mean: Number((total / sorted.length).toFixed(3)),
    p50: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
  };
}

function buildSummaryContext(sourceFixtures) {
  const groups = new Map();
  for (const fixture of sourceFixtures) {
    const current = groups.get(fixture.summary_group) ?? [];
    current.push(fixture);
    groups.set(fixture.summary_group, current);
  }
  return new Map(
    [...groups].map(([group, entries]) => [
      group,
      entries
        .filter((entry) => entry.summary_window_retained === true)
        .sort((left, right) => left.conversation_order - right.conversation_order)
        .map((entry) => ({ id: entry.id, text: entry.statement })),
    ]),
  );
}

function deterministicRetriever(query, documents) {
  const queryTokens = lexicalTokens(query);
  if (queryTokens.size === 0) return [];
  const ranked = documents
    .map((document) => {
      const documentTokens = lexicalTokens(document.text);
      const overlap = [...queryTokens].filter((token) => documentTokens.has(token)).length;
      return { id: document.id, score: overlap / queryTokens.size };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return ranked[0]?.score >= 0.9 ? [ranked[0].id] : [];
}

function lexicalTokens(value) {
  return new Set(
    (
      value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((token) => token.length > 1),
  );
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function safeMessage(error) {
  return typeof error?.message === 'string'
    ? error.message.slice(0, 240)
    : 'Unexpected local evaluation failure';
}
