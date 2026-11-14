import { describe, expect, it } from 'vitest';
import {
  normalizeProjectName,
  projectTextProblems,
  ProjectTree,
  type ProjectNode,
} from '../packages/memory-records/src/index.js';

const workspaceId = `wsp_${'a'.repeat(32)}`;
const id = (digit: string) => `prj_${digit.repeat(32)}`;

function node(digit: string, name: string, parent: string | null): ProjectNode {
  return {
    id: id(digit),
    workspaceId,
    parentId: parent === null ? null : id(parent),
    name,
    normalizedName: normalizeProjectName(name),
    description: '',
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  };
}

// Retail (1) > Deals (2) > Quartz (3) > Phase one (4); Logistics (5) at the top.
const tree = new ProjectTree([
  node('1', 'Retail', null),
  node('2', 'Deals', '1'),
  node('3', 'Quartz', '2'),
  node('4', 'Phase one', '3'),
  node('5', 'Logistics', null),
]);

describe('project hierarchy', () => {
  it('computes depth, height, path, ancestors and descendants from the hierarchy', () => {
    expect(tree.depth(id('1'))).toBe(1);
    expect(tree.depth(id('4'))).toBe(4);
    expect(tree.height(id('1'))).toBe(4);
    expect(tree.height(id('5'))).toBe(1);
    expect(tree.path(id('3'))).toEqual(['Retail', 'Deals', 'Quartz']);
    expect(tree.ancestors(id('3')).map((item) => item.name)).toEqual(['Deals', 'Retail']);
    expect(tree.descendants(id('1')).map((item) => item.name)).toEqual([
      'Deals',
      'Quartz',
      'Phase one',
    ]);
  });

  it('refuses a fifth level and a name already used under the same parent', () => {
    expect(tree.createProblems(id('4'), 'next')).toEqual([
      "a workspace's projects have at most 4 levels",
    ]);
    expect(tree.createProblems(id('3'), 'next')).toEqual([]);
    expect(tree.createProblems(null, normalizeProjectName('  ＲＥＴＡＩＬ '))).toEqual([
      'a project with this name exists under the same parent',
    ]);
    expect(tree.createProblems(id('5'), 'retail')).toEqual([]);
    expect(tree.createProblems(id('9'), 'x')).toEqual([
      'parent is not a project of this workspace',
    ]);
  });

  it('refuses a cycle, a move that would exceed four levels and a clashing rename', () => {
    expect(tree.updateProblems(id('1'), id('3'), 'retail')).toEqual([
      'a project cannot move under itself or one of its descendants',
    ]);
    expect(tree.updateProblems(id('2'), id('2'), 'deals')).toEqual([
      'a project cannot move under itself or one of its descendants',
    ]);
    // Retail spans four levels, so it cannot go below Logistics; Deals spans three and can.
    expect(tree.updateProblems(id('1'), id('5'), 'retail')).toEqual([
      "a workspace's projects have at most 4 levels",
    ]);
    expect(tree.updateProblems(id('2'), id('5'), 'deals')).toEqual([]);
    expect(tree.updateProblems(id('3'), id('5'), 'quartz')).toEqual([]);
    expect(tree.updateProblems(id('2'), null, 'deals')).toEqual([]);
    expect(tree.updateProblems(id('5'), null, 'retail')).toEqual([
      'a project with this name exists under the same parent',
    ]);
    expect(tree.updateProblems(id('1'), null, 'retail')).toEqual([]);
  });

  it('checks names and descriptions', () => {
    expect(projectTextProblems({ name: ' ' })).toHaveLength(1);
    expect(projectTextProblems({ name: 'x'.repeat(81) })).toHaveLength(1);
    expect(projectTextProblems({ description: 'a\u0007b' })).toHaveLength(1);
    expect(projectTextProblems({ name: 'Retail', description: '' })).toEqual([]);
  });
});
