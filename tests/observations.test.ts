import { describe, expect, it } from 'vitest';
import {
  arrivalRelation,
  computeCourse,
  computeCourseAt,
  deriveTier,
  normalizeLabel,
  observationInputProblems,
  topicKeyFor,
  type Observation,
  type ObservationInput,
  type ObservationTier,
} from '../packages/memory-records/src/index.js';

const topicKey = topicKeyFor('subject-acme', 'Quoted price');

function state(
  id: string,
  options: {
    value?: string | null;
    effectiveAt?: string | null;
    recordedAt: string;
    tier?: ObservationTier;
    writer?: string;
    retracts?: string;
  },
): Observation {
  return {
    id,
    tenantId: 'tenant-demo',
    scopeId: 'scope-demo',
    schemaVersion: 1,
    title: `Quoted price ${id}`,
    summary: `Acme quoted ${options.value ?? 'a price'}`,
    nature: 'state',
    kind: 'fact',
    value: options.value === undefined ? null : options.value,
    subjectIds: ['subject-acme'],
    subjectNames: ['Acme'],
    aspect: 'Quoted price',
    topicKey,
    recordedAt: options.recordedAt,
    observedAt: options.recordedAt,
    effectiveAt: options.effectiveAt === undefined ? null : options.effectiveAt,
    effectiveUntil: null,
    writer: { principalId: options.writer ?? 'ai-one', connectionId: 'connection-demo' },
    tier: options.tier ?? 'source',
    speaker: null,
    sources: [],
    compartmentIds: [],
    retracts: options.retracts ?? null,
  };
}

