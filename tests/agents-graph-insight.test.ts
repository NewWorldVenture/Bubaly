import { describe, it, expect } from 'vitest';
import { graphInsights } from '@/lib/agents/graph-insight';
import { runAllAgents, EMPTY_AGENT_CONTEXT } from '@/lib/agents/roster';
import type { Graph } from '@/lib/graph/reason';

// A hub (soccer, degree 4) + three orphan nodes.
const graph: Graph = {
  entities: [
    { id: 'emma', kind: 'person', name: 'Emma' },
    { id: 'soccer', kind: 'activity', name: 'Soccer' },
    { id: 'field', kind: 'place', name: 'Field' },
    { id: 'coach', kind: 'person', name: 'Coach' },
    { id: 'cleats', kind: 'item', name: 'Cleats' },
    { id: 'o1', kind: 'other', name: 'Orphan 1' },
    { id: 'o2', kind: 'other', name: 'Orphan 2' },
    { id: 'o3', kind: 'other', name: 'Orphan 3' },
  ],
  edges: [
    { id: 'e1', sourceId: 'emma', targetId: 'soccer', relation: 'plays', weight: 0.9 },
    { id: 'e2', sourceId: 'soccer', targetId: 'field', relation: 'at', weight: 0.8 },
    { id: 'e3', sourceId: 'soccer', targetId: 'coach', relation: 'coached_by', weight: 0.7 },
    { id: 'e4', sourceId: 'soccer', targetId: 'cleats', relation: 'needs', weight: 0.6 },
  ],
};

describe('graphInsights', () => {
  it('returns nothing for an empty graph', () => {
    expect(graphInsights({ entities: [], edges: [] })).toEqual([]);
  });

  it('surfaces the coordination hub with its ripple count', () => {
    const items = graphInsights(graph);
    const hub = items.find((i) => i.title.includes('coordination hub'));
    expect(hub).toBeDefined();
    expect(hub!.title).toContain('Soccer');
    expect(hub!.detail).toMatch(/4 things depend on it/);
    expect(hub!.detail).toMatch(/ripples to \d+/);
    expect(hub!.href).toBe('/dashboard/graph');
    expect(hub!.severity).toBe('info');
  });

  it('flags unlinked entities when there are 3+', () => {
    const items = graphInsights(graph);
    const orphan = items.find((i) => i.title.includes("aren't linked"));
    expect(orphan).toBeDefined();
    expect(orphan!.title).toContain('3 things');
  });

  it('does not flag orphans below the threshold', () => {
    const twoOrphans: Graph = {
      entities: [
        { id: 'a', kind: 'person', name: 'A' }, { id: 'b', kind: 'activity', name: 'B' },
        { id: 'c', kind: 'activity', name: 'C' }, { id: 'd', kind: 'activity', name: 'D' },
        { id: 'o1', kind: 'other', name: 'O1' }, { id: 'o2', kind: 'other', name: 'O2' },
      ],
      edges: [
        { id: 'e1', sourceId: 'a', targetId: 'b', relation: 'r', weight: 1 },
        { id: 'e2', sourceId: 'a', targetId: 'c', relation: 'r', weight: 1 },
        { id: 'e3', sourceId: 'a', targetId: 'd', relation: 'r', weight: 1 },
      ],
    };
    expect(graphInsights(twoOrphans).some((i) => i.title.includes("aren't linked"))).toBe(false);
  });
});

describe('Chief of Staff consumes graph insights', () => {
  it('injects graph insights into the Chief of Staff when the household is calm', () => {
    const briefings = runAllAgents(EMPTY_AGENT_CONTEXT, graphInsights(graph));
    const chief = briefings.find((b) => b.agentId === 'chief_of_staff')!;
    // calm household → the info-level graph insight rises into the top items
    expect(chief.items.some((i) => i.title.includes('coordination hub'))).toBe(true);
  });

  it('does not change the Chief of Staff status (insights are info-level)', () => {
    const withInsights = runAllAgents(EMPTY_AGENT_CONTEXT, graphInsights(graph));
    const chief = withInsights.find((b) => b.agentId === 'chief_of_staff')!;
    expect(chief.status).toBe('clear');
  });
});
