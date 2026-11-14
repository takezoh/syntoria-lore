/**
 * Queries over where observations belong (ADR 0012, docs/design/memory-workspaces.md). The
 * grammar follows the classification leaves of Weave's perspective query version 2: `and`, `or`
 * and `not` over leaves with `eq`, `ne`, `in` and `not_in`, `null` for unassigned, and
 * `include_descendants` defaulting to true. A query selects what a request returns; it is never
 * a disclosure boundary, which the connection's allowance alone decides.
 */
import type { ObservationPlacement, ObservationScope } from './observations.js';

export const QUERY_LIMITS = Object.freeze({ maxDepth: 8, maxNodes: 64, maxIds: 64 });

const WORKSPACE_ID = /^wsp_[a-f0-9]{32}$/u;
const PROJECT_ID = /^prj_[a-f0-9]{32}$/u;
const SCOPE_KINDS: readonly ObservationScope['kind'][] = [
  'project',
  'workspace',
  'shared',
  'inbox',
];

export type PlaceField = 'workspace_id' | 'project_id';

export type QueryNode =
  | { readonly and: readonly QueryNode[] }
  | { readonly or: readonly QueryNode[] }
  | { readonly not: QueryNode }
  | {
      readonly field: PlaceField;
      readonly op: 'eq' | 'ne' | 'in' | 'not_in';
      readonly values: readonly (string | null)[];
      readonly includeDescendants: boolean;
    }
  | {
      readonly field: 'scope';
      readonly op: 'eq' | 'in';
      readonly values: readonly ObservationScope['kind'][];
    }
  | { readonly field: 'usable_in'; readonly op: 'eq' | 'in'; readonly values: readonly string[] };

/** A query or context that is malformed, or that names a place the connection may not use. */
export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

/** One message for every place a connection may not use, so none reveals what exists. */
export const UNKNOWN_PLACE = 'Unknown workspace or project in the query';

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function exactKeys(record: Plain, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(record);
  if (
    required.some((key) => !(key in record)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new QueryError(`A query node has keys ${keys.join(', ') || 'none'}`);
}

/** Validates a query received as JSON. */
export function parseQuery(value: unknown): QueryNode {
  let nodes = 0;
  let ids = 0;
  const parse = (node: unknown, depth: number): QueryNode => {
    nodes += 1;
    if (depth > QUERY_LIMITS.maxDepth)
      throw new QueryError(`A query nests at most ${QUERY_LIMITS.maxDepth} levels`);
    if (nodes > QUERY_LIMITS.maxNodes)
      throw new QueryError(`A query has at most ${QUERY_LIMITS.maxNodes} nodes`);
    if (!isPlain(node)) throw new QueryError('A query node must be an object');
    if ('and' in node || 'or' in node) {
      const key = 'and' in node ? 'and' : 'or';
      exactKeys(node, [key]);
      const children = node[key];
      if (!Array.isArray(children) || children.length === 0)
        throw new QueryError(`${key} needs at least one condition`);
      const parsed = children.map((child) => parse(child, depth + 1));
      return key === 'and' ? { and: parsed } : { or: parsed };
    }
    if ('not' in node) {
      exactKeys(node, ['not']);
      return { not: parse(node['not'], depth + 1) };
    }
    const field = node['field'];
    const op = node['op'];
    const many = op === 'in' || op === 'not_in';
    exactKeys(node, ['field', 'op', many ? 'values' : 'value'], ['include_descendants']);
    const raw = many ? node['values'] : [node['value']];
    if (!Array.isArray(raw) || raw.length === 0)
      throw new QueryError('values must be a non-empty array');
    ids += raw.length;
    if (ids > QUERY_LIMITS.maxIds)
      throw new QueryError(`A query names at most ${QUERY_LIMITS.maxIds} values`);
    if (
      'include_descendants' in node &&
      (field !== 'project_id' || typeof node['include_descendants'] !== 'boolean')
    )
      throw new QueryError('include_descendants is a boolean of a project_id condition');
    if (field === 'workspace_id' || field === 'project_id') {
      if (op !== 'eq' && op !== 'ne' && op !== 'in' && op !== 'not_in')
        throw new QueryError(`${field} takes eq, ne, in or not_in`);
      const pattern = field === 'workspace_id' ? WORKSPACE_ID : PROJECT_ID;
      if (!raw.every((item) => item === null || (typeof item === 'string' && pattern.test(item))))
        throw new QueryError(
          `${field} values are ${field === 'workspace_id' ? 'wsp_' : 'prj_'}… IDs or null`,
        );
      return {
        field,
        op,
        values: raw as (string | null)[],
        includeDescendants: node['include_descendants'] !== false,
      };
    }
    if (field === 'scope') {
      if (op !== 'eq' && op !== 'in') throw new QueryError('scope takes eq or in');
      if (!raw.every((item) => SCOPE_KINDS.includes(item as ObservationScope['kind'])))
        throw new QueryError('scope values are project, workspace, shared or inbox');
      return { field, op, values: raw as ObservationScope['kind'][] };
    }
    if (field === 'usable_in') {
      if (op !== 'eq' && op !== 'in') throw new QueryError('usable_in takes eq or in');
      if (
        !raw.every(
          (item) => typeof item === 'string' && (WORKSPACE_ID.test(item) || PROJECT_ID.test(item)),
        )
      )
        throw new QueryError('usable_in values are workspace or project IDs');
      return { field, op, values: raw as string[] };
    }
    throw new QueryError('field is workspace_id, project_id, scope or usable_in');
  };
  return parse(value, 1);
}

/** The project hierarchy of the granted workspaces, as of this request. */
export interface PlaceHierarchy {
  hasWorkspace(workspaceId: string): boolean;
  /** The workspace of a project in a granted workspace; undefined otherwise. */
  workspaceOf(projectId: string): string | undefined;
  /** The project and its current descendants. */
  descendantsAndSelf(projectId: string): ReadonlySet<string>;
  /** The project and its current ancestors. */
  ancestorsAndSelf(projectId: string): ReadonlySet<string>;
}

/** Builds the hierarchy from granted workspaces and their projects. */
export function placeHierarchy(
  workspaces: readonly {
    readonly id: string;
    readonly projects: readonly { readonly id: string; readonly parentId: string | null }[];
  }[],
): PlaceHierarchy {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const workspaceOf = new Map<string, string>();
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const workspace of workspaces)
    for (const project of workspace.projects) {
      workspaceOf.set(project.id, workspace.id);
      parent.set(project.id, project.parentId);
      if (project.parentId !== null)
        children.set(project.parentId, [...(children.get(project.parentId) ?? []), project.id]);
    }
  return {
    hasWorkspace: (workspaceId) => workspaceIds.has(workspaceId),
    workspaceOf: (projectId) => workspaceOf.get(projectId),
    descendantsAndSelf(projectId) {
      const result = new Set<string>();
      const queue = [projectId];
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (result.has(next)) continue;
        result.add(next);
        queue.push(...(children.get(next) ?? []));
      }
      return result;
    },
    ancestorsAndSelf(projectId) {
      const result = new Set<string>();
      let current: string | null | undefined = projectId;
      while (current !== null && current !== undefined && !result.has(current)) {
        result.add(current);
        current = parent.get(current);
      }
      return result;
    },
  };
}

