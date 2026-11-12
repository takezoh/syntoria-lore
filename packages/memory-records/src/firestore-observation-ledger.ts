import {
  FieldPath,
  FieldValue,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import {
  FirestoreMemoryRecordRepository,
  MemoryRepositoryError,
  assertActor,
  assertWorkerActor,
  containsOnly,
  digest,
  id,
  memoryForgetDigest,
  nonempty,
  type AuthorizationDocument,
  type DeletionLedger,
  type DeletionLedgerEntry,
  type ForgetResult,
  type ProtectedApprovalDocument,
  type VerifiedActorCapability,
} from './firestore-repository.js';
import { createFirestoreClient } from './firestore-client.js';
import { deriveAuthority, isMemoryRecord, type MemoryRecord } from './index.js';
import {
  arrivalRelation,
  computeCourse,
  computeCourseAt,
  deriveTier,
  normalizeLabel,
  observationInputProblems,
  tierRank,
  topicKeyFor,
  type ArrivalRelation,
  type CourseStep,
  type Observation,
  type ObservationInput,
  type ObservationKind,
  type ObservationSource,
  type ObservationTier,
  type TopicView,
} from './observations.js';

/**
 * The observation ledger on Firestore: observations that are written once, the subjects and
 * aliases they name, the derived view of each topic, and the bounded reads over them. Every read
 * is by key or a bounded query; none scans a collection. See docs/design/observation-ledger.md.
 */

const OBSERVATION_ID = /^obs_[a-f0-9]{32}$/u;
const SUBJECT_ID = /^sub_[a-f0-9]{32}$/u;
/** State observations read to compute one topic. A longer course keeps its latest ones. */
const MAX_TOPIC_OBSERVATIONS = 500;
const MAX_IN = 30;
const MAX_TERM_CANDIDATES = 200;

export interface ObserveRequest {
  readonly observationId: string;
  readonly input: ObservationInput;
  /** Other spellings of the primary subject. */
  readonly aliases: readonly string[];
  readonly recordedAt: string;
  /** Digest of the request, so a resend with other content is refused. */
  readonly inputDigest: string;
}

export interface ObserveReceipt {
  readonly observationId: string;
  readonly sequence: number;
  readonly replayed: boolean;
  readonly tier: ObservationTier;
  readonly subjectIds: readonly string[];
  /** Names that matched several subjects and were therefore not resolved. */
  readonly ambiguousNames: readonly string[];
  /** Aliases that already belong to another subject and were not added. */
  readonly aliasConflicts: readonly string[];
  readonly topicKey: string | null;
  readonly arrival: StoredArrival | null;
}

export interface StoredArrival {
  readonly relation: ArrivalRelation;
  readonly toObservationId: string | null;
}

interface StoredObservation extends Observation {
  /** Effective time when known, otherwise the recorded time; the order key of timelines. */
  readonly at: string;
  readonly inputDigest: string;
  readonly sequence: number;
  readonly arrival: StoredArrival | null;
  readonly suppressed?: boolean;
  readonly legacyRecordId?: string;
}

interface TopicDocument {
  readonly topicKey: string;
  readonly subjectId: string;
  readonly aspect: string;
  readonly aspectLabel: string;
  readonly view: TopicView | null;
  readonly upcoming: readonly string[];
  readonly truncated: boolean;
  readonly compartmentIds: readonly string[];
  readonly lastRecordedAt: string;
}

export interface TopicResult {
  readonly topicKey: string;
  readonly subjectId: string;
  readonly aspect: string;
  readonly view: TopicView;
  readonly upcoming: readonly string[];
  /** True when the course is longer than what was read to compute the view. */
  readonly truncated: boolean;
  readonly current: Observation;
  readonly previous: Observation | null;
  readonly conflicts: readonly Observation[];
  /** The whole course in time order, when it was asked for. */
  readonly course?: readonly Observation[];
  readonly steps?: readonly CourseStep[];
}

export interface SubjectDocument {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface ObservationIndexEntry {
  readonly observationId: string;
  readonly terms: readonly string[];
  readonly subjectIds: readonly string[];
  readonly topicKey: string | null;
  readonly nature: Observation['nature'];
  readonly at: string;
  readonly compartmentIds: readonly string[];
  readonly embedding: {
    readonly modelId: string;
    readonly dimension: number;
    readonly values: readonly number[];
  };
}

export interface SourceReport {
  readonly observationId: string;
  readonly sourceIndex: number;
  readonly status: 'unchanged' | 'changed' | 'gone' | 'no-access';
  readonly checkedAt: string;
  readonly by: string;
}

export type LinkKind = 'same-subject' | 'same-topic';

interface ReadContext {
  readonly authorization: AuthorizationDocument;
  readonly writerSuppressed: (observation: Observation) => boolean;
}

/** The digest a person's approval must carry for one observation. */
export function observationDigest(
  scopeId: string,
  observationId: string,
  inputDigest: string,
): string {
  return digest(['observe', scopeId, observationId, inputDigest]);
}

/** The key under which a source's right can be revoked. */
export function observationSourceKey(source: ObservationSource): string {
  return `${source.provider}\u0000${digest(source.ids)}`;
}

function sortTime(observation: Observation): string {
  return observation.effectiveAt ?? observation.recordedAt;
}

function isStoredObservation(value: unknown): value is StoredObservation {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data['id'] === 'string' &&
    OBSERVATION_ID.test(data['id']) &&
    typeof data['tenantId'] === 'string' &&
    typeof data['scopeId'] === 'string' &&
    typeof data['summary'] === 'string' &&
    typeof data['title'] === 'string' &&
    (data['nature'] === 'state' || data['nature'] === 'event') &&
    Array.isArray(data['subjectIds']) &&
    Array.isArray(data['compartmentIds']) &&
    Array.isArray(data['sources']) &&
    typeof data['recordedAt'] === 'string' &&
    typeof data['at'] === 'string' &&
    typeof data['writer'] === 'object' &&
    data['writer'] !== null &&
    (data['tier'] === 'person' || data['tier'] === 'source' || data['tier'] === 'inference')
  );
}

/** The observation as callers see it, without the fields the ledger keeps for itself. */
function publicObservation(stored: StoredObservation): Observation {
  return {
    id: stored.id,
    tenantId: stored.tenantId,
    scopeId: stored.scopeId,
    schemaVersion: 1,
    title: stored.title,
    summary: stored.summary,
    nature: stored.nature,
    kind: stored.kind ?? null,
    value: stored.value ?? null,
    subjectIds: [...stored.subjectIds],
    subjectNames: [...(stored.subjectNames ?? [])],
    aspect: stored.aspect ?? null,
    topicKey: stored.topicKey ?? null,
    recordedAt: stored.recordedAt,
    observedAt: stored.observedAt,
    effectiveAt: stored.effectiveAt ?? null,
    effectiveUntil: stored.effectiveUntil ?? null,
    writer: { ...stored.writer },
    tier: stored.tier,
    speaker: stored.speaker ?? null,
    sources: stored.sources.map((source) => ({ ...source, ids: { ...source.ids } })),
    compartmentIds: [...stored.compartmentIds],
    retracts: stored.retracts ?? null,
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

export class FirestoreObservationLedger extends FirestoreMemoryRecordRepository {
  // ---- Writing ----------------------------------------------------------------------------

  /**
   * Writes one observation with its subjects, its topic's view and its change-feed entry in one
   * transaction. A resend with the same ID and digest returns the first result.
   */
  async observe(
    actor: VerifiedActorCapability,
    scopeId: string,
    request: ObserveRequest,
  ): Promise<ObserveReceipt> {
    assertActor(actor, scopeId);
    const { input } = request;
    if (actor.actorKind === 'worker')
      throw new MemoryRepositoryError('authorization_denied', 'A worker cannot observe');
    if (
      !OBSERVATION_ID.test(request.observationId) ||
      !/^[a-f0-9]{64}$/u.test(request.inputDigest) ||
      !Number.isFinite(Date.parse(request.recordedAt))
    )
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid observation request');
    const problems = observationInputProblems(input);
    if (problems.length > 0)
      throw new MemoryRepositoryError('invalid_change_set', problems.join('; '));
    if (
      !input.compartmentIds.every(nonempty) ||
      !containsOnly(input.compartmentIds, actor.compartmentAllowance)
    )
      throw new MemoryRepositoryError(
        'authorization_denied',
        "A compartment is outside the writer's allowance",
      );
    const approval = actor.protectedChangeApproval;
    const personAuthority = actor.actorKind === 'person';
    if (
      personAuthority &&
      (!approval ||
        approval.requestDigest !==
          observationDigest(scopeId, request.observationId, request.inputDigest))
    )
      throw new MemoryRepositoryError(
        'authorization_denied',
        "The person's approval does not match the observation",
      );
    await this.assertRestoreReady(actor, scopeId);

    const observationRef = this.observationRef(actor, scopeId, request.observationId);
    return this.firestore.runTransaction(async (transaction) => {
      const [auth, existing, sequence, indexState, persistedApproval, suppressions] =
        await Promise.all([
          transaction.get(this.authorizationRef(actor, scopeId)),
          transaction.get(observationRef),
          transaction.get(this.sequenceRef(actor, scopeId)),
          transaction.get(this.indexStateRef(actor, scopeId)),
          approval
            ? transaction.get(this.protectedApprovalRef(actor, scopeId, approval.protectedChangeId))
            : Promise.resolve(null),
          transaction.get(this.writerSuppressionRef(actor, scopeId)),
        ]);
      this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
      if (existing.exists) {
        const stored: unknown = existing.data();
        if (!isStoredObservation(stored) || stored.inputDigest !== request.inputDigest)
          throw new MemoryRepositoryError(
            'idempotency_conflict',
            'The observation ID was used for a different request',
          );
        return {
          observationId: stored.id,
          sequence: stored.sequence,
          replayed: true,
          tier: stored.tier,
          subjectIds: stored.subjectIds,
          ambiguousNames: [],
          aliasConflicts: [],
          topicKey: stored.topicKey ?? null,
          arrival: stored.arrival ?? null,
        } satisfies ObserveReceipt;
      }
      if (personAuthority) {
        const stored = persistedApproval?.data() as ProtectedApprovalDocument | undefined;
        if (
          !stored ||
          stored.principalId !== actor.principalId ||
          stored.connectionId !== actor.connectionId ||
          stored.gateClientId !== actor.gateClientId ||
          stored.provenance !== approval!.provenance ||
          stored.requestDigest !== approval!.requestDigest
        )
          throw new MemoryRepositoryError(
            'authorization_denied',
            "The person's approval is not recorded for this observation",
          );
      }

      const subjects = await this.resolveSubjects(
        transaction,
        actor,
        scopeId,
        input.subjects,
        request.aliases,
        request.recordedAt,
      );
      const primary = subjects.resolved[0];
      if (!subjects.primaryResolved || primary === undefined)
        throw new MemoryRepositoryError(
          'invalid_change_set',
          'The first subject matches several subjects; name it by its subject ID',
        );
      const tier = deriveTier({ personAuthority, sources: input.sources });
      const topicKey =
        input.nature === 'state' && input.aspect !== undefined
          ? topicKeyFor(primary, input.aspect)
          : null;
      const nextSequence = Number(sequence.get('sequence') ?? 0) + 1;
      const observation: StoredObservation = {
        id: request.observationId,
        tenantId: actor.tenantId,
        scopeId,
        schemaVersion: 1,
        title: input.title.trim(),
        summary: input.summary.trim(),
        nature: input.nature,
        kind: input.kind ?? null,
        value: input.value?.trim() ?? null,
        subjectIds: subjects.resolved,
        subjectNames: input.subjects.map((name) => name.trim()),
        aspect: input.aspect?.trim() ?? null,
        topicKey,
        recordedAt: request.recordedAt,
        observedAt: input.observedAt ?? request.recordedAt,
        effectiveAt: input.effectiveAt ?? null,
        effectiveUntil: input.effectiveUntil ?? null,
        writer: { principalId: actor.principalId, connectionId: actor.connectionId },
        tier,
        speaker: input.speaker?.trim() ?? null,
        sources: input.sources.map((source) => ({ ...source, ids: { ...source.ids } })),
        compartmentIds: [...new Set(input.compartmentIds)].sort(),
        retracts: input.retracts ?? null,
        at: input.effectiveAt ?? request.recordedAt,
        inputDigest: request.inputDigest,
        sequence: nextSequence,
        arrival: null,
      };

      if (observation.retracts !== null) {
        const target = await transaction.get(
          this.observationRef(actor, scopeId, observation.retracts),
        );
        const stored: unknown = target.data();
        if (
          !isStoredObservation(stored) ||
          stored.suppressed === true ||
          !containsOnly(stored.compartmentIds, actor.compartmentAllowance) ||
          stored.nature !== observation.nature ||
          (stored.topicKey ?? null) !== topicKey
        )
          throw new MemoryRepositoryError(
            'invalid_change_set',
            'The observation to retract was not found in the same topic',
          );
      }

      let arrival: StoredArrival | null =
        observation.retracts === null
          ? null
          : { relation: 'retracts', toObservationId: observation.retracts };
      let topicWrite: { ref: DocumentReference; data: TopicDocument | null } | null = null;
      if (topicKey !== null) {
        const topicRef = this.topicRef(actor, scopeId, topicKey);
        const [topic, course] = await Promise.all([
          transaction.get(topicRef),
          transaction.get(
            this.observationCollection(actor, scopeId)
              .where('topicKey', '==', topicKey)
              .orderBy('recordedAt', 'desc')
              .limit(MAX_TOPIC_OBSERVATIONS),
          ),
        ]);
        const writerSuppressed = this.writerSuppressionCheck(suppressions);
        const members = course.docs
          .map((document) => document.data() as unknown)
          .filter(isStoredObservation)
          .filter((member) => member.suppressed !== true && !writerSuppressed(member));
        const all = [...members, observation];
        const computed = computeCourse(all, new Set(), request.recordedAt);
        arrival = arrivalRelation(computed, observation);
        topicWrite = {
          ref: topicRef,
          data: {
            topicKey,
            subjectId: primary,
            aspect: normalizeLabel(observation.aspect!),
            aspectLabel: (topic.get('aspectLabel') as string | undefined) ?? observation.aspect!,
            view: computed.view,
            upcoming: computed.upcoming,
            truncated: course.size >= MAX_TOPIC_OBSERVATIONS,
            compartmentIds: [...new Set(all.flatMap((member) => member.compartmentIds))].sort(),
            lastRecordedAt: request.recordedAt,
          },
        };
      }

      for (const write of subjects.writes) transaction.set(write.ref, write.data, { merge: true });
      transaction.create(observationRef, {
        ...observation,
        arrival,
        sourceKeys: observation.sources.map(observationSourceKey),
      });
      if (topicWrite !== null) transaction.set(topicWrite.ref, topicWrite.data);
      // The feed entry needs no work from the legacy index worker, so its job is born complete
      // and the watermark can pass it. Observations are indexed from their own queue.
      transaction.create(this.jobRef(actor, scopeId, nextSequence), {
        sequence: nextSequence,
        recordIds: [],
        revisions: [],
        status: 'complete',
        completedAt: request.recordedAt,
      });
      if (Number(indexState.get('indexedThrough') ?? 0) === nextSequence - 1)
        transaction.set(this.indexStateRef(actor, scopeId), { indexedThrough: nextSequence });
      transaction.set(this.sequenceRef(actor, scopeId), { sequence: nextSequence });
      transaction.create(this.changeRef(actor, scopeId, nextSequence), {
        sequence: nextSequence,
        operation: 'observe',
        recordIds: [observation.id],
        revisionNumbers: [],
        compartmentIds: observation.compartmentIds,
        createdAt: request.recordedAt,
      });
      transaction.set(this.indexQueueRef(actor, scopeId, observation.id), {
        observationId: observation.id,
        queuedAt: request.recordedAt,
      });
      return {
        observationId: observation.id,
        sequence: nextSequence,
        replayed: false,
        tier,
        subjectIds: subjects.resolved,
        ambiguousNames: subjects.ambiguous,
        aliasConflicts: subjects.aliasConflicts,
        topicKey,
        arrival,
      } satisfies ObserveReceipt;
    });
  }

  /**
   * Resolves names to subjects inside a transaction, reading every alias before any write. A
   * name without a subject gets one; a name with several is left unresolved. Nothing is merged.
   */
  private async resolveSubjects(
    transaction: Transaction,
    actor: VerifiedActorCapability,
    scopeId: string,
    names: readonly string[],
    aliases: readonly string[],
    now: string,
  ): Promise<{
    resolved: string[];
    primaryResolved: boolean;
    ambiguous: string[];
    aliasConflicts: string[];
    writes: { ref: DocumentReference; data: Record<string, unknown> }[];
  }> {
    const writes: { ref: DocumentReference; data: Record<string, unknown> }[] = [];
    const resolved: string[] = [];
    const ambiguous: string[] = [];
    const aliasConflicts: string[] = [];
    const lookups = await Promise.all(
      names.map(async (name) => {
        const trimmed = name.trim();
        if (SUBJECT_ID.test(trimmed)) {
          const subject = await transaction.get(this.subjectRef(actor, scopeId, trimmed));
          if (!subject.exists)
            throw new MemoryRepositoryError('invalid_change_set', 'Unknown subject ID');
          return { name: trimmed, subjectIds: [trimmed], normalized: null as string | null };
        }
        const normalized = normalizeLabel(trimmed);
        const alias = await transaction.get(this.aliasRef(actor, scopeId, normalized));
        const subjectIds: unknown = alias.get('subjectIds');
        return {
          name: trimmed,
          normalized,
          subjectIds: Array.isArray(subjectIds) ? (subjectIds as string[]) : [],
        };
      }),
    );
    const extra = [...new Set(aliases.map(normalizeLabel).filter((alias) => alias.length > 0))];
    const extraDocs = await Promise.all(
      extra.map((alias) => transaction.get(this.aliasRef(actor, scopeId, alias))),
    );
    let primaryResolved = false;
    lookups.forEach((lookup, index) => {
      let subjectId: string | undefined;
      if (lookup.subjectIds.length === 1) subjectId = lookup.subjectIds[0];
      else if (lookup.subjectIds.length === 0 && lookup.normalized !== null) {
        subjectId = `sub_${digest(['subject', actor.tenantId, scopeId, lookup.normalized]).slice(0, 32)}`;
        writes.push({
          ref: this.subjectRef(actor, scopeId, subjectId),
          data: { id: subjectId, name: lookup.name, createdAt: now },
        });
        writes.push({
          ref: this.aliasRef(actor, scopeId, lookup.normalized),
          data: { name: lookup.normalized, subjectIds: [subjectId] },
        });
      } else ambiguous.push(lookup.name);
      if (subjectId !== undefined) {
        if (index === 0) primaryResolved = true;
        if (!resolved.includes(subjectId)) resolved.push(subjectId);
      }
    });
    const primary = primaryResolved ? resolved[0] : undefined;
    if (primary !== undefined)
      extra.forEach((alias, index) => {
        const subjectIds: unknown = extraDocs[index]?.get('subjectIds');
        const current = Array.isArray(subjectIds) ? (subjectIds as string[]) : [];
        // Writes queued above for the same alias already point at the primary subject.
        if (writes.some((write) => write.data['name'] === alias)) return;
        if (current.length === 0)
          writes.push({
            ref: this.aliasRef(actor, scopeId, alias),
            data: { name: alias, subjectIds: [primary] },
          });
        else if (!current.includes(primary)) aliasConflicts.push(alias);
      });
    return { resolved, primaryResolved, ambiguous, aliasConflicts, writes };
  }

  // ---- Reading by key ---------------------------------------------------------------------

  /** The visible observations among the given IDs, in the order given. */
  async getObservations(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationIds: readonly string[],
  ): Promise<Observation[]> {
    const context = await this.readContext(actor, scopeId);
    return this.readObservations(context, actor, scopeId, observationIds);
  }

  /** The Memory Record an observation was converted from, if any and if the caller may see it. */
  async legacyRecordIdOf(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationId: string,
  ): Promise<string | null> {
    const context = await this.readContext(actor, scopeId);
    if (!OBSERVATION_ID.test(observationId)) return null;
    const stored: unknown = (await this.observationRef(actor, scopeId, observationId).get()).data();
    return isStoredObservation(stored) && this.visible(context, actor, scopeId, stored)
      ? (stored.legacyRecordId ?? null)
      : null;
  }

  /** Subject IDs for each name, through the alias table. A subject ID resolves to itself. */
  async resolveNames(
    actor: VerifiedActorCapability,
    scopeId: string,
    names: readonly string[],
  ): Promise<Map<string, string[]>> {
    await this.readContext(actor, scopeId);
    const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))];
    const result = new Map<string, string[]>();
    const lookups = unique.filter((name) => {
      if (!SUBJECT_ID.test(name)) return true;
      result.set(name, [name]);
      return false;
    });
    if (lookups.length === 0) return result;
    const documents = await this.firestore.getAll(
      ...lookups.map((name) => this.aliasRef(actor, scopeId, normalizeLabel(name))),
    );
    documents.forEach((document, index) => {
      const subjectIds: unknown = document.get('subjectIds');
      if (Array.isArray(subjectIds) && subjectIds.length > 0)
        result.set(lookups[index]!, subjectIds as string[]);
    });
    return result;
  }

  async getSubjects(
    actor: VerifiedActorCapability,
    scopeId: string,
    subjectIds: readonly string[],
  ): Promise<SubjectDocument[]> {
    await this.readContext(actor, scopeId);
    const ids = [...new Set(subjectIds)].filter((subjectId) => SUBJECT_ID.test(subjectId));
    if (ids.length === 0) return [];
    const documents = await this.firestore.getAll(
      ...ids.map((subjectId) => this.subjectRef(actor, scopeId, subjectId)),
    );
    return documents
      .filter((document) => document.exists)
      .map((document) => ({
        id: String(document.get('id')),
        name: String(document.get('name')),
        createdAt: String(document.get('createdAt')),
      }));
  }

  /** The given subjects together with those a `same-subject` link ties to them, one step out. */
  async linkedSubjects(
    actor: VerifiedActorCapability,
    scopeId: string,
    subjectIds: readonly string[],
  ): Promise<string[]> {
    await this.readContext(actor, scopeId);
    return this.linked(actor, scopeId, 'same-subject', subjectIds);
  }

  /** The topics of the given subjects, most recently written first. */
  async listTopics(
    actor: VerifiedActorCapability,
    scopeId: string,
    subjectIds: readonly string[],
    options: { readonly limit: number; readonly now: string; readonly at?: string },
  ): Promise<TopicResult[]> {
    const context = await this.readContext(actor, scopeId);
    const ids = [...new Set(subjectIds)].slice(0, MAX_IN);
    if (ids.length === 0) return [];
    const snapshot = await this.topicCollection(actor, scopeId)
      .where('subjectId', 'in', ids)
      .limit(100)
      .get();
    const topics = snapshot.docs
      .map((document) => document.data() as TopicDocument)
      .sort((left, right) => right.lastRecordedAt.localeCompare(left.lastRecordedAt));
    // Topics that a link declares the same are shown once, under the most recently written.
    const shown: TopicDocument[] = [];
    const covered = new Set<string>();
    for (const topic of topics) {
      if (covered.has(topic.topicKey)) continue;
      for (const key of await this.linked(actor, scopeId, 'same-topic', [topic.topicKey]))
        covered.add(key);
      shown.push(topic);
      if (shown.length >= options.limit) break;
    }
    const results = await Promise.all(
      shown.map((topic) =>
        this.topicResult(context, actor, scopeId, topic, {
          now: options.now,
          ...(options.at === undefined ? {} : { at: options.at }),
        }),
      ),
    );
    return results.filter((result): result is TopicResult => result !== null);
  }

  /** One topic by subject and aspect: its present, or its course, or what held at a past time. */
  async getTopic(
    actor: VerifiedActorCapability,
    scopeId: string,
    subjectId: string,
    aspect: string,
    options: { readonly now: string; readonly at?: string; readonly course?: boolean },
  ): Promise<TopicResult | null> {
    const context = await this.readContext(actor, scopeId);
    const topic = await this.topicRef(actor, scopeId, topicKeyFor(subjectId, aspect)).get();
    if (!topic.exists) return null;
    return this.topicResult(context, actor, scopeId, topic.data() as TopicDocument, options);
  }

  /** Observations about the given subjects, latest first, within an optional time range. */
  async timeline(
    actor: VerifiedActorCapability,
    scopeId: string,
    subjectIds: readonly string[],
    options: { readonly from?: string; readonly to?: string; readonly limit: number },
  ): Promise<Observation[]> {
    const context = await this.readContext(actor, scopeId);
    const ids = [...new Set(subjectIds)].slice(0, MAX_IN);
    if (ids.length === 0) return [];
    let query = this.observationCollection(actor, scopeId).where(
      'subjectIds',
      'array-contains-any',
      ids,
    );
    if (options.from !== undefined) query = query.where('at', '>=', options.from);
    if (options.to !== undefined) query = query.where('at', '<=', options.to);
    const snapshot = await query
      .orderBy('at', 'desc')
      .limit(Math.min(options.limit * 2, 200))
      .get();
    const stored = snapshot.docs
      .map((document) => document.data() as unknown)
      .filter(isStoredObservation)
      .filter((observation) => this.visible(context, actor, scopeId, observation));
    const unsuppressed = await this.dropSuppressed(actor, scopeId, stored);
    const retracted = await this.retractedAmong(actor, scopeId, unsuppressed);
    return unsuppressed
      .filter((observation) => observation.retracts === null && !retracted.has(observation.id))
      .slice(0, options.limit)
      .map(publicObservation);
  }

  // ---- Search -----------------------------------------------------------------------------

  /** Whether an observation is still waiting to be indexed. */
  async hasPendingIndex(actor: VerifiedActorCapability, scopeId: string): Promise<boolean> {
    assertActor(actor, scopeId);
    return !(await this.indexQueueCollection(actor, scopeId).limit(1).get()).empty;
  }

  async listIndexQueue(
    actor: VerifiedActorCapability,
    scopeId: string,
    limit: number,
  ): Promise<string[]> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    const queue = await this.indexQueueCollection(actor, scopeId).limit(limit).get();
    return queue.docs.map((document) => String(document.get('observationId')));
  }

  /** The observation a worker is about to index, or null when it is gone or outside its reach. */
  async getObservationForIndex(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationId: string,
  ): Promise<Observation | null> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    const [document, suppression] = await Promise.all([
      this.observationRef(actor, scopeId, observationId).get(),
      this.suppressionRef(actor, scopeId, observationId).get(),
    ]);
    const stored: unknown = document.data();
    if (!isStoredObservation(stored) || stored.suppressed === true || suppression.exists) {
      await this.indexQueueRef(actor, scopeId, observationId).delete();
      return null;
    }
    // An observation in a compartment the worker may not read stays queued and unindexed; it
    // is still found through its subject and topic.
    if (!containsOnly(stored.compartmentIds, actor.compartmentAllowance)) return null;
    return publicObservation(stored);
  }

  async writeObservationIndexEntry(
    actor: VerifiedActorCapability,
    scopeId: string,
    entry: ObservationIndexEntry,
  ): Promise<void> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    if (
      !OBSERVATION_ID.test(entry.observationId) ||
      entry.embedding.values.length !== entry.embedding.dimension ||
      entry.embedding.values.some((value) => !Number.isFinite(value)) ||
      !containsOnly(entry.compartmentIds, actor.compartmentAllowance)
    )
      throw new MemoryRepositoryError('invalid_change_set', 'Invalid observation index entry');
    await this.firestore.runTransaction(async (transaction) => {
      const [observation, suppression] = await Promise.all([
        transaction.get(this.observationRef(actor, scopeId, entry.observationId)),
        transaction.get(this.suppressionRef(actor, scopeId, entry.observationId)),
      ]);
      transaction.delete(this.indexQueueRef(actor, scopeId, entry.observationId));
      if (!observation.exists || suppression.exists || observation.get('suppressed') === true)
        return;
      transaction.set(this.indexRef(actor, scopeId, entry.observationId), {
        observationId: entry.observationId,
        terms: [...entry.terms],
        subjectIds: [...entry.subjectIds],
        topicKey: entry.topicKey,
        nature: entry.nature,
        at: entry.at,
        compartmentIds: [...entry.compartmentIds],
        embeddingModelId: entry.embedding.modelId,
        embedding: FieldValue.vector([...entry.embedding.values]),
      });
    });
  }

  /**
   * Index entries that contain any of at most thirty terms. `partial` is true when the bound
   * was reached, so matches may have been left out.
   */
  async searchByTerms(
    actor: VerifiedActorCapability,
    scopeId: string,
    terms: readonly string[],
  ): Promise<{
    entries: { observationId: string; terms: string[]; at: string }[];
    partial: boolean;
  }> {
    await this.readContext(actor, scopeId);
    const wanted = [...new Set(terms)].slice(0, MAX_IN);
    if (wanted.length === 0) return { entries: [], partial: false };
    const snapshot = await this.indexCollectionOfObservations(actor, scopeId)
      .where('terms', 'array-contains-any', wanted)
      .limit(MAX_TERM_CANDIDATES)
      .get();
    return {
      partial: snapshot.size >= MAX_TERM_CANDIDATES,
      entries: snapshot.docs
        .filter((document) =>
          containsOnly(
            (document.get('compartmentIds') as string[] | undefined) ?? [],
            actor.compartmentAllowance,
          ),
        )
        .map((document) => ({
          observationId: String(document.get('observationId')),
          terms: (document.get('terms') as string[] | undefined) ?? [],
          at: String(document.get('at')),
        })),
    };
  }

  /** The nearest index entries to an embedding of the same model, with their similarity. */
  async searchByVector(
    actor: VerifiedActorCapability,
    scopeId: string,
    embedding: { readonly modelId: string; readonly values: readonly number[] },
    limit: number,
  ): Promise<{
    hits: { observationId: string; similarity: number }[];
    exhausted: boolean;
    scanned: number;
  }> {
    await this.readContext(actor, scopeId);
    const snapshot = await this.indexCollectionOfObservations(actor, scopeId)
      .findNearest({
        vectorField: 'embedding',
        queryVector: [...embedding.values],
        limit: 1000,
        distanceMeasure: 'COSINE',
        distanceResultField: 'distance',
      })
      .get();
    const hits = snapshot.docs
      .filter(
        (document) =>
          document.get('embeddingModelId') === embedding.modelId &&
          containsOnly(
            (document.get('compartmentIds') as string[] | undefined) ?? [],
            actor.compartmentAllowance,
          ),
      )
      .map((document) => ({
        observationId: String(document.get('observationId')),
        similarity: 1 - Number(document.get('distance')),
      }))
      .slice(0, limit);
    return { hits, exhausted: snapshot.size === 1000, scanned: snapshot.size };
  }

  // ---- Links, source reports, writer suppression ------------------------------------------

  /** Declares two subjects, or two topics, the same. The link can be revoked; nothing merges. */
  async link(
    actor: VerifiedActorCapability,
    scopeId: string,
    request: {
      readonly kind: LinkKind;
      readonly members: readonly [string, string];
      readonly at: string;
      readonly revoke: boolean;
    },
  ): Promise<{ linkId: string; active: boolean }> {
    assertActor(actor, scopeId);
    if (actor.actorKind === 'worker')
      throw new MemoryRepositoryError('authorization_denied', 'A worker cannot link');
    await this.assertRestoreReady(actor, scopeId);
    const members = [...new Set(request.members)].sort();
    if (members.length !== 2 || !Number.isFinite(Date.parse(request.at)))
      throw new MemoryRepositoryError('invalid_change_set', 'A link needs two different members');
    const refs = members.map((member) =>
      request.kind === 'same-subject'
        ? this.subjectRef(actor, scopeId, member)
        : this.topicRef(actor, scopeId, member),
    );
    const linkId = digest([request.kind, members]).slice(0, 40);
    const linkRef = this.scopeRef(actor, scopeId).collection('links').doc(linkId);
    return this.firestore.runTransaction(async (transaction) => {
      const [auth, ...targets] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        ...refs.map((ref) => transaction.get(ref)),
      ]);
      this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
      if (targets.some((target) => !target.exists))
        throw new MemoryRepositoryError('not_found', 'A member of the link was not found');
      transaction.set(
        linkRef,
        {
          kind: request.kind,
          members,
          active: !request.revoke,
          history: FieldValue.arrayUnion({
            action: request.revoke ? 'revoke' : 'link',
            by: actor.principalId,
            at: request.at,
          }),
        },
        { merge: true },
      );
      return { linkId, active: !request.revoke };
    });
  }

  /** Appends what a reader found when it opened a source. */
  async reportSource(
    actor: VerifiedActorCapability,
    scopeId: string,
    report: Omit<SourceReport, 'by'>,
  ): Promise<void> {
    const [observation] = await this.getObservations(actor, scopeId, [report.observationId]);
    if (
      observation === undefined ||
      !Number.isSafeInteger(report.sourceIndex) ||
      report.sourceIndex < 0 ||
      report.sourceIndex >= observation.sources.length ||
      !Number.isFinite(Date.parse(report.checkedAt))
    )
      throw new MemoryRepositoryError('not_found', 'The observation or its source was not found');
    await this.scopeRef(actor, scopeId)
      .collection('sourceReports')
      .add({ ...report, by: actor.principalId });
  }

  /** The latest report for each source of the given observations. */
  async latestSourceReports(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationIds: readonly string[],
  ): Promise<SourceReport[]> {
    assertActor(actor, scopeId);
    const latest = new Map<string, SourceReport>();
    for (const group of chunks([...new Set(observationIds)], MAX_IN)) {
      const snapshot = await this.scopeRef(actor, scopeId)
        .collection('sourceReports')
        .where('observationId', 'in', group)
        .limit(200)
        .get();
      for (const document of snapshot.docs) {
        const report = document.data() as SourceReport;
        const key = `${report.observationId}\u0000${report.sourceIndex}`;
        const known = latest.get(key);
        if (known === undefined || known.checkedAt < report.checkedAt) latest.set(key, report);
      }
    }
    return [...latest.values()];
  }

  /**
   * Takes every observation of one writer, optionally within a period, out of all reads, or
   * lifts that again. For a writer that was misled; it deletes nothing.
   */
  async setWriterSuppression(
    actor: VerifiedActorCapability,
    scopeId: string,
    suppression: {
      readonly principalId: string;
      readonly from: string | null;
      readonly until: string | null;
      readonly active: boolean;
    },
  ): Promise<void> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    const ref = this.writerSuppressionRef(actor, scopeId);
    await this.firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const entries = ((current.get('entries') as unknown[] | undefined) ?? []).filter(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { principalId?: unknown }).principalId !== suppression.principalId,
      );
      if (suppression.active)
        entries.push({
          principalId: suppression.principalId,
          from: suppression.from,
          until: suppression.until,
        });
      transaction.set(ref, { entries });
    });
  }

  // ---- Forget -----------------------------------------------------------------------------

  /** Observation IDs whose primary subject is the given one, or that cite the given source. */
  async listObservationIds(
    actor: VerifiedActorCapability,
    scopeId: string,
    selector: { readonly subjectId: string } | { readonly sourceKey: string },
    limit: number,
  ): Promise<string[]> {
    const context = await this.readContext(actor, scopeId);
    const query =
      'subjectId' in selector
        ? this.observationCollection(actor, scopeId).where(
            'subjectIds',
            'array-contains',
            selector.subjectId,
          )
        : this.observationCollection(actor, scopeId).where(
            'sourceKeys',
            'array-contains',
            selector.sourceKey,
          );
    const snapshot = await query.limit(limit).get();
    return snapshot.docs
      .map((document) => document.data() as unknown)
      .filter(isStoredObservation)
      .filter(
        (observation) =>
          this.visible(context, actor, scopeId, observation) &&
          (!('subjectId' in selector) || observation.subjectIds[0] === selector.subjectId),
      )
      .map((observation) => observation.id);
  }

  /**
   * Records a Forget for one observation: it leaves every read at once, and its use is reported
   * stopped only when the independent ledger holds the entry.
   */
  async forgetObservation(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationId: string,
    requestId: string,
  ): Promise<ForgetResult> {
    assertActor(actor, scopeId);
    if (actor.actorKind !== 'person' || !OBSERVATION_ID.test(observationId) || !nonempty(requestId))
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Forget requires an approved person change',
      );
    const requestDigest = memoryForgetDigest(scopeId, observationId, requestId);
    const approval = actor.protectedChangeApproval;
    if (!approval || approval.requestDigest !== requestDigest)
      throw new MemoryRepositoryError(
        'authorization_denied',
        'Forget approval does not match the request',
      );
    const ledgerEntry: DeletionLedgerEntry = {
      id: digest([actor.tenantId, scopeId, requestId]),
      tenantId: actor.tenantId,
      scopeId,
      recordId: observationId,
    };
    const requestRef = this.forgetRequestRef(actor, scopeId, requestId);
    const observationRef = this.observationRef(actor, scopeId, observationId);
    await this.firestore.runTransaction(async (transaction) => {
      const [auth, current, sequence, prior, persisted, suppression, indexState] =
        await Promise.all([
          transaction.get(this.authorizationRef(actor, scopeId)),
          transaction.get(observationRef),
          transaction.get(this.sequenceRef(actor, scopeId)),
          transaction.get(requestRef),
          transaction.get(this.protectedApprovalRef(actor, scopeId, approval.protectedChangeId)),
          transaction.get(this.suppressionRef(actor, scopeId, observationId)),
          transaction.get(this.indexStateRef(actor, scopeId)),
        ]);
      this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
      if (prior.exists && prior.get('requestDigest') !== requestDigest)
        throw new MemoryRepositoryError(
          'idempotency_conflict',
          'Forget request identity was reused',
        );
      const stored = persisted.data() as ProtectedApprovalDocument | undefined;
      if (
        !stored ||
        stored.principalId !== actor.principalId ||
        stored.connectionId !== actor.connectionId ||
        stored.gateClientId !== actor.gateClientId ||
        stored.provenance !== approval.provenance ||
        stored.requestDigest !== requestDigest
      )
        throw new MemoryRepositoryError(
          'authorization_denied',
          'Persisted Forget approval is invalid',
        );
      if (prior.exists) return;
      const observation: unknown = current.data();
      // An unknown, hidden or already forgotten observation reads as not found.
      if (
        suppression.exists ||
        !isStoredObservation(observation) ||
        observation.suppressed === true ||
        !containsOnly(observation.compartmentIds, actor.compartmentAllowance)
      )
        throw new MemoryRepositoryError('not_found', 'Observation was not found');
      const nextSequence = Number(sequence.get('sequence') ?? 0) + 1;
      transaction.create(this.jobRef(actor, scopeId, nextSequence), {
        sequence: nextSequence,
        recordIds: [],
        revisions: [],
        status: 'complete',
        completedAt: new Date().toISOString(),
      });
      if (Number(indexState.get('indexedThrough') ?? 0) === nextSequence - 1)
        transaction.set(this.indexStateRef(actor, scopeId), { indexedThrough: nextSequence });
      transaction.set(this.suppressionRef(actor, scopeId, observationId), {
        deletionId: ledgerEntry.id,
      });
      transaction.update(observationRef, { suppressed: true });
      transaction.create(requestRef, { ledgerEntry, requestDigest });
      transaction.set(this.sequenceRef(actor, scopeId), { sequence: nextSequence });
      transaction.create(this.changeRef(actor, scopeId, nextSequence), {
        sequence: nextSequence,
        operation: 'deletion',
        recordIds: [],
        revisionNumbers: [],
        compartmentIds: [],
      });
      transaction.create(this.deletionIntentRef(actor, scopeId, ledgerEntry.id), {
        id: ledgerEntry.id,
        recordId: observationId,
        state: 'pending',
      });
    });
    try {
      if (!(await this.deletionLedger.includes(ledgerEntry.id)))
        await this.deletionLedger.append(ledgerEntry);
      if (!(await this.deletionLedger.includes(ledgerEntry.id)))
        return { status: 'pending', requestId };
      await this.applyLedgerSnapshot(actor, scopeId);
      return { status: 'stopped', requestId };
    } catch {
      return { status: 'pending', requestId };
    }
  }

  /** Purges a forgotten observation with what was derived from it; other targets as before. */
  override async purge(
    actor: VerifiedActorCapability,
    scopeId: string,
    deletionId: string,
  ): Promise<boolean> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    const intentRef = this.deletionIntentRef(actor, scopeId, deletionId);
    const intent = await intentRef.get();
    const target = String(intent.get('recordId') ?? '');
    if (!intent.exists || !OBSERVATION_ID.test(target))
      return super.purge(actor, scopeId, deletionId);
    const authorization = await this.authorizationRef(actor, scopeId).get();
    this.assertCurrentAuthorization(
      actor,
      authorization.data() as AuthorizationDocument | undefined,
    );
    if (!(await this.deletionLedger.includes(deletionId))) return false;
    const observationRef = this.observationRef(actor, scopeId, target);
    const topicKey = (await observationRef.get()).get('topicKey') as string | null | undefined;
    const reports = await this.scopeRef(actor, scopeId)
      .collection('sourceReports')
      .where('observationId', '==', target)
      .get();
    for (const report of reports.docs) await report.ref.delete();
    await this.indexRef(actor, scopeId, target).delete();
    await this.indexQueueRef(actor, scopeId, target).delete();
    await observationRef.delete();
    if (typeof topicKey === 'string') await this.rebuildTopic(actor, scopeId, topicKey);
    if ((await observationRef.get()).exists) return false;
    await intentRef.set({ id: deletionId, state: 'complete' });
    return true;
  }

  /** Recomputes one topic's view from its observations; removes the view when none remain. */
  async rebuildTopic(
    actor: VerifiedActorCapability,
    scopeId: string,
    topicKey: string,
  ): Promise<void> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    const topicRef = this.topicRef(actor, scopeId, topicKey);
    await this.firestore.runTransaction(async (transaction) => {
      const [topic, course, suppressions] = await Promise.all([
        transaction.get(topicRef),
        transaction.get(
          this.observationCollection(actor, scopeId)
            .where('topicKey', '==', topicKey)
            .orderBy('recordedAt', 'desc')
            .limit(MAX_TOPIC_OBSERVATIONS),
        ),
        transaction.get(this.writerSuppressionRef(actor, scopeId)),
      ]);
      const writerSuppressed = this.writerSuppressionCheck(suppressions);
      const members = course.docs
        .map((document) => document.data() as unknown)
        .filter(isStoredObservation)
        .filter((member) => member.suppressed !== true && !writerSuppressed(member));
      const computed = computeCourse(members, new Set(), new Date().toISOString());
      const first = members[0];
      if (computed.view === null || first === undefined) {
        transaction.delete(topicRef);
        return;
      }
      transaction.set(topicRef, {
        topicKey,
        subjectId: first.subjectIds[0]!,
        aspect: normalizeLabel(first.aspect ?? ''),
        aspectLabel: (topic.get('aspectLabel') as string | undefined) ?? first.aspect ?? '',
        view: computed.view,
        upcoming: computed.upcoming,
        truncated: course.size >= MAX_TOPIC_OBSERVATIONS,
        compartmentIds: [...new Set(members.flatMap((member) => member.compartmentIds))].sort(),
        lastRecordedAt: computed.view.lastRecordedAt,
      } satisfies TopicDocument);
    });
  }

  // ---- Conversion of Memory Records -------------------------------------------------------

  /**
   * Converts a bounded number of Memory Records into event observations, keeping their text,
   * sources, writer and times. No aspect or value is invented, so they join no topic. Records
   * that were retracted, or whose text does not fit an observation, are left where they are.
   */
  async convertLegacyRecords(
    actor: VerifiedActorCapability,
    scopeId: string,
    limit = 50,
  ): Promise<{ complete: boolean; converted: number; skipped: number }> {
    assertActor(actor, scopeId);
    assertWorkerActor(actor);
    await this.assertRestoreReady(actor, scopeId);
    const stateRef = this.scopeRef(actor, scopeId).collection('metadata').doc('legacyConversion');
    const state = await stateRef.get();
    if (state.get('complete') === true) return { complete: true, converted: 0, skipped: 0 };
    const cursor: unknown = state.get('cursor');
    let page = this.scopeRef(actor, scopeId)
      .collection('records')
      .orderBy(FieldPath.documentId())
      .limit(limit);
    if (typeof cursor === 'string' && cursor !== '') page = page.startAfter(cursor);
    const records = await page.get();
    let converted = 0;
    let skipped = Number(state.get('skipped') ?? 0);
    for (const document of records.docs) {
      const record: unknown = document.data();
      if (!isMemoryRecord(record) || record.suppressed || record.lifecycle === 'retracted') {
        skipped += 1;
        continue;
      }
      const done = await this.convertLegacyRecord(actor, scopeId, record);
      if (done === 'converted') converted += 1;
      else if (done === 'skipped') skipped += 1;
    }
    const complete = records.size < limit;
    await stateRef.set({
      complete,
      cursor: complete ? null : (records.docs.at(-1)?.id ?? null),
      skipped,
      ...(complete ? { completedAt: new Date().toISOString() } : {}),
    });
    return { complete, converted, skipped };
  }

  private async convertLegacyRecord(
    actor: VerifiedActorCapability,
    scopeId: string,
    record: MemoryRecord,
  ): Promise<'converted' | 'exists' | 'skipped'> {
    const observationId = `obs_${digest(['legacy', actor.tenantId, scopeId, record.id]).slice(0, 32)}`;
    const kinds: Record<MemoryRecord['kind'], ObservationKind | null> = {
      decision: 'decision',
      fact: 'fact',
      preference: 'preference',
      hypothesis: null,
      experience: 'lesson',
      procedure: 'procedure',
    };
    const recordedAt = record.revision.recordedAt;
    const sources: ObservationSource[] = record.revision.sourceReferences
      .slice(0, 10)
      .map((source): ObservationSource => ({
        provider: source.provider,
        ids: { account: source.accountOrTenant, resource: source.resourceId },
        ...(source.uri === undefined ? {} : { uri: source.uri }),
        ...(source.title === undefined ? {} : { title: source.title.slice(0, 200) }),
        ...(source.version === undefined ? {} : { version: source.version }),
        readAt: recordedAt,
        ...(source.locator === undefined ? {} : { locator: source.locator }),
        sensitivity: source.rights?.includes('confidential') ? 'confidential' : 'normal',
      }));
    const input: ObservationInput = {
      title: [...record.title].slice(0, 120).join(''),
      summary: record.statement,
      nature: 'event',
      ...(kinds[record.kind] === null ? {} : { kind: kinds[record.kind]! }),
      subjects: record.subjectIds.slice(0, 10),
      effectiveAt: record.valid.from,
      effectiveUntil: record.valid.until,
      sources,
      compartmentIds: record.compartmentIds,
    };
    if (observationInputProblems(input).length > 0) return 'skipped';
    const authority = deriveAuthority({
      writer: record.revision.writer,
      protectedChange: record.revision.approval.status === 'approved',
      approval: record.revision.approval,
    });
    // A reference to the request that wrote the record is provenance, not an original to check.
    const external = sources.filter((source) => source.uri !== undefined);
    const tier = deriveTier({ personAuthority: authority === 'user', sources: external });
    const observationRef = this.observationRef(actor, scopeId, observationId);
    return this.firestore.runTransaction(async (transaction) => {
      const [existing, suppression] = await Promise.all([
        transaction.get(observationRef),
        transaction.get(this.suppressionRef(actor, scopeId, record.id)),
      ]);
      if (existing.exists) return 'exists';
      if (suppression.exists) return 'skipped';
      const subjects = await this.resolveSubjects(
        transaction,
        actor,
        scopeId,
        input.subjects,
        record.aliases.map((alias) => alias.value),
        recordedAt,
      );
      if (!subjects.primaryResolved) return 'skipped';
      for (const write of subjects.writes) transaction.set(write.ref, write.data, { merge: true });
      const observation: StoredObservation = {
        id: observationId,
        tenantId: actor.tenantId,
        scopeId,
        schemaVersion: 1,
        title: input.title,
        summary: input.summary,
        nature: 'event',
        kind: input.kind ?? null,
        value: null,
        subjectIds: subjects.resolved,
        subjectNames: [...input.subjects],
        aspect: null,
        topicKey: null,
        recordedAt,
        observedAt: recordedAt,
        effectiveAt: input.effectiveAt ?? null,
        effectiveUntil: input.effectiveUntil ?? null,
        writer: {
          principalId: record.revision.writer.id,
          connectionId:
            record.revision.writer.kind === 'ai' ? record.revision.writer.connectionId : 'legacy',
        },
        tier,
        speaker: record.attribution.speaker,
        sources,
        compartmentIds: [...record.compartmentIds].sort(),
        retracts: null,
        at: input.effectiveAt ?? recordedAt,
        inputDigest: digest(['legacy', record.id, record.revision.revision]),
        sequence: 0,
        arrival: null,
        legacyRecordId: record.id,
      };
      transaction.create(observationRef, {
        ...observation,
        sourceKeys: sources.map(observationSourceKey),
      });
      transaction.set(this.indexQueueRef(actor, scopeId, observationId), {
        observationId,
        queuedAt: recordedAt,
      });
      return 'converted';
    });
  }

  // ---- Internals --------------------------------------------------------------------------

  private async readContext(actor: VerifiedActorCapability, scopeId: string): Promise<ReadContext> {
    assertActor(actor, scopeId);
    await this.assertRestoreReady(actor, scopeId);
    const [authorization, suppressions] = await Promise.all([
      this.authorizationRef(actor, scopeId).get(),
      this.writerSuppressionRef(actor, scopeId).get(),
    ]);
    return {
      authorization: this.assertCurrentAuthorization(
        actor,
        authorization.data() as AuthorizationDocument | undefined,
      ),
      writerSuppressed: this.writerSuppressionCheck(suppressions),
    };
  }

  private writerSuppressionCheck(
    document: DocumentSnapshot,
  ): (observation: Observation) => boolean {
    const entries = ((document.get('entries') as unknown[] | undefined) ?? []).filter(
      (entry): entry is { principalId: string; from: string | null; until: string | null } =>
        typeof entry === 'object' && entry !== null,
    );
    return (observation) =>
      entries.some(
        (entry) =>
          entry.principalId === observation.writer.principalId &&
          (entry.from === null || observation.recordedAt >= entry.from) &&
          (entry.until === null || observation.recordedAt <= entry.until),
      );
  }

  /** Identity, suppression, allowance, source rights and writer suppression, on stored data. */
  private visible(
    context: ReadContext,
    actor: VerifiedActorCapability,
    scopeId: string,
    observation: StoredObservation,
  ): boolean {
    const revoked = new Set(context.authorization.revokedSourceReferences);
    return (
      observation.tenantId === actor.tenantId &&
      observation.scopeId === scopeId &&
      observation.suppressed !== true &&
      containsOnly(observation.compartmentIds, actor.compartmentAllowance) &&
      !observation.sources.some((source) => revoked.has(observationSourceKey(source))) &&
      !context.writerSuppressed(observation)
    );
  }

  /** Removes observations that a suppression document names, as after a restore. */
  private async dropSuppressed<T extends { readonly id: string }>(
    actor: VerifiedActorCapability,
    scopeId: string,
    observations: readonly T[],
  ): Promise<T[]> {
    if (observations.length === 0) return [];
    const suppressions = await this.firestore.getAll(
      ...observations.map((observation) => this.suppressionRef(actor, scopeId, observation.id)),
    );
    return observations.filter((_, index) => suppressions[index]?.exists !== true);
  }

  private async readObservations(
    context: ReadContext,
    actor: VerifiedActorCapability,
    scopeId: string,
    observationIds: readonly string[],
  ): Promise<Observation[]> {
    const ids = [...new Set(observationIds)].filter((value) => OBSERVATION_ID.test(value));
    if (ids.length === 0) return [];
    const documents = await this.firestore.getAll(
      ...ids.map((observationId) => this.observationRef(actor, scopeId, observationId)),
    );
    const stored = documents
      .map((document) => document.data() as unknown)
      .filter(isStoredObservation)
      .filter((observation) => this.visible(context, actor, scopeId, observation));
    return (await this.dropSuppressed(actor, scopeId, stored)).map(publicObservation);
  }

  /** IDs among the given observations that a valid retraction withdraws. */
  private async retractedAmong(
    actor: VerifiedActorCapability,
    scopeId: string,
    observations: readonly StoredObservation[],
  ): Promise<Set<string>> {
    const byId = new Map(observations.map((observation) => [observation.id, observation]));
    const retracted = new Set<string>();
    for (const group of chunks([...byId.keys()], MAX_IN)) {
      const snapshot = await this.observationCollection(actor, scopeId)
        .where('retracts', 'in', group)
        .limit(100)
        .get();
      for (const document of snapshot.docs) {
        const retraction: unknown = document.data();
        if (!isStoredObservation(retraction) || retraction.suppressed === true) continue;
        const target = byId.get(retraction.retracts ?? '');
        if (
          target !== undefined &&
          (target.writer.principalId === retraction.writer.principalId ||
            tierRank(retraction.tier) >= tierRank(target.tier))
        )
          retracted.add(target.id);
      }
    }
    return retracted;
  }

  private async linked(
    actor: VerifiedActorCapability,
    scopeId: string,
    kind: LinkKind,
    members: readonly string[],
  ): Promise<string[]> {
    const result = new Set(members);
    for (const group of chunks([...new Set(members)], MAX_IN)) {
      const snapshot = await this.scopeRef(actor, scopeId)
        .collection('links')
        .where('members', 'array-contains-any', group)
        .limit(100)
        .get();
      for (const document of snapshot.docs) {
        if (document.get('kind') !== kind || document.get('active') !== true) continue;
        for (const member of (document.get('members') as string[] | undefined) ?? [])
          result.add(member);
      }
    }
    return [...result];
  }

  /**
   * One topic for one reader. The stored view is used when the reader may see everything that
   * went into it and what it names is still readable; otherwise the view is computed from the
   * observations this reader may see.
   */
  private async topicResult(
    context: ReadContext,
    actor: VerifiedActorCapability,
    scopeId: string,
    topic: TopicDocument,
    options: { readonly now: string; readonly at?: string; readonly course?: boolean },
  ): Promise<TopicResult | null> {
    const keys = await this.linked(actor, scopeId, 'same-topic', [topic.topicKey]);
    const base = { topicKey: topic.topicKey, subjectId: topic.subjectId, aspect: topic.aspect };
    const stored = topic.view;
    if (
      stored !== null &&
      keys.length === 1 &&
      options.at === undefined &&
      options.course !== true &&
      topic.upcoming.length === 0 &&
      containsOnly(topic.compartmentIds, actor.compartmentAllowance)
    ) {
      const wanted = [
        stored.current.observationId,
        ...(stored.previous === null ? [] : [stored.previous.observationId]),
        ...stored.conflicts,
      ];
      const found = new Map(
        (await this.readObservations(context, actor, scopeId, wanted)).map((observation) => [
          observation.id,
          observation,
        ]),
      );
      if (wanted.every((observationId) => found.has(observationId)))
        return {
          ...base,
          view: stored,
          upcoming: [],
          truncated: topic.truncated,
          current: found.get(stored.current.observationId)!,
          previous: stored.previous === null ? null : found.get(stored.previous.observationId)!,
          conflicts: stored.conflicts.map((observationId) => found.get(observationId)!),
        };
    }
    const snapshots = await Promise.all(
      keys.map((key) =>
        this.observationCollection(actor, scopeId)
          .where('topicKey', '==', key)
          .orderBy('recordedAt', 'desc')
          .limit(MAX_TOPIC_OBSERVATIONS)
          .get(),
      ),
    );
    const members = snapshots
      .flatMap((snapshot) => snapshot.docs)
      .map((document) => document.data() as unknown)
      .filter(isStoredObservation)
      .filter((observation) => this.visible(context, actor, scopeId, observation));
    // Linked topics are read as one course under the key that was asked for.
    const course = (await this.dropSuppressed(actor, scopeId, members)).map((member) => ({
      ...publicObservation(member),
      topicKey: topic.topicKey,
    }));
    const computed =
      options.at === undefined
        ? computeCourse(course, new Set(), options.now)
        : computeCourseAt(course, options.at);
    if (computed.view === null) return null;
    const byId = new Map(course.map((observation) => [observation.id, observation]));
    const view = computed.view;
    const inCourse = new Set(computed.steps.map((step) => step.observationId));
    return {
      ...base,
      view,
      upcoming: computed.upcoming,
      truncated: snapshots.some((snapshot) => snapshot.size >= MAX_TOPIC_OBSERVATIONS),
      current: byId.get(view.current.observationId)!,
      previous: view.previous === null ? null : byId.get(view.previous.observationId)!,
      conflicts: view.conflicts.map((observationId) => byId.get(observationId)!),
      ...(options.course === true
        ? {
            course: course
              .filter((observation) => inCourse.has(observation.id))
              .sort((left, right) => sortTime(left).localeCompare(sortTime(right))),
            steps: computed.steps,
          }
        : {}),
    };
  }

  private observationCollection(actor: VerifiedActorCapability, scopeId: string) {
    return this.scopeRef(actor, scopeId).collection('observations');
  }

  private observationRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationId: string,
  ): DocumentReference {
    return this.observationCollection(actor, scopeId).doc(id(observationId));
  }

  private subjectRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    subjectId: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('subjects').doc(subjectId);
  }

  private aliasRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    normalizedName: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('subjectAliases').doc(digest(normalizedName));
  }

  private topicCollection(actor: VerifiedActorCapability, scopeId: string) {
    return this.scopeRef(actor, scopeId).collection('topics');
  }

  private topicRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    topicKey: string,
  ): DocumentReference {
    return this.topicCollection(actor, scopeId).doc(digest(topicKey));
  }

  private indexCollectionOfObservations(actor: VerifiedActorCapability, scopeId: string) {
    return this.scopeRef(actor, scopeId).collection('observationIndex');
  }

  private indexRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationId: string,
  ): DocumentReference {
    return this.indexCollectionOfObservations(actor, scopeId).doc(id(observationId));
  }

  private indexQueueCollection(actor: VerifiedActorCapability, scopeId: string) {
    return this.scopeRef(actor, scopeId).collection('observationIndexQueue');
  }

  private indexQueueRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    observationId: string,
  ): DocumentReference {
    return this.indexQueueCollection(actor, scopeId).doc(id(observationId));
  }

  private writerSuppressionRef(actor: VerifiedActorCapability, scopeId: string): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('metadata').doc('writerSuppressions');
  }
}

export function createFirestoreObservationLedger(options: {
  projectId: string;
  cursorSecret: Uint8Array;
  databaseId?: string;
  deletionLedger: DeletionLedger;
}): FirestoreObservationLedger {
  if (!nonempty(options.projectId)) throw new TypeError('Firestore project ID is required');
  if (!options.deletionLedger) throw new TypeError('An independent deletion ledger is required');
  return new FirestoreObservationLedger(
    createFirestoreClient({
      projectId: options.projectId,
      ...(options.databaseId === undefined ? {} : { databaseId: options.databaseId }),
    }),
    options.cursorSecret,
    options.deletionLedger,
  );
}
