import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { projectActivity, type ActivityDecision, type SimContext } from '@/lib/twin/simulate';
import { createInMemorySupabase, type Row } from '@/tests/helpers/in-memory-supabase';
import { runTwinProjection, ROW_LIMIT } from '@/lib/twin/project-server';
import { assembleFamilyContext, entityProvenance, entitySubkind, entitiesOfSubkind, mapEntityRow, mapEdgeRow } from '@/lib/reasoning/context';
import type { HouseholdSnapshot } from '@/lib/operating-index/score';

function activity(o: Partial<ActivityDecision> = {}): ActivityDecision {
  return {
    memberName: 'Emma', activityName: 'Travel Soccer',
    startsAt: '2026-07-08T17:30:00.000Z', // Wed evening
    durationMin: 90, sessionsPerWeek: 3, weeks: 12,
    travelMinEach: 25, costCents: 40000, costCategory: 'activities',
    ...o,
  };
}
function ctx(o: Partial<SimContext> = {}): SimContext {
  return { memberEvents: [], budgets: [{ category: 'activities', limitCents: 60000, spentCents: 10000 }], ...o };
}

describe('projectActivity', () => {
  it('projects every dimension for a rich activity', () => {
    const r = projectActivity(activity(), ctx());
    const keys = new Set(r.dimensions.map((d) => d.key));
    expect(keys.has('schedule')).toBe(true);
    expect(keys.has('travel')).toBe(true);
    expect(keys.has('cost')).toBe(true);
    expect(keys.has('family_time')).toBe(true);
    // Wed 17:30 → school night + dinner overlap.
    expect(keys.has('homework')).toBe(true);
    expect(keys.has('meals')).toBe(true);
    // weeklyHours = 3 × (90 + 50) / 60 = 7h.
    expect(r.weeklyHours).toBe(7);
  });

  it('flags a hard schedule conflict as a blocker verdict', () => {
    const r = projectActivity(activity(), ctx({
      memberEvents: [{ id: 'e1', title: 'Piano', startsAt: '2026-07-08T17:45:00.000Z', endsAt: '2026-07-08T18:30:00.000Z', allDay: false }],
    }));
    const sched = r.dimensions.find((d) => d.key === 'schedule')!;
    expect(sched.severity).toBe('blocker');
    expect(r.verdict).toBe('conflict');
  });

  it('flags an over-budget cost as a blocker', () => {
    const r = projectActivity(activity({ costCents: 90000 }), ctx()); // 90k vs 50k headroom
    const cost = r.dimensions.find((d) => d.key === 'cost')!;
    expect(cost.severity).toBe('blocker');
  });

  it('flags heavy travel and heavy weekly hours', () => {
    const r = projectActivity(activity({ travelMinEach: 60, sessionsPerWeek: 3, durationMin: 120 }), ctx());
    const travel = r.dimensions.find((d) => d.key === 'travel')!;
    expect(travel.severity).not.toBe('ok'); // 3 × 120 min travel/week = 6h
    const ft = r.dimensions.find((d) => d.key === 'family_time')!;
    expect(ft.severity).toBe('blocker'); // 3 × (120+120)/60 = 12h/week
  });

  it('detects a vacation overlap', () => {
    const r = projectActivity(activity({ startsAt: '2026-07-08T10:00:00.000Z' }), ctx({
      vacationWindows: [{ start: '2026-07-14T00:00:00.000Z', end: '2026-07-21T00:00:00.000Z', label: 'Beach week' }],
    }));
    const vac = r.dimensions.find((d) => d.key === 'vacation');
    expect(vac).toBeTruthy();
    expect(vac!.headline).toContain('Beach week');
  });

  it('reads as clear for a light, well-timed, in-budget activity', () => {
    // Sat morning, 1×/week, short, no travel, cheap.
    const r = projectActivity({
      memberName: 'Leo', activityName: 'Chess Club', startsAt: '2026-07-11T10:00:00.000Z',
      durationMin: 60, sessionsPerWeek: 1, weeks: 8, travelMinEach: 0, costCents: 2000, costCategory: 'activities',
    }, ctx());
    expect(r.verdict).toBe('clear');
    expect(r.dimensions.find((d) => d.key === 'homework')).toBeUndefined(); // weekend
    expect(r.dimensions.find((d) => d.key === 'meals')).toBeUndefined();    // morning
  });

  it('handles an invalid start time without throwing', () => {
    const r = projectActivity(activity({ startsAt: 'nope' }), ctx());
    expect(r.verdict).toBe('conflict');
  });
});