type Placement = Pick<ObservationPlacement, 'workspaceId' | 'projectId' | 'scope'>;

/**
 * Whether an observation may be used as a fact in a project or workspace: Shared, or in its
 * workspace with scope `workspace`, or with a project scope that is the project or one of its
 * current ancestors. For a workspace: Shared, or in it with scope `workspace`.
 */
export function usableIn(target: string, placement: Placement, hierarchy: PlaceHierarchy): boolean {
  const { scope, workspaceId } = placement;
  if (scope.kind === 'shared') return true;
  const targetWorkspace = PROJECT_ID.test(target) ? hierarchy.workspaceOf(target) : target;
  if (targetWorkspace === undefined || workspaceId !== targetWorkspace) return false;
  if (scope.kind === 'workspace') return true;
  return (
    scope.kind === 'project' &&
    PROJECT_ID.test(target) &&
    hierarchy.ancestorsAndSelf(target).has(scope.projectId)
  );
}

/** Rejects a place the connection may not use; one message for unknown and ungranted alike. */
export function assertKnownPlace(id: string, hierarchy: PlaceHierarchy): void {
  const known = PROJECT_ID.test(id)
    ? hierarchy.workspaceOf(id) !== undefined
    : hierarchy.hasWorkspace(id);
  if (!known) throw new QueryError(UNKNOWN_PLACE);
}

/** Turns a parsed query into a predicate over placements, checking every place it names. */
export function compileQuery(
  node: QueryNode,
  hierarchy: PlaceHierarchy,
): (placement: Placement) => boolean {
  if ('and' in node) {
    const parts = node.and.map((child) => compileQuery(child, hierarchy));
    return (placement) => parts.every((part) => part(placement));
  }
  if ('or' in node) {
    const parts = node.or.map((child) => compileQuery(child, hierarchy));
    return (placement) => parts.some((part) => part(placement));
  }
  if ('not' in node) {
    const inner = compileQuery(node.not, hierarchy);
    return (placement) => !inner(placement);
  }
  if (node.field === 'scope') {
    const kinds = new Set(node.values);
    return (placement) => kinds.has(placement.scope.kind);
  }
  if (node.field === 'usable_in') {
    node.values.forEach((id) => assertKnownPlace(id, hierarchy));
    return (placement) => node.values.some((id) => usableIn(id, placement, hierarchy));
  }
  for (const value of node.values) if (value !== null) assertKnownPlace(value, hierarchy);
  const negated = node.op === 'ne' || node.op === 'not_in';
  let matches: (placement: Placement) => boolean;
  if (node.field === 'workspace_id') {
    const wanted = new Set(node.values);
    matches = (placement) => wanted.has(placement.workspaceId);
  } else {
    const wantsNone = node.values.includes(null);
    const projects = new Set<string>();
    for (const value of node.values)
      if (value !== null)
        for (const id of node.includeDescendants ? hierarchy.descendantsAndSelf(value) : [value])
          projects.add(id);
    matches = (placement) =>
      placement.projectId === null ? wantsNone : projects.has(placement.projectId);
  }
  return negated ? (placement) => !matches(placement) : matches;
}
