import { describe, it, expect } from 'vitest';
import {
  projectTwin, projectionSummary, EMPTY_SNAPSHOT, eventWindow, EVENT_HORIZON_DAYS,
  stalePrunableEntityIds, knowledgeNodeKind, clampEdgeWeight, knowledgeGraphTarget, toCanonicalGraphRow,
  type TwinSnapshot,
} from '@/lib/twin/project';
import { buildIndex, neighbours, findPath } from '@/lib/graph/reason';

const snap: TwinSnapshot = {
  members: [{ id: 'm1', name: 'Emma' }, { id: 'm2', name: 'Daniel' }],
  pets: [{ id: 'p1', name: 'Rex', species: 'dog' }],
  vehicles: [{ id: 'v1', label: 'Van', primary_driver: 'm2' }, { id: 'v2', label: 'Bike', primary_driver: null }],
  classes: [{ id: 'c1', member_id: 'm1', subject: 'Math' }],
  teams: [{ id: 't1', member_id: 'm1', sport: 'Soccer' }],
  routines: [{ id: 'r1', member_id: 'm1', title: 'Bedtime' }],
  places: [{ id: 'pl1', name: 'Field' }],
  accounts: [{ id: 'a1', name: 'Checking' }],
  providers: [],
};

describe('projectTwin', () => {
  it('projects every domain row into a typed entity with a stable ref key', () => {
    const { entities } = projectTwin(snap);
    // 2 members + 1 pet + 2 vehicles + 1 class + 1 team + 1 routine + 1 place + 1 account = 10
    expect(entities).toHaveLength(10);
    const emma = entities.find((e) => e.refTable === 'family_members' && e.refId === 'm1');
    expect(emma).toMatchObject({ kind: 'person', name: 'Emma', key: 'family_members:m1' });
    expect(entities.find((e) => e.refTable === 'teams')).toMatchObject({ kind: 'activity', name: 'Soccer' });
    expect(entities.find((e) => e.refTable === 'family_places')).toMatchObject({ kind: 'place' });
  });

  it('links members to their schools/teams/routines and drivers to vehicles', () => {
    const { edges } = projectTwin(snap);
    expect(edges).toContainEqual({ sourceKey: 'family_members:m1', targetKey: 'teams:t1', relation: 'plays', weight: 0.8 });
    expect(edges).toContainEqual({ sourceKey: 'family_members:m1', targetKey: 'school_classes:c1', relation: 'attends', weight: 0.7 });
    expect(edges).toContainEqual({ sourceKey: 'family_members:m2', targetKey: 'vehicles:v1', relation: 'drives', weight: 0.6 });
  });

  it('emits no edge for a vehicle with no driver', () => {
    const { edges } = projectTwin(snap);
    expect(edges.some((e) => e.targetKey === 'vehicles:v2')).toBe(false);
  });

  it('drops edges that reference an unknown member (no dangling links)', () => {
    const bad = { ...EMPTY_SNAPSHOT, members: [], teams: [{ id: 't1', member_id: 'ghost', sport: 'Soccer' }] };
    const { entities, edges } = projectTwin(bad);
    expect(entities).toHaveLength(1); // the team node
    expect(edges).toHaveLength(0);    // ghost member never became a node
  });

  it('falls back to sensible names for blank fields', () => {
    const { entities } = projectTwin({ ...EMPTY_SNAPSHOT, members: [{ id: 'm', name: '  ' }], pets: [{ id: 'p', name: null, species: 'cat' }] });
    expect(entities.find((e) => e.refTable === 'family_members')?.name).toBe('Member');
    expect(entities.find((e) => e.refTable === 'pets')?.name).toBe('cat');
  });

  it('projects care providers as org nodes the member "sees"', () => {
    const { entities, edges } = projectTwin({
      ...EMPTY_SNAPSHOT,
      members: [{ id: 'm1', name: 'Emma' }],
      providers: [
        { id: 'd1', member_id: 'm1', name: 'Dr. Lee', specialty: 'Pediatrics' },
        { id: 'd2', member_id: null, name: 'Bright Smiles', specialty: 'Dentist' }, // family-level, no edge
        { id: 'd3', member_id: 'ghost', name: 'Dr. Nobody', specialty: null },       // dangling → no edge
      ],
    });
    const lee = entities.find((e) => e.refTable === 'health_providers' && e.refId === 'd1');
    expect(lee).toMatchObject({ kind: 'org', name: 'Dr. Lee (Pediatrics)', key: 'health_providers:d1' });
    expect(entities.find((e) => e.refId === 'd2')?.name).toBe('Bright Smiles (Dentist)');
    expect(entities.find((e) => e.refId === 'd3')?.name).toBe('Dr. Nobody'); // no specialty suffix
    expect(edges).toContainEqual({ sourceKey: 'family_members:m1', targetKey: 'health_providers:d1', relation: 'sees', weight: 0.6 });
    // family-level + dangling providers produce a node but no edge
    expect(edges.some((e) => e.targetKey === 'health_providers:d2')).toBe(false);
    expect(edges.some((e) => e.targetKey === 'health_providers:d3')).toBe(false);
  });

  it('handles the empty snapshot', () => {
    const p = projectTwin(EMPTY_SNAPSHOT);
    expect(p.entities).toHaveLength(0);
    expect(p.edges).toHaveLength(0);
  });
});

