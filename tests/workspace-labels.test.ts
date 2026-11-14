import { describe, expect, it } from 'vitest';
import {
  ALL_WORKSPACES,
  allowanceForGrant,
  INBOX,
  labelForCompartments,
  labelVisible,
  normalizeWorkspaceName,
  storedLabel,
} from '../packages/memory-records/src/index.js';

const northwind = `wsp_${'a'.repeat(32)}`;
const cedar = `wsp_${'b'.repeat(32)}`;

describe('workspace labels', () => {
  it('shows a Shared label to every allowance and a workspace label only where granted', () => {
    expect(labelVisible([], [])).toBe(true);
    expect(labelVisible([northwind], [northwind])).toBe(true);
    expect(labelVisible([northwind], [cedar])).toBe(false);
    expect(labelVisible([northwind], [ALL_WORKSPACES])).toBe(true);
    expect(labelVisible([INBOX], [ALL_WORKSPACES])).toBe(false);
    expect(labelVisible([INBOX], [INBOX])).toBe(true);
  });

  it('does not let the all-workspaces grant cover reserved or legacy compartments', () => {
    expect(labelVisible(['work'], [ALL_WORKSPACES])).toBe(false);
    expect(labelVisible(['wsp_short'], [ALL_WORKSPACES])).toBe(false);
    expect(labelVisible(['work'], ['work'])).toBe(true);
  });

  it('reads a document stored before labels existed as its compartments or the Inbox', () => {
    expect(storedLabel(undefined, [])).toEqual([INBOX]);
    expect(storedLabel(undefined, undefined)).toEqual([INBOX]);
    expect(storedLabel(undefined, ['work'])).toEqual(['work']);
    expect(storedLabel([], [])).toEqual([]);
    expect(storedLabel([northwind, northwind], [])).toEqual([northwind]);
    expect(storedLabel([''], [])).toEqual([INBOX]);
  });

  it('gives a new observation without compartments the Inbox label', () => {
    expect(labelForCompartments([])).toEqual([INBOX]);
    expect(labelForCompartments([cedar, northwind, cedar])).toEqual([northwind, cedar].sort());
  });

  it('derives an allowance from a grant', () => {
    expect(allowanceForGrant({ workspaces: 'all', inbox: true, defaultWorkspace: null })).toEqual(
      [INBOX, ALL_WORKSPACES].sort(),
    );
    expect(
      allowanceForGrant({ workspaces: [cedar], inbox: false, defaultWorkspace: cedar }),
    ).toEqual([cedar]);
  });

  it('compares workspace names after normalization', () => {
    expect(normalizeWorkspaceName('  Ｎｏｒｔｈｗｉｎｄ   Holdings ')).toBe('northwind holdings');
  });
});
