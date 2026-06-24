import { describe, expect, it } from 'vitest';
import { analyzeFamilyTree, buildFamilyTreePrompt, parseFamilyTreeResponse, type TreeNodeForAI } from '@/lib/family-tree/family-tree-ai';

function node(overrides: Partial<TreeNodeForAI> = {}): TreeNodeForAI {
  return { name: 'John', relationship: 'grandparent', birth_year: 1950, death_year: null, birth_place: null, ...overrides };
}

describe('analyzeFamilyTree', () => {
  it('summarizes tree', () => {
    const r = analyzeFamilyTree([node(), node({ name: 'Jane', relationship: 'parent', birth_year: 1975 })]);
    expect(r.totalNodes).toBe(2);
    expect(r.relationshipCounts['grandparent']).toBe(1);
    expect(r.relationshipCounts['parent']).toBe(1);
    expect(r.generationCount).toBe(2);
  });

  it('handles empty list', () => {
    const r = analyzeFamilyTree([]);
    expect(r.totalNodes).toBe(0);
    expect(r.generationCount).toBe(0);
  });
});

describe('buildFamilyTreePrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildFamilyTreePrompt([node({ name: 'Grandma Rose', birth_place: 'Italy' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Grandma Rose');
    expect(user).toContain('Italy');
  });
});

describe('parseFamilyTreeResponse', () => {
  it('parses valid JSON', () => {
    const r = parseFamilyTreeResponse('{"suggestions":["add photos"],"heritageTips":["interview elders"],"storytellingTip":"record audio"}');
    expect(r.suggestions).toEqual(['add photos']);
    expect(r.storytellingTip).toBe('record audio');
  });

  it('handles malformed input', () => {
    expect(parseFamilyTreeResponse('bad').suggestions).toEqual([]);
  });
});