describe('projection feeds the reasoning engine end-to-end', () => {
  it('the projected graph is traversable (Emma reaches her vehicle-mate household)', () => {
    const idx = buildIndex(
      // reshape ProjectedEntity/Edge into the engine's Graph via ref keys as ids
      (() => {
        const { entities, edges } = projectTwin(snap);
        return {
          entities: entities.map((e) => ({ id: e.key, kind: e.kind, name: e.name })),
          edges: edges.map((e, i) => ({ id: `e${i}`, sourceId: e.sourceKey, targetId: e.targetKey, relation: e.relation, weight: e.weight })),
        };
      })(),
    );
    // Emma -> Soccer is a direct neighbour
    expect(neighbours(idx, 'family_members:m1').some((n) => n.entity.name === 'Soccer')).toBe(true);
    // Daniel -> Van path exists
    expect(findPath(idx, 'family_members:m2', 'vehicles:v1')?.length).toBe(2);
  });
});

describe('projectionSummary', () => {
  it('counts entities/edges and buckets by kind', () => {
    const s = projectionSummary(projectTwin(snap));
    expect(s.entities).toBe(10);
    expect(s.edges).toBe(4);
    expect(s.byKind.person).toBe(2);
    expect(s.byKind.item).toBe(3); // 2 vehicles + 1 account
  });
});

// ─── M3: events, assets, obligations, preferences ────────────────────────────
// The twin used to know WHO the household is but not what is coming, what they
// own, what they owe or what they like. These are the four kinds that close it,
// and the provenance that lets a reader tell a derived claim from a typed one.

const NOW = new Date('2026-03-01T09:00:00.000Z');

/** Every attributes value the projector can produce, read back safely. */
function attrs(e: { attributes?: Record<string, unknown> } | undefined): Record<string, unknown> {
  return (e?.attributes ?? {}) as Record<string, unknown>;
}
function nodeFor(p: ReturnType<typeof projectTwin>, table: string, id: string) {
  return p.entities.find((e) => e.refTable === table && e.refId === id);
}

describe('provenance', () => {
  it('stamps every projected node with source, observed_at and its ref table', () => {
    const p = projectTwin(snap, { now: NOW });
    expect(p.entities.length).toBeGreaterThan(0);
    for (const e of p.entities) {
      expect(e.attributes?.provenance).toEqual({
        source: 'projection',
        observed_at: NOW.toISOString(),
        ref_table: e.refTable,
      });
    }
  });

  it('carries the finer subkind alongside the CHECK-constrained kind', () => {
    // graph_entities.kind is CHECKed to the 0129 vocabulary (no 'asset',
    // 'obligation' or 'preference'), so the finer type has to live in attributes.
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      vehicles: [{ id: 'v1', label: 'Van', primary_driver: null }],
    }, { now: NOW });
    expect(nodeFor(p, 'vehicles', 'v1')).toMatchObject({ kind: 'item' });
    expect(attrs(nodeFor(p, 'vehicles', 'v1')).subkind).toBe('asset');
  });
});

