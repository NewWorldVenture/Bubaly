import { describe, it, expect } from 'vitest';
import { buildFamilyContext, graphFromRows, emptyFamilyContext, type EntityRow, type EdgeRow } from '@/lib/reasoning/context';
import { familyInsights, insightsToPromptLines } from '@/lib/reasoning/insights';

// A hub graph: "Dinner" is wired to five things (a coordination hub); three other
// entities are left unlinked (orphans).
const entRows: EntityRow[] = [
  { id: 'dinner', kind: 'event', name: 'Dinner', ref_table: null, ref_id: null, attributes: {} },
  { id: 'mom', kind: 'person', name: 'Mom', ref_table: 'family_members', ref_id: 'fm-mom', attributes: {} },
  { id: 'emma', kind: 'person', name: 'Emma', ref_table: 'family_members', ref_id: 'fm-emma', attributes: {} },
  { id: 'groceries', kind: 'item', name: 'Groceries', ref_table: null, ref_id: null, attributes: {} },
  { id: 'kitchen', kind: 'place', name: 'Kitchen', ref_table: null, ref_id: null, attributes: {} },
  { id: 'recipe', kind: 'item', name: 'Recipe', ref_table: null, ref_id: null, attributes: {} },
  // Three orphans (no edges):
  { id: 'o1', kind: 'item', name: 'Umbrella', ref_table: null, ref_id: null, attributes: {} },
  { id: 'o2', kind: 'item', name: 'Passport', ref_table: null, ref_id: null, attributes: {} },
  { id: 'o3', kind: 'item', name: 'Charger', ref_table: null, ref_id: null, attributes: {} },
];
const edgeRows: EdgeRow[] = [
  { id: 'e1', source_id: 'dinner', target_id: 'mom', relation: 'cooked_by', weight: 1, attributes: {} },
  { id: 'e2', source_id: 'dinner', target_id: 'emma', relation: 'attended_by', weight: 1, attributes: {} },
  { id: 'e3', source_id: 'dinner', target_id: 'groceries', relation: 'needs', weight: 1, attributes: {} },
  { id: 'e4', source_id: 'dinner', target_id: 'kitchen', relation: 'at', weight: 1, attributes: {} },
  { id: 'e5', source_id: 'dinner', target_id: 'recipe', relation: 'uses', weight: 1, attributes: {} },
];

describe('familyInsights', () => {
  const ctx = buildFamilyContext('fam-1', graphFromRows(entRows, edgeRows));

  it('surfaces the coordination hub with its degree and blast radius', () => {
    const hub = familyInsights(ctx).find((i) => i.kind === 'hub');
    expect(hub).toBeDefined();
    expect(hub!.entityId).toBe('dinner');
    expect(hub!.title).toContain('Dinner');
    expect(hub!.detail).toContain('5 things depend on it');
    expect(hub!.detail).toContain('ripples');
  });

  it('flags unlinked entities when there are enough of them', () => {
    const unlinked = familyInsights(ctx).find((i) => i.kind === 'unlinked');
    expect(unlinked).toBeDefined();
    expect(unlinked!.title).toContain("aren't linked yet");
  });

  it('respects thresholds (a high hub floor suppresses the hub insight)', () => {
    const kinds = familyInsights(ctx, { hubMinDegree: 99, unlinkedMinCount: 99 }).map((i) => i.kind);
    expect(kinds).not.toContain('hub');
    expect(kinds).not.toContain('unlinked');
  });

  it('renders prompt lines, with a graceful fallback for an empty graph', () => {
    const lines = insightsToPromptLines(familyInsights(ctx));
    expect(lines).toContain('Dinner');
    expect(insightsToPromptLines(familyInsights(emptyFamilyContext('x')))).toContain('No linked relationships');
  });

  it('returns nothing for an empty context', () => {
    expect(familyInsights(emptyFamilyContext('x'))).toEqual([]);
  });
});
