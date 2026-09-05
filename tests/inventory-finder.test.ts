import { describe, expect, it } from 'vitest';
import {
  ITEM_CATEGORIES, ITEM_STATUSES, LOCATION_KINDS, categoryMeta, inventorySummary, lentOut, locationLabel, locationPath, locationTree,
  searchItems, valueSummary, warrantyAlerts, type ItemLike, type LocationLike,
} from '@/lib/inventory/finder';

const TODAY = new Date('2026-09-05T12:00:00');
const locations: LocationLike[] = [
  { id: 'garage', name: 'Garage', kind: 'garage', parent_id: null },
  { id: 'shelf', name: 'Shelf B', kind: 'shelf', parent_id: 'garage' },
  { id: 'box', name: 'Box 3', kind: 'box', parent_id: 'shelf' },
  { id: 'office', name: 'Office', kind: 'room', parent_id: null },
  { id: 'drawer', name: 'Top drawer', kind: 'drawer', parent_id: 'office' },
  { id: 'orphan', name: 'Orphan bin', kind: 'box', parent_id: 'missing' },
];
let n = 0;
function item(p: Partial<ItemLike> & { name: string }): ItemLike {
  n += 1;
  return { id: `i${n}`, category: 'other', location_id: null, quantity: 1, value_cents: null, brand: null, model: null, serial_number: null, tags: [], status: 'in_place', lent_to: null, lent_on: null, warranty_until: null, ...p };
}

describe('catalogs + paths', () => {
  it('has labels for every enum and walks location paths safely', () => {
    expect(LOCATION_KINDS).toHaveLength(13);
    expect(ITEM_CATEGORIES).toHaveLength(14);
    expect(ITEM_STATUSES).toHaveLength(5);
    expect(categoryMeta('nope' as never).value).toBe('other');
    expect(locationPath(locations, 'box')).toEqual(['Garage', 'Shelf B', 'Box 3']);
    expect(locationLabel(locations, 'box')).toBe('Garage › Shelf B › Box 3');
    expect(locationLabel(locations, null)).toBe('No location yet');
    const cyclic: LocationLike[] = [{ id: 'a', name: 'A', kind: 'box', parent_id: 'b' }, { id: 'b', name: 'B', kind: 'box', parent_id: 'a' }];
    expect(locationPath(cyclic, 'a')).toEqual(['B', 'A']);
  });
  it('builds a room tree with orphans promoted to roots', () => {
    const tree = locationTree(locations);
    expect(tree.map((t) => t.location.name)).toEqual(['Garage', 'Office', 'Orphan bin']);
    expect(tree[0].children.map((c) => c.name)).toEqual(['Shelf B']);
  });
});

describe('searchItems', () => {
  const items = [
    item({ name: 'Passports', category: 'documents', location_id: 'drawer', tags: ['travel', 'ids'] }),
    item({ name: 'Ski helmet', category: 'sports', location_id: 'box', brand: 'Giro' }),
    item({ name: 'Spare house key', category: 'keys', location_id: 'drawer', status: 'lent' }),
    item({ name: 'Drill', category: 'tools', location_id: 'shelf', brand: 'DeWalt', model: 'DCD771', serial_number: 'SN-4432' }),
  ];
  it('matches every token across name, brand, model, serial, tags and location path', () => {
    expect(searchItems(items, locations, 'passport').map((h) => h.item.name)).toEqual(['Passports']);
    expect(searchItems(items, locations, 'giro').map((h) => h.item.name)).toEqual(['Ski helmet']);
    expect(searchItems(items, locations, 'sn-4432')[0].matched).toContain('serial');
    expect(searchItems(items, locations, 'travel')[0].matched).toContain('tags');
    expect(searchItems(items, locations, 'garage').map((h) => h.item.name).sort()).toEqual(['Drill', 'Ski helmet']);
    expect(searchItems(items, locations, 'drawer key').map((h) => h.item.name)).toEqual(['Spare house key']);
    expect(searchItems(items, locations, 'drawer unicorn')).toEqual([]);
    expect(searchItems(items, locations, '   ')).toEqual([]);
    expect(searchItems(items, locations, 'ski')[0].where).toBe('Garage › Shelf B › Box 3');
  });
});

describe('loans, warranties, value', () => {
  it('lists lent items with overdue flags', () => {
    const items = [
      item({ name: 'Ladder', status: 'lent', lent_to: 'Neighbor', lent_on: '2026-07-01' }),
      item({ name: 'Board game', status: 'lent', lent_on: '2026-09-01' }),
      item({ name: 'Undated loan', status: 'lent' }),
      item({ name: 'Home', status: 'in_place' }),
    ];
    const loans = lentOut(items, TODAY);
    expect(loans.map((l) => [l.item.name, l.days, l.overdue])).toEqual([['Ladder', 66, true], ['Board game', 4, false], ['Undated loan', null, false]]);
  });
  it('flags warranties expiring within 60 days or expired within a year', () => {
    const items = [
      item({ name: 'TV', warranty_until: '2026-10-01' }),
      item({ name: 'Laptop', warranty_until: '2026-06-01' }),
      item({ name: 'Fridge', warranty_until: '2028-01-01' }),
      item({ name: 'Old phone', warranty_until: '2024-01-01' }),
      item({ name: 'Sold', warranty_until: '2026-09-10', status: 'disposed' }),
    ];
    expect(warrantyAlerts(items, TODAY).map((a) => [a.item.name, a.state])).toEqual([['Laptop', 'expired'], ['TV', 'expiring']]);
  });
  it('totals replacement value for what is still owned', () => {
    const items = [
      item({ name: 'TV', category: 'electronics', value_cents: 80000 }),
      item({ name: 'Chairs', category: 'furniture', value_cents: 5000, quantity: 4 }),
      item({ name: 'Lost watch', category: 'jewelry', value_cents: 30000, status: 'lost' }),
      item({ name: 'Unvalued' }),
    ];
    const v = valueSummary(items);
    expect(v.totalCents).toBe(100000);
    expect(v.valuedItems).toBe(2);
    expect(v.byCategory[0]).toEqual({ category: 'electronics', cents: 80000 });
  });
  it('summarises the catalog', () => {
    const items = [item({ name: 'A', location_id: 'box' }), item({ name: 'B' }), item({ name: 'C', status: 'lent', lent_on: '2026-01-01' }), item({ name: 'D', status: 'disposed' })];
    const s = inventorySummary(items, locations, TODAY);
    expect(s).toMatchObject({ items: 3, located: 1, unlocated: 2, rooms: 3, lent: 1, overdueLoans: 1 });
    expect(s.text).toBe('3 items · 1 placed · 1 lent out');
    expect(inventorySummary([], [], TODAY).text).toBe('Nothing catalogued yet');
  });
});