describe('projectTwin — events', () => {
  it('projects a calendar event and links it to the member it lands on', () => {
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      members: [{ id: 'm1', name: 'Emma' }],
      events: [
        { id: 'ev1', title: 'Dentist', starts_at: '2026-03-04T14:00:00.000Z', ends_at: '2026-03-04T15:00:00.000Z', all_day: false, category: 'health', location: 'Bright Smiles', assignee_id: 'm1' },
        { id: 'ev2', title: null, starts_at: '2026-03-05T00:00:00.000Z', all_day: true, assignee_id: null },
      ],
    }, { now: NOW });

    expect(nodeFor(p, 'calendar_events', 'ev1')).toMatchObject({ kind: 'event', name: 'Dentist' });
    expect(attrs(nodeFor(p, 'calendar_events', 'ev1'))).toMatchObject({
      subkind: 'event', starts_at: '2026-03-04T14:00:00.000Z', category: 'health', location: 'Bright Smiles',
    });
    expect(p.edges).toContainEqual({ sourceKey: 'calendar_events:ev1', targetKey: 'family_members:m1', relation: 'attended_by', weight: 0.7 });
    // An unassigned event is still a node — it just makes no claim about who attends.
    expect(nodeFor(p, 'calendar_events', 'ev2')?.name).toBe('Event');
    expect(p.edges.some((e) => e.sourceKey === 'calendar_events:ev2')).toBe(false);
  });

  it('the 60-day window is a pure, testable range', () => {
    const w = eventWindow(NOW);
    expect(EVENT_HORIZON_DAYS).toBe(60);
    expect(w.from).toBe(NOW.toISOString());
    expect(w.to).toBe('2026-04-30T09:00:00.000Z');
  });
});

describe('projectTwin — assets', () => {
  it('places home assets in their home and inventory in its storage location and owner', () => {
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      members: [{ id: 'm1', name: 'Emma' }],
      homes: [{ id: 'h1', name: 'Main House' }],
      storageLocations: [{ id: 'l1', name: 'Garage', kind: 'garage' }],
      homeAssets: [{ id: 'a1', name: 'Water heater', category: 'plumbing', home_id: 'h1', location: 'Basement', warranty_until: '2028-01-01' }],
      inventory: [{ id: 'i1', name: 'Drill', category: 'tools', location_id: 'l1', owner_member_id: 'm1', status: 'in_place', value_cents: 12000 }],
    }, { now: NOW });

    expect(nodeFor(p, 'home_assets', 'a1')).toMatchObject({ kind: 'item', name: 'Water heater' });
    expect(attrs(nodeFor(p, 'home_assets', 'a1'))).toMatchObject({ subkind: 'asset', asset_kind: 'home_asset', category: 'plumbing' });
    expect(nodeFor(p, 'homes', 'h1')).toMatchObject({ kind: 'place', name: 'Main House' });
    expect(p.edges).toContainEqual({ sourceKey: 'home_assets:a1', targetKey: 'homes:h1', relation: 'located_at', weight: 0.5 });

    expect(attrs(nodeFor(p, 'inventory_items', 'i1'))).toMatchObject({ subkind: 'asset', asset_kind: 'inventory_item', value_cents: 12000 });
    expect(p.edges).toContainEqual({ sourceKey: 'inventory_items:i1', targetKey: 'home_locations:l1', relation: 'located_at', weight: 0.4 });
    expect(p.edges).toContainEqual({ sourceKey: 'inventory_items:i1', targetKey: 'family_members:m1', relation: 'owned_by', weight: 0.5 });
  });

  it('a warranty covers the asset it names, or the home when it is a whole-home plan — never both', () => {
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      homes: [{ id: 'h1', name: 'Main House' }],
      homeAssets: [{ id: 'a1', name: 'Fridge' }],
      warranties: [
        { id: 'w1', name: 'Fridge extended', provider: 'LG', asset_id: 'a1', home_id: 'h1', expires_on: '2027-06-01', status: 'active' },
        { id: 'w2', name: 'Home warranty', provider: 'First American', asset_id: null, home_id: 'h1', status: 'active' },
      ],
    }, { now: NOW });

    expect(attrs(nodeFor(p, 'home_warranties', 'w1'))).toMatchObject({ subkind: 'warranty', provider: 'LG', expires_on: '2027-06-01' });
    const w1Edges = p.edges.filter((e) => e.sourceKey === 'home_warranties:w1');
    expect(w1Edges).toEqual([{ sourceKey: 'home_warranties:w1', targetKey: 'home_assets:a1', relation: 'covers', weight: 0.8 }]);
    expect(p.edges).toContainEqual({ sourceKey: 'home_warranties:w2', targetKey: 'homes:h1', relation: 'covers', weight: 0.5 });
  });

  it('projects a home project as an item owned by a member', () => {
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      members: [{ id: 'm2', name: 'Daniel' }],
      projects: [{ id: 'pr1', title: 'Repaint the deck', status: 'in_progress', room: 'Outdoor', owner_id: 'm2', priority: 'high' }],
    }, { now: NOW });

    expect(nodeFor(p, 'home_projects', 'pr1')).toMatchObject({ kind: 'item', name: 'Repaint the deck' });
    expect(attrs(nodeFor(p, 'home_projects', 'pr1'))).toMatchObject({ subkind: 'project', status: 'in_progress', room: 'Outdoor', priority: 'high' });
    expect(p.edges).toContainEqual({ sourceKey: 'home_projects:pr1', targetKey: 'family_members:m2', relation: 'owned_by', weight: 0.5 });
  });
});

