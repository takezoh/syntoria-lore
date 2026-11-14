import { randomBytes } from 'node:crypto';
import {
  FieldPath,
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import {
  FirestoreMemoryRecordRepository,
  MemoryRepositoryError,
  assertActor,
  assertWorkerActor,
  digest,
  id,
  memoryForgetDigest,
  nonempty,
  type AuthorizationDocument,
  type ChangeFeedEntry,
  type DeletionLedger,
  type DeletionLedgerEntry,
  type ForgetResult,
  type ProtectedApprovalDocument,
  type VerifiedActorCapability,
} from './firestore-repository.js';
import { createFirestoreClient } from './firestore-client.js';
import { labelForCompartments, labelVisible, storedLabel, WORKSPACE_ID } from './labels.js';
import {
  normalizeProjectName,
  PROJECT_ID,
  projectTextProblems,
  ProjectTree,
  type ProjectNode,
} from './projects.js';
import { deriveAuthority, isMemoryRecord, type MemoryRecord } from './index.js';
import {
  arrivalRelation,
  computeCourse,
  INBOX_PLACEMENT,
  labelForPlacement,
  placementProblems,
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
  type ObservationPlacement,
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
/** Observations read to decide whether a reader may see a subject or a topic. */
const MEMBER_VISIBILITY_SCAN = 50;

export interface ObserveRequest {
  readonly observationId: string;
  readonly input: ObservationInput;
  /** Other spellings of the primary subject. */
  readonly aliases: readonly string[];
  readonly recordedAt: string;
  /** Digest of the request, placement included, so a resend with other content is refused. */
  readonly inputDigest: string;
  /** Where the observation belongs and how far it may travel; checked against stored data. */
  readonly placement: ObservationPlacement;
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

interface StoredObservation extends Omit<Observation, 'label' | 'placement'> {
  /** Absent on observations stored before labels existed; read through {@link labelOf}. */
  readonly label?: readonly string[];
  /** Absent before placements existed; read through {@link placementOf}. */
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly scope?: ObservationPlacement['scope'];
  readonly derivedFrom?: readonly string[];
  readonly scopeApproval?: ObservationPlacement['scopeApproval'];
  /** Effective time when known, otherwise the recorded time; the order key of timelines. */
  readonly at: string;
  readonly inputDigest: string;
  readonly sequence: number;
  readonly arrival: StoredArrival | null;
  readonly suppressed?: boolean;
  readonly legacyRecordId?: string;
}

/** The current label of a stored observation (ADR 0012). */
function labelOf(stored: Pick<StoredObservation, 'label' | 'compartmentIds'>): string[] {
  return storedLabel(stored.label, stored.compartmentIds);
}

/** A label as one string, for alias and link records: `shared` for `[]`. */
function labelKey(label: readonly string[]): string {
  return label.length === 0 ? 'shared' : [...label].sort().join('|');
}

function keyLabel(key: string): string[] {
  return key === 'shared' ? [] : key.split('|');
}

/**
 * The subjects an alias names that a reader may see. Each subject of an alias keeps the labels
 * of the writes that gave the alias that subject; an entry written before labels existed reads
 * as the Inbox.
 */
function visibleAliasSubjects(
  data: DocumentData | undefined,
  allowance: readonly string[],
): string[] {
  const subjectIds: unknown = data?.['subjectIds'];
  if (!Array.isArray(subjectIds)) return [];
  const labels: unknown = data?.['labels'];
  return (subjectIds as unknown[]).filter((subjectId): subjectId is string => {
    if (typeof subjectId !== 'string') return false;
    const keys: unknown =
      typeof labels === 'object' && labels !== null
        ? (labels as Record<string, unknown>)[subjectId]
        : undefined;
    if (!Array.isArray(keys)) return labelVisible(['inbox'], allowance);
    return keys.some((key) => typeof key === 'string' && labelVisible(keyLabel(key), allowance));
  });
}

/** The placement of a stored observation; one stored before placements existed is in the Inbox. */
function placementOf(stored: StoredObservation): ObservationPlacement {
  const scope = stored.scope;
  if (
    scope === undefined ||
    typeof scope !== 'object' ||
    !['project', 'workspace', 'shared', 'inbox'].includes(scope.kind)
  )
    return INBOX_PLACEMENT;
  return {
    workspaceId: stored.workspaceId ?? null,
    projectId: stored.projectId ?? null,
    scope: { ...scope },
    derivedFrom: [...(stored.derivedFrom ?? [])],
    scopeApproval: stored.scopeApproval ?? null,
  };
}

/** A stored observation with its current label and placement, usable wherever one is. */
type LabeledObservation = StoredObservation & {
  readonly label: readonly string[];
  readonly placement: ObservationPlacement;
};

function withLabel(stored: StoredObservation): LabeledObservation {
  return { ...stored, label: labelOf(stored), placement: placementOf(stored) };
}

/** The labels of several observations joined, as a topic or derived document carries them. */
function joinedLabel(
  members: readonly Pick<StoredObservation, 'label' | 'compartmentIds'>[],
): string[] {
  return [...new Set(members.flatMap(labelOf))].sort();
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
  /** The members' labels joined; absent on topics stored before labels existed. */
  readonly label?: readonly string[];
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
  /** The observation's current label; it decides who may find the entry. */
  readonly label: readonly string[];
  readonly placement: ObservationPlacement;
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

/** A project as callers see it, with its path from the current hierarchy. */
export interface ProjectView {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly description: string;
  /** Names from the top of the workspace down to this project. */
  readonly path: readonly string[];
  readonly depth: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A granted workspace with its project hierarchy. */
export interface WorkspaceProjects {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Increases with every change to the workspace's projects. */
  readonly revision: number;
  readonly projects: readonly ProjectView[];
  /** True when the workspace holds more projects than one read returns. */
  readonly truncated: boolean;
}

/** One change to a workspace's projects. `parentId: null` moves a project to the top. */
export type ProjectChange =
  | {
      readonly action: 'create';
      readonly workspaceId: string;
      readonly parentId: string | null;
      readonly name: string;
      readonly description?: string;
    }
  | {
      readonly action: 'update';
      readonly projectId: string;
      readonly name?: string;
      readonly description?: string;
      readonly parentId?: string | null;
    }
  | { readonly action: 'delete'; readonly projectId: string };

/** One message for every placement that is not available, so none reveals what exists. */
const PLACEMENT_UNAVAILABLE = 'The workspace, project or scope is not available';

/** Projects read for one workspace; a workspace beyond it is reported as truncated. */
const MAX_PROJECTS_PER_WORKSPACE = 500;
const MAX_WORKSPACES = 200;

function parseProject(value: unknown): ProjectNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data['id'] !== 'string' ||
    !PROJECT_ID.test(data['id']) ||
    typeof data['workspaceId'] !== 'string' ||
    !(data['parentId'] === null || typeof data['parentId'] === 'string') ||
    typeof data['name'] !== 'string' ||
    typeof data['normalizedName'] !== 'string' ||
    typeof data['description'] !== 'string' ||
    typeof data['createdAt'] !== 'string' ||
    typeof data['updatedAt'] !== 'string'
  )
    return null;
  return {
    id: data['id'],
    workspaceId: data['workspaceId'],
    parentId: data['parentId'],
    name: data['name'],
    normalizedName: data['normalizedName'],
    description: data['description'],
    createdAt: data['createdAt'],
    updatedAt: data['updatedAt'],
  };
}

function projectView(tree: ProjectTree, node: ProjectNode): ProjectView {
  return {
    id: node.id,
    workspaceId: node.workspaceId,
    parentId: node.parentId,
    name: node.name,
    description: node.description,
    path: tree.path(node.id),
    depth: tree.depth(node.id),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

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
    label: labelOf(stored),
    placement: placementOf(stored),
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
    const { placement } = request;
    if (input.compartmentIds.length > 0)
      throw new MemoryRepositoryError(
        'invalid_change_set',
        'Compartments are not written directly; give a workspace',
      );
    const placementShape = placementProblems(placement);
    if (placementShape.length > 0)
      throw new MemoryRepositoryError('invalid_change_set', placementShape.join('; '));
    const label = labelForPlacement(placement);
    // An unknown workspace and one outside the allowance read the same.
    if (
      (placement.workspaceId !== null &&
        !labelVisible([placement.workspaceId], actor.compartmentAllowance)) ||
      // Without a workspace an observation belongs to the Inbox, Shared or not, so writing it
      // needs the Inbox grant.
      (placement.workspaceId === null && !labelVisible(['inbox'], actor.compartmentAllowance))
    )
      throw new MemoryRepositoryError('invalid_change_set', PLACEMENT_UNAVAILABLE);
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
      await this.assertPlacement(transaction, actor, scopeId, placement);
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
        label,
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
        compartmentIds: [],
        label,
        workspaceId: placement.workspaceId,
        projectId: placement.projectId,
        scope: { ...placement.scope },
        derivedFrom: [...placement.derivedFrom],
        scopeApproval: placement.scopeApproval === null ? null : { ...placement.scopeApproval },
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
          !labelVisible(labelOf(stored), actor.compartmentAllowance) ||
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
          .map(withLabel)
          .filter((member) => member.suppressed !== true && !writerSuppressed(member));
        const all = [...members, withLabel(observation)];
        const computed = computeCourse(all, new Set(), request.recordedAt);
        // The writer learns how its observation stands only among the members it may see, so a
        // relation never reveals an observation of a workspace outside its allowance. The topic
        // document keeps the full view, which every read recomputes for a narrower reader.
        const visibleToWriter = members.filter((member) =>
          labelVisible(member.label, actor.compartmentAllowance),
        );
        arrival = arrivalRelation(
          computeCourse(
            [...visibleToWriter, withLabel(observation)],
            new Set(),
            request.recordedAt,
          ),
          withLabel(observation),
        );
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
            label: joinedLabel(all),
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
        label: observation.label,
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
    label: readonly string[],
  ): Promise<{
    resolved: string[];
    primaryResolved: boolean;
    ambiguous: string[];
    aliasConflicts: string[];
    writes: { ref: DocumentReference; data: Record<string, unknown> }[];
  }> {
    const key = labelKey(label);
    const allowance = actor.compartmentAllowance;
    const writes: { ref: DocumentReference; data: Record<string, unknown> }[] = [];
    const resolved: string[] = [];
    const ambiguous: string[] = [];
    const aliasConflicts: string[] = [];
    // An alias entry is added, never replaced, so entries of other workspaces stay as they are.
    const aliasWrite = (normalized: string, subjectId: string) => ({
      ref: this.aliasRef(actor, scopeId, normalized),
      data: {
        name: normalized,
        subjectIds: FieldValue.arrayUnion(subjectId),
        labels: { [subjectId]: FieldValue.arrayUnion(key) },
      },
    });
    const lookups = await Promise.all(
      names.map(async (name) => {
        const trimmed = name.trim();
        if (SUBJECT_ID.test(trimmed)) {
          // A subject ID names a subject only where a visible observation names it, so an ID
          // reveals nothing about subjects outside the allowance.
          if (!(await this.subjectVisible(actor, scopeId, trimmed, transaction)))
            throw new MemoryRepositoryError('invalid_change_set', 'Unknown subject ID');
          return { name: trimmed, subjectIds: [trimmed], normalized: null as string | null };
        }
        const normalized = normalizeLabel(trimmed);
        const alias = await transaction.get(this.aliasRef(actor, scopeId, normalized));
        return {
          name: trimmed,
          normalized,
          subjectIds: visibleAliasSubjects(alias.data(), allowance),
        };
      }),
    );
    const extra = [...new Set(aliases.map(normalizeLabel).filter((alias) => alias.length > 0))];
    const extraDocs = await Promise.all(
      extra.map((alias) => transaction.get(this.aliasRef(actor, scopeId, alias))),
    );
    const created = lookups.filter(
      (lookup) => lookup.subjectIds.length === 0 && lookup.normalized !== null,
    );
    const existingSubjects = await Promise.all(
      created.map((lookup) =>
        transaction.get(
          this.subjectRef(
            actor,
            scopeId,
            `sub_${digest(['subject', actor.tenantId, scopeId, lookup.normalized!]).slice(0, 32)}`,
          ),
        ),
      ),
    );
    let primaryResolved = false;
    lookups.forEach((lookup, index) => {
      let subjectId: string | undefined;
      if (lookup.subjectIds.length === 1) {
        subjectId = lookup.subjectIds[0];
        if (lookup.normalized !== null) writes.push(aliasWrite(lookup.normalized, subjectId!));
      } else if (lookup.subjectIds.length === 0 && lookup.normalized !== null) {
        subjectId = `sub_${digest(['subject', actor.tenantId, scopeId, lookup.normalized]).slice(0, 32)}`;
        // The subject document is an identity shared by every label; an existing one is kept.
        if (existingSubjects[created.indexOf(lookup)]?.exists !== true)
          writes.push({
            ref: this.subjectRef(actor, scopeId, subjectId),
            data: { id: subjectId, name: lookup.name, createdAt: now },
          });
        writes.push(aliasWrite(lookup.normalized, subjectId));
      } else ambiguous.push(lookup.name);
      if (subjectId !== undefined) {
        if (index === 0) primaryResolved = true;
        if (!resolved.includes(subjectId)) resolved.push(subjectId);
      }
    });
    const primary = primaryResolved ? resolved[0] : undefined;
    if (primary !== undefined)
      extra.forEach((alias, index) => {
        const current = visibleAliasSubjects(extraDocs[index]?.data(), allowance);
        // Writes queued above for the same alias already point at the primary subject.
        if (writes.some((write) => write.data['name'] === alias)) return;
        if (current.length === 0 || current.includes(primary))
          writes.push(aliasWrite(alias, primary));
        else aliasConflicts.push(alias);
      });
    return { resolved, primaryResolved, ambiguous, aliasConflicts, writes };
  }

  /**
   * Whether a visible observation names a subject, or, for a topic key, belongs to the topic.
   * The scan is bounded; a subject named only beyond it reads as not visible.
   */
  private async subjectVisible(
    actor: VerifiedActorCapability,
    scopeId: string,
    member: string,
    transaction?: Transaction,
    kind: LinkKind = 'same-subject',
  ): Promise<boolean> {
    const query = this.observationCollection(actor, scopeId)
      .where(
        kind === 'same-subject' ? 'subjectIds' : 'topicKey',
        kind === 'same-subject' ? 'array-contains' : '==',
        member,
      )
      .limit(MEMBER_VISIBILITY_SCAN);
    const snapshot = transaction === undefined ? await query.get() : await transaction.get(query);
    return snapshot.docs.some((document) => {
      const stored: unknown = document.data();
      return (
        isStoredObservation(stored) &&
        stored.suppressed !== true &&
        labelVisible(labelOf(stored), actor.compartmentAllowance)
      );
    });
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
      const subjectIds = visibleAliasSubjects(document.data(), actor.compartmentAllowance);
      if (subjectIds.length > 0) result.set(lookups[index]!, subjectIds);
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
    // A subject is named only where a visible observation names it.
    const visible = await Promise.all(
      documents.map((document) =>
        document.exists ? this.subjectVisible(actor, scopeId, document.id) : Promise.resolve(false),
      ),
    );
    return documents
      .filter((document, index) => document.exists && visible[index] === true)
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
    // An observation whose label the worker may not read stays queued and unindexed; it is
    // still found through its subject and topic.
    if (!labelVisible(labelOf(stored), actor.compartmentAllowance)) return null;
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
      !entry.label.every(nonempty) ||
      !labelVisible(entry.label, actor.compartmentAllowance)
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
        label: [...new Set(entry.label)].sort(),
        workspaceId: entry.placement.workspaceId,
        projectId: entry.placement.projectId,
        scopeKind: entry.placement.scope.kind,
        scopeProjectId:
          entry.placement.scope.kind === 'project' ? entry.placement.scope.projectId : null,
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
          labelVisible(
            storedLabel(document.get('label'), document.get('compartmentIds')),
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
          labelVisible(
            storedLabel(document.get('label'), document.get('compartmentIds')),
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

  /**
   * Every change-feed entry is read with the observation ledger's labels: an entry written
   * before labels existed, record and deletion entries included, reads as an Inbox item.
   */
  protected override changeEntryLabel(entry: ChangeFeedEntry): readonly string[] {
    return storedLabel(entry.label, entry.compartmentIds);
  }

  // ---- Projects -----------------------------------------------------------------------------

  /** The granted workspaces and their project hierarchies. */
  async listProjects(
    actor: VerifiedActorCapability,
    scopeId: string,
  ): Promise<WorkspaceProjects[]> {
    await this.readContext(actor, scopeId);
    const workspaces = await this.scopeRef(actor, scopeId)
      .collection('workspaces')
      .limit(MAX_WORKSPACES)
      .get();
    const granted = workspaces.docs.filter((document) =>
      labelVisible([document.id], actor.compartmentAllowance),
    );
    return Promise.all(
      granted.map(async (document) => {
        const [projects, state] = await Promise.all([
          this.projectQuery(actor, scopeId, document.id).get(),
          this.projectStateRef(actor, scopeId, document.id).get(),
        ]);
        const nodes = projects.docs
          .map((item) => parseProject(item.data()))
          .filter((item) => item !== null);
        const tree = new ProjectTree(nodes);
        return {
          id: document.id,
          name: String(document.get('name')),
          description: String(document.get('description') ?? ''),
          revision: Number(state.get('revision') ?? 0),
          projects: nodes
            .map((node) => projectView(tree, node))
            .sort((left, right) =>
              left.path.join('\u0000').localeCompare(right.path.join('\u0000')),
            ),
          truncated: projects.size >= MAX_PROJECTS_PER_WORKSPACE,
        };
      }),
    );
  }

  /**
   * Creates, renames, describes, moves or deletes a project of a granted workspace. One
   * transaction rechecks the actor's authorization, the hierarchy rules and, for a delete, that
   * no observation's current project or project scope refers to it, then appends the access
   * history and increases the workspace's project revision.
   */
  async changeProject(
    actor: VerifiedActorCapability,
    scopeId: string,
    change: ProjectChange,
  ): Promise<{ project: ProjectView | null; revision: number }> {
    assertActor(actor, scopeId);
    if (actor.actorKind === 'worker')
      throw new MemoryRepositoryError('authorization_denied', 'A worker cannot change projects');
    const textProblems =
      change.action === 'delete'
        ? []
        : projectTextProblems({
            ...(change.name === undefined ? {} : { name: change.name }),
            ...(change.description === undefined ? {} : { description: change.description }),
          });
    if (textProblems.length > 0)
      throw new MemoryRepositoryError('invalid_change_set', textProblems.join('; '));
    await this.assertRestoreReady(actor, scopeId);
    const scope = this.scopeRef(actor, scopeId);
    const now = new Date().toISOString();
    return this.firestore.runTransaction(async (transaction) => {
      const auth = await transaction.get(this.authorizationRef(actor, scopeId));
      this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
      let existing: ProjectNode | null = null;
      let workspaceId: string;
      if (change.action === 'create') {
        workspaceId = change.workspaceId;
      } else {
        if (!PROJECT_ID.test(change.projectId))
          throw new MemoryRepositoryError('not_found', 'Project was not found');
        existing = parseProject(
          (await transaction.get(scope.collection('projects').doc(change.projectId))).data(),
        );
        if (existing === null)
          throw new MemoryRepositoryError('not_found', 'Project was not found');
        workspaceId = existing.workspaceId;
      }
      // An unknown workspace and one outside the allowance read the same.
      if (
        !WORKSPACE_ID.test(workspaceId) ||
        !labelVisible([workspaceId], actor.compartmentAllowance)
      )
        throw new MemoryRepositoryError(
          change.action === 'create' ? 'invalid_change_set' : 'not_found',
          change.action === 'create' ? 'Unknown workspace' : 'Project was not found',
        );
      const [workspace, projects, state] = await Promise.all([
        transaction.get(scope.collection('workspaces').doc(workspaceId)),
        transaction.get(this.projectQuery(actor, scopeId, workspaceId)),
        transaction.get(this.projectStateRef(actor, scopeId, workspaceId)),
      ]);
      if (!workspace.exists)
        throw new MemoryRepositoryError('invalid_change_set', 'Unknown workspace');
      if (projects.size >= MAX_PROJECTS_PER_WORKSPACE)
        throw new MemoryRepositoryError(
          'invalid_change_set',
          'The workspace has too many projects',
        );
      const tree = new ProjectTree(
        projects.docs.map((item) => parseProject(item.data())).filter((item) => item !== null),
      );
      const revision = Number(state.get('revision') ?? 0) + 1;
      let after: ProjectNode | null = null;

      if (change.action === 'create') {
        const name = change.name.trim();
        const normalizedName = normalizeProjectName(name);
        const parentId = change.parentId;
        if (parentId !== null && !PROJECT_ID.test(parentId))
          throw new MemoryRepositoryError(
            'invalid_change_set',
            'parent is not a project of this workspace',
          );
        const problems = tree.createProblems(parentId, normalizedName);
        if (problems.length > 0) throw this.projectProblem(problems);
        const nameRef = this.projectNameRef(actor, scopeId, workspaceId, parentId, normalizedName);
        if ((await transaction.get(nameRef)).exists)
          throw this.projectProblem(['a project with this name exists under the same parent']);
        after = {
          id: `prj_${randomBytes(16).toString('hex')}`,
          workspaceId,
          parentId,
          name,
          normalizedName,
          description: change.description?.trim() ?? '',
          createdAt: now,
          updatedAt: now,
        };
        transaction.create(scope.collection('projects').doc(after.id), after);
        transaction.create(nameRef, { projectId: after.id });
      } else if (change.action === 'update') {
        const current = existing!;
        const name = change.name?.trim() ?? current.name;
        const normalizedName = normalizeProjectName(name);
        const parentId = change.parentId === undefined ? current.parentId : change.parentId;
        if (parentId !== null && !PROJECT_ID.test(parentId))
          throw new MemoryRepositoryError(
            'invalid_change_set',
            'parent is not a project of this workspace',
          );
        const problems = tree.updateProblems(current.id, parentId, normalizedName);
        if (problems.length > 0) throw this.projectProblem(problems);
        after = {
          ...current,
          name,
          normalizedName,
          parentId,
          description: change.description?.trim() ?? current.description,
          updatedAt: now,
        };
        if (parentId !== current.parentId || normalizedName !== current.normalizedName) {
          const nameRef = this.projectNameRef(
            actor,
            scopeId,
            workspaceId,
            parentId,
            normalizedName,
          );
          if ((await transaction.get(nameRef)).exists)
            throw this.projectProblem(['a project with this name exists under the same parent']);
          transaction.delete(
            this.projectNameRef(
              actor,
              scopeId,
              workspaceId,
              current.parentId,
              current.normalizedName,
            ),
          );
          transaction.create(nameRef, { projectId: current.id });
        }
        transaction.set(scope.collection('projects').doc(current.id), after);
      } else {
        const current = existing!;
        const [byProject, byScope] = await Promise.all([
          transaction.get(
            this.observationCollection(actor, scopeId)
              .where('projectId', '==', current.id)
              .limit(1),
          ),
          transaction.get(
            this.observationCollection(actor, scopeId)
              .where('scope.projectId', '==', current.id)
              .limit(1),
          ),
        ]);
        if (tree.childrenOf(current.id).length > 0 || !byProject.empty || !byScope.empty)
          throw new MemoryRepositoryError(
            'project_in_use',
            'The project has child projects or observations; move or classify them first',
          );
        transaction.delete(scope.collection('projects').doc(current.id));
        transaction.delete(
          this.projectNameRef(
            actor,
            scopeId,
            workspaceId,
            current.parentId,
            current.normalizedName,
          ),
        );
      }
      transaction.set(this.projectStateRef(actor, scopeId, workspaceId), { revision });
      transaction.create(scope.collection('accessHistory').doc(), {
        operation: `${change.action}-project`,
        target: after?.id ?? existing!.id,
        before: existing,
        after,
        writer: actor.principalId,
        note: '',
        at: now,
      });
      if (after === null) return { project: null, revision };
      const updated = new ProjectTree([
        ...tree.nodes.filter((node) => node.id !== after!.id),
        after,
      ]);
      return { project: projectView(updated, after), revision };
    });
  }

  /**
   * Checks a placement against stored data inside the write transaction: the workspace exists,
   * the project belongs to it, a project scope is the project or one of its current ancestors,
   * and every observation it was derived from is visible to the writer.
   */
  private async assertPlacement(
    transaction: Transaction,
    actor: VerifiedActorCapability,
    scopeId: string,
    placement: ObservationPlacement,
  ): Promise<void> {
    const { workspaceId, projectId, scope } = placement;
    const scopeRef = this.scopeRef(actor, scopeId);
    const [workspace, projects, derived] = await Promise.all([
      workspaceId === null
        ? Promise.resolve(null)
        : transaction.get(scopeRef.collection('workspaces').doc(workspaceId)),
      workspaceId === null || (projectId === null && scope.kind !== 'project')
        ? Promise.resolve(null)
        : transaction.get(this.projectQuery(actor, scopeId, workspaceId)),
      Promise.all(
        placement.derivedFrom.map((observationId) =>
          transaction.get(this.observationRef(actor, scopeId, observationId)),
        ),
      ),
    ]);
    if (workspace !== null && !workspace.exists)
      throw new MemoryRepositoryError('invalid_change_set', PLACEMENT_UNAVAILABLE);
    if (projects !== null && projectId !== null) {
      const tree = new ProjectTree(
        projects.docs.map((item) => parseProject(item.data())).filter((item) => item !== null),
      );
      const reach = [projectId, ...tree.ancestors(projectId).map((node) => node.id)];
      if (
        tree.get(projectId) === undefined ||
        (scope.kind === 'project' && !reach.includes(scope.projectId))
      )
        throw new MemoryRepositoryError('invalid_change_set', PLACEMENT_UNAVAILABLE);
    }
    for (const document of derived) {
      const stored: unknown = document.data();
      if (
        !isStoredObservation(stored) ||
        stored.suppressed === true ||
        !labelVisible(labelOf(stored), actor.compartmentAllowance)
      )
        throw new MemoryRepositoryError(
          'invalid_change_set',
          'An observation in derived_from was not found',
        );
    }
  }

  private projectProblem(problems: readonly string[]): MemoryRepositoryError {
    return new MemoryRepositoryError('project_conflict', problems.join('; '));
  }

  private projectQuery(actor: VerifiedActorCapability, scopeId: string, workspaceId: string) {
    return this.scopeRef(actor, scopeId)
      .collection('projects')
      .where('workspaceId', '==', workspaceId)
      .limit(MAX_PROJECTS_PER_WORKSPACE);
  }

  private projectStateRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    workspaceId: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId).collection('projectState').doc(workspaceId);
  }

  private projectNameRef(
    actor: VerifiedActorCapability,
    scopeId: string,
    workspaceId: string,
    parentId: string | null,
    normalizedName: string,
  ): DocumentReference {
    return this.scopeRef(actor, scopeId)
      .collection('projectNames')
      .doc(digest(['project-name', workspaceId, parentId ?? '', normalizedName]));
  }

  /** Declares two subjects, or two topics, the same. The link can be revoked; nothing merges. */
  async link(
    actor: VerifiedActorCapability,
    scopeId: string,
    request: {
      readonly kind: LinkKind;
      readonly members: readonly [string, string];
      readonly at: string;
      readonly revoke: boolean;
      /** The label of the write; it decides who reads through the link. */
      readonly label: readonly string[];
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
    if (!request.label.every(nonempty) || !labelVisible(request.label, actor.compartmentAllowance))
      throw new MemoryRepositoryError('invalid_change_set', PLACEMENT_UNAVAILABLE);
    const key = labelKey(request.label);
    // An Inbox link keeps the ID links had before labels existed, so it stays one document.
    const linkId = (
      key === 'inbox' ? digest([request.kind, members]) : digest([request.kind, members, key])
    ).slice(0, 40);
    const linkRef = this.scopeRef(actor, scopeId).collection('links').doc(linkId);
    return this.firestore.runTransaction(async (transaction) => {
      const [auth, ...targets] = await Promise.all([
        transaction.get(this.authorizationRef(actor, scopeId)),
        ...refs.map((ref) => transaction.get(ref)),
      ]);
      this.assertCurrentAuthorization(actor, auth.data() as AuthorizationDocument | undefined);
      const visible = await Promise.all(
        members.map((member) =>
          this.subjectVisible(actor, scopeId, member, transaction, request.kind),
        ),
      );
      // A member outside the allowance reads exactly like one that does not exist.
      if (targets.some((target) => !target.exists) || visible.some((item) => !item))
        throw new MemoryRepositoryError('not_found', 'A member of the link was not found');
      transaction.set(
        linkRef,
        {
          kind: request.kind,
          members,
          label: [...request.label],
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
        !labelVisible(labelOf(observation), actor.compartmentAllowance)
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
        // A deletion marker is content-free, but its presence is disclosed only where the
        // forgotten observation was visible.
        label: labelOf(observation),
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
        .map(withLabel)
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
        label: joinedLabel(members),
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
        labelForCompartments(record.compartmentIds),
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
        label: labelForCompartments(record.compartmentIds),
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
      labelVisible(labelOf(observation), actor.compartmentAllowance) &&
      !observation.sources.some((source) => revoked.has(observationSourceKey(source))) &&
      !context.writerSuppressed(withLabel(observation))
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
        // A link written before labels existed reads as an Inbox link.
        if (
          !labelVisible(storedLabel(document.get('label'), undefined), actor.compartmentAllowance)
        )
          continue;
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
      labelVisible(storedLabel(topic.label, topic.compartmentIds), actor.compartmentAllowance)
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
