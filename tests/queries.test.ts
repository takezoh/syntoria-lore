import { describe, expect, it } from 'vitest';
import {
  compileQuery,
  parseQuery,
  placeHierarchy,
  QueryError,
  UNKNOWN_PLACE,
  usableIn,
  type ObservationPlacement,
} from '../packages/memory-records/src/index.js';

const northwind = `wsp_${'a'.repeat(32)}`;
const cedar = `wsp_${'b'.repeat(32)}`;
const retail = `prj_${'1'.repeat(32)}`;
const deals = `prj_${'2'.repeat(32)}`;
const logistics = `prj_${'3'.repeat(32)}`;
const platform = `prj_${'4'.repeat(32)}`;

const hierarchy = placeHierarchy([
  {
    id: northwind,
    projects: [
      { id: retail, parentId: null },
      { id: deals, parentId: retail },
      { id: logistics, parentId: null },
    ],
  },
  { id: cedar, projects: [{ id: platform, parentId: null }] },
]);

type Place = Pick<ObservationPlacement, 'workspaceId' | 'projectId' | 'scope'>;
const places: Record<string, Place> = {
  price: {
    workspaceId: northwind,
    projectId: retail,
    scope: { kind: 'project', projectId: retail },
  },
  rule: { workspaceId: northwind, projectId: retail, scope: { kind: 'workspace' } },
  memo: { workspaceId: northwind, projectId: null, scope: { kind: 'workspace' } },
  lesson: { workspaceId: northwind, projectId: retail, scope: { kind: 'shared' } },
  note: { workspaceId: null, projectId: null, scope: { kind: 'inbox' } },
  deal: { workspaceId: northwind, projectId: deals, scope: { kind: 'project', projectId: retail } },
  logistics: {
    workspaceId: northwind,
    projectId: logistics,
    scope: { kind: 'project', projectId: logistics },
  },
  cedar: {
    workspaceId: cedar,
    projectId: platform,
    scope: { kind: 'project', projectId: platform },
  },
};

function select(where: unknown): string[] {
  const predicate = compileQuery(parseQuery(where), hierarchy);
  return Object.entries(places)
    .filter(([, place]) => predicate(place))
    .map(([key]) => key)
    .sort();
}

const leaf = (field: string, op: string, value: unknown) =>
  op === 'in' || op === 'not_in' ? { field, op, values: value } : { field, op, value };

describe('placement queries', () => {
  it('selects what is usable in a project, its ancestors reaching down and Shared reaching all', () => {
    expect(select(leaf('usable_in', 'eq', retail))).toEqual(
      ['deal', 'lesson', 'memo', 'price', 'rule'].sort(),
    );
    expect(select(leaf('usable_in', 'eq', deals))).toEqual(
      ['deal', 'lesson', 'memo', 'price', 'rule'].sort(),
    );
    expect(select(leaf('usable_in', 'eq', logistics))).toEqual(
      ['lesson', 'logistics', 'memo', 'rule'].sort(),
    );
    expect(select(leaf('usable_in', 'eq', cedar))).toEqual(['lesson']);
    expect(usableIn(platform, places['cedar']!, hierarchy)).toBe(true);
  });

  it('combines conditions with or, and and not, with null for the Inbox and no project', () => {
    expect(
      select({ or: [leaf('usable_in', 'eq', cedar), leaf('workspace_id', 'eq', null)] }),
    ).toEqual(['lesson', 'note']);
    expect(
      select({
        and: [leaf('workspace_id', 'eq', northwind), { not: leaf('usable_in', 'eq', logistics) }],
      }),
    ).toEqual(['deal', 'price']);
    expect(select(leaf('project_id', 'in', [retail]))).toEqual(
      ['deal', 'lesson', 'price', 'rule'].sort(),
    );
    expect(
      select({ field: 'project_id', op: 'eq', value: retail, include_descendants: false }),
    ).toEqual(['lesson', 'price', 'rule'].sort());
    expect(select(leaf('project_id', 'eq', null))).toEqual(['memo', 'note']);
    expect(select(leaf('project_id', 'not_in', [null, retail]))).toEqual(['cedar', 'logistics']);
    expect(select(leaf('scope', 'in', ['shared', 'inbox']))).toEqual(['lesson', 'note']);
    expect(select(leaf('workspace_id', 'ne', northwind))).toEqual(['cedar', 'note']);
  });

  it('refuses malformed queries and unknown places with distinct messages', () => {
    const malformed = [
      {},
      { and: [] },
      { field: 'workspace_id', op: 'gt', value: northwind },
      { field: 'workspace_id', op: 'eq', value: 'northwind' },
      { field: 'scope', op: 'eq', value: 'company' },
      { field: 'scope', op: 'eq', value: 'shared', include_descendants: true },
      { field: 'usable_in', op: 'eq', value: null },
      { field: 'project_id', op: 'in', values: [] },
      { field: 'project_id', op: 'eq', value: retail, extra: 1 },
      {
        not: {
          not: { not: { not: { not: { not: { not: { not: leaf('scope', 'eq', 'shared') } } } } } },
        },
      },
    ];
    for (const where of malformed) {
      expect(() => parseQuery(where)).toThrow(QueryError);
      expect(() => parseQuery(where)).not.toThrow(UNKNOWN_PLACE);
    }
    expect(() =>
      parseQuery({ or: Array.from({ length: 65 }, () => leaf('scope', 'eq', 'shared')) }),
    ).toThrow(QueryError);
    expect(() => select(leaf('workspace_id', 'eq', `wsp_${'0'.repeat(32)}`))).toThrow(
      UNKNOWN_PLACE,
    );
    expect(() => select(leaf('usable_in', 'eq', `prj_${'0'.repeat(32)}`))).toThrow(UNKNOWN_PLACE);
  });
});