describe('projectTwin — obligations', () => {
  it('projects bills, open paperwork and renewals as obligations carrying due date and amount', () => {
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      members: [{ id: 'm1', name: 'Emma' }],
      bills: [{ id: 'b1', name: 'Electric', amount: 142.5, due_date: '2026-03-12', status: 'upcoming', category: 'utilities' }],
      paperwork: [{
        id: 'pw1', title: 'Field trip slip', status: 'needs_action', due_on: '2026-03-08', amount: 15, kind: 'permission_slip',
        actions: [
          { kind: 'sign', label: 'Sign and return the slip', due_on: '2026-03-08', amount: null },
          { kind: 'pay', label: 'Pay the fee', due_on: null, amount: 15, materialized_as: 'bills' },
        ],
      }],
      renewals: [{ id: 'r1', title: 'Passport', member_id: 'm1', expires_at: '2026-09-01', cost: 130, category: 'passport', status: 'active' }],
    }, { now: NOW });

    expect(nodeFor(p, 'bills', 'b1')).toMatchObject({ kind: 'other', name: 'Electric' });
    expect(attrs(nodeFor(p, 'bills', 'b1'))).toMatchObject({ subkind: 'obligation', obligation_kind: 'bill', due_on: '2026-03-12', amount: 142.5 });

    expect(attrs(nodeFor(p, 'paperwork_items', 'pw1'))).toMatchObject({
      subkind: 'obligation', obligation_kind: 'paperwork', due_on: '2026-03-08',
      // Only the action nobody has materialised yet is still outstanding.
      open_actions: ['Sign and return the slip'],
    });

    expect(attrs(nodeFor(p, 'renewals', 'r1'))).toMatchObject({ subkind: 'obligation', obligation_kind: 'renewal', due_on: '2026-09-01', amount: 130 });
    expect(p.edges).toContainEqual({ sourceKey: 'renewals:r1', targetKey: 'family_members:m1', relation: 'owed_by', weight: 0.6 });
    // bills has no member column, so the graph states no owner rather than guessing one.
    expect(p.edges.some((e) => e.sourceKey === 'bills:b1')).toBe(false);
  });

  it('treats a malformed paperwork actions blob as no open actions, not a crash', () => {
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      paperwork: [
        { id: 'pw1', title: 'A', actions: 'not-an-array' },
        { id: 'pw2', title: 'B', actions: [null, 42, { kind: 'review' }] },
      ],
    }, { now: NOW });
    expect(attrs(nodeFor(p, 'paperwork_items', 'pw1')).open_actions).toEqual([]);
    // A label-less action still names its kind rather than vanishing.
    expect(attrs(nodeFor(p, 'paperwork_items', 'pw2')).open_actions).toEqual(['review']);
  });
});

