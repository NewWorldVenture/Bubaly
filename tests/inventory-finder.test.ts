import { describe, expect, it } from 'vitest';
import {
  CONFIRM_REASON, ITEM_CATEGORIES, ITEM_STATUSES, LOCATION_KINDS, categoryMeta, inventorySummary, isConfirmation, lastConfirmed, lastMoved,
  lentOut, locationLabel, locationPath, locationTree, searchItems, valueSummary, warrantyAlerts,
  type ItemLike, type LocationLike, type MoveLike,
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
  it.each([
    ['Where are the passports?', 'Passports'],
    ['"Where are the passports?"', 'Passports'],
    ['Where do we keep our passports?', 'Passports'],
    ["WHERE'S MY SPARE HOUSE KEY?!", 'Spare house key'],
    ['Where\u2019s the spare house key?', 'Spare house key'],
    ['Where can I find the Giro helmet?', 'Ski helmet'],
    ['Please find the ski helmet.', 'Ski helmet'],
    ['Where is the ski helmet, please?', 'Ski helmet'],
    ['Could you locate our passports?', 'Passports'],
  ])('finds stored items for %s', (query, name) => {
    expect(searchItems(items, locations, query).map((hit) => hit.item.name)).toEqual([name]);
  });
  it('keeps meaningful qualifiers and the existing relevance evidence', () => {
    expect(searchItems(items, locations, 'Where is the red ski helmet?')).toEqual([]);
    expect(searchItems(items, locations, 'Where are the passports unicorn?')).toEqual([]);
    expect(searchItems(items, locations, 'Where is the passport drawer?'))
      .toEqual(searchItems(items, locations, 'passport drawer'));
    expect(searchItems(items, locations, 'Giro, helmet!').map((hit) => hit.item.name)).toEqual(['Ski helmet']);
  });
  it.each(['Where are the?', 'Where can I find?', 'Find my', 'Please locate the', '...?!', '   '])(
    'does not return the catalog for an empty item question: %s', (query) => {
      expect(searchItems(items, locations, query)).toEqual([]);
    },
  );
  it('preserves literal names, model numbers and serial punctuation', () => {
    const named = [
      item({ name: 'IT guide' }),
      item({ name: 'The Office DVD' }),
      item({ name: 'Office cable', category: 'electronics' }),
      item({ name: 'Programming guide', model: 'C++' }),
      item({ name: 'Programming notes', model: 'C#' }),
    ];
    expect(searchItems(named, locations, 'IT').map((hit) => hit.item.name)).toEqual(['IT guide']);
    expect(searchItems(named, locations, 'The Office').map((hit) => hit.item.name)).toEqual(['The Office DVD']);
    expect(searchItems(named, locations, 'C++').map((hit) => hit.item.name)).toEqual(['Programming guide']);
    expect(searchItems(named, locations, 'C#').map((hit) => hit.item.name)).toEqual(['Programming notes']);
    expect(searchItems(items, locations, 'SN-4432?')[0].matched).toContain('serial');
    expect(searchItems(items, locations, 'DCD771!')[0].matched).toContain('model');
  });
  it('uses the same Unicode normalization for stored fields and questions', () => {
    const unicodeItems = [item({ name: '\uff30\uff41\uff53\uff53\uff50\uff4f\uff52\uff54\uff53' })];
    expect(searchItems(unicodeItems, locations, 'Where are the passports?')[0].item).toBe(unicodeItems[0]);
  });
  it('never supplies absent records or invents a missing location', () => {
    expect(searchItems([items[1]], locations, 'Where are the passports?')).toEqual([]);
    expect(searchItems([], locations, 'Where are the passports?')).toEqual([]);
    const unlocated = item({ name: 'Passports', location_id: 'missing' });
    expect(searchItems([unlocated], locations, 'Where are the passports?')[0])
      .toMatchObject({ item: unlocated, where: 'No location yet' });
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

// "Is it still there?" — a catalogue is only as good as its last check, and
// the card may never claim a check nobody recorded. A confirmation is a move
// row with from = to and reason 'confirmed'; anything else is a relocation.
describe('confirmations', () => {
  const move = (p: Partial<MoveLike> & { id: string; item_id: string }): MoveLike =>
    ({ from_location_id: null, to_location_id: null, moved_at: '2026-09-01T10:00:00Z', reason: null, ...p });

  it('tells a confirmation from a relocation and from a same-place move with another reason', () => {
    expect(CONFIRM_REASON).toBe('confirmed');
    expect(isConfirmation({ from_location_id: 'drawer', to_location_id: 'drawer', reason: 'confirmed' })).toBe(true);
    expect(isConfirmation({ from_location_id: null, to_location_id: null, reason: 'confirmed' })).toBe(true);
    expect(isConfirmation({ from_location_id: 'drawer', to_location_id: 'box', reason: 'confirmed' })).toBe(false);
    expect(isConfirmation({ from_location_id: 'drawer', to_location_id: 'drawer', reason: 'spring clean' })).toBe(false);
    expect(isConfirmation({ from_location_id: 'drawer', to_location_id: 'drawer', reason: null })).toBe(false);
  });

  it('reads back the latest confirmation for the item, and nothing when nobody confirmed it', () => {
    const moves: MoveLike[] = [
      move({ id: 'm1', item_id: 'passport', from_location_id: 'drawer', to_location_id: 'drawer', reason: CONFIRM_REASON, moved_at: '2026-08-01T10:00:00Z' }),
      move({ id: 'm2', item_id: 'passport', from_location_id: 'drawer', to_location_id: 'drawer', reason: CONFIRM_REASON, moved_at: '2026-09-03T09:00:00Z' }),
      move({ id: 'm3', item_id: 'passport', from_location_id: 'box', to_location_id: 'drawer', reason: 'tidy', moved_at: '2026-09-04T09:00:00Z' }),
      move({ id: 'm4', item_id: 'helmet', from_location_id: 'garage', to_location_id: 'garage', reason: CONFIRM_REASON, moved_at: '2026-09-05T09:00:00Z' }),
    ];
    expect(lastConfirmed(moves, 'passport')).toEqual({ moveId: 'm2', at: '2026-09-03T09:00:00Z', locationId: 'drawer' });
    expect(lastConfirmed(moves, 'nothing')).toBeNull();
    expect(lastConfirmed([], 'passport')).toBeNull();
    // A relocation is never reported as a confirmation, and vice versa.
    expect(lastMoved(moves, 'passport')).toEqual({ moveId: 'm3', at: '2026-09-04T09:00:00Z', fromLocationId: 'box', toLocationId: 'drawer' });
    expect(lastMoved(moves, 'helmet')).toBeNull();
  });

  it('ignores a row whose timestamp cannot be read, whichever order it arrives in', () => {
    const good = move({ id: 'good', item_id: 'passport', from_location_id: 'drawer', to_location_id: 'drawer', reason: CONFIRM_REASON, moved_at: '2026-09-03T09:00:00Z' });
    const bad = move({ id: 'bad', item_id: 'passport', from_location_id: 'drawer', to_location_id: 'drawer', reason: CONFIRM_REASON, moved_at: 'not a date' });
    expect(lastConfirmed([good, bad], 'passport')?.moveId).toBe('good');
    expect(lastConfirmed([bad, good], 'passport')?.moveId).toBe('good');
    expect(lastConfirmed([bad], 'passport')).toBeNull();
  });
});
