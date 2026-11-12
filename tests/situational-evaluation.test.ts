import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('situational evaluation scoring', () => {
  it('preserves required fields and nullable timestamps in Vertex tool schemas', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { vertexSchema } from './scripts/evaluate-situational-clients.mjs';
      console.log(JSON.stringify(vertexSchema({
        type: 'object', required: ['title', 'nature'], properties: {
          title: { type: 'string' },
          nature: { type: 'string', enum: ['state', 'event'] },
          effective_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] }
        }
      })));
    `,
      ],
      { encoding: 'utf8' },
    );
    const schema = JSON.parse(output);
    expect(schema.required).toEqual(['title', 'nature']);
    expect(schema.properties.nature.enum).toEqual(['state', 'event']);
    expect(schema.properties.effective_at).toEqual({
      type: 'STRING',
      format: 'date-time',
      nullable: true,
    });
  });

  it('fails incomplete runs and detects prohibited evidence beyond the output budget', () => {
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { score } from './scripts/evaluate-situational-recall.mjs';
      const dataset = {
        observations: [{ id: 'relevant' }, { id: 'private' }],
        cases: [{ id: 'case', top_k: 1, required_evidence: ['relevant'], forbidden_evidence: ['private'] }]
      };
      let missingRejected = false;
      try { score(dataset, []); } catch { missingRejected = true; }
      const failed = score(dataset, [{ id: 'case', items: [['relevant'], ['private']] }]);
      const passed = score(dataset, [{ id: 'case', items: [['relevant']] }]);
      console.log(JSON.stringify({ missingRejected, failed, passed }));
    `,
      ],
      { encoding: 'utf8' },
    );
    const scored = JSON.parse(result);
    expect(scored.missingRejected).toBe(true);
    expect(scored.failed.macro_recall_at_5).toBe(1);
    expect(scored.failed.prohibited_content_cases).toBe(1);
    expect(scored.failed.retrieval_passed).toBe(false);
    expect(scored.passed.retrieval_passed).toBe(true);
    expect(scored.passed.passed).toBeNull();
    expect(scored.passed.cases[0].answer_use).toBe('not-measured');
  });
});
