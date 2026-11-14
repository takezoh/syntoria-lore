/**
 * The project hierarchy of a workspace (ADR 0012, docs/design/memory-workspaces.md): pure rules
 * for names, depth, cycles, paths, ancestors and descendants. Projects classify; they are not a
 * boundary. Paths are always computed from the current hierarchy and never stored elsewhere.
 */

/** Project IDs are opaque: `prj_` and 32 lower-case hexadecimal digits. */
export const PROJECT_ID = /^prj_[a-f0-9]{32}$/u;

/** A project and its ancestors span at most this many levels. */
export const MAX_PROJECT_DEPTH = 4;

export const MAX_PROJECT_NAME = 80;
export const MAX_PROJECT_DESCRIPTION = 500;

export interface ProjectNode {
  readonly id: string;
  readonly workspaceId: string;
  /** `null` for a project at the top of its workspace. */
  readonly parentId: string | null;
  readonly name: string;
  readonly normalizedName: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/** Names are compared after NFKC, case folding and whitespace collapsing. */
export function normalizeProjectName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Problems with a name or description; empty when they are acceptable. */
export function projectTextProblems(input: {
  readonly name?: string;
  readonly description?: string;
}): string[] {
  const problems: string[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === '' || [...name].length > MAX_PROJECT_NAME || hasControlCharacter(name))
      problems.push(`name must be printable text of 1 to ${MAX_PROJECT_NAME} characters`);
  }
  if (input.description !== undefined) {
    const description = input.description.trim();
    if ([...description].length > MAX_PROJECT_DESCRIPTION || hasControlCharacter(description))
      problems.push(
        `description must be printable text of at most ${MAX_PROJECT_DESCRIPTION} characters`,
      );
  }
  return problems;
}

/** A read-only view over one workspace's projects. */
export class ProjectTree {
  private readonly byId: ReadonlyMap<string, ProjectNode>;
  private readonly children: ReadonlyMap<string | null, readonly ProjectNode[]>;

  constructor(readonly nodes: readonly ProjectNode[]) {
    this.byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map<string | null, ProjectNode[]>();
    for (const node of nodes) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    for (const siblings of children.values())
      siblings.sort((left, right) => left.name.localeCompare(right.name));
    this.children = children;
  }

  get(projectId: string): ProjectNode | undefined {
    return this.byId.get(projectId);
  }

  childrenOf(projectId: string | null): readonly ProjectNode[] {
    return this.children.get(projectId) ?? [];
  }

  /** The ancestors of a project, nearest first; stops at a missing parent or a cycle. */
  ancestors(projectId: string): ProjectNode[] {
    const result: ProjectNode[] = [];
    const seen = new Set([projectId]);
    let parentId = this.byId.get(projectId)?.parentId ?? null;
    while (parentId !== null && !seen.has(parentId)) {
      const parent = this.byId.get(parentId);
      if (parent === undefined) break;
      result.push(parent);
      seen.add(parentId);
      parentId = parent.parentId;
    }
    return result;
  }

  /** Every descendant of a project, breadth first. */
  descendants(projectId: string): ProjectNode[] {
    const result: ProjectNode[] = [];
    const seen = new Set([projectId]);
    const queue = [...this.childrenOf(projectId)];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      result.push(node);
      queue.push(...this.childrenOf(node.id));
    }
    return result;
  }

  /** The level of a project: 1 at the top of its workspace. */
  depth(projectId: string): number {
    return this.ancestors(projectId).length + 1;
  }

  /** Levels below and including a project: 1 for a project without children. */
  height(projectId: string): number {
    const below = this.childrenOf(projectId).map((child) => this.height(child.id));
    return 1 + (below.length === 0 ? 0 : Math.max(...below));
  }

  /** The names from the top of the workspace down to the project. */
  path(projectId: string): string[] {
    const node = this.byId.get(projectId);
    if (node === undefined) return [];
    return [
      ...this.ancestors(projectId)
        .reverse()
        .map((item) => item.name),
      node.name,
    ];
  }

  /** Why a new project under `parentId` would be invalid; empty when it is valid. */
  createProblems(parentId: string | null, normalizedName: string): string[] {
    const problems: string[] = [];
    if (parentId !== null && this.byId.get(parentId) === undefined)
      problems.push('parent is not a project of this workspace');
    else if (parentId !== null && this.depth(parentId) + 1 > MAX_PROJECT_DEPTH)
      problems.push(`a workspace's projects have at most ${MAX_PROJECT_DEPTH} levels`);
    if (this.childrenOf(parentId).some((sibling) => sibling.normalizedName === normalizedName))
      problems.push('a project with this name exists under the same parent');
    return problems;
  }

  /** Why moving or renaming a project would be invalid; empty when it is valid. */
  updateProblems(projectId: string, parentId: string | null, normalizedName: string): string[] {
    const problems: string[] = [];
    if (this.byId.get(projectId) === undefined) return ['project is not in this workspace'];
    if (parentId !== null) {
      if (
        parentId === projectId ||
        this.descendants(projectId).some((node) => node.id === parentId)
      )
        problems.push('a project cannot move under itself or one of its descendants');
      else if (this.byId.get(parentId) === undefined)
        problems.push('parent is not a project of this workspace');
      else if (this.depth(parentId) + this.height(projectId) > MAX_PROJECT_DEPTH)
        problems.push(`a workspace's projects have at most ${MAX_PROJECT_DEPTH} levels`);
    } else if (this.height(projectId) > MAX_PROJECT_DEPTH) {
      problems.push(`a workspace's projects have at most ${MAX_PROJECT_DEPTH} levels`);
    }
    if (
      this.childrenOf(parentId).some(
        (sibling) => sibling.id !== projectId && sibling.normalizedName === normalizedName,
      )
    )
      problems.push('a project with this name exists under the same parent');
    return problems;
  }
}