// ─── M3: the projection actually reaches the graph ───────────────────────────
// The pure projector is pinned in tests/twin-project.test.ts. This half proves
// the round trip: real domain rows in, graph_entities/graph_edges out, read back
// the way loadFamilyContext reads them — with provenance intact, upserts
// idempotent on (family_id, ref_table, ref_id), and nodes for vanished rows
// pruned instead of lingering as claims about a household that moved on.

const FAM = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-03-01T09:00:00.000Z');

function calmSnapshot(): HouseholdSnapshot {
  return {
    memberCount: 1,
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

function household() {
  const db = createInMemorySupabase({
    // The 0129 unique index the projector upserts against.
    uniques: { graph_entities: [['family_id', 'ref_table', 'ref_id']], graph_edges: [['family_id', 'source_id', 'target_id', 'relation']] },
    defaults: { graph_entities: { attributes: {} }, graph_edges: { attributes: {}, weight: 1 } },
  });
  db.seed('family_members', [{ id: 'm1', family_id: FAM, display_name: 'Emma', is_active: true }]);
  db.seed('calendar_events', [{ id: 'ev1', family_id: FAM, title: 'Dentist', starts_at: '2026-03-04T14:00:00.000Z', ends_at: null, all_day: false, category: 'health', location: 'Bright Smiles', assignee_id: 'm1' }]);
  db.seed('homes', [{ id: 'h1', family_id: FAM, name: 'Main House' }]);
  db.seed('home_assets', [{ id: 'a1', family_id: FAM, name: 'Water heater', category: 'plumbing', home_id: 'h1' }]);
  db.seed('home_warranties', [{ id: 'w1', family_id: FAM, name: 'Heater plan', asset_id: 'a1', status: 'active' }]);
  db.seed('bills', [{ id: 'b1', family_id: FAM, name: 'Electric', amount: 142.5, due_date: '2026-03-12', status: 'upcoming' }]);
  db.seed('renewals', [{ id: 'r1', family_id: FAM, title: 'Passport', member_id: 'm1', expires_at: '2026-09-01', status: 'active' }]);
  db.seed('family_facts', [{ id: 'f1', family_id: FAM, member_id: 'm1', category: 'preference', label: 'Favourite dinner', value: 'Tacos', source: 'ai_conversation', confidence: 70 }]);
  return db;
}

function client(db: ReturnType<typeof household>) {
  return db as unknown as SupabaseClient<Database>;
}

function nodeFor(db: ReturnType<typeof household>, refTable: string, refId: string): Row | undefined {
  return db.table('graph_entities').find((r) => r.ref_table === refTable && r.ref_id === refId);
}

describe('runTwinProjection writes one graph', () => {
  it('lands every new kind with provenance in attributes', async () => {
    const db = household();
    const res = await runTwinProjection(client(db), FAM, null, NOW);

    expect(res.ok).toBe(true);
    const kindOf = (table: string, id: string) => nodeFor(db, table, id)?.kind;
    expect(kindOf('calendar_events', 'ev1')).toBe('event');
    expect(kindOf('home_assets', 'a1')).toBe('item');
    expect(kindOf('home_warranties', 'w1')).toBe('item');
    expect(kindOf('bills', 'b1')).toBe('other');
    expect(kindOf('renewals', 'r1')).toBe('other');
    expect(kindOf('family_facts', 'f1')).toBe('topic');

    // Provenance rides in the jsonb because graph_entities has no columns for it.
    for (const row of db.table('graph_entities')) {
      expect(row.attributes).toMatchObject({
        provenance: { source: 'projection', observed_at: NOW.toISOString(), ref_table: row.ref_table },
      });
    }
    // Edges carry it too, so a link is as attributable as a node.
    expect(db.table('graph_edges').length).toBeGreaterThan(0);
    for (const edge of db.table('graph_edges')) {
      expect(edge.attributes).toMatchObject({ provenance: { source: 'projection', observed_at: NOW.toISOString() } });
    }
  });

  it('links the event to its member, the warranty to its asset and the asset to its home', async () => {
    const db = household();
    await runTwinProjection(client(db), FAM, null, NOW);

    const id = (table: string, refId: string): unknown => nodeFor(db, table, refId)?.id;
    const hasEdge = (source: unknown, target: unknown, relation: string) =>
      db.table('graph_edges').some((e) => e.source_id === source && e.target_id === target && e.relation === relation);

    expect(hasEdge(id('calendar_events', 'ev1'), id('family_members', 'm1'), 'attended_by')).toBe(true);
    expect(hasEdge(id('home_assets', 'a1'), id('homes', 'h1'), 'located_at')).toBe(true);
    expect(hasEdge(id('home_warranties', 'w1'), id('home_assets', 'a1'), 'covers')).toBe(true);
    expect(hasEdge(id('renewals', 'r1'), id('family_members', 'm1'), 'owed_by')).toBe(true);
    expect(hasEdge(id('family_facts', 'f1'), id('family_members', 'm1'), 'preference_of')).toBe(true);
  });

  it('is idempotent — a second run updates the same rows instead of duplicating them', async () => {
    const db = household();
    await runTwinProjection(client(db), FAM, null, NOW);
    const firstCount = db.table('graph_entities').length;
    const firstId = nodeFor(db, 'bills', 'b1')?.id;

    const later = new Date(NOW.getTime() + 3_600_000);
    await runTwinProjection(client(db), FAM, null, later);

    expect(db.table('graph_entities')).toHaveLength(firstCount);
    expect(nodeFor(db, 'bills', 'b1')?.id).toBe(firstId);
    // The stamp moves forward: the node says when it was last observed.
    expect((nodeFor(db, 'bills', 'b1')?.attributes as { provenance: { observed_at: string } }).provenance.observed_at)
      .toBe(later.toISOString());
  });

  it('prunes a projected node whose source row is gone, and keeps a hand-made one', async () => {
    const db = household();
    await runTwinProjection(client(db), FAM, null, NOW);

    // A node somebody typed in, naming a table the projector owns.
    db.seed('graph_entities', [{
      family_id: FAM, kind: 'topic', name: 'Hates Mondays', ref_table: 'family_facts', ref_id: 'f-typed',
      attributes: { provenance: { source: 'manual', observed_at: NOW.toISOString() } },
    }]);

    // The bill is paid and deleted; the preference is forgotten.
    db.replace('bills', []);
    db.replace('family_facts', []);
    await runTwinProjection(client(db), FAM, null, NOW);

    expect(nodeFor(db, 'bills', 'b1')).toBeUndefined();
    expect(nodeFor(db, 'family_facts', 'f1')).toBeUndefined();
    // The typed-in node survives — it was never the projector's to remove.
    expect(nodeFor(db, 'family_facts', 'f-typed')).toBeTruthy();
    // And the household's real rows are untouched.
    expect(nodeFor(db, 'home_assets', 'a1')).toBeTruthy();
  });

  // A household big enough to hit the read cap (the Home Inventory module
  // exists so people can catalogue everything they own) used to have its
  // out-of-page nodes deleted on the next run: the read returned ROW_LIMIT
  // rows, the projection listed only those, and everything else looked stale.
  // Rows past the cap are unknown, not gone.
  it('never prunes on a read that came back at the row cap', async () => {
    const db = household();
    db.seed('home_locations', [{ id: 'loc1', family_id: FAM, name: 'Garage', kind: 'room' }]);

    // First a household the read covers completely, so real nodes exist.
    const early = Array.from({ length: 300 }, (_, i) => ({
      id: `z-${String(i).padStart(3, '0')}`, family_id: FAM, name: `Old thing ${i}`,
      category: 'general', location_id: 'loc1', owner_member_id: 'm1', status: 'kept', value_cents: 1000,
    }));
    db.seed('inventory_items', early);
    await runTwinProjection(client(db), FAM, null, NOW);
    expect(db.table('graph_entities').filter((r) => r.ref_table === 'inventory_items')).toHaveLength(300);

    // Then it grows past the cap, with the new rows sorting ahead of the old
    // ones — so the ordered page of ROW_LIMIT no longer reaches the tail.
    db.seed('inventory_items', Array.from({ length: 250 }, (_, i) => ({
      id: `a-${String(i).padStart(3, '0')}`, family_id: FAM, name: `New thing ${i}`,
      category: 'general', location_id: 'loc1', owner_member_id: 'm1', status: 'kept', value_cents: 1000,
    })));
    expect(db.table('inventory_items').length).toBeGreaterThan(ROW_LIMIT);

    const edgesBefore = db.table('graph_edges').filter((e) => e.relation === 'owned_by').length;
    await runTwinProjection(client(db), FAM, null, NOW);

    // Every node from the earlier complete read survives, tail included: the
    // last-sorting items are live rows the capped page simply did not reach.
    expect(nodeFor(db, 'inventory_items', 'z-299')).toBeTruthy();
    expect(nodeFor(db, 'inventory_items', 'z-250')).toBeTruthy();
    for (const item of early) expect(nodeFor(db, 'inventory_items', String(item.id))).toBeTruthy();
    // Their edges cascade with the node, so nothing was cascade-deleted either.
    expect(db.table('graph_edges').filter((e) => e.relation === 'owned_by').length)
      .toBeGreaterThanOrEqual(edgesBefore);
    // The rest of the graph is judged as usual — one capped table does not
    // suspend the prune everywhere.
    db.replace('bills', []);
    await runTwinProjection(client(db), FAM, null, NOW);
    expect(nodeFor(db, 'bills', 'b1')).toBeUndefined();
  });

  it('takes a deterministic page when a read is capped, so runs do not churn', async () => {
    const seedItems = () => Array.from({ length: ROW_LIMIT + 20 }, (_, i) => ({
      id: `i-${String(i).padStart(4, '0')}`, family_id: FAM, name: `Thing ${i}`,
      category: 'general', location_id: null, owner_member_id: 'm1', status: 'kept', value_cents: 100,
    }));

    const db = household();
    db.seed('inventory_items', seedItems());
    await runTwinProjection(client(db), FAM, null, NOW);
    const first = db.table('graph_entities').filter((r) => r.ref_table === 'inventory_items').map((r) => r.ref_id).sort();

    // A second household seeded in a different physical order still reads the
    // same page, because the read names an order rather than trusting the heap.
    const db2 = household();
    db2.seed('inventory_items', seedItems().reverse());
    await runTwinProjection(client(db2), FAM, null, NOW);
    const second = db2.table('graph_entities').filter((r) => r.ref_table === 'inventory_items').map((r) => r.ref_id).sort();

    expect(first).toHaveLength(ROW_LIMIT);
    expect(second).toEqual(first);
  });
});

describe('the reasoning context reads the projection back', () => {
  it('exposes subkind and provenance so a surface can say where a claim came from', async () => {
    const db = household();
    await runTwinProjection(client(db), FAM, null, NOW);

    const ctx = assembleFamilyContext({
      familyId: FAM,
      graph: {
        entities: db.table('graph_entities').map((r) => mapEntityRow(r as Parameters<typeof mapEntityRow>[0])),
        edges: db.table('graph_edges').map((r) => mapEdgeRow(r as Parameters<typeof mapEdgeRow>[0])),
      },
      snapshot: calmSnapshot(),
      now: NOW,
    });

    expect(ctx.stats.bySubkind).toMatchObject({ event: 1, asset: 1, warranty: 1, obligation: 2, preference: 1 });
    expect(entitiesOfSubkind(ctx, 'obligation').map((e) => e.name).sort()).toEqual(['Electric', 'Passport']);

    const preference = entitiesOfSubkind(ctx, 'preference')[0];
    expect(entitySubkind(preference)).toBe('preference');
    expect(entityProvenance(preference)).toEqual({
      source: 'projection', observedAt: NOW.toISOString(), refTable: 'family_facts',
    });
    // The preference keeps the family_facts source + confidence the graph has no columns for.
    expect(preference.attributes).toMatchObject({ source: 'ai_conversation', confidence: 70 });
  });

  it('calls a node with no stamp `unknown` rather than inventing a source', () => {
    const ctx = assembleFamilyContext({
      familyId: FAM,
      graph: { entities: [{ id: 'g1', kind: 'person', name: 'Emma', refTable: 'family_members', refId: 'm1' }], edges: [] },
      snapshot: calmSnapshot(),
      now: NOW,
    });
    expect(entityProvenance(ctx.graph.entities[0])).toEqual({ source: 'unknown', observedAt: null, refTable: 'family_members' });
    expect(entitySubkind(ctx.graph.entities[0])).toBeNull();
  });
});
