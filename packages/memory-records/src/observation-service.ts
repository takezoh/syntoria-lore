import {
  assessRecall,
  recallEvidenceIds,
  type RecallAssessment,
  type RecallAssessor,
} from './recall-assessment.js';
import { createHash } from 'node:crypto';
import { AccessDeniedError, type ConnectionAccess, type MemoryAccess } from './access.js';
import type { Embedding, EmbeddingProvider } from './derived-recall.js';
import {
  observationDigest,
  observationSourceKey,
  type FirestoreObservationLedger,
  type LinkKind,
  type SourceReport,
  type TopicResult,
} from './firestore-observation-ledger.js';
import {
  MemoryRepositoryError,
  memoryForgetDigest,
  type ChangeFeedEntry,
} from './firestore-repository.js';
import {
  observationInputProblems,
  type Observation,
  type ObservationInput,
  type ObservationSource,
} from './observations.js';
import {
  lookupTerms,
  MIN_TERM_COVERAGE,
  nameCandidates,
  termWeights,
  tokenizeSearchText,
  weightedShare,
} from './search-terms.js';
import { MemoryServiceError, type AccessView } from './service.js';

/**
 * The operations an adapter calls on the observation ledger. Adapters validate the shape of the
 * input; authority comes only from the {@link ConnectionAccess} issued for a verified principal
 * and from the admission's approval policy.
 */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:~-]{1,200}$/u;
const DEFAULT_RECALL_LIMIT = 8;
const RECALL_BYTE_BUDGET = 32_768;

export type SourceInput = Omit<ObservationSource, 'readAt' | 'sensitivity'> & {
  readonly readAt?: string;
  readonly sensitivity?: ObservationSource['sensitivity'];
};

export interface ObserveInput extends Omit<ObservationInput, 'sources' | 'compartmentIds'> {
  readonly sources?: readonly SourceInput[];
  readonly compartmentIds?: readonly string[];
  /** Other spellings of the first subject. */
  readonly aliases?: readonly string[];
  /** True only when the person states this themselves; the approval policy then decides. */
  readonly asUser: boolean;
  readonly idempotencyKey: string;
}

export interface SourceView extends ObservationSource {
  /** What a reader last found when it opened the original, if any reader reported. */
  readonly last_report?: { readonly status: SourceReport['status']; readonly checked_at: string };
}

export interface ObservationView {
  readonly observation_id: string;
  readonly title: string;
  readonly summary: string;
  readonly nature: Observation['nature'];
  readonly kind: Observation['kind'];
  readonly value: string | null;
  readonly subject_ids: readonly string[];
  /** Names attached to this evidence, not inferred from the current question. */
  readonly subject_names: readonly string[];
  readonly effective_until: string | null;
  readonly aspect: string | null;
  /** When it was the case, if known; otherwise when it was recorded. */
  readonly at: string;
  readonly recorded_at: string;
  readonly tier: Observation['tier'];
  readonly writer: string;
  readonly speaker: string | null;
  readonly retracts: string | null;
  readonly sources: readonly SourceView[];
}

export interface TopicStateView {
  readonly subject: { readonly id: string; readonly name: string | null };
  readonly aspect: string;
  readonly current: ObservationView;
  readonly previous: ObservationView | null;
  /** Whether the current state differs from the previous one. */
  readonly changed: 'yes' | 'no' | 'unknown';
  readonly changed_at: string | null;
  /** Distinct writers that stated the current value. */
  readonly agreeing: number;
  /** Lower-tier observations that state something else after the current state. */
  readonly conflicts: readonly ObservationView[];
  /** States announced for a later time. */
  readonly upcoming: number;
  readonly observations: number;
  readonly truncated: boolean;
  readonly course?: readonly ObservationView[];
}

export type RecallMatch = 'name' | 'terms' | 'semantic';

export type RecallItemView = {
  readonly applicability_assessment?: Omit<RecallAssessment, 'index'> & {
    readonly status: 'unverified-model-interpretation';
  };
} & (
  | {
      readonly type: 'topic';
      readonly matched: readonly RecallMatch[];
      readonly topic: TopicStateView;
      readonly evidence: readonly ObservationView[];
    }
  | {
      readonly type: 'event';
      readonly matched: readonly RecallMatch[];
      readonly observation: ObservationView;
    }
);

export interface ObservationRecallView {
  readonly items: readonly RecallItemView[];
  /** Subjects whose names the query contained. */
  readonly subjects: readonly { readonly id: string; readonly name: string | null }[];
  readonly notes: readonly string[];
  readonly at: string;
  readonly empty_meaning: 'no-supported-match';
}

export interface ObserveView {
  readonly observation_id: string;
  readonly sequence: number;
  readonly replayed: boolean;
  readonly tier: Observation['tier'];
  readonly subject_ids: readonly string[];
  readonly ambiguous_names: readonly string[];
  readonly alias_conflicts: readonly string[];
  /** How the observation stands in its topic; null for an event. */
  readonly relation: string | null;
  readonly topic: TopicStateView | null;
}

