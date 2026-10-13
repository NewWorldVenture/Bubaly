// S1 / S5 — the twin projection copied audience-restricted rows into the
// family-wide knowledge graph.
//
// `graph_entities` and `graph_edges` read with is_family_member (0129) for every
// role, guests included, and /dashboard/graph renders every node and relation.
// The projector — the parent's "Rebuild from data", the on-read auto-refresh
// and the daily model-refresh cron, the last two on the SERVICE client — read
// every health provider (name, specialty, which member "sees" them), every open
// paperwork item (title, amount, kind, open actions), every unpaid bill, every
// financial account, every warranty and every place and storage location, and
// upserted them as nodes. So a guest, refused /dashboard/medical, read "Dr. Lee
// (Psychiatry)" with "Emma sees" it on the graph, and a teen narrowed to their
// own paperwork read the parents' medical forms with their amounts. The held
// 0509/0514/0517 narrow the source tables, not the graph, and the service role
// bypasses them anyway.
//
// Driven through the real rebuild action (and the cron's own call), against an
// in-memory household holding one row of each restricted kind and the nodes an
// earlier run already wrote for them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAM = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-13T09:00:00.000Z');
const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'parent-user' },
    active: { familyId: '11111111-1111-4111-8111-111111111111', role: 'parent', member: { id: 'm-dad' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));

const { projectTwinAction } = await import('@/app/(app)/dashboard/graph/twin-actions');
const { runTwinProjection } = await import('@/lib/twin/project-server');

const RESTRICTED = ['health_providers', 'paperwork_items', 'home_warranties', 'financial_accounts', 'bills', 'family_places', 'home_locations'];

/** What any member's browser reads back from /dashboard/graph (GraphModule selects `*`). */
const graphText = (db: InMemorySupabase) => JSON.stringify([db.table('graph_entities'), db.table('graph_edges')]);

function household(): InMemorySupabase {
  const db = createInMemorySupabase({
    uniques: { graph_entities: [['family_id', 'ref_table', 'ref_id']], graph_edges: [['family_id', 'source_id', 'target_id', 'relation']] },
    defaults: { graph_entities: { attributes: {} }, graph_edges: { attributes: {}, weight: 1 } },
  });
  db.seed('family_members', [
    { id: 'm-dad', family_id: FAM, display_name: 'Dad', is_active: true },
    { id: 'm-emma', family_id: FAM, display_name: 'Emma', is_active: true },
  ]);
  db.seed('teams', [{ id: 't1', family_id: FAM, member_id: 'm-emma', sport: 'Soccer', is_active: true }]);
  db.seed('health_providers', [{ id: 'hp1', family_id: FAM, member_id: 'm-emma', name: 'Dr. Lee', specialty: 'Psychiatry' }]);
  db.seed('paperwork_items', [{
    id: 'pw1', family_id: FAM, title: 'Custody evaluation intake form', status: 'needs_action', due_on: '2026-10-20',
    amount: 450, kind: 'medical_form', actions: [{ kind: 'pay', label: 'Pay the evaluator' }], created_by: 'parent-user',
  }]);
  db.seed('bills', [{ id: 'b1', family_id: FAM, name: 'Therapy co-pay', amount: 180, due_date: '2026-10-15', status: 'upcoming' }]);
  db.seed('financial_accounts', [{ id: 'fa1', family_id: FAM, name: 'Divorce settlement savings' }]);
  db.seed('home_warranties', [{ id: 'w1', family_id: FAM, name: 'Furnace plan', status: 'active', created_by: 'parent-user' }]);
  db.seed('family_places', [{ id: 'pl1', family_id: FAM, name: 'Safe house' }]);
  db.seed('home_locations', [{ id: 'loc1', family_id: FAM, name: 'Gun safe', kind: 'closet' }]);
  return db;
}