describe('projectTwin — preferences', () => {
  it('projects family_facts preferences as topics carrying source and confidence', () => {
    const p = projectTwin({
      ...EMPTY_SNAPSHOT,
      members: [{ id: 'm1', name: 'Emma' }],
      preferences: [
        { id: 'f1', member_id: 'm1', label: 'Favourite dinner', value: 'Tacos', source: 'ai_conversation', confidence: 70 },
        { id: 'f2', member_id: null, label: 'No nuts in the house', value: 'Allergy', source: 'user', confidence: null },
      ],
    }, { now: NOW });

    expect(nodeFor(p, 'family_facts', 'f1')).toMatchObject({ kind: 'topic', name: 'Favourite dinner' });
    expect(attrs(nodeFor(p, 'family_facts', 'f1'))).toMatchObject({
      subkind: 'preference', value: 'Tacos', source: 'ai_conversation', confidence: 70,
    });
    expect(p.edges).toContainEqual({ sourceKey: 'family_facts:f1', targetKey: 'family_members:m1', relation: 'preference_of', weight: 0.5 });
    // A whole-family preference is a node with no member edge — not a guess at whose it is.
    expect(attrs(nodeFor(p, 'family_facts', 'f2')).confidence).toBeNull();
    expect(p.edges.some((e) => e.sourceKey === 'family_facts:f2')).toBe(false);
  });
});

describe('projectTwin — idempotence and stability', () => {
  const rich: TwinSnapshot = {
    ...snap,
    events: [{ id: 'ev1', title: 'Dentist', starts_at: '2026-03-04T14:00:00.000Z', assignee_id: 'm1' }],
    homes: [{ id: 'h1', name: 'Main House' }],
    homeAssets: [{ id: 'a1', name: 'Fridge', home_id: 'h1' }],
    bills: [{ id: 'b1', name: 'Electric', amount: 10, due_date: '2026-03-12' }],
    preferences: [{ id: 'f1', member_id: 'm1', label: 'Tacos', value: 'yes' }],
  };

  it('is deterministic — two runs at the same instant produce identical output', () => {
    expect(projectTwin(rich, { now: NOW })).toEqual(projectTwin(rich, { now: NOW }));
  });

  it('keys stay `${refTable}:${refId}`, so the upsert conflict target never moves', () => {
    for (const e of projectTwin(rich, { now: NOW }).entities) {
      expect(e.key).toBe(`${e.refTable}:${e.refId}`);
    }
  });
});

