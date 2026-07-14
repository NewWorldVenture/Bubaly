import { describe, it, expect } from 'vitest';
import { reasoningInsights, graphReasoningInsights } from '@/lib/reasoning/insights';
import { assembleFamilyContext } from '@/lib/reasoning/context';
import type { Graph } from '@/lib/graph/reason';
import type { HouseholdSnapshot } from '@/lib/operating-index/score';

function snapshot(over: Partial<HouseholdSnapshot> = {}): HouseholdSnapshot {
  return {
    memberCount: 4,
    upcomingEvents: 0, upcomingEventsOwned: 0, eventsMissingInfo: 0, overdueReminders: 0,
    conflicts: 0,
    billsDueSoon: 0, billsCovered: 0, overspentBudgets: 0, negativeBalances: 0,
    expiringDocs: 0, overdueMaintenance: 0, lowInventory: 0,
    pendingApprovals: 0, openVotes: 0, unreadThreads: 0,
    choresAssignedRecently: 0, choresCompletedRecently: 0, overdueTasks: 0,
    activeGoals: 0, goalsOnTrack: 0,
    memberLoads: [],
    ...over,
  };
}

// A hub ("Field") depended on by 2 activities AND affecting 4 things downstream
// (so both its degree and its outgoing impact are high), plus 4 orphans.
function hubGraph(): Graph {
  const entities = [
    { id: 'field', kind: 'place' as const, name: 'North Field' },
    ...[1, 2].map((i) => ({ id: `d${i}`, kind: 'activity' as const, name: `Dep ${i}` })),
    ...[1, 2, 3, 4].map((i) => ({ id: `g${i}`, kind: 'event' as const, name: `Game ${i}` })),
    ...[1, 2, 3, 4].map((i) => ({ id: `o${i}`, kind: 'item' as const, name: `Orphan ${i}` })),
  ];
  const edges = [
    // 2 activities depend on the field (incoming), 4 games are affected by it (outgoing).
    ...[1, 2].map((i) => ({ id: `in${i}`, sourceId: `d${i}`, targetId: 'field', relation: 'at', weight: 0.9 })),
    ...[1, 2, 3, 4].map((i) => ({ id: `out${i}`, sourceId: 'field', targetId: `g${i}`, relation: 'affects', weight: 0.9 })),
  ];
  return { entities, edges };
}

describe('reasoningInsights', () => {
  it('returns nothing for an empty graph', () => {
    const ctx = assembleFamilyContext({ familyId: 'f', graph: { entities: [], edges: [] }, snapshot: snapshot() });
    expect(reasoningInsights(ctx)).toEqual([]);
  });

  it('surfaces the coordination hub and the coverage gap', () => {
    const ctx = assembleFamilyContext({ familyId: 'f', graph: hubGraph(), snapshot: snapshot() });
    const ins = reasoningInsights(ctx);
    const hub = ins.find((i) => i.kind === 'hub');
    const coverage = ins.find((i) => i.kind === 'coverage');
    expect(hub?.title).toContain('North Field');
    expect(hub?.detail).toContain('6 things depend on it'); // degree = 2 in + 4 out
    expect(hub?.detail).toContain('ripples to 4');
    expect(coverage?.title).toContain('4 things aren');
  });

  it('does NOT raise a ripple alert when the household is calm', () => {
    const ctx = assembleFamilyContext({ familyId: 'f', graph: hubGraph(), snapshot: snapshot() });
    expect(reasoningInsights(ctx).some((i) => i.kind === 'ripple')).toBe(false);
  });

  it('raises a ripple alert (graph × snapshot) when the week is overloaded', () => {
    // Push the operating index into "overloaded" with heavy pressure signals.
    const stressed = snapshot({ conflicts: 6, overdueReminders: 8, overdueTasks: 10, pendingApprovals: 6, billsDueSoon: 8, billsCovered: 0 });
    const ctx = assembleFamilyContext({ familyId: 'f', graph: hubGraph(), snapshot: stressed });
    const ripple = reasoningInsights(ctx).find((i) => i.kind === 'ripple');
    expect(ripple).toBeTruthy();
    expect(ripple?.severity).toBe('attention');
    expect(ripple?.title).toContain('ripple wide');
  });
});

// Mom is the SOLE person linked to 4 things — a bus-factor risk (no backup).
function fragilityGraph(): Graph {
  return {
    entities: [
      { id: 'mom', kind: 'person' as const, name: 'Mom' },
      { id: 'peds', kind: 'org' as const, name: 'Pediatrician' },
      { id: 'ins', kind: 'org' as const, name: 'Insurance' },
      { id: 'portal', kind: 'item' as const, name: 'School Portal' },
      { id: 'dmv', kind: 'org' as const, name: 'DMV' },
    ],
    edges: [
      { id: 'f1', sourceId: 'mom', targetId: 'peds', relation: 'manages', weight: 1 },
      { id: 'f2', sourceId: 'mom', targetId: 'ins', relation: 'manages', weight: 1 },
      { id: 'f3', sourceId: 'mom', targetId: 'portal', relation: 'manages', weight: 1 },
      { id: 'f4', sourceId: 'mom', targetId: 'dmv', relation: 'manages', weight: 1 },
    ],
  };
}

describe('reasoningInsights — fragility (bus-factor)', () => {
  it('flags the person who is the sole backup for several things', () => {
    const ctx = assembleFamilyContext({ familyId: 'f', graph: fragilityGraph(), snapshot: snapshot() });
    const frag = reasoningInsights(ctx).find((i) => i.kind === 'fragility');
    expect(frag?.title).toBe('Mom is the only backup for 4 things');
    expect(frag?.detail).toContain('DMV, Insurance, Pediatrician'); // first 3, alphabetical
    expect(frag?.detail).toContain('+1 more');
    expect(frag?.severity).toBe('attention'); // calm week
  });

  it('escalates fragility to an action when the week is overloaded', () => {
    const frag = graphReasoningInsights(fragilityGraph(), 'overloaded').find((i) => i.kind === 'fragility');
    expect(frag?.severity).toBe('action');
  });

  it('does not flag fragility when no person solely holds ≥3 things', () => {
    const ctx = assembleFamilyContext({ familyId: 'f', graph: hubGraph(), snapshot: snapshot() });
    expect(reasoningInsights(ctx).some((i) => i.kind === 'fragility')).toBe(false);
  });
});

describe('graphReasoningInsights (graph + band, no snapshot)', () => {
  it('matches reasoningInsights for the same graph + band', () => {
    const g = hubGraph();
    const fromGraph = graphReasoningInsights(g, 'thriving');
    const fromCtx = reasoningInsights(assembleFamilyContext({ familyId: 'f', graph: g, snapshot: snapshot() }));
    expect(fromGraph).toEqual(fromCtx); // calm snapshot → band 'thriving'
  });

  it('fires the ripple alert when the band is overloaded, no snapshot needed', () => {
    const ins = graphReasoningInsights(hubGraph(), 'overloaded');
    expect(ins.some((i) => i.kind === 'ripple')).toBe(true);
  });

  it('is empty for an empty graph', () => {
    expect(graphReasoningInsights({ entities: [], edges: [] }, 'steady')).toEqual([]);
  });
});
