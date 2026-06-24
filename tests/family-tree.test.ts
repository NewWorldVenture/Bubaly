import { describe, expect, it } from 'vitest';
import {
  buildTree, flattenTree, maxGeneration, countByRelationship,
  treeStats, generationLabel, groupByGeneration, lifespan,
  relationshipLabel, type NodeLike,
} from '@/lib/family-tree/tree';

const nodes: NodeLike[] = [
  { id: 'g1', parent_node_id: null, name: 'Grandpa Joe', relationship: 'grandparent', birth_year: 1940, death_year: 2020, member_id: null },
  { id: 'g2', parent_node_id: null, name: 'Grandma Rose', relationship: 'grandparent', birth_year: 1942, death_year: null, member_id: null },
  { id: 'p1', parent_node_id: 'g1', name: 'Dad', relationship: 'parent', birth_year: 1970, death_year: null, member_id: 'm1' },
  { id: 'p2', parent_node_id: 'g2', name: 'Mom', relationship: 'parent', birth_year: 1972, death_year: null, member_id: 'm2' },
  { id: 'c1', parent_node_id: 'p1', name: 'Alice', relationship: 'self', birth_year: 2000, death_year: null, member_id: 'm3' },
  { id: 'c2', parent_node_id: 'p1', name: 'Bob', relationship: 'sibling', birth_year: 2003, death_year: null, member_id: 'm4' },
];

describe('family tree', () => {
  it('builds a tree with correct parent-child links', () => {
    const roots = buildTree(nodes);
    expect(roots).toHaveLength(2);
    expect(roots[0].name).toBe('Grandpa Joe');
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].name).toBe('Dad');
    expect(roots[0].children[0].children).toHaveLength(2);
  });

  it('assigns generations correctly', () => {
    const roots = buildTree(nodes);
    expect(roots[0].generation).toBe(0);
    expect(roots[0].children[0].generation).toBe(1);
    expect(roots[0].children[0].children[0].generation).toBe(2);
  });

  it('flattenTree returns all nodes', () => {
    const roots = buildTree(nodes);
    expect(flattenTree(roots)).toHaveLength(6);
  });

  it('maxGeneration', () => {
    expect(maxGeneration(buildTree(nodes))).toBe(2);
    expect(maxGeneration(buildTree([]))).toBe(0);
  });

  it('countByRelationship', () => {
    const counts = countByRelationship(nodes);
    expect(counts.get('grandparent')).toBe(2);
    expect(counts.get('parent')).toBe(2);
    expect(counts.get('self')).toBe(1);
  });

  it('treeStats', () => {
    const s = treeStats(nodes);
    expect(s.total).toBe(6);
    expect(s.generations).toBe(3);
    expect(s.living).toBe(5);
    expect(s.deceased).toBe(1);
  });

  it('generationLabel', () => {
    expect(generationLabel(0)).toBe('Elders');
    expect(generationLabel(2)).toBe('Our Generation');
    expect(generationLabel(5)).toBe('Generation 6');
  });

  it('groupByGeneration groups correctly', () => {
    const groups = groupByGeneration(buildTree(nodes));
    expect(groups).toHaveLength(3);
    expect(groups[0].generation).toBe(0);
    expect(groups[0].nodes).toHaveLength(2);
    expect(groups[2].nodes).toHaveLength(2);
  });

  it('lifespan formatting', () => {
    expect(lifespan(nodes[0])).toBe('1940–2020');
    expect(lifespan(nodes[2])).toBe('b. 1970');
    expect(lifespan({ ...nodes[0], birth_year: null })).toBe('');
  });

  it('relationshipLabel', () => {
    expect(relationshipLabel('grandparent')).toBe('Grandparent');
    expect(relationshipLabel('step_child')).toBe('Step-Child');
    expect(relationshipLabel('unknown')).toBe('unknown');
  });

  it('handles empty nodes', () => {
    expect(buildTree([])).toEqual([]);
    expect(treeStats([]).total).toBe(0);
    expect(treeStats([]).generations).toBe(1);
  });

  it('orphaned parent_node_id becomes a root', () => {
    const orphan: NodeLike = { id: 'x', parent_node_id: 'nonexistent', name: 'Orphan', relationship: 'other', birth_year: null, death_year: null, member_id: null };
    const roots = buildTree([orphan]);
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('Orphan');
  });
});