export interface ObservationServiceOptions {
  readonly ledger: FirestoreObservationLedger;
  readonly access: MemoryAccess;
  readonly embeddings: EmbeddingProvider;
  readonly recallAssessor?: RecallAssessor;
  readonly indexBatchSize?: number;
  readonly now?: () => Date;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

function sha256(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function searchableText(observation: Observation): string {
  return [
    observation.title,
    observation.summary,
    observation.value ?? '',
    observation.aspect ?? '',
    ...observation.subjectNames,
  ].join(' ');
}

export class ObservationService {
  private readonly ledger: FirestoreObservationLedger;
  private readonly access: MemoryAccess;
  private readonly embeddings: EmbeddingProvider;
  private readonly recallAssessor: RecallAssessor | undefined;
  private readonly indexBatchSize: number;
  private readonly now: () => Date;
  private readonly log: (event: Readonly<Record<string, unknown>>) => void;

  constructor(options: ObservationServiceOptions) {
    this.ledger = options.ledger;
    this.access = options.access;
    this.embeddings = options.embeddings;
    this.recallAssessor = options.recallAssessor;
    this.indexBatchSize = options.indexBatchSize ?? 20;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  }

  private readonly maintenanceScopes = new Map<
    string,
    { access: ConnectionAccess; next: number; delay: number }
  >();
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  private maintenanceRun: Promise<void> | undefined;

  /** Retry durable queues for authenticated scopes while this process is running. */
  startMaintenance(intervalMs = 1000): void {
    if (this.maintenanceTimer !== undefined) return;
    this.maintenanceTimer = setInterval(() => {
      if (this.maintenanceRun !== undefined) return;
      this.maintenanceRun = this.maintain().finally(() => {
        this.maintenanceRun = undefined;
      });
    }, intervalMs);
    this.maintenanceTimer.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    await this.maintenanceRun;
    this.maintenanceScopes.clear();
  }

  private async maintain(): Promise<void> {
    for (const [key, entry] of [...this.maintenanceScopes.entries()]) {
      if (entry.next > Date.now()) continue;
      try {
        const worker = await this.access.worker(entry.access);
        if (!(await this.ledger.isRestoreReady(worker, entry.access.scopeId))) {
          await this.ledger.reconcileRestore(worker, entry.access.scopeId);
        }
        await this.afterWrite(entry.access);
        const pending = await this.ledger.hasPendingIndex(worker, entry.access.scopeId);
        if (!pending) {
          this.maintenanceScopes.delete(key);
          continue;
        }
        entry.delay = Math.min(entry.delay * 2, 60_000);
      } catch {
        entry.delay = Math.min(entry.delay * 2, 60_000);
      }
      entry.next = Date.now() + entry.delay;
    }
  }

  describeAccess(access: ConnectionAccess): AccessView {
    return {
      tenant_id: access.tenantId,
      scope_id: access.scopeId,
      compartment_allowance: [...access.actor.compartmentAllowance],
      approval_policy: access.approvalPolicy,
      principal_id: access.actor.principalId,
    };
  }

  async observe(access: ConnectionAccess, input: ObserveInput): Promise<ObserveView> {
    return this.run(access, async () => {
      const key = this.idempotencyKey(input.idempotencyKey);
      const now = this.now().toISOString();
      const { asUser, idempotencyKey: _key, aliases, sources, compartmentIds, ...content } = input;
      void _key;
      const observation: ObservationInput = {
        ...content,
        sources: (sources ?? []).map((source) => ({
          ...source,
          readAt: source.readAt ?? now,
          sensitivity: source.sensitivity ?? 'normal',
        })),
        compartmentIds: compartmentIds ?? [],
      };
      const problems = observationInputProblems(observation);
      if (problems.length > 0) throw new MemoryServiceError('invalid_input', problems.join('; '));
      const inputDigest = sha256(
        stableJson({ observation: { ...observation, sources: sources ?? [] }, aliases, asUser }),
      );
      const { recordedAt } = await this.ledger.pinRequest(
        access.actor,
        access.scopeId,
        key,
        inputDigest,
        now,
      );
      const observationId = `obs_${sha256('lore-observation-v1', access.actor.principalId, access.scopeId, key).slice(0, 32)}`;
      // Sources without an explicit read time were read when the request was first received.
      const pinned: ObservationInput = {
        ...observation,
        sources: (sources ?? []).map((source) => ({
          ...source,
          readAt: source.readAt ?? recordedAt,
          sensitivity: source.sensitivity ?? 'normal',
        })),
      };
      const actor = asUser
        ? await this.access.approveByPolicy(access, {
            protectedChangeId: this.protectedChangeId(access, 'observe', key),
            requestDigest: observationDigest(access.scopeId, observationId, inputDigest),
          })
        : access.actor;
      const receipt = await this.ledger.observe(actor, access.scopeId, {
        observationId,
        input: pinned,
        aliases: aliases ?? [],
        recordedAt,
        inputDigest,
      });
      await this.afterWrite(access);
      const primary = receipt.subjectIds[0];
      const topic =
        receipt.topicKey === null || primary === undefined || pinned.aspect === undefined
          ? null
          : await this.ledger.getTopic(access.actor, access.scopeId, primary, pinned.aspect, {
              now: this.now().toISOString(),
            });
      return {
        observation_id: receipt.observationId,
        sequence: receipt.sequence,
        replayed: receipt.replayed,
        tier: receipt.tier,
        subject_ids: receipt.subjectIds,
        ambiguous_names: receipt.ambiguousNames,
        alias_conflicts: receipt.aliasConflicts,
        relation: receipt.arrival?.relation ?? null,
        topic: topic === null ? null : (await this.topicViews(access, [topic]))[0]!,
      };
    });
  }

  /**
   * Answers a question from the ledger: the topics and recent events of the subjects the query
   * names, then observations found by term and by meaning. Every path is bounded.
   */
  async recall(
    access: ConnectionAccess,
    input: {
      readonly query: string;
      readonly limit?: number;
      readonly at?: string;
      readonly intent?: 'contextual' | 'entity' | 'historical';
    },
  ): Promise<ObservationRecallView> {
    return this.run(access, async () => {
      const limit = input.limit ?? DEFAULT_RECALL_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30)
        throw new MemoryServiceError('invalid_input', 'limit must be between 1 and 30');
      if (input.at !== undefined && !Number.isFinite(Date.parse(input.at)))
        throw new MemoryServiceError('invalid_input', 'at must be an ISO time');
      const intent = input.intent ?? 'contextual';
      const now = this.now().toISOString();
      const { actor } = access;
      const scopeId = access.scopeId;
      const notes = new Set<string>();

      const named = await this.ledger.resolveNames(actor, scopeId, nameCandidates(input.query));
      const namedIds = [...new Set([...named.values()].flat())];
      const subjectIds = await this.ledger.linkedSubjects(actor, scopeId, namedIds);
      const terms = lookupTerms(input.query, 30);
      const [topics, timeline, termHits, vectorHits, pending] = await Promise.all([
        this.ledger.listTopics(actor, scopeId, subjectIds, {
          limit,
          now,
          ...(input.at === undefined ? {} : { at: input.at }),
        }),
        this.ledger.timeline(actor, scopeId, subjectIds, {
          limit,
          ...(input.at === undefined ? {} : { to: input.at }),
        }),
        this.ledger.searchByTerms(actor, scopeId, terms),
        this.vectorHits(access, input.query, notes),
        this.ledger.hasPendingIndex(actor, scopeId),
      ]);
      if (termHits.partial) notes.add('term-search-partial');
      if (pending) notes.add('index-pending');

      const queryTerms = tokenizeSearchText(input.query);
      const termSets = termHits.entries.map((entry) => new Set(entry.terms));
      const weights = termWeights(queryTerms, termSets);
      const byTerms = termHits.entries
        .map((entry, index) => ({
          observationId: entry.observationId,
          share: weightedShare(queryTerms, weights, termSets[index]!),
        }))
        .filter((hit) => hit.share >= MIN_TERM_COVERAGE)
        .sort((left, right) => right.share - left.share)
        .slice(0, limit * 2);
      const termIds = new Set(byTerms.map((hit) => hit.observationId));
      const semanticIds = new Set(vectorHits.map((hit) => hit.observationId));

      const found = new Map(
        (
          await this.ledger.getObservations(actor, scopeId, [
            ...termIds,
            ...vectorHits.map((hit) => hit.observationId),
          ])
        ).map((observation) => [observation.id, observation]),
      );
      const cut = input.at === undefined ? Number.POSITIVE_INFINITY : Date.parse(input.at);
      const withinCut = (observation: Observation): boolean =>
        Date.parse(observation.effectiveAt ?? observation.recordedAt) <= cut;

      // A state found by search is shown through its topic, so the reader gets its present.
      const topicByKey = new Map(topics.map((topic) => [topic.topicKey, topic]));
      const namedTopicKeys = new Set(topicByKey.keys());
      const searched = [...found.values()].filter(withinCut);
      for (const observation of searched) {
        const primary = observation.subjectIds[0];
        if (
          observation.topicKey === null ||
          observation.aspect === null ||
          primary === undefined ||
          topicByKey.has(observation.topicKey)
        )
          continue;
        const topic = await this.ledger.getTopic(actor, scopeId, primary, observation.aspect, {
          now,
          ...(input.at === undefined ? {} : { at: input.at }),
        });
        if (topic !== null) topicByKey.set(observation.topicKey, topic);
      }
      const matchedOf = (observationIds: readonly string[], byName: boolean): RecallMatch[] => [
        ...(byName ? (['name'] as const) : []),
        ...(observationIds.some((observationId) => termIds.has(observationId))
          ? (['terms'] as const)
          : []),
        ...(observationIds.some((observationId) => semanticIds.has(observationId))
          ? (['semantic'] as const)
          : []),
      ];
      const stateIdsOf = (topic: TopicResult): string[] => [
        topic.current.id,
        ...(topic.previous === null ? [] : [topic.previous.id]),
        ...topic.conflicts.map((conflict) => conflict.id),
        ...searched
          .filter((observation) => observation.topicKey === topic.topicKey)
          .map((observation) => observation.id),
      ];

      const evidenceReports = await this.ledger.latestSourceReports(
        actor,
        scopeId,
        searched.map((item) => item.id),
      );
      const topicViews = await this.topicViews(access, [...topicByKey.values()]);
      const topicItems: RecallItemView[] = [...topicByKey.values()].map((topic, index) => ({
        type: 'topic',
        matched: matchedOf(stateIdsOf(topic), namedTopicKeys.has(topic.topicKey)),
        topic: topicViews[index]!,
        evidence: searched
          .filter((item) => item.topicKey === topic.topicKey)
          .map((item) => this.observationView(item, evidenceReports)),
      }));
      const namedEvents = timeline.filter(
        (observation) => observation.nature === 'event' && withinCut(observation),
      );
      const namedEventIds = new Set(namedEvents.map((observation) => observation.id));
      const events = [
        ...namedEvents,
        ...searched.filter(
          (observation) => observation.nature === 'event' && !namedEventIds.has(observation.id),
        ),
      ];
      const reports = await this.ledger.latestSourceReports(
        actor,
        scopeId,
        events.map((observation) => observation.id),
      );
      const eventItems: RecallItemView[] = events.map((observation) => ({
        type: 'event',
        matched: matchedOf([observation.id], namedEventIds.has(observation.id)),
        observation: this.observationView(observation, reports),
      }));

      const rank = (item: RecallItemView): number =>
        item.matched.includes('name') ? 0 : item.matched.includes('terms') ? 1 : 2;
      const termRanks = new Map(byTerms.map((hit, index) => [hit.observationId, index + 1]));
      const vectorRanks = new Map(vectorHits.map((hit, index) => [hit.observationId, index + 1]));
      const strength = (item: RecallItemView): number => {
        const ids =
          item.type === 'topic'
            ? [
                item.topic.current.observation_id,
                ...item.evidence.map((entry) => entry.observation_id),
              ]
            : [item.observation.observation_id];
        return Math.max(
          0,
          ...ids.map(
            (id) =>
              (termRanks.has(id) ? 1 / (60 + termRanks.get(id)!) : 0) +
              (vectorRanks.has(id) ? 1 / (60 + vectorRanks.get(id)!) : 0),
          ),
        );
      };
      const when = (item: RecallItemView): string =>
        item.type === 'topic'
          ? (item.topic.changed_at ?? item.topic.current.at)
          : item.observation.at;
      const ordered = [...topicItems, ...eventItems].sort(
        (left, right) =>
          (intent === 'entity' ? rank(left) - rank(right) : 0) ||
          // For a named subject, where things stand comes before what happened.
          (intent === 'entity' && rank(left) === 0
            ? Number(left.type === 'event') - Number(right.type === 'event')
            : 0) ||
          strength(right) - strength(left) ||
          when(right).localeCompare(when(left)),
      );
      const supported = ordered.some((item) => rank(item) < 2);
      let selected = ordered.slice(0, limit);
      if (this.recallAssessor !== undefined && intent === 'contextual' && ordered.length > 0) {
        const candidates = ordered.slice(0, Math.min(30, limit * 3));
        if (candidates.length < ordered.length) notes.add('assessment-candidates-truncated');
        let assessments: readonly RecallAssessment[] | undefined;
        try {
          assessments = await assessRecall(this.recallAssessor, {
            query: input.query,
            at: input.at ?? now,
            candidates,
          });
        } catch {
          notes.add('recall-assessment-unavailable');
          this.log({ event: 'observation.recall.assessment_unavailable' });
        }
        // Slow inference must not return data forgotten or made inaccessible while it ran.
        // If any input disappeared, discard all annotations: they may refer to other candidates.
        const ids = [...new Set(candidates.flatMap(recallEvidenceIds))];
        const stillVisible = new Set(
          (await this.ledger.getObservations(actor, scopeId, ids)).map((entry) => entry.id),
        );
        const changed = ids.some((id) => !stillVisible.has(id));
        if (changed) {
          assessments = undefined;
          notes.add('assessment-evidence-changed');
        }
        const visible = candidates.filter((item) =>
          recallEvidenceIds(item).every((id) => stillVisible.has(id)),
        );
        if (assessments === undefined) {
          selected = visible.slice(0, limit);
        } else {
          selected = candidates
            .flatMap((item, index) => {
              const assessment = assessments.find((entry) => entry.index === index)!;
              if (assessment.role === 'irrelevant') return [];
              return [
                {
                  ...item,
                  applicability_assessment: {
                    status: 'unverified-model-interpretation' as const,
                    role: assessment.role,
                    reason: assessment.reason,
                    limits: assessment.limits,
                  },
                },
              ];
            })
            .slice(0, limit);
          notes.add('recall-assessment-applied');
          if (selected.length === 0) notes.add('assessment-no-applicable-candidates');
        }
      }
      if (selected.length > 0 && !supported) notes.add('semantic-match-only');

      const subjects = await this.subjectNames(access, namedIds);
      const view = (items: readonly RecallItemView[]): ObservationRecallView => ({
        items,
        subjects,
        notes: [...notes].sort(),
        at: input.at ?? now,
        empty_meaning: 'no-supported-match',
      });
      const items = [...selected];
      while (
        items.length > 0 &&
        Buffer.byteLength(JSON.stringify(view(items)), 'utf8') > RECALL_BYTE_BUDGET
      ) {
        const dropped = items.pop()!;
        void dropped;
        notes.add('byte-budget-dropped-matches');
      }
      return view(items);
    });
  }

  /**
   * The course of one topic when an aspect is named, otherwise everything about the subjects in
   * time order.
   */
  async getTimeline(
    access: ConnectionAccess,
    input: {
      readonly subjects: readonly string[];
      readonly aspect?: string;
      readonly from?: string;
      readonly to?: string;
      readonly at?: string;
      readonly limit?: number;
    },
  ): Promise<{
    readonly subjects: readonly { readonly id: string; readonly name: string | null }[];
    readonly topic: TopicStateView | null;
    readonly observations: readonly ObservationView[];
  }> {
    return this.run(access, async () => {
      const limit = input.limit ?? 30;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new MemoryServiceError('invalid_input', 'limit must be between 1 and 100');
      for (const time of [input.from, input.to, input.at])
        if (time !== undefined && !Number.isFinite(Date.parse(time)))
          throw new MemoryServiceError('invalid_input', 'from, to and at must be ISO times');
      const { actor, scopeId } = { actor: access.actor, scopeId: access.scopeId };
      const named = await this.ledger.resolveNames(actor, scopeId, input.subjects);
      const namedIds = [...new Set([...named.values()].flat())];
      if (namedIds.length === 0) return { subjects: [], topic: null, observations: [] };
      const subjects = await this.subjectNames(access, namedIds);
      if (input.aspect !== undefined) {
        const now = this.now().toISOString();
        for (const subjectId of namedIds) {
          const topic = await this.ledger.getTopic(actor, scopeId, subjectId, input.aspect, {
            now,
            course: true,
            ...(input.at === undefined ? {} : { at: input.at }),
          });
          if (topic !== null)
            return {
              subjects,
              topic: (await this.topicViews(access, [topic]))[0]!,
              observations: [],
            };
        }
        return { subjects, topic: null, observations: [] };
      }
      const subjectIds = await this.ledger.linkedSubjects(actor, scopeId, namedIds);
      const observations = await this.ledger.timeline(actor, scopeId, subjectIds, {
        limit,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
      });
      const reports = await this.ledger.latestSourceReports(
        actor,
        scopeId,
        observations.map((observation) => observation.id),
      );
      return {
        subjects,
        topic: null,
        observations: observations.map((observation) => this.observationView(observation, reports)),
      };
    });
  }

  async getObservation(access: ConnectionAccess, observationId: string): Promise<ObservationView> {
    return this.run(access, async () => {
      const [observation] = await this.ledger.getObservations(access.actor, access.scopeId, [
        observationId,
      ]);
      if (observation === undefined)
        throw new MemoryServiceError('not_found', 'Observation not found');
      const reports = await this.ledger.latestSourceReports(access.actor, access.scopeId, [
        observation.id,
      ]);
      return this.observationView(observation, reports);
    });
  }

  /** Declares two subjects, or two aspects of one subject, the same, or revokes that. */
  async link(
    access: ConnectionAccess,
    input:
      | {
          readonly kind: 'same-subject';
          readonly a: string;
          readonly b: string;
          readonly revoke: boolean;
        }
      | {
          readonly kind: 'same-topic';
          readonly subject: string;
          readonly a: string;
          readonly b: string;
          readonly revoke: boolean;
        },
  ): Promise<{ readonly link_id: string; readonly active: boolean }> {
    return this.run(access, async () => {
      const { actor, scopeId } = { actor: access.actor, scopeId: access.scopeId };
      const one = async (name: string): Promise<string> => {
        const subjectIds = (await this.ledger.resolveNames(actor, scopeId, [name])).get(
          name.trim(),
        );
        if (subjectIds === undefined || subjectIds.length !== 1)
          throw new MemoryServiceError(
            'invalid_input',
            `"${name}" does not name exactly one subject`,
          );
        return subjectIds[0]!;
      };
      let kind: LinkKind = 'same-subject';
      let members: [string, string];
      if (input.kind === 'same-subject') members = [await one(input.a), await one(input.b)];
      else {
        kind = 'same-topic';
        const subjectId = await one(input.subject);
        const keys = await Promise.all(
          [input.a, input.b].map(async (aspect) => {
            const topic = await this.ledger.getTopic(actor, scopeId, subjectId, aspect, {
              now: this.now().toISOString(),
            });
            if (topic === null)
              throw new MemoryServiceError('not_found', `No topic "${aspect}" for that subject`);
            return topic.topicKey;
          }),
        );
        members = [keys[0]!, keys[1]!];
      }
      const result = await this.ledger.link(actor, scopeId, {
        kind,
        members,
        at: this.now().toISOString(),
        revoke: input.revoke,
      });
      return { link_id: result.linkId, active: result.active };
    });
  }

  /** Records what the caller found when it opened a source of an observation. */
  async reportSource(
    access: ConnectionAccess,
    input: {
      readonly observationId: string;
      readonly sourceIndex: number;
      readonly status: SourceReport['status'];
    },
  ): Promise<{ readonly recorded: true }> {
    return this.run(access, async () => {
      await this.ledger.reportSource(access.actor, access.scopeId, {
        observationId: input.observationId,
        sourceIndex: input.sourceIndex,
        status: input.status,
        checkedAt: this.now().toISOString(),
      });
      return { recorded: true as const };
    });
  }

  /**
   * Forgets one observation, everything whose first subject is a given subject, or everything
   * that cites a given source. Each call handles a bounded number; `remaining` says to call again.
   */
  async forget(
    access: ConnectionAccess,
    input: {
      readonly target:
        | { readonly observationId: string }
        | { readonly subject: string }
        | { readonly source: { readonly provider: string; readonly ids: Record<string, string> } };
      readonly idempotencyKey: string;
    },
  ): Promise<{
    readonly stopped: number;
    readonly pending: number;
    readonly remaining: boolean;
    readonly use_stopped: boolean;
  }> {
    return this.run(access, async () => {
      const key = this.idempotencyKey(input.idempotencyKey);
      const { actor, scopeId } = { actor: access.actor, scopeId: access.scopeId };
      const batch = 50;
      let observationIds: string[];
      if ('observationId' in input.target) observationIds = [input.target.observationId];
      else if ('subject' in input.target) {
        const name = input.target.subject;
        const subjectIds = (await this.ledger.resolveNames(actor, scopeId, [name])).get(
          name.trim(),
        );
        if (subjectIds === undefined || subjectIds.length !== 1)
          throw new MemoryServiceError(
            'invalid_input',
            `"${name}" does not name exactly one subject`,
          );
        observationIds = await this.ledger.listObservationIds(
          actor,
          scopeId,
          { subjectId: subjectIds[0]! },
          batch + 1,
        );
      } else
        observationIds = await this.ledger.listObservationIds(
          actor,
          scopeId,
          {
            sourceKey: observationSourceKey({
              ...input.target.source,
              readAt: '',
              sensitivity: 'normal',
            }),
          },
          batch + 1,
        );
      if (observationIds.length === 0)
        throw new MemoryServiceError('not_found', 'Nothing to forget was found');
      let stopped = 0;
      let pending = 0;
      for (const observationId of observationIds.slice(0, batch)) {
        const legacyRecordId = await this.ledger.legacyRecordIdOf(actor, scopeId, observationId);
        const status = await this.forgetOne(access, key, observationId, 'observation');
        if (status === 'stopped') stopped += 1;
        else pending += 1;
        // The record an observation was converted from holds the same text and goes with it.
        if (legacyRecordId !== null) await this.forgetOne(access, key, legacyRecordId, 'record');
      }
      await this.afterWrite(access);
      return {
        stopped,
        pending,
        remaining: observationIds.length > batch,
        use_stopped: pending === 0 && observationIds.length <= batch,
      };
    });
  }

  async getChanges(
    access: ConnectionAccess,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<{
    readonly entries: readonly ChangeFeedEntry[];
    readonly cursor: string;
    readonly has_more: boolean;
  }> {
    return this.run(access, async () => {
      const page = await this.ledger.getChanges(
        access.actor,
        access.scopeId,
        cursor ?? null,
        limit ?? 50,
      );
      return { entries: page.entries, cursor: page.cursor, has_more: page.hasMore };
    });
  }

  private async forgetOne(
    access: ConnectionAccess,
    key: string,
    targetId: string,
    kind: 'observation' | 'record',
  ): Promise<'stopped' | 'pending'> {
    // Request identity is per person principal and target, so one key can cover many targets.
    const requestId = `forget_${sha256('lore-forget-v2', access.personPrincipalId, access.scopeId, key, targetId).slice(0, 40)}`;
    const person = await this.access.approveByPolicy(access, {
      protectedChangeId: this.protectedChangeId(access, 'forget', `${key}\u0000${targetId}`),
      requestDigest: memoryForgetDigest(access.scopeId, targetId, requestId),
    });
    try {
      const result =
        kind === 'observation'
          ? await this.ledger.forgetObservation(person, access.scopeId, targetId, requestId)
          : await this.ledger.forget(person, access.scopeId, targetId, requestId);
      return result.status;
    } catch (error) {
      // A record that is already gone needs no second Forget.
      if (kind === 'record' && error instanceof MemoryRepositoryError && error.code === 'not_found')
        return 'stopped';
      throw error;
    }
  }

  private async vectorHits(
    access: ConnectionAccess,
    query: string,
    notes: Set<string>,
  ): Promise<{ observationId: string; similarity: number }[]> {
    let embedding: Embedding;
    try {
      embedding = await this.embeddings.embed(query);
    } catch {
      notes.add('embedding-unavailable');
      this.log({ event: 'observation.recall.embedding_unavailable' });
      return [];
    }
    try {
      const result = await this.ledger.searchByVector(access.actor, access.scopeId, embedding, 100);
      if (result.exhausted) notes.add('semantic-candidate-budget-exhausted');
      this.log({
        event: 'observation.recall.candidates',
        scanned: result.scanned,
        eligible: result.hits.length,
        exhausted: result.exhausted,
      });
      return result.hits;
    } catch (error) {
      if (error instanceof MemoryRepositoryError) throw error;
      // A missing vector index must not take name and term search down with it.
      notes.add('semantic-search-unavailable');
      this.log({ event: 'observation.recall.vector_search_failed' });
      return [];
    }
  }

  private async subjectNames(
    access: ConnectionAccess,
    subjectIds: readonly string[],
  ): Promise<{ id: string; name: string | null }[]> {
    const subjects = await this.ledger.getSubjects(access.actor, access.scopeId, subjectIds);
    const names = new Map(subjects.map((subject) => [subject.id, subject.name]));
    return [...new Set(subjectIds)].map((subjectId) => ({
      id: subjectId,
      name: names.get(subjectId) ?? null,
    }));
  }

  private async topicViews(
    access: ConnectionAccess,
    topics: readonly TopicResult[],
  ): Promise<TopicStateView[]> {
    if (topics.length === 0) return [];
    const observations = topics.flatMap((topic) => [
      topic.current,
      ...(topic.previous === null ? [] : [topic.previous]),
      ...topic.conflicts,
      ...(topic.course ?? []),
    ]);
    const [reports, subjects] = await Promise.all([
      this.ledger.latestSourceReports(
        access.actor,
        access.scopeId,
        observations.map((observation) => observation.id),
      ),
      this.subjectNames(
        access,
        topics.map((topic) => topic.subjectId),
      ),
    ]);
    const names = new Map(subjects.map((subject) => [subject.id, subject.name]));
    return topics.map((topic) => ({
      subject: { id: topic.subjectId, name: names.get(topic.subjectId) ?? null },
      aspect: topic.aspect,
      current: this.observationView(topic.current, reports),
      previous: topic.previous === null ? null : this.observationView(topic.previous, reports),
      changed: topic.view.changed,
      changed_at: topic.view.changedAt,
      agreeing: topic.view.agreeing,
      conflicts: topic.conflicts.map((conflict) => this.observationView(conflict, reports)),
      upcoming: topic.upcoming.length,
      observations: topic.view.count,
      truncated: topic.truncated,
      ...(topic.course === undefined
        ? {}
        : {
            course: topic.course.map((observation) => this.observationView(observation, reports)),
          }),
    }));
  }

  private observationView(
    observation: Observation,
    reports: readonly SourceReport[],
  ): ObservationView {
    return {
      observation_id: observation.id,
      title: observation.title,
      summary: observation.summary,
      nature: observation.nature,
      kind: observation.kind,
      value: observation.value,
      subject_ids: observation.subjectIds,
      subject_names: observation.subjectNames,
      effective_until: observation.effectiveUntil,
      aspect: observation.aspect,
      at: observation.effectiveAt ?? observation.recordedAt,
      recorded_at: observation.recordedAt,
      tier: observation.tier,
      writer: observation.writer.principalId,
      speaker: observation.speaker,
      retracts: observation.retracts,
      sources: observation.sources.map((source, index) => {
        const report = reports.find(
          (item) => item.observationId === observation.id && item.sourceIndex === index,
        );
        return {
          ...source,
          ...(report === undefined
            ? {}
            : { last_report: { status: report.status, checked_at: report.checkedAt } }),
        };
      }),
    };
  }

  /** Purges recorded Forgets, indexes waiting observations and converts old records. */
  private async afterWrite(access: ConnectionAccess): Promise<void> {
    try {
      const worker = await this.access.worker(access);
      const scopeId = access.scopeId;
      for (const deletionId of await this.ledger.listPendingDeletions(worker, scopeId, 20)) {
        const purged = await this.ledger.purge(worker, scopeId, deletionId);
        this.log({ event: 'observation.purge', purged });
      }
      const converted = await this.ledger.convertLegacyRecords(worker, scopeId, 100);
      if (converted.converted > 0 || converted.skipped > 0)
        this.log({ event: 'observation.legacy_converted', ...converted });
      let indexed = 0;
      let failed = 0;
      for (const observationId of await this.ledger.listIndexQueue(
        worker,
        scopeId,
        this.indexBatchSize,
      )) {
        try {
          const observation = await this.ledger.getObservationForIndex(
            worker,
            scopeId,
            observationId,
          );
          if (observation === null) continue;
          const text = searchableText(observation);
          await this.ledger.writeObservationIndexEntry(worker, scopeId, {
            observationId,
            terms: tokenizeSearchText(text),
            subjectIds: observation.subjectIds,
            topicKey: observation.topicKey,
            nature: observation.nature,
            at: observation.effectiveAt ?? observation.recordedAt,
            compartmentIds: observation.compartmentIds,
            embedding: await this.embeddings.embed(text),
          });
          indexed += 1;
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) this.log({ event: 'observation.index.failed', failed, indexed });
    } catch (error) {
      this.log({
        event: 'observation.after_write.failed',
        error: error instanceof MemoryRepositoryError ? error.code : 'unexpected',
      });
    }
  }

  private async run<T>(access: ConnectionAccess, operation: () => Promise<T>): Promise<T> {
    const key = access.tenantId + ':' + access.scopeId;
    if (!this.maintenanceScopes.has(key) && this.maintenanceScopes.size >= 100) {
      this.log({ event: 'observation.maintenance.scope_limit' });
    } else {
      const existing = this.maintenanceScopes.get(key);
      this.maintenanceScopes.set(key, existing ?? { access, next: 0, delay: 1000 });
    }
    try {
      if (!(await this.ledger.isRestoreReady(access.actor, access.scopeId))) {
        const worker = await this.access.worker(access);
        const head = await this.ledger.reconcileRestore(worker, access.scopeId);
        this.log({ event: 'observation.restore.reconciled', ledger_head: head });
      }
      return await operation();
    } catch (error) {
      throw this.translate(error);
    }
  }

  private idempotencyKey(value: string): string {
    if (!IDEMPOTENCY_KEY.test(value))
      throw new MemoryServiceError(
        'invalid_input',
        'idempotency_key must be 1 to 200 characters of letters, digits and ._:~-',
      );
    return value;
  }

  private protectedChangeId(access: ConnectionAccess, operation: string, key: string): string {
    return `policy_${sha256('lore-approval-v1', access.personPrincipalId, access.scopeId, operation, key).slice(0, 40)}`;
  }

  private translate(error: unknown): unknown {
    if (error instanceof MemoryServiceError) return error;
    if (error instanceof AccessDeniedError)
      return error.code === 'user_required'
        ? new MemoryServiceError('user_required', error.message)
        : new MemoryServiceError('forbidden', 'This connection is not authorized for the change');
    if (!(error instanceof MemoryRepositoryError)) return error;
    switch (error.code) {
      case 'not_found':
        return new MemoryServiceError('not_found', 'Not found');
      case 'conflict':
        return new MemoryServiceError('conflict', 'The request conflicts with what is stored');
      case 'idempotency_conflict':
        return new MemoryServiceError(
          'idempotency_conflict',
          'This idempotency_key was already used for a different request',
        );
      case 'resync_required':
        return new MemoryServiceError(
          'resync_required',
          'The cursor is no longer valid; read the changes again without a cursor',
        );
      case 'stale_authorization':
        return new MemoryServiceError(
          'stale_authorization',
          "The connection's authorization changed during the request; try again",
          true,
        );
      case 'invalid_change_set':
        // These messages describe the request, never stored content.
        return new MemoryServiceError('invalid_input', error.message);
      case 'change_set_too_large':
        return new MemoryServiceError('too_large', 'The request is too large');
      default:
        return new MemoryServiceError(
          'forbidden',
          'This connection is not allowed to read or change this memory',
        );
    }
  }
}
