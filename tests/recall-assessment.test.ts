import { describe, expect, it } from 'vitest';
import {
  assessRecall,
  validateRecallAssessments,
} from '../packages/memory-records/src/recall-assessment.js';
import { VertexRecallAssessor } from '../apps/api/src/recall-assessment.js';
const direct = { index: 0, role: 'direct', reason: 'Same scope', limits: 'No cost measurement' };
describe('recall assessment boundary', () => {
  it('rejects missing, duplicate, out-of-range and unbounded annotations', () => {
    for (const value of [
      [],
      [direct, direct],
      [{ ...direct, index: 1 }],
      [{ ...direct, role: 'verified' }],
      [{ ...direct, limits: 'x'.repeat(601) }],
      [null],
    ]) {
      expect(() => validateRecallAssessments(value, 1)).toThrow();
    }
    expect(
      validateRecallAssessments([{ ...direct, tier: 'person', summary: 'forged' }], 1),
    ).toEqual([direct]);
  });
  it('bounds inference even when a provider ignores cancellation', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      assessRecall(
        {
          assess: async (_, received) => {
            signal = received;
            return new Promise(() => {});
          },
        },
        { query: 'question', at: '2026-11-12T00:00:00Z', candidates: [] },
        10,
      ),
    ).rejects.toThrow('timed out');
    expect(signal?.aborted).toBe(true);
  });
  it('does not send oversized evidence to a provider', async () => {
    let called = false;
    await expect(
      assessRecall(
        {
          assess: async () => {
            called = true;
            return [];
          },
        },
        { query: 'x'.repeat(70_000), at: '2026-11-12T00:00:00Z', candidates: [] },
      ),
    ).rejects.toThrow('budget');
    expect(called).toBe(false);
  });
  it('uses structured provider output, cancellation and strict completion checks', async () => {
    let finish = 'STOP';
    const controller = new AbortController();
    const provider = new VertexRecallAssessor({
      projectId: 'example-project',
      location: 'asia-southeast1',
      model: 'gemini-2.5-flash',
      accessToken: async () => 'synthetic-token',
      fetch: async (_, init) => {
        expect(init?.signal).toBe(controller.signal);
        expect(init?.redirect).toBe('error');
        const body = JSON.parse(String(init?.body));
        expect(
          body.generationConfig.responseSchema.properties.items.items.properties.role.enum,
        ).toContain('conditional');
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: finish,
                content: { parts: [{ text: JSON.stringify({ items: [direct] }) }] },
              },
            ],
          }),
        );
      },
    });
    const input = { query: 'question', at: '2026-11-12T00:00:00Z', candidates: [] };
    expect(await provider.assess(input, controller.signal)).toEqual([direct]);
    finish = 'MAX_TOKENS';
    await expect(provider.assess(input, controller.signal)).rejects.toThrow('Incomplete');
  });
});