describe('stalePrunableEntityIds', () => {
  const projection = projectTwin({
    ...EMPTY_SNAPSHOT,
    bills: [{ id: 'b1', name: 'Electric' }],
  }, { now: NOW });
  const projected = { provenance: { source: 'projection', observed_at: NOW.toISOString(), ref_table: 'bills' } };
  const covered = ['bills', 'family_facts', 'grocery_items'];

  it('prunes a projected node whose source row has disappeared', () => {
    const stale = stalePrunableEntityIds([
      { id: 'g1', ref_table: 'bills', ref_id: 'b1', attributes: projected },   // still live
      { id: 'g2', ref_table: 'bills', ref_id: 'b-gone', attributes: projected }, // paid + deleted
    ], projection, covered);
    expect(stale).toEqual(['g2']);
  });

  it('never prunes a hand-made node, even one naming a table the projector owns', () => {
    const manual = { provenance: { source: 'manual', observed_at: NOW.toISOString() } };
    const stale = stalePrunableEntityIds([
      { id: 'g3', ref_table: 'bills', ref_id: 'b-gone', attributes: manual },
      { id: 'g4', ref_table: null, ref_id: null, attributes: manual },            // free-standing node
      { id: 'g5', ref_table: 'bills', ref_id: 'b-old', attributes: {} },          // predates the stamp
      { id: 'g6', ref_table: 'grocery_items', ref_id: 'x', attributes: projected }, // not ours
    ], projection, covered);
    expect(stale).toEqual([]);
  });

  // The prune's premise is "the projection lists every live row". A capped read
  // that came back full breaks that premise: the rows past the cap are unknown,
  // not gone. Absence from a truncated projection must never mean deleted.
  it('leaves a table alone when the caller could not read it in full', () => {
    const stale = stalePrunableEntityIds([
      { id: 'g7', ref_table: 'bills', ref_id: 'b-unseen', attributes: projected },
    ], projection, []);
    expect(stale).toEqual([]);
  });

  it('judges only the tables the caller vouches for, not the ones it could not', () => {
    const factProjected = { provenance: { source: 'projection', observed_at: NOW.toISOString(), ref_table: 'family_facts' } };
    const stale = stalePrunableEntityIds([
      { id: 'g8', ref_table: 'bills', ref_id: 'b-gone', attributes: projected },        // fully read → judged
      { id: 'g9', ref_table: 'family_facts', ref_id: 'f-unseen', attributes: factProjected }, // truncated → spared
    ], projection, ['bills']);
    expect(stale).toEqual(['g8']);
  });
});

describe('the legacy knowledge graph maps onto the canonical one', () => {
  it('maps legacy node types onto the kinds the 0129 CHECK admits', () => {
    expect(knowledgeNodeKind('person')).toBe('person');
    expect(knowledgeNodeKind('  SCHOOL ')).toBe('org');
    expect(knowledgeNodeKind('preference')).toBe('topic');
    expect(knowledgeNodeKind('vehicle')).toBe('item');
    // Unrecognised types land honestly rather than being guessed or dropped.
    expect(knowledgeNodeKind('spaceship')).toBe('other');
    expect(knowledgeNodeKind(null)).toBe('other');
  });

  it('clamps the legacy unbounded weight into the 0..1 CHECK', () => {
    expect(clampEdgeWeight(0.4)).toBe(0.4);
    expect(clampEdgeWeight(7)).toBe(1);
    expect(clampEdgeWeight(-3)).toBe(0);
    expect(clampEdgeWeight('nope')).toBe(1);
    expect(clampEdgeWeight(undefined)).toBe(1);
  });

  it('translates a node write into a canonical row stamped as manual', () => {
    const row = toCanonicalGraphRow('graph_entities', {
      member_id: 'm1', node_type: 'preference', label: 'Loves tacos', ref_table: 'family_facts', ref_id: 'f1', weight: 4,
    }, NOW.toISOString());

    expect(row).toMatchObject({ kind: 'topic', name: 'Loves tacos', ref_table: 'family_facts', ref_id: 'f1' });
    // Columns the canonical table does not have are preserved, not dropped.
    expect(row.attributes).toEqual({
      provenance: { source: 'manual', observed_at: NOW.toISOString() },
      node_type: 'preference', member_id: 'm1', weight: 1,
    });
  });

  it('only emits the keys the caller supplied, so a partial update nulls nothing', () => {
    const row = toCanonicalGraphRow('graph_entities', { label: 'Renamed' }, NOW.toISOString());
    expect(Object.keys(row).sort()).toEqual(['attributes', 'name']);
  });

  it('translates an edge write, defaulting the weight the legacy table left open', () => {
    const row = toCanonicalGraphRow('graph_edges', { source_id: 'g1', target_id: 'g2', relation: 'related_to' }, NOW.toISOString());
    expect(row).toEqual({
      source_id: 'g1', target_id: 'g2', relation: 'related_to',
      attributes: { provenance: { source: 'manual', observed_at: NOW.toISOString() } },
    });
  });

  it('routes only the two legacy tables', () => {
    expect(knowledgeGraphTarget('family_knowledge_nodes')).toBe('graph_entities');
    expect(knowledgeGraphTarget('family_knowledge_edges')).toBe('graph_edges');
    expect(knowledgeGraphTarget('family_memories')).toBeNull();
  });
});
