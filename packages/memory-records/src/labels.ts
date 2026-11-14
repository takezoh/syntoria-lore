/**
 * Workspace labels (ADR 0012). An observation's label is the compartment set the ledger checks:
 * `[workspaceId]` for an observation in a workspace, `["inbox"]` for one without a workspace,
 * and `[]` for a Shared observation, which every connection may read.
 */

/** The reserved compartment of observations that have no workspace yet. */
export const INBOX = 'inbox';

/** The reserved allowance entry that grants every workspace, including ones created later. */
export const ALL_WORKSPACES = 'workspaces:all';

/** Workspace IDs are opaque: `wsp_` and 32 lower-case hexadecimal digits. */
export const WORKSPACE_ID = /^wsp_[a-f0-9]{32}$/u;

const nonempty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** True when every compartment of the label is within the allowance. */
export function labelVisible(label: readonly string[], allowance: readonly string[]): boolean {
  const allowed = new Set(allowance);
  const everyWorkspace = allowed.has(ALL_WORKSPACES);
  return label.every(
    (compartment) => allowed.has(compartment) || (everyWorkspace && WORKSPACE_ID.test(compartment)),
  );
}

/**
 * The current label of a stored observation, index entry, topic or change-feed entry. A document
 * written before labels existed reads as its compartments, or as the Inbox when it has none, so
 * that existing General observations become Inbox items and nothing is widened.
 */
export function storedLabel(label: unknown, compartmentIds: unknown): string[] {
  if (Array.isArray(label) && label.every(nonempty)) return [...new Set(label)].sort();
  if (Array.isArray(compartmentIds) && compartmentIds.length > 0 && compartmentIds.every(nonempty))
    return [...new Set(compartmentIds)].sort();
  return [INBOX];
}

/** The label a new observation gets from the compartments it was written with. */
export function labelForCompartments(compartmentIds: readonly string[]): string[] {
  return compartmentIds.length === 0 ? [INBOX] : [...new Set(compartmentIds)].sort();
}
