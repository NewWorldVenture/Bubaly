import { describe, it, expect } from 'vitest';
import {
  buildIndex, neighbours, findPath, reachable, propagateImpact, hubs, orphans,
  describePath, EMPTY_GRAPH, type Graph,
} from '@/lib/graph/reason';

// A small household graph modelling the canonical chain:
//   Emma --plays--> Soccer --at--> Field --affected_by--> Weather
//   Soccer --coached_by--> Coach
//   Emma --child_of--> Daniel
//   Soccer --needs--> Cleats
const g: Graph = {
  entities: [
    { id: 'emma', kind: 'person', name: 'Emma' },
    { id: 'daniel', kind: 'person', name: 'Daniel' },
    { id: 'soccer', kind: 'activity', name: 'Soccer' },
    { id: 'field', kind: 'place', name: 'Field' },
    { id: 'weather', kind: 'topic', name: 'Weather' },
    { id: 'coach', kind: 'person', name: 'Coach' },
    { id: 'cleats', kind: 'item', name: 'Cleats' },
    { id: 'lonely', kind: 'other', name: 'Unlinked Thing' },
  ],
  edges: [
    { id: 'e1', sourceId: 'emma', targetId: 'soccer', relation: 'plays', weight: 0.9 },
    { id: 'e2', sourceId: 'soccer', targetId: 'field', relation: 'at', weight: 0.8 },
    { id: 'e3', sourceId: 'weather', targetId: 'field', relation: 'affects', weight: 0.9 },
    { id: 'e4', sourceId: 'soccer', targetId: 'coach', relation: 'coached_by', weight: 0.7 },
    { id: 'e5', sourceId: 'daniel', targetId: 'emma', relation: 'parent_of', weight: 1 },
    { id: 'e6', sourceId: 'soccer', targetId: 'cleats', relation: 'needs', weight: 0.6 },
  ],
};

describe('buildIndex', () => {
  it('indexes entities and adjacency both directions', () => {
    const idx = buildIndex(g);
    expect(idx.byId.size).toBe(8);
    expect(idx.out.get('soccer')?.length).toBe(3); // at, coached_by, needs
    expect(idx.in.get('field')?.length).toBe(2);   // soccer at, weather affects
  });
  it('drops dangling edges whose endpoints are missing', () => {
    const idx = buildIndex({
      entities: [{ id: 'a', kind: 'other', name: 'A' }],
      edges: [{ id: 'x', sourceId: 'a', targetId: 'ghost', relation: 'r', weight: 1 }],
    });
    expect(idx.out.get('a') ?? []).toHaveLength(0);
  });
  it('handles the empty graph', () => {
    const idx = buildIndex(EMPTY_GRAPH);
    expect(idx.byId.size).toBe(0);
  });
});

describe('neighbours', () => {
  it('returns both incoming and outgoing with relation + direction', () => {
    const idx = buildIndex(g);
    const n = neighbours(idx, 'soccer');
    const names = n.map((x) => x.entity.name).sort();
    expect(names).toEqual(['Cleats', 'Coach', 'Emma', 'Field']);
    const emma = n.find((x) => x.entity.id === 'emma');
    expect(emma?.direction).toBe('in');
    expect(emma?.relation).toBe('plays');
  });
});

describe('findPath', () => {
  it('finds the relationship path between two entities', () => {
    const idx = buildIndex(g);
    const path = findPath(idx, 'emma', 'weather');
    expect(path?.map((e) => e.id)).toEqual(['emma', 'soccer', 'field', 'weather']);
  });
  it('returns a single-node path when from === to', () => {
    const idx = buildIndex(g);
    expect(findPath(idx, 'emma', 'emma')?.map((e) => e.id)).toEqual(['emma']);
  });
  it('returns null when unconnected', () => {
    const idx = buildIndex(g);
    expect(findPath(idx, 'emma', 'lonely')).toBeNull();
  });
  it('returns null for unknown ids', () => {
    const idx = buildIndex(g);
    expect(findPath(idx, 'emma', 'nope')).toBeNull();
  });
});

describe('reachable', () => {
  it('lists everything within N hops, nearest first', () => {
    const idx = buildIndex(g);
    const r = reachable(idx, 'emma', 2);
    expect(r.find((x) => x.entity.id === 'soccer')?.depth).toBe(1);
    expect(r.find((x) => x.entity.id === 'field')?.depth).toBe(2);
    // weather is 3 hops away — excluded at maxDepth 2
    expect(r.find((x) => x.entity.id === 'weather')).toBeUndefined();
  });
});

describe('propagateImpact', () => {
  it('scores downstream blast radius from a change (weather rains out the field)', () => {
    const idx = buildIndex(g);
    const impact = propagateImpact(idx, 'weather');
    const ids = impact.map((i) => i.entity.id);
    expect(ids).toContain('field');
    // field is directly affected; strongest impact
    expect(impact[0].entity.id).toBe('field');
    expect(impact[0].score).toBeCloseTo(0.9, 5);
  });
  it('does not include the source itself', () => {
    const idx = buildIndex(g);
    expect(propagateImpact(idx, 'weather').some((i) => i.entity.id === 'weather')).toBe(false);
  });
  it('prunes paths below the threshold', () => {
    const idx = buildIndex(g);
    const impact = propagateImpact(idx, 'emma', { threshold: 0.5 });
    // emma->soccer (0.9) kept; soccer->cleats (0.9*0.6=0.54) kept; soccer->field (0.72) kept;
    // field has no outgoing edges so chain stops. All above 0.5.
    expect(impact.every((i) => i.score >= 0.5)).toBe(true);
  });
});

describe('hubs + orphans', () => {
  it('ranks the most connected entities', () => {
    const idx = buildIndex(g);
    expect(hubs(idx, 1)[0].entity.id).toBe('soccer'); // degree 4
  });
  it('finds unlinked entities', () => {
    const idx = buildIndex(g);
    expect(orphans(idx).map((e) => e.id)).toEqual(['lonely']);
  });
});

describe('describePath', () => {
  it('renders a readable relationship chain', () => {
    const idx = buildIndex(g);
    const path = findPath(idx, 'emma', 'field')!;
    expect(describePath(idx, path)).toBe('Emma —plays→ Soccer —at→ Field');
  });
  it('renders empty for an empty path', () => {
    const idx = buildIndex(g);
    expect(describePath(idx, [])).toBe('');
  });
});