describe('Observation ledger value model', () => {
  it('treats two spellings of one aspect as one topic', () => {
    expect(normalizeLabel('  Quoted   ＰＲＩＣＥ ')).toBe('quoted price');
    expect(topicKeyFor('subject-acme', 'quoted price')).toBe(topicKey);
    expect(topicKeyFor('subject-other', 'Quoted price')).not.toBe(topicKey);
  });

  it('derives the tier from authority and sources, not from the request', () => {
    const source = {
      provider: 'slack',
      ids: { channel: 'C1', ts: '1.2' },
      readAt: '2026-01-01T00:00:00.000Z',
      sensitivity: 'normal',
    } as const;
    expect(deriveTier({ personAuthority: true, sources: [] })).toBe('person');
    expect(deriveTier({ personAuthority: false, sources: [source] })).toBe('source');
    expect(deriveTier({ personAuthority: false, sources: [] })).toBe('inference');
  });

  it('keeps the earlier state when a later one follows and says what changed', () => {
    const first = state('a', {
      value: '800,000 yen total',
      effectiveAt: '2026-01-06T00:00:00.000Z',
      recordedAt: '2026-01-10T00:00:00.000Z',
    });
    const second = state('b', {
      value: '800,000 yen per month',
      effectiveAt: '2026-01-09T00:00:00.000Z',
      recordedAt: '2026-01-10T00:00:01.000Z',
    });
    const course = computeCourse([second, first]);
    expect(course.steps).toEqual([
      { observationId: 'a', relation: 'first', toObservationId: null },
      { observationId: 'b', relation: 'follows', toObservationId: 'a' },
    ]);
    expect(course.view).toMatchObject({
      current: { observationId: 'b', value: '800,000 yen per month' },
      previous: { observationId: 'a', value: '800,000 yen total' },
      changedAt: '2026-01-09T00:00:00.000Z',
      changed: 'yes',
      agreeing: 1,
      conflicts: [],
      count: 2,
      firstAt: '2026-01-06T00:00:00.000Z',
    });
  });

  it('gives the same view whatever the order of arrival, and places a late report in the past', () => {
    const early = state('early', {
      value: 'draft',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-20T00:00:00.000Z',
    });
    const late = state('late', {
      value: 'signed',
      effectiveAt: '2026-01-15T00:00:00.000Z',
      recordedAt: '2026-01-16T00:00:00.000Z',
    });
    const forward = computeCourse([late, early]);
    expect(forward).toEqual(computeCourse([early, late]));
    expect(forward.view?.current.observationId).toBe('late');
    // The report that arrived last describes an earlier time, so it does not take over.
    expect(arrivalRelation(forward, early)).toEqual({
      relation: 'precedes',
      toObservationId: 'late',
    });
    expect(arrivalRelation(forward, late)).toEqual({
      relation: 'follows',
      toObservationId: 'early',
    });
  });

  it('counts distinct writers that state the same value and does not call it a change', () => {
    const course = computeCourse([
      state('a', { value: 'Signed', recordedAt: '2026-01-01T00:00:00.000Z', writer: 'ai-one' }),
      state('b', { value: ' signed ', recordedAt: '2026-01-02T00:00:00.000Z', writer: 'ai-two' }),
      state('c', { value: 'SIGNED', recordedAt: '2026-01-03T00:00:00.000Z', writer: 'ai-two' }),
    ]);
    expect(course.steps.map((step) => step.relation)).toEqual(['first', 'restates', 'restates']);
    expect(course.view).toMatchObject({
      current: { observationId: 'a' },
      previous: null,
      changed: 'no',
      agreeing: 2,
      count: 3,
    });
  });

  it('says unknown, not changed, when a value is missing', () => {
    const course = computeCourse([
      state('a', { value: 'in review', recordedAt: '2026-01-01T00:00:00.000Z' }),
      state('b', { recordedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(course.view).toMatchObject({ current: { observationId: 'b' }, changed: 'unknown' });
  });

  it('keeps a lower tier that disagrees as an open conflict instead of letting it take over', () => {
    const person = state('person', {
      value: 'not agreed',
      recordedAt: '2026-01-01T00:00:00.000Z',
      tier: 'person',
    });
    const inferred = state('inferred', {
      value: 'agreed',
      recordedAt: '2026-01-02T00:00:00.000Z',
      tier: 'inference',
    });
    const open = computeCourse([person, inferred]);
    expect(open.view).toMatchObject({
      current: { observationId: 'person' },
      conflicts: ['inferred'],
      changed: 'no',
    });
    expect(arrivalRelation(open, inferred)).toEqual({
      relation: 'conflicts',
      toObservationId: 'person',
    });
    // A later statement of the same tier settles it either way.
    const settled = computeCourse([
      person,
      inferred,
      state('person-2', {
        value: 'agreed',
        recordedAt: '2026-01-03T00:00:00.000Z',
        tier: 'person',
      }),
    ]);
    expect(settled.view).toMatchObject({
      current: { observationId: 'person-2', value: 'agreed' },
      previous: { observationId: 'person' },
      conflicts: [],
      changed: 'yes',
    });
  });

  it('removes a retracted observation from the course and restores what it had replaced', () => {
    const first = state('a', { value: 'draft', recordedAt: '2026-01-01T00:00:00.000Z' });
    const wrong = state('b', { value: 'signed', recordedAt: '2026-01-02T00:00:00.000Z' });
    const retraction = state('c', { recordedAt: '2026-01-03T00:00:00.000Z', retracts: 'b' });
    const course = computeCourse([first, wrong, retraction]);
    expect(course.view).toMatchObject({
      current: { observationId: 'a' },
      previous: null,
      changed: 'no',
      count: 1,
    });
    expect(arrivalRelation(course, retraction)).toEqual({
      relation: 'retracts',
      toObservationId: 'b',
    });
    // Suppressing the retraction itself undoes it.
    expect(computeCourse([first, wrong, retraction], new Set(['c'])).view).toMatchObject({
      current: { observationId: 'b' },
      previous: { observationId: 'a' },
    });
  });

  it('honours a retraction only from the same writer or an equal or higher tier', () => {
    const person = state('person', {
      value: 'not agreed',
      recordedAt: '2026-01-01T00:00:00.000Z',
      tier: 'person',
      writer: 'person-one',
    });
    const fromBelow = state('low', {
      recordedAt: '2026-01-02T00:00:00.000Z',
      tier: 'inference',
      writer: 'ai-one',
      retracts: 'person',
    });
    expect(computeCourse([person, fromBelow]).view?.current.observationId).toBe('person');
    const own = state('own', {
      value: 'draft',
      recordedAt: '2026-01-03T00:00:00.000Z',
      tier: 'source',
      writer: 'ai-one',
    });
    const ownRetraction = state('own-r', {
      recordedAt: '2026-01-04T00:00:00.000Z',
      tier: 'inference',
      writer: 'ai-one',
      retracts: 'own',
    });
    // Its own writer may withdraw it even from a lower tier.
    expect(computeCourse([own, ownRetraction]).view).toBeNull();
    // A retraction that was itself retracted has no effect.
    const undo = state('undo', {
      recordedAt: '2026-01-05T00:00:00.000Z',
      tier: 'inference',
      writer: 'ai-one',
      retracts: 'own-r',
    });
    expect(computeCourse([own, ownRetraction, undo]).view?.current.observationId).toBe('own');
  });

  it('does not let a state dated in the future hold the present', () => {
    const now = '2026-01-10T00:00:00.000Z';
    const current = state('a', { value: 'draft', recordedAt: '2026-01-01T00:00:00.000Z' });
    const farFuture = state('b', {
      value: 'signed',
      effectiveAt: '2099-01-01T00:00:00.000Z',
      recordedAt: '2026-01-02T00:00:00.000Z',
    });
    const later = state('c', { value: 'in review', recordedAt: '2026-01-03T00:00:00.000Z' });
    const course = computeCourse([current, farFuture, later], new Set(), now);
    expect(course.view).toMatchObject({
      current: { observationId: 'c' },
      previous: { observationId: 'a' },
      count: 2,
    });
    expect(course.upcoming).toEqual(['b']);
    expect(arrivalRelation(course, farFuture)).toEqual({
      relation: 'follows',
      toObservationId: 'c',
    });
    // Once its date arrives it takes its place in the course.
    expect(
      computeCourse([current, farFuture, later], new Set(), '2099-01-02T00:00:00.000Z').view
        ?.current.observationId,
    ).toBe('b');
  });

  it('leaves out suppressed observations and returns no view for an empty course', () => {
    const only = state('a', { value: 'draft', recordedAt: '2026-01-01T00:00:00.000Z' });
    expect(computeCourse([only], new Set(['a']))).toEqual({ steps: [], view: null, upcoming: [] });
    expect(computeCourse([])).toEqual({ steps: [], view: null, upcoming: [] });
  });

  it('answers what held on a past date from everything known now', () => {
    const observations = [
      state('a', {
        value: 'draft',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-03-01T00:00:00.000Z',
      }),
      state('b', {
        value: 'signed',
        effectiveAt: '2026-01-10T00:00:00.000Z',
        recordedAt: '2026-03-01T00:00:01.000Z',
      }),
    ];
    // Both were reported in March; the question is about January.
    expect(computeCourseAt(observations, '2026-01-05T00:00:00.000Z').view?.current.value).toBe(
      'draft',
    );
    expect(computeCourseAt(observations, '2026-01-10T00:00:00.000Z').view).toMatchObject({
      current: { value: 'signed' },
      previous: { value: 'draft' },
    });
    expect(computeCourseAt(observations, '2025-12-31T00:00:00.000Z').view).toBeNull();
  });

  it('rejects observations of another topic or nature in one course', () => {
    const other = { ...state('x', { recordedAt: '2026-01-01T00:00:00.000Z' }), topicKey: 'other' };
    expect(() =>
      computeCourse([state('a', { recordedAt: '2026-01-01T00:00:00.000Z' }), other]),
    ).toThrow(TypeError);
  });

  it('validates what a writer supplies', () => {
    const input: ObservationInput = {
      title: 'Quoted price',
      summary: 'Acme quoted 800,000 yen for two months.',
      nature: 'state',
      value: '800,000 yen total',
      subjects: ['Acme'],
      aspect: 'Quoted price',
      effectiveAt: '2026-01-06T00:00:00.000Z',
      sources: [
        {
          provider: 'notion',
          ids: { pageId: 'page-1' },
          uri: 'https://www.example.com/page-1',
          readAt: '2026-01-10T00:00:00.000Z',
          sensitivity: 'normal',
        },
      ],
      compartmentIds: [],
    };
    expect(observationInputProblems(input)).toEqual([]);
    const withoutAspect: ObservationInput = { ...input };
    delete (withoutAspect as { aspect?: string }).aspect;
    expect(observationInputProblems(withoutAspect)).toEqual(['a state needs an aspect']);
    expect(observationInputProblems({ ...withoutAspect, nature: 'event' })).toEqual([]);
    expect(
      observationInputProblems({
        ...input,
        summary: 'x'.repeat(2001),
        subjects: [],
        effectiveUntil: '2026-01-01T00:00:00.000Z',
        sources: [{ ...input.sources[0]!, ids: {} }],
      }),
    ).toEqual([
      'summary must be 1 to 2000 characters',
      'subjects must be 1 to 10 names of at most 128 bytes',
      'effectiveUntil must not be before effectiveAt',
      'sources must be at most 10 valid references',
    ]);
  });
});
