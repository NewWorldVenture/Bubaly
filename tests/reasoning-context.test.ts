import { describe, it, expect } from 'vitest';
import {
  assembleFamilyContext, mapEntityRow, mapEdgeRow, refKey,
  entityForRow, relatedTo, impactFrom, contextSummary,
} from '@/lib/reasoning/context';
import type { Graph } from '@/lib/graph/reason';
import type { HouseholdSnapshot } from '@/lib/operating-index/score';

// A calm/empty household → composite 100 (thriving), same fixture shape the
// operating-index tests use.
function calmSnapshot(): HouseholdSnapshot {
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
  };
}

// Emma → Soccer → Field → Weather chain + a member row mirror, plus an orphan.
function sampleGraph(): Graph {
  return {
    entities: [
      { id: 'emma', kind: 'person', name: 'Emma', refTable: 'family_members', refId: 'm-1' },
      { id: 'soccer', kind: 'activity', name: 'Soccer' },
      { id: 'field', kind: 'place', name: 'North Field' },
      { id: 'weather', kind: 'topic', name: 'Weather' },
      { id: 'lonely', kind: 'item', name: 'Unlinked thing' },
    ],
    edges: [
      { id: 'e1', sourceId: 'emma', targetId: 'soccer', relation: 'plays', weight: 1 },
      { id: 'e2', sourceId: 'soccer', targetId: 'field', relation: 'at', weight: 1 },
      { id: 'e3', sourceId: 'weather', targetId: 'field', relation: 'affects', weight: 0.8 },
    ],
  };
}

describe('row mappers', () => {
  it('maps entity rows, defaulting kind and weight', () => {
    const e = mapEntityRow({ id: 'x', kind: null, name: 'X', ref_table: 't', ref_id: 'r' });
    expect(e).toMatchObject({ id: 'x', kind: 'other', name: 'X', refTable: 't', refId: 'r' });
  });
  it('maps edge rows, defaulting weight to 1', () => {
    const e = mapEdgeRow({ id: 'e', source_id: 'a', target_id: 'b', relation: 'rel', weight: null });
    expect(e).toMatchObject({ id: 'e', sourceId: 'a', targetId: 'b', relation: 'rel', weight: 1 });
  });
});

describe('assembleFamilyContext', () => {
  const ctx = assembleFamilyContext({ familyId: 'fam', graph: sampleGraph(), snapshot: calmSnapshot() });

  it('carries the graph + a derived operating index from the snapshot', () => {
    expect(ctx.familyId).toBe('fam');
    expect(ctx.stats.entities).toBe(5);
    expect(ctx.stats.edges).toBe(3);
    expect(ctx.operatingIndex.composite).toBe(100);
    expect(ctx.operatingIndex.band).toBe('thriving');
  });

  it('counts entities by kind', () => {
    expect(ctx.stats.byKind).toMatchObject({ person: 1, activity: 1, place: 1, topic: 1, item: 1 });
  });

  it('indexes DB-row mirrors for the row→node join', () => {
    expect(ctx.refIndex.get(refKey('family_members', 'm-1'))?.id).toBe('emma');
    expect(entityForRow(ctx, 'family_members', 'm-1')?.name).toBe('Emma');
    expect(entityForRow(ctx, 'family_members', 'nope')).toBeNull();
  });

  it('ranks the connected nodes as hubs and flags the orphan', () => {
    expect(ctx.hubs[0].degree).toBe(2); // soccer + field both have degree 2
    expect(ctx.hubs.map((h) => h.entity.id)).toEqual(expect.arrayContaining(['soccer', 'field']));
    expect(ctx.orphanCount).toBe(1);    // "Unlinked thing"
  });
});

describe('graph reasoning helpers', () => {
  const ctx = assembleFamilyContext({ familyId: 'fam', graph: sampleGraph(), snapshot: calmSnapshot() });

  it('relatedTo walks the chain from Emma', () => {
    const ids = relatedTo(ctx, 'emma').map((r) => r.entity.id);
    expect(ids).toContain('soccer');
    expect(ids).toContain('field');
  });

  it('impactFrom weather reaches the field', () => {
    const hit = impactFrom(ctx, 'weather').map((i) => i.entity.id);
    expect(hit).toContain('field');
  });

  it('contextSummary reads as a one-liner', () => {
    expect(contextSummary(ctx)).toContain('5 entities and 3 links');
    expect(contextSummary(ctx)).toContain('100/100');
  });
});

describe('empty graph', () => {
  const ctx = assembleFamilyContext({ familyId: 'fam', graph: { entities: [], edges: [] }, snapshot: calmSnapshot() });
  it('degrades cleanly', () => {
    expect(ctx.stats.entities).toBe(0);
    expect(ctx.hubs).toEqual([]);
    expect(ctx.orphanCount).toBe(0);
    expect(contextSummary(ctx)).toContain('No knowledge graph yet');
  });
});
