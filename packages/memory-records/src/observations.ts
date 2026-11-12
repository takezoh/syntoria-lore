import { normalizeSearchText } from './search-terms.js';

/**
 * The observation ledger's value model: an observation is written once and never changed, and
 * the present state of a topic is computed from its observations. See
 * docs/design/observation-ledger.md.
 */

export const observationNatures = ['state', 'event'] as const;
export type ObservationNature = (typeof observationNatures)[number];

export const observationKinds = [
  'decision',
  'fact',
  'preference',
  'plan',
  'lesson',
  'procedure',
] as const;
export type ObservationKind = (typeof observationKinds)[number];

/** How an observation came to be. The server derives it; a request cannot set it. */
export const observationTiers = ['inference', 'source', 'person'] as const;
export type ObservationTier = (typeof observationTiers)[number];

export interface ObservationSource {
  readonly provider: string;
  /** The provider's own identifiers for the original, such as a channel and message time. */
  readonly ids: Readonly<Record<string, string>>;
  readonly uri?: string;
  readonly title?: string;
  /** The version or last-edited value the writer saw. */
  readonly version?: string;
  readonly readAt: string;
  /** A label for the place inside the original, such as a heading. Never a quotation. */
  readonly locator?: string;
  readonly sensitivity: 'normal' | 'confidential';
}

/** What a writer supplies. Identity, writer, tier and recorded time come from the server. */
export interface ObservationInput {
  readonly title: string;
  readonly summary: string;
  readonly nature: ObservationNature;
  readonly kind?: ObservationKind;
  readonly value?: string;
  readonly subjects: readonly string[];
  readonly aspect?: string;
  readonly observedAt?: string;
  readonly effectiveAt?: string | null;
  readonly effectiveUntil?: string | null;
  readonly speaker?: string;
  readonly sources: readonly ObservationSource[];
  readonly compartmentIds: readonly string[];
  readonly retracts?: string;
}

export interface Observation {
  readonly id: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly schemaVersion: 1;
  readonly title: string;
  readonly summary: string;
  readonly nature: ObservationNature;
  readonly kind: ObservationKind | null;
  readonly value: string | null;
  /** Resolved subject IDs; the first is the primary subject. */
  readonly subjectIds: readonly string[];
  /** The names as the writer wrote them, including any that resolved to no single subject. */
  readonly subjectNames: readonly string[];
  readonly aspect: string | null;
  readonly topicKey: string | null;
  readonly recordedAt: string;
  readonly observedAt: string;
  readonly effectiveAt: string | null;
  readonly effectiveUntil: string | null;
  readonly writer: { readonly principalId: string; readonly connectionId: string };
  readonly tier: ObservationTier;
  readonly speaker: string | null;
  readonly sources: readonly ObservationSource[];
  readonly compartmentIds: readonly string[];
  readonly retracts: string | null;
}

export type CourseRelation = 'first' | 'restates' | 'follows' | 'conflicts';
/** How a newly written observation stands in its topic; `precedes` when a later state is current. */
export type ArrivalRelation = CourseRelation | 'precedes' | 'retracts';

export interface CourseStep {
  readonly observationId: string;
  readonly relation: CourseRelation;
  /** The state the relation is to; null for the first observation of a topic. */
  readonly toObservationId: string | null;
}

export interface TopicStateRef {
  readonly observationId: string;
  readonly value: string | null;
  readonly summary: string;
  /** Effective time when known, otherwise the recorded time. */
  readonly at: string;
  readonly tier: ObservationTier;
  readonly writerPrincipalId: string;
}

export interface TopicView {
  readonly topicKey: string;
  readonly current: TopicStateRef;
  readonly previous: TopicStateRef | null;
  readonly changedAt: string | null;
  /** Whether the current state differs from the previous one; unknown when a value is missing. */
  readonly changed: 'yes' | 'no' | 'unknown';
  /** Distinct writers whose observations state the current value, including the first. */
  readonly agreeing: number;
  /** Observations of a lower tier that state something else after the current state. */
  readonly conflicts: readonly string[];
  readonly count: number;
  readonly firstAt: string;
  readonly lastRecordedAt: string;
}

const MAX_SUMMARY = 2000;
const MAX_TITLE = 120;
const MAX_ASPECT = 80;
const MAX_VALUE = 200;
const MAX_NAME_BYTES = 128;

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;
}

/** Collapses case, width and runs of whitespace so that two spellings of one label compare equal. */
export function normalizeLabel(value: string): string {
  return normalizeSearchText(value).trim().replace(/\s+/gu, ' ');
}

