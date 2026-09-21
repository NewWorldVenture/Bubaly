// A relation that MOVED must not leave the old link behind.
//
// The twin projection writes edges with an upsert, and an upsert can only ever
// ADD. The node prune reaches an edge only through the 0129 FK cascade — that
// is, only when one of its ENDS disappears. So when the Odyssey's primary
// driver changes from Emma to Dad, both ends survive, the new edge is written
// and the old one is immortal: the Knowledge Graph lists "Emma drives Odyssey"
// and "Dad drives Odyssey" side by side, and assembleFamilyContext hands both
// to the AI as current fact when it is asked who can drive Emma to practice.
//
// The prune has to stay as careful as the node prune it mirrors, so this also
// pins what must NOT be removed: a hand-linked edge, and an edge belonging to a
// table whose read came back at the row cap (rows past the cap are unknown, not
// gone).
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from '@/tests/helpers/in-memory-supabase';
import { runTwinProjection, ROW_LIMIT } from '@/lib/twin/project-server';

const FAM = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-03-01T09:00:00.000Z');

function household() {
  const db = createInMemorySupabase({
    // The 0129 unique indexes the projector upserts against.
    uniques: {
      graph_entities: [['family_id', 'ref_table', 'ref_id']],
      graph_edges: [['family_id', 'source_id', 'target_id', 'relation']],
    },
    defaults: { graph_entities: { attributes: {} }, graph_edges: { attributes: {}, weight: 1 } },
  });
  db.seed('family_members', [
    { id: 'm-emma', family_id: FAM, display_name: 'Emma', is_active: true },
    { id: 'm-dad', family_id: FAM, display_name: 'Dad', is_active: true },
  ]);
  db.seed('vehicles', [{
    id: 'v-odyssey', family_id: FAM, nickname: 'Odyssey', make: 'Honda', model: 'Odyssey',
    primary_driver: 'm-emma',
  }]);
  return db;
}

type DB = ReturnType<typeof household>;

function client(db: DB) {
  return db as unknown as SupabaseClient<Database>;
}

function node(db: DB, refTable: string, refId: string): Row | undefined {
  return db.table('graph_entities').find((r) => r.ref_table === refTable && r.ref_id === refId);
}

/** The ref_ids of every member the graph currently claims drives this vehicle. */
function driversOf(db: DB, vehicleRefId: string): unknown[] {
  const vehicle = node(db, 'vehicles', vehicleRefId);
  return db.table('graph_edges')
    .filter((e) => e.relation === 'drives' && e.target_id === vehicle?.id)
    .map((e) => db.table('graph_entities').find((n) => n.id === e.source_id)?.ref_id)
    .sort();
}

describe('runTwinProjection prunes an edge whose relation moved', () => {
  it('hands the Odyssey to Dad instead of listing both drivers', async () => {
    const db = household();
    expect((await runTwinProjection(client(db), FAM, null, NOW)).ok).toBe(true);
    expect(driversOf(db, 'v-odyssey')).toEqual(['m-emma']);

    // Dad takes the car over: the parent changes Primary driver on /dashboard/auto.
    db.table('vehicles')[0].primary_driver = 'm-dad';
    expect((await runTwinProjection(client(db), FAM, null, NOW)).ok).toBe(true);

    // Exactly one driver, and it is the current one. Both nodes survive, so
    // nothing but an explicit edge prune can remove Emma's claim.
    expect(driversOf(db, 'v-odyssey')).toEqual(['m-dad']);
    // The car and both people are still in the graph — the edge went, not a node.
    expect(node(db, 'vehicles', 'v-odyssey')).toBeTruthy();
    expect(node(db, 'family_members', 'm-emma')).toBeTruthy();
    expect(node(db, 'family_members', 'm-dad')).toBeTruthy();
  });

  it('drops the link entirely when the relation is cleared', async () => {
    const db = household();
    await runTwinProjection(client(db), FAM, null, NOW);
    expect(driversOf(db, 'v-odyssey')).toEqual(['m-emma']);

    db.table('vehicles')[0].primary_driver = null;
    expect((await runTwinProjection(client(db), FAM, null, NOW)).ok).toBe(true);

    expect(driversOf(db, 'v-odyssey')).toEqual([]);
  });

  it('keeps a hand-linked edge the projector never wrote', async () => {
    const db = household();
    await runTwinProjection(client(db), FAM, null, NOW);

    // Somebody linked these two by hand from the Knowledge Graph card. It
    // carries no projection stamp, so it is not the projector's to remove.
    db.seed('graph_edges', [{
      family_id: FAM, source_id: node(db, 'family_members', 'm-emma')?.id,
      target_id: node(db, 'vehicles', 'v-odyssey')?.id, relation: 'washes', weight: 0.8,
    }]);

    db.table('vehicles')[0].primary_driver = 'm-dad';
    await runTwinProjection(client(db), FAM, null, NOW);

    expect(db.table('graph_edges').some((e) => e.relation === 'washes')).toBe(true);
    expect(driversOf(db, 'v-odyssey')).toEqual(['m-dad']);
  });

  // The node prune withholds a table whose read came back at the cap, because
  // rows past the cap are unknown rather than absent. The edge prune has to obey
  // the same rule or it would delete the live links of everything past the cap.
  it('never prunes an edge whose table came back at the row cap', async () => {
    const db = household();
    const early = Array.from({ length: 300 }, (_, i) => ({
      id: `z-${String(i).padStart(3, '0')}`, family_id: FAM, name: `Old thing ${i}`,
      category: 'general', location_id: null, owner_member_id: 'm-emma', status: 'kept', value_cents: 1000,
    }));
    db.seed('inventory_items', early);
    await runTwinProjection(client(db), FAM, null, NOW);
    expect(db.table('graph_edges').filter((e) => e.relation === 'owned_by')).toHaveLength(300);

    // The household catalogues 250 more, sorting ahead of the old ones, so the
    // ordered page of ROW_LIMIT no longer reaches the tail.
    db.seed('inventory_items', Array.from({ length: 250 }, (_, i) => ({
      id: `a-${String(i).padStart(3, '0')}`, family_id: FAM, name: `New thing ${i}`,
      category: 'general', location_id: null, owner_member_id: 'm-emma', status: 'kept', value_cents: 1000,
    })));
    expect(db.table('inventory_items').length).toBeGreaterThan(ROW_LIMIT);

    expect((await runTwinProjection(client(db), FAM, null, NOW)).ok).toBe(true);

    // Every owner link from the earlier complete read survives, tail included.
    for (const item of early) {
      const itemNode = node(db, 'inventory_items', String(item.id));
      expect(itemNode).toBeTruthy();
      expect(db.table('graph_edges').some((e) => e.source_id === itemNode?.id && e.relation === 'owned_by')).toBe(true);
    }
  });
});
