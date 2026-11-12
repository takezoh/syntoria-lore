import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  createMemoryRecordsRuntime,
  ObservationService,
  type RecallAssessor,
  type RecallAssessmentInput,
} from '../packages/memory-records/src/index.js';
import { DeterministicEmbeddingProvider } from '../apps/api/src/embeddings.js';

describe('recall assessment against the ledger', () => {
  it('filters within bounds, preserves evidence, falls back and rechecks Forget after inference', async () => {
    const projectId = 'demo-assess-' + randomUUID().slice(0, 8);
    const databaseId = 'lore-eval';
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
        'synthetic-owner',
        '--tenant',
        'synthetic',
        '--scope',
        'personal',
      ],
      { env: process.env },
    );
    const runtime = createMemoryRecordsRuntime({
      projectId,
      databaseId,
      ledgerDatabaseId: 'lore-deletions',
      cursorSecret: Buffer.alloc(32, 4),
    });
    const access = await runtime.access.resolve({
      issuer: 'https://example.test',
      subject: 'synthetic-owner',
      clientId: 'test',
      connectionId: 'test',
    });
    let mode = 'filter';
    let forgetId: string | undefined;
    let seen: RecallAssessmentInput | undefined;
    const assessor: RecallAssessor = {
      assess: async (input) => {
        seen = input;
        if (mode === 'invalid') return [];
        if (mode === 'forget')
          await service.forget(access, {
            target: { observationId: forgetId! },
            idempotencyKey: 'forget-during-inference',
          });
        const result = input.candidates.map((item, index) => ({
          index,
          role:
            mode === 'empty'
              ? 'irrelevant'
              : item.type === 'event' && item.observation.title === 'Unrelated'
                ? 'irrelevant'
                : 'conditional',
          reason: 'Check applicability',
          limits: 'Not verified for the new case',
        }));
        // Simulate an incorrectly implemented provider mutating its request object.
        const first = input.candidates[0];
        if (first?.type === 'event')
          Object.assign(first.observation, { summary: 'forged provider text' });
        return result;
      },
    };
    const service = new ObservationService({
      ledger: runtime.observations,
      access: runtime.access,
      embeddings: new DeterministicEmbeddingProvider(),
      recallAssessor: assessor,
      log: () => {},
    });
    try {
      const saved = await service.observe(access, {
        title: 'Constraint',
        summary: 'Only one operator; avoid routine manual work.',
        nature: 'event',
        subjects: ['Evaluation'],
        asUser: true,
        idempotencyKey: 'one',
      });
      forgetId = saved.observation_id;
      await service.observe(access, {
        title: 'Unrelated',
        summary: 'The logo is purple.',
        nature: 'event',
        subjects: ['Evaluation'],
        asUser: true,
        idempotencyKey: 'two',
      });
      const result = await service.recall(access, { query: 'Evaluation operations', limit: 1 });
      expect(seen?.candidates).toHaveLength(2);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        observation: {
          observation_id: saved.observation_id,
          summary: 'Only one operator; avoid routine manual work.',
          tier: 'person',
        },
        applicability_assessment: {
          role: 'conditional',
          status: 'unverified-model-interpretation',
        },
      });
      expect(result.notes).toContain('recall-assessment-applied');
      mode = 'invalid';
      const fallback = await service.recall(access, { query: 'Evaluation operations', limit: 2 });
      expect(fallback.items).toHaveLength(2);
      expect(fallback.notes).toContain('recall-assessment-unavailable');
      expect(fallback.items.every((item) => item.applicability_assessment === undefined)).toBe(
        true,
      );
      mode = 'empty';
      expect((await service.recall(access, { query: 'Evaluation operations' })).items).toEqual([]);
      expect(
        (await service.recall(access, { query: 'Evaluation', intent: 'entity' })).items,
      ).toHaveLength(2);
      mode = 'forget';
      const afterForget = await service.recall(access, {
        query: 'Evaluation operations',
        limit: 2,
      });
      expect(JSON.stringify(afterForget)).not.toContain(saved.observation_id);
      expect(afterForget.notes).toContain('assessment-evidence-changed');
      expect(afterForget.items.every((item) => item.applicability_assessment === undefined)).toBe(
        true,
      );
    } finally {
      await service.close();
      await runtime.close();
    }
  });
});