export function topicKeyFor(primarySubjectId: string, aspect: string): string {
  return `${primarySubjectId}\u0000${normalizeLabel(aspect)}`;
}

export function tierRank(tier: ObservationTier): number {
  return observationTiers.indexOf(tier);
}

/** The tier of a write: the person's authority when granted, else whether it cites a source. */
export function deriveTier(input: {
  readonly personAuthority: boolean;
  readonly sources: readonly ObservationSource[];
}): ObservationTier {
  if (input.personAuthority) return 'person';
  return input.sources.length > 0 ? 'source' : 'inference';
}

function isSource(value: unknown): value is ObservationSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Record<string, unknown>;
  const ids = source['ids'];
  return (
    text(source['provider'], 100) &&
    typeof ids === 'object' &&
    ids !== null &&
    Object.keys(ids).length > 0 &&
    Object.keys(ids).length <= 8 &&
    Object.entries(ids).every(([key, id]) => text(key, 40) && text(id, 512)) &&
    (source['uri'] === undefined || text(source['uri'], 2048)) &&
    (source['title'] === undefined || text(source['title'], 200)) &&
    (source['version'] === undefined || text(source['version'], 100)) &&
    isIso(source['readAt']) &&
    (source['locator'] === undefined || text(source['locator'], 200)) &&
    (source['sensitivity'] === 'normal' || source['sensitivity'] === 'confidential')
  );
}

/** Returns why a writer's input is not a valid observation, or an empty list. */
export function observationInputProblems(input: ObservationInput): string[] {
  const problems: string[] = [];
  if (!text(input.title, MAX_TITLE)) problems.push(`title must be 1 to ${MAX_TITLE} characters`);
  if (!text(input.summary, MAX_SUMMARY))
    problems.push(`summary must be 1 to ${MAX_SUMMARY} characters`);
  if (!observationNatures.includes(input.nature)) problems.push('nature must be state or event');
  if (input.kind !== undefined && !observationKinds.includes(input.kind))
    problems.push('kind is not a known label');
  if (input.value !== undefined && !text(input.value, MAX_VALUE))
    problems.push(`value must be 1 to ${MAX_VALUE} characters`);
  if (
    !Array.isArray(input.subjects) ||
    input.subjects.length < 1 ||
    input.subjects.length > 10 ||
    input.subjects.some(
      (name) =>
        typeof name !== 'string' ||
        name.trim().length === 0 ||
        Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES,
    )
  )
    problems.push('subjects must be 1 to 10 names of at most 128 bytes');
  if (input.aspect !== undefined && !text(input.aspect, MAX_ASPECT))
    problems.push(`aspect must be 1 to ${MAX_ASPECT} characters`);
  if (input.nature === 'state' && input.aspect === undefined)
    problems.push('a state needs an aspect');
  for (const [name, value] of [
    ['observedAt', input.observedAt],
    ['effectiveAt', input.effectiveAt],
    ['effectiveUntil', input.effectiveUntil],
  ] as const)
    if (value !== undefined && value !== null && !isIso(value))
      problems.push(`${name} must be an ISO time`);
  if (
    isIso(input.effectiveAt) &&
    isIso(input.effectiveUntil) &&
    Date.parse(input.effectiveUntil) < Date.parse(input.effectiveAt)
  )
    problems.push('effectiveUntil must not be before effectiveAt');
  if (input.speaker !== undefined && !text(input.speaker, 200))
    problems.push('speaker must be 1 to 200 characters');
  if (!Array.isArray(input.sources) || input.sources.length > 10 || !input.sources.every(isSource))
    problems.push('sources must be at most 10 valid references');
  if (input.retracts !== undefined && !text(input.retracts, 200))
    problems.push('retracts must be an observation ID');
  return problems;
}

function sortTime(observation: Observation): number {
  return Date.parse(observation.effectiveAt ?? observation.recordedAt);
}

function stateRef(observation: Observation): TopicStateRef {
  return {
    observationId: observation.id,
    value: observation.value,
    summary: observation.summary,
    at: observation.effectiveAt ?? observation.recordedAt,
    tier: observation.tier,
    writerPrincipalId: observation.writer.principalId,
  };
}

function sameValue(left: Observation, right: Observation): boolean {
  return (
    left.value !== null &&
    right.value !== null &&
    normalizeLabel(left.value) === normalizeLabel(right.value)
  );
}

