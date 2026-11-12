import type { RecallItemView } from './observation-service.js';

export const RECALL_ASSESSMENT_ROLES = ['direct', 'conditional', 'lesson', 'irrelevant'] as const;
export interface RecallAssessment {
  readonly index: number;
  readonly role: (typeof RECALL_ASSESSMENT_ROLES)[number];
  readonly reason: string;
  readonly limits: string;
}
export interface RecallAssessmentInput {
  readonly query: string;
  readonly at: string;
  readonly candidates: readonly RecallItemView[];
}
export interface RecallAssessor {
  assess(input: RecallAssessmentInput, signal: AbortSignal): Promise<unknown>;
}

/** Reject the whole assessment rather than silently dropping an unassessed candidate. */
export function validateRecallAssessments(
  value: unknown,
  count: number,
): readonly RecallAssessment[] {
  if (!Array.isArray(value) || value.length !== count)
    throw new Error('Incomplete recall assessment');
  const indices = new Set<number>();
  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !Number.isInteger(entry.index) ||
      entry.index < 0 ||
      entry.index >= count ||
      indices.has(entry.index) ||
      !RECALL_ASSESSMENT_ROLES.includes(entry.role) ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim() ||
      entry.reason.length > 600 ||
      typeof entry.limits !== 'string' ||
      !entry.limits.trim() ||
      entry.limits.length > 600
    ) {
      throw new Error('Invalid recall assessment');
    }
    indices.add(entry.index);
  }
  // Copy only the permitted annotations. No source content, IDs or authority comes from a model.
  return value.map((entry) => ({
    index: entry.index,
    role: entry.role,
    reason: entry.reason,
    limits: entry.limits,
  }));
}

export async function assessRecall(
  assessor: RecallAssessor,
  input: RecallAssessmentInput,
  timeoutMs = 10_000,
): Promise<readonly RecallAssessment[]> {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 65_536)
    throw new Error('Assessment input exceeds budget');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      assessor.assess(structuredClone(input), controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Assessment timed out'));
        }, timeoutMs);
      }),
    ]);
    return validateRecallAssessments(result, input.candidates.length);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Every observation included in the payload, including historical states and conflicts. */
export function recallEvidenceIds(item: RecallItemView): readonly string[] {
  const evidence =
    item.type === 'event'
      ? [item.observation]
      : [
          item.topic.current,
          item.topic.previous,
          ...item.topic.conflicts,
          ...(item.topic.course ?? []),
          ...item.evidence,
        ];
  return [...new Set(evidence.filter((x) => x !== null).map((x) => x.observation_id))];
}