/** The nodes and the "sees" edge a projection before this fix had already written. */
function seedEarlierProjection(db: InMemorySupabase) {
  const stamp = (refTable: string) => ({ provenance: { source: 'projection', observed_at: NOW.toISOString(), ref_table: refTable } });
  db.seed('graph_entities', [
    { id: 'g-emma', family_id: FAM, kind: 'person', name: 'Emma', ref_table: 'family_members', ref_id: 'm-emma', attributes: stamp('family_members') },
    { id: 'g-hp1', family_id: FAM, kind: 'org', name: 'Dr. Lee (Psychiatry)', ref_table: 'health_providers', ref_id: 'hp1', attributes: stamp('health_providers') },
    { id: 'g-pw1', family_id: FAM, kind: 'other', name: 'Custody evaluation intake form', ref_table: 'paperwork_items', ref_id: 'pw1', attributes: { ...stamp('paperwork_items'), amount: 450 } },
    { id: 'g-b1', family_id: FAM, kind: 'other', name: 'Therapy co-pay', ref_table: 'bills', ref_id: 'b1', attributes: stamp('bills') },
    { id: 'g-fa1', family_id: FAM, kind: 'item', name: 'Divorce settlement savings', ref_table: 'financial_accounts', ref_id: 'fa1', attributes: stamp('financial_accounts') },
    { id: 'g-w1', family_id: FAM, kind: 'item', name: 'Furnace plan', ref_table: 'home_warranties', ref_id: 'w1', attributes: stamp('home_warranties') },
    { id: 'g-pl1', family_id: FAM, kind: 'place', name: 'Safe house', ref_table: 'family_places', ref_id: 'pl1', attributes: stamp('family_places') },
    { id: 'g-loc1', family_id: FAM, kind: 'place', name: 'Gun safe', ref_table: 'home_locations', ref_id: 'loc1', attributes: stamp('home_locations') },
  ]);
  db.seed('graph_edges', [{
    id: 'e-sees', family_id: FAM, source_id: 'g-emma', target_id: 'g-hp1', relation: 'sees', weight: 0.6,
    attributes: { provenance: { source: 'projection', observed_at: NOW.toISOString() } },
  }]);
}

/** 0129's FK cascade: an edge goes with either of its ends. */
function cascade(db: InMemorySupabase) {
  const ids = new Set(db.table('graph_entities').map((row) => row.id));
  db.replace('graph_edges', db.table('graph_edges').filter((edge) => ids.has(edge.source_id) && ids.has(edge.target_id)));
}

let db: InMemorySupabase;
beforeEach(() => {
  db = household();
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the family graph every member reads holds no audience-restricted record', () => {
  it("a parent's rebuild projects the household but no clinician, paperwork, bill, account, warranty or place", async () => {
    const res = await projectTwinAction();
    expect(res.ok, res.error).toBe(true);

    const refTables = new Set(db.table('graph_entities').map((row) => row.ref_table));
    expect(refTables.has('family_members')).toBe(true);
    expect(refTables.has('teams')).toBe(true);
    for (const table of RESTRICTED) expect(refTables.has(table), `${table} reached the graph`).toBe(false);

    const text = graphText(db);
    for (const leaked of ['Dr. Lee', 'Psychiatry', 'Custody evaluation', 'Therapy co-pay', 'Divorce settlement', 'Furnace plan', 'Safe house', 'Gun safe', 'Pay the evaluator']) {
      expect(text, `${leaked} is readable on /dashboard/graph`).not.toContain(leaked);
    }
    expect(db.table('graph_edges').some((edge) => edge.relation === 'sees')).toBe(false);
  });

  it('the service-role cron prunes the restricted nodes an earlier projection wrote, and their edges with them', async () => {
    seedEarlierProjection(db);

    const res = await runTwinProjection(db as unknown as SupabaseClient<Database>, FAM, null, NOW);
    expect(res.ok, res.error).toBe(true);
    cascade(db);

    expect(db.table('graph_entities').filter((row) => RESTRICTED.includes(String(row.ref_table)))).toEqual([]);
    expect(db.table('graph_edges').some((edge) => edge.relation === 'sees')).toBe(false);
    // The household's own nodes are untouched.
    expect(db.table('graph_entities').some((row) => row.ref_table === 'family_members' && row.ref_id === 'm-emma')).toBe(true);
    expect(graphText(db)).not.toContain('Psychiatry');
  });

  it('a node a person typed in by hand, naming one of those tables, is not the projector\'s to remove', async () => {
    db.seed('graph_entities', [{
      id: 'g-manual', family_id: FAM, kind: 'org', name: 'Pediatric dentist', ref_table: 'health_providers', ref_id: 'hp-typed',
      attributes: { provenance: { source: 'manual', observed_at: NOW.toISOString() } },
    }]);

    expect((await projectTwinAction()).ok).toBe(true);

    expect(db.table('graph_entities').some((row) => row.id === 'g-manual')).toBe(true);
  });
});