/**
 * Computes the course and the present state of one topic from its state observations. The
 * result depends only on the set given, never on the order of arrival, so a rebuild gives the
 * same view as incremental writes.
 *
 * Observations named by a `retracts` field of another observation in the set, and those in
 * `excluded` (suppressed or forgotten), take no part.
 */
export function computeCourse(
  observations: readonly Observation[],
  excluded: ReadonlySet<string> = new Set(),
): { readonly steps: readonly CourseStep[]; readonly view: TopicView | null } {
  const topicKey = observations[0]?.topicKey ?? null;
  for (const observation of observations)
    if (
      observation.nature !== 'state' ||
      observation.topicKey === null ||
      observation.topicKey !== topicKey
    )
      throw new TypeError('A course takes state observations of one topic');
  const retracted = new Set(
    observations
      .filter((observation) => observation.retracts !== null && !excluded.has(observation.id))
      .map((observation) => observation.retracts!),
  );
  const course = observations
    .filter(
      (observation) =>
        !excluded.has(observation.id) &&
        !retracted.has(observation.id) &&
        // An observation that only retracts another states nothing new about the topic.
        observation.retracts === null,
    )
    .sort(
      (left, right) =>
        sortTime(left) - sortTime(right) ||
        Date.parse(left.recordedAt) - Date.parse(right.recordedAt) ||
        left.id.localeCompare(right.id),
    );
  const first = course[0];
  if (first === undefined || topicKey === null) return { steps: [], view: null };

  const steps: CourseStep[] = [
    { observationId: first.id, relation: 'first', toObservationId: null },
  ];
  let current = first;
  let previous: Observation | null = null;
  let changedAt: string | null = null;
  let changed: TopicView['changed'] = 'no';
  let agreeing = new Set([first.writer.principalId]);
  let conflicts: string[] = [];

  for (const observation of course.slice(1)) {
    if (sameValue(observation, current)) {
      agreeing.add(observation.writer.principalId);
      steps.push({
        observationId: observation.id,
        relation: 'restates',
        toObservationId: current.id,
      });
      continue;
    }
    if (tierRank(observation.tier) < tierRank(current.tier)) {
      conflicts.push(observation.id);
      steps.push({
        observationId: observation.id,
        relation: 'conflicts',
        toObservationId: current.id,
      });
      continue;
    }
    steps.push({ observationId: observation.id, relation: 'follows', toObservationId: current.id });
    previous = current;
    changedAt = observation.effectiveAt ?? observation.recordedAt;
    changed = observation.value !== null && current.value !== null ? 'yes' : 'unknown';
    current = observation;
    agreeing = new Set([observation.writer.principalId]);
    // A state of the same or a higher tier settles what was in conflict before it.
    conflicts = [];
  }

  const lastRecordedAt = course
    .map((observation) => observation.recordedAt)
    .reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest));

  return {
    steps,
    view: {
      topicKey,
      current: stateRef(current),
      previous: previous === null ? null : stateRef(previous),
      changedAt,
      changed,
      agreeing: agreeing.size,
      conflicts,
      count: course.length,
      firstAt: first.effectiveAt ?? first.recordedAt,
      lastRecordedAt,
    },
  };
}

/**
 * The relation to store with an observation when it is written: its step in the course, or
 * `precedes` when it took its place before the state that is current, or `retracts` when it
 * only withdraws another observation.
 */
export function arrivalRelation(
  course: ReturnType<typeof computeCourse>,
  observation: Observation,
): { readonly relation: ArrivalRelation; readonly toObservationId: string | null } {
  if (observation.retracts !== null)
    return { relation: 'retracts', toObservationId: observation.retracts };
  const step = course.steps.find((item) => item.observationId === observation.id);
  if (step === undefined) throw new TypeError('The observation is not part of the course');
  const currentId = course.view?.current.observationId ?? null;
  if ((step.relation === 'follows' || step.relation === 'first') && currentId !== observation.id)
    return { relation: 'precedes', toObservationId: currentId };
  return { relation: step.relation, toObservationId: step.toObservationId };
}

/** The course as it stood at a past time: only observations effective and recorded by then. */
export function computeCourseAt(
  observations: readonly Observation[],
  at: string,
  excluded: ReadonlySet<string> = new Set(),
): ReturnType<typeof computeCourse> {
  if (!isIso(at)) throw new TypeError('at must be an ISO time');
  const cut = Date.parse(at);
  return computeCourse(
    observations.filter(
      (observation) => Date.parse(observation.recordedAt) <= cut && sortTime(observation) <= cut,
    ),
    excluded,
  );
}
