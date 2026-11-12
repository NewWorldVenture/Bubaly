// "Rebuild from data" on the Reasoning Graph (projectTwinAction), called the way
// components/modules/graph-module.tsx calls it, with household B beside A.
//
// The action takes no argument: the family is the session's, and the real
// projector (lib/twin/project-server.ts) runs on the caller's client, reading
// A's domain tables, upserting A's graph_entities / graph_edges and pruning A's
// stale projected nodes. What is pinned:
//   - a parent and an adult rebuild A's graph from A's rows: one node per
//     member and pet, a stale projected node pruned, a hand-made node kept;
//   - nothing of B's is read into A's graph, and B's graph rows (including a
//     stale projected node of B's) are untouched;
//   - a refused write is reported, not answered with ok;
//   - a signed-out caller is sent to sign in and nothing is read.
//
// The teen, child, caregiver and guest are NOT pinned. The action has no role
// check, 0129's policies let any member write graph_entities and graph_edges,
// and the page offers the button to every viewer, while roles.ts describes a
// guest as one who views and 0464's guest guard does not cover these tables.
// The sources do not settle it, so it is under "Needs an owner decision".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';

const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent' as string, signedOut: false }));

vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (harness.signedOut) throw new Error('REDIRECT:/login');
    return {
      user: { id: `user-${harness.role}`, email: `${harness.role}@example.com` },
      memberships: [],
      active: { familyId: FAMILY_A, role: harness.role, member: { id: `member-${harness.role}` }, family: { id: FAMILY_A, timezone: 'UTC' } },
    };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));

const { projectTwinAction } = await import('@/app/(app)/dashboard/graph/twin-actions');

const PROJECTED = { provenance: { source: 'projection', observed_at: '2026-10-01T00:00:00.000Z' } };

let db: InMemorySupabase;
let read: string[];

const nodes = (family: string) => db.table('graph_entities').filter((r) => r.family_id === family);
const edges = (family: string) => db.table('graph_edges').filter((r) => r.family_id === family);
const graphOf = (family: string) => structuredClone({ nodes: nodes(family), edges: edges(family) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.role = 'parent';
  harness.signedOut = false;
  db = createInMemorySupabase({
    uniques: {
      graph_entities: [['family_id', 'ref_table', 'ref_id']],
      graph_edges: [['family_id', 'source_id', 'target_id', 'relation']],
    },
  });
  harness.db = db;
  read = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table: string) => { read.push(table); return from(table); });

  db.seed('family_members', [
    { id: 'member-ana', family_id: FAMILY_A, display_name: 'Ana', is_active: true },
    { id: 'member-emma', family_id: FAMILY_A, display_name: 'Emma', is_active: true },
    { id: 'member-leo', family_id: FAMILY_B, display_name: 'Leo', is_active: true },
  ]);
  db.seed('pets', [
    { id: 'pet-a', family_id: FAMILY_A, name: 'Biscuit', species: 'dog', is_active: true },
    { id: 'pet-b', family_id: FAMILY_B, name: 'Rex', species: 'dog', is_active: true },
  ]);
  db.seed('graph_entities', [
    // A: a projected node whose pet is gone (stale), and a hand-made node.
    { id: 'node-a-stale', family_id: FAMILY_A, kind: 'pet', name: 'Old cat', ref_table: 'pets', ref_id: 'pet-gone', attributes: PROJECTED },
    { id: 'node-a-hand', family_id: FAMILY_A, kind: 'topic', name: 'Grandma\'s recipes', ref_table: null, ref_id: null, attributes: {} },
    // B: its own projected node for a pet A's run never sees.
    { id: 'node-b-stale', family_id: FAMILY_B, kind: 'pet', name: 'B old cat', ref_table: 'pets', ref_id: 'pet-b-gone', attributes: PROJECTED },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ACTION-C745FFD9BC03 projectTwinAction', () => {
  it.each(['parent', 'adult'])('ACTION-C745FFD9BC03 the %s rebuilds A\'s graph from A\'s own rows', async (role) => {
    harness.role = role;
    const b = graphOf(FAMILY_B);
    const res = await projectTwinAction();
    expect(res.ok).toBe(true);

    const projected = nodes(FAMILY_A).filter((n) => n.ref_table).map((n) => `${n.ref_table}:${n.ref_id}`).sort();
    expect(projected).toEqual(['family_members:member-ana', 'family_members:member-emma', 'pets:pet-a']);
    expect(res.entities).toBe(3);
    // The stale projected node is pruned; the hand-made one is kept.
    expect(nodes(FAMILY_A).map((n) => n.id)).not.toContain('node-a-stale');
    expect(nodes(FAMILY_A).map((n) => n.id)).toContain('node-a-hand');
    expect(nodes(FAMILY_A).every((n) => n.family_id === FAMILY_A)).toBe(true);
    expect(nodes(FAMILY_A).find((n) => n.ref_id === 'pet-a')?.created_by).toBe(`user-${role}`);
    // Nothing of B's reached A's graph, and B's graph is as it was.
    expect(JSON.stringify(graphOf(FAMILY_A))).not.toMatch(/Leo|Rex|member-leo|pet-b/);
    expect(graphOf(FAMILY_B)).toEqual(b);
  });

  it('ACTION-C745FFD9BC03 a rebuild run twice leaves one node per source row', async () => {
    await projectTwinAction();
    const once = nodes(FAMILY_A).length;
    expect(await projectTwinAction()).toMatchObject({ ok: true, entities: 3 });
    expect(nodes(FAMILY_A)).toHaveLength(once);
  });

  it('ACTION-C745FFD9BC03 a refused graph write is reported in words, not answered with ok', async () => {
    const real = vi.mocked(db.from).getMockImplementation()!;
    vi.mocked(db.from).mockImplementation((table: string) => {
      const builder = real(table);
      if (table !== 'graph_entities') return builder;
      return Object.assign(builder, {
        upsert: async () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "graph_entities"' } }),
      });
    });
    const before = graphOf(FAMILY_A);
    const res = await projectTwinAction();
    expect(res.ok).toBe(false);
    // A sentence for a person, never the database's own text.
    expect(res.error).toMatch(/\w+ \w+/);
    expect(res.error).not.toContain('row-level security');
    expect(graphOf(FAMILY_A)).toEqual(before);
  });

  it('ACTION-C745FFD9BC03 a signed-out caller is sent to sign in and nothing is read or written', async () => {
    harness.signedOut = true;
    const a = graphOf(FAMILY_A);
    await expect(projectTwinAction()).rejects.toThrow('REDIRECT:/login');
    expect(read).toEqual([]);
    expect(graphOf(FAMILY_A)).toEqual(a);
  });
});
