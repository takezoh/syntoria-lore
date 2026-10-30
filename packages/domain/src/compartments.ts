import {
  bindActorAuthorizationGuard,
  CoreError,
  getActorAuthorizationGuard,
  uuidSchema,
  type ActorContext,
} from '@memory/contracts';
import type { PoolClient } from 'pg';

/** The reserved compartment that labels every record created before compartments existed. */
export const UNCLASSIFIED_COMPARTMENT_ID = '00000000-0000-4000-8000-000000000001';

/** How a memory version's label was set. */
export type LabelOrigin =
  | 'explicit'
  | 'default'
  | 'held'
  | 'inherited'
  | 'derived'
  | 'reclassified'
  | 'relaxed'
  | 'imported';

export interface WriteLabel {
  readonly ids: readonly string[];
  readonly origin: LabelOrigin;
  /** True when a General write was kept in the connection's compartments. */
  readonly held: boolean;
}

export function normalizeCompartmentName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** A canonical label: sorted and without duplicates. The empty label is General. */
export function canonicalLabel(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

export function unionLabels(...labels: readonly (readonly string[])[]): string[] {
  return canonicalLabel(labels.flat());
}

export function isSubsetLabel(label: readonly string[], of: readonly string[]): boolean {
  return label.every((id) => of.includes(id));
}

/** The compartments an actor may use, or null when it may use every compartment of the user. */
export function allowanceIds(actor: ActorContext): readonly string[] | null {
  return actor.compartments.kind === 'all' ? null : actor.compartments.ids;
}

export function compartmentNotAvailable(): CoreError {
  return new CoreError(
    403,
    'compartment_not_available',
    'A named compartment does not exist or is not available to this connection',
  );
}

/**
 * Resolves compartment IDs or names to IDs the actor may use. A compartment that does not exist
 * and one outside the actor's allowance return the same error.
 */
export async function resolveCompartments(
  client: PoolClient,
  actor: ActorContext,
  refs: readonly string[],
): Promise<string[]> {
  if (refs.length === 0) return [];
  const ids = refs
    .filter((ref) => uuidSchema.safeParse(ref).success)
    .map((ref) => ref.toLowerCase());
  const names = refs
    .filter((ref) => !uuidSchema.safeParse(ref).success)
    .map(normalizeCompartmentName);
  const rows = await client.query<{ id: string; normalized_name: string }>(
    `SELECT id::text AS id, normalized_name FROM compartments
     WHERE user_id = $1 AND (id = ANY($2::uuid[]) OR normalized_name = ANY($3::text[]))`,
    [actor.userId, ids, names],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row.id]));
  const byName = new Map(rows.rows.map((row) => [row.normalized_name, row.id]));
  const allowance = allowanceIds(actor);
  const resolved: string[] = [];
  for (const ref of refs) {
    const id = uuidSchema.safeParse(ref).success
      ? byId.get(ref.toLowerCase())
      : byName.get(normalizeCompartmentName(ref));
    if (id === undefined || (allowance !== null && !allowance.includes(id))) {
      throw compartmentNotAvailable();
    }
    resolved.push(id);
  }
  return canonicalLabel(resolved);
}

/**
 * The label a write receives before it joins the labels of its evidence. A connection's default
 * is its allowance; a General write from a connection that holds compartments is held in them.
 * Worker and system writes take their label from their evidence.
 */
export function resolveWriteLabel(
  actor: ActorContext,
  requested: readonly string[] | undefined,
): WriteLabel {
  const allowance = allowanceIds(actor);
  if (allowance === null) {
    return requested === undefined
      ? { ids: [], origin: 'derived', held: false }
      : { ids: canonicalLabel(requested), origin: 'explicit', held: false };
  }
  if (requested === undefined) {
    return { ids: canonicalLabel(allowance), origin: 'default', held: false };
  }
  if (requested.length === 0 && allowance.length > 0) {
    return { ids: canonicalLabel(allowance), origin: 'held', held: true };
  }
  return { ids: canonicalLabel(requested), origin: 'explicit', held: false };
}

/**
 * The same actor, limited to the named compartments of its allowance for one read. General
 * records remain visible. The actor's commit revalidation carries over.
 */
export function narrowActor(actor: ActorContext, compartmentIds: readonly string[]): ActorContext {
  const allowance = allowanceIds(actor);
  const ids = canonicalLabel(
    allowance === null ? compartmentIds : compartmentIds.filter((id) => allowance.includes(id)),
  );
  const narrowed: ActorContext = Object.freeze({
    ...actor,
    compartments: Object.freeze({
      kind: 'allowance' as const,
      ids: Object.freeze(ids),
      epoch: actor.compartments.kind === 'allowance' ? actor.compartments.epoch : 0,
    }),
  });
  const guard = getActorAuthorizationGuard(actor);
  if (guard !== undefined) bindActorAuthorizationGuard(narrowed, guard);
  return narrowed;
}
