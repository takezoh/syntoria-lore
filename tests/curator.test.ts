import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LocalDeterministicCuratorProvider,
  LocalDeterministicEmbeddingProvider,
  validateProposalEvidence,
  type CuratorObservation,
} from '@memory/curator';

describe('local curator fixtures', () => {
  it('does not treat common words or run identifiers as semantic evidence', async () => {
    const provider = new LocalDeterministicEmbeddingProvider();
    const [unknownQuery, unrelatedProcedure, relatedQuery, numericQuery, numericEvidence] =
      await provider.embed([
        'AI draft proposal 36f62fea-5: the zephyr buoy pulses violet twice before dawn.',
        'Procedure 36f62fea-5: when snow arrives, wrapped the field kit and the result is intact.',
        'zephyr buoy pulses violet twice before dawn',
        'HTTP 500 retry after 60 seconds on protocol v2',
        'HTTP 500 retried after 60 seconds using protocol v2',
      ]);
    const cosine = (left: readonly number[], right: readonly number[]) =>
      left.reduce((sum, value, index) => sum + value * right[index]!, 0);

    expect(provider.modelId).toBe('local-hash-1536-v2');
    expect(cosine(unknownQuery!, unrelatedProcedure!)).toBeLessThan(0.18);
    expect(cosine(unknownQuery!, relatedQuery!)).toBeGreaterThan(0.18);
    expect(cosine(numericQuery!, numericEvidence!)).toBeGreaterThan(0.18);
  });

  it('keeps an episode condition, action, and outcome in one supported experience candidate', async () => {
    const content = JSON.stringify({
      condition: { weather: 'rain', destination: 'work' },
      action: 'packed a waterproof cover around the laptop',
      outcome: 'the laptop stayed dry',
    });
    const observation: CuratorObservation = {
      id: randomUUID(),
      source_id: randomUUID(),
      source_kind: 'episode',
      source_revision: '1',
      locator: 'episode/1',
      content,
      speaker: 'owner',
      event_time: null,
      lineage_root: randomUUID(),
    };

    const result = await new LocalDeterministicCuratorProvider().extract({
      observations: [observation],
      candidates: [],
      promptVersion: 'test-v1',
      modelId: 'local-fake-v1',
      signal: new AbortController().signal,
      tokenBudget: 1000,
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      kind: 'experience',
      statement: content,
      context: { episode: JSON.parse(content) },
    });
    expect(validateProposalEvidence(result.proposals[0]!, [observation])).toMatchObject([
      { start: 0, end: content.length, span: content },
    ]);
  });

  it('rejects poisoned anchors that reference another observation or unsupported text', () => {
    const input = 'The supported statement came from this exact observation.';
    const observation: CuratorObservation = {
      id: randomUUID(),
      source_id: randomUUID(),
      source_kind: 'chat',
      source_revision: '1',
      locator: 'message/1',
      content: input,
      speaker: 'owner',
      event_time: null,
      lineage_root: randomUUID(),
    };
    const stranger: CuratorObservation = {
      ...observation,
      id: randomUUID(),
      locator: 'message/2',
      content: 'Unrelated content.',
    };
    const proposal = {
      kind: 'fact' as const,
      statement: 'The supported statement came from this exact observation.',
      context: {},
      subjects: [],
      valid_from: null,
      valid_to: null,
      epistemic_status: 'inferred' as const,
      anchors: [
        {
          observation_id: stranger.id,
          span_start: 0,
          span_end: stranger.content.length,
        },
      ],
      rationale: 'untrusted provider output',
      contested: false,
    };
    expect(() => validateProposalEvidence(proposal, [observation])).toThrow(
      /input observation span/,
    );
    expect(() => validateProposalEvidence(proposal, [stranger])).toThrow(/fully supported/);
  });
});
