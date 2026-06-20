import { describe, expect, it } from 'vitest';
import { degreeMap, mostConnected, layout, edgeLines, type GraphNode, type GraphEdge } from '@/lib/family/knowledge';

const nodes: GraphNode[] = [
  { id: 'm1', label: 'Mom', type: 'member' },
  { id: 'm2', label: 'Kid', type: 'member' },
  { id: 't1', label: 'Soccer', type: 'team' },
  { id: 'g1', label: 'Vacation', type: 'goal' },
];
const edges: GraphEdge[] = [
  { source: 'm2', target: 't1', relation: 'plays_on' },
  { source: 'm1', target: 'g1', relation: 'works_toward' },
  { source: 'm2', target: 'g1', relation: 'works_toward' },
];

describe('degreeMap', () => {
  it('counts undirected connections per node', () => {
    const d = degreeMap(edges);
    expect(d.get('m2')).toBe(2);
    expect(d.get('g1')).toBe(2);
    expect(d.get('t1')).toBe(1);
    expect(d.get('m1')).toBe(1);
  });
});

describe('mostConnected', () => {
  it('ranks nodes by descending degree', () => {
    const top = mostConnected(nodes, edges, 2);
    expect(top).toHaveLength(2);
    expect(top[0].degree).toBeGreaterThanOrEqual(top[1].degree);
    expect(['m2', 'g1']).toContain(top[0].id);
  });
});

describe('layout', () => {
  it('positions every node within the canvas', () => {
    const positioned = layout(nodes, edges, { width: 600, height: 600 });
    expect(positioned).toHaveLength(nodes.length);
    for (const p of positioned) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(600);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(600);
    }
  });

  it('centers a single member node', () => {
    const single = layout([{ id: 'm1', label: 'Mom', type: 'member' }], [], { width: 600, height: 600 });
    expect(single[0].x).toBe(300);
    expect(single[0].y).toBe(300);
  });
});

describe('edgeLines', () => {
  it('resolves endpoints and drops edges with a missing node', () => {
    const positioned = layout(nodes, edges);
    const lines = edgeLines([...edges, { source: 'm1', target: 'ghost', relation: 'x' }], positioned);
    expect(lines).toHaveLength(edges.length);
    for (const l of lines) {
      expect(typeof l.x1).toBe('number');
      expect(typeof l.y2).toBe('number');
    }
  });
});
