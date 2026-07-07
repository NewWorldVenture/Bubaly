import { describe, it, expect } from 'vitest';
import {
  entityFromRow, edgeFromRow, graphFromRows, buildFamilyContext, emptyFamilyContext,
  type EntityRow, type EdgeRow,
} from '@/lib/reasoning/context';

// A small household graph: Emma (person) plays Soccer (activity) at Field (place),
// which is affected by Weather (topic); Emma is a member of the Smith family org.
const entRows: EntityRow[] = [
  { id: 'emma', kind: 'person', name: 'Emma', ref_table: 'family_members', ref_id: 'fm-emma', attributes: { role: 'child' } },
  { id: 'mom', kind: 'person', name: 'Mom', ref_table: 'family_members', ref_id: 'fm-mom', attributes: {} },
  { id: 'soccer', kind: 'activity', name: 'Soccer', ref_table: 'teams', ref_id: 't-1', attributes: {} },
  { id: 'field', kind: 'place', name: 'Field', ref_table: null, ref_id: null, attributes: {} },
  { id: 'weather', kind: 'topic', name: 'Weather', ref_table: null, ref_id: null, attributes: {} },
  { id: 'bad', kind: 'nonsense', name: 'Bad Kind', ref_table: null, ref_id: null, attributes: 'not-an-object' },
];
const edgeRows: EdgeRow[] = [
  { id: 'e1', source_id: 'emma', target_id: 'soccer', relation: 'plays', weight: 1, attributes: {} },
  { id: 'e2', source_id: 'soccer', target_id: 'field', relation: 'at', weight: 0.9, attributes: {} },
  { id: 'e3', source_id: 'weather', target_id: 'field', relation: 'affects', weight: '0.8', attributes: {} },
  { id: 'e4', source_id: 'mom', target_id: 'emma', relation: 'parent_of', weight: 1, attributes: {} },
];

describe('row → graph mapping', () => {
  it('maps snake_case entity rows and coerces an unknown kind to "other"', () => {
    expect(entityFromRow(entRows[0])).toMatchObject({ id: 'emma', kind: 'person', name: 'Emma', refTable: 'family_members', refId: 'fm-emma' });
    expect(entityFromRow(entRows[5]).kind).toBe('other');       // 'nonsense' → other
    expect(entityFromRow(entRows[5]).attributes).toEqual({});   // non-object attrs → {}
  });
  it('maps edge rows and parses a string weight', () => {
    expect(edgeFromRow(edgeRows[0])).toMatchObject({ sourceId: 'emma', targetId: 'soccer', relation: 'plays', weight: 1 });
    expect(edgeFromRow(edgeRows[2]).weight).toBeCloseTo(0.8, 5); // '0.8' → 0.8
  });
});

describe('FamilyContext', () => {
  const ctx = buildFamilyContext('fam-1', graphFromRows(entRows, edgeRows));

  it('is not empty and exposes the family id', () => {
    expect(ctx.isEmpty).toBe(false);
    expect(ctx.familyId).toBe('fam-1');
  });

  it('looks entities up by id, kind, ref, and roster', () => {
    expect(ctx.entity('emma')?.name).toBe('Emma');
    expect(ctx.byKind('person').map((e) => e.id).sort()).toEqual(['emma', 'mom']);
    expect(ctx.byRef('teams', 't-1')?.id).toBe('soccer');
    expect(ctx.byRef('family_members', 'nope')).toBeUndefined();
    expect(ctx.members().map((e) => e.id).sort()).toEqual(['emma', 'mom']); // person + family_members ref
  });

  it('walks direct relations by relation name', () => {
    expect(ctx.relatedByRelation('emma', 'plays').map((e) => e.id)).toEqual(['soccer']);
    expect(ctx.related('emma').map((n) => n.relation).sort()).toEqual(['parent_of', 'plays']);
  });

  it('finds the relationship path Emma → Soccer → Field with a description', () => {
    const c = ctx.connection('emma', 'field');
    expect(c?.path.map((e) => e.id)).toEqual(['emma', 'soccer', 'field']);
    expect(c?.description).toContain('Emma');
    expect(c?.description).toContain('Field');
    expect(ctx.connection('emma', 'nobody')).toBeNull();
  });

  it('ripples impact from weather out to the field (blast radius)', () => {
    const hit = ctx.ripple('weather').map((i) => i.entity.id);
    expect(hit).toContain('field');
  });

  it('reports the neighbourhood within N hops', () => {
    const ids = ctx.neighbourhood('emma', 2).map((n) => n.entity.id);
    expect(ids).toContain('soccer'); // 1 hop
    expect(ids).toContain('field');  // 2 hops
  });

  it('ranks the household hubs by connection degree', () => {
    const hubs = ctx.keyHubs(3).map((h) => h.entity.id);
    expect(hubs.length).toBeGreaterThan(0);
  });
});

describe('emptyFamilyContext', () => {
  it('is a safe no-graph fallback', () => {
    const ctx = emptyFamilyContext('fam-9');
    expect(ctx.isEmpty).toBe(true);
    expect(ctx.members()).toEqual([]);
    expect(ctx.related('anything')).toEqual([]);
    expect(ctx.connection('a', 'b')).toBeNull();
    expect(ctx.keyHubs()).toEqual([]);
  });
});
