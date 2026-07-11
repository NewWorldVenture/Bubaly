import { describe, it, expect } from 'vitest';
import { projectTwin, projectionSummary, EMPTY_SNAPSHOT, type TwinSnapshot } from '@/lib/twin/project';
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
