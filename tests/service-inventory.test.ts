// The inventory service behind "where's the passport?": the answer comes with
// the full room › container path and the last confirmation on file; a move
// updates the item and writes a family-scoped history row; a confirmation is
// a move with from = to and the confirmed reason; and every read fails closed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { confirmItem, findItems, recordMove, resolveLocationByName } from '@/lib/services/inventory';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-05T12:00:00Z');
const FAMILY = 'fam-1';
const OTHER_FAMILY = 'fam-2';

function makeDb(): InMemorySupabase {
  const db = createInMemorySupabase({
    defaults: {
      inventory_items: { category: 'other', quantity: 1, value_cents: null, brand: null, model: null, serial_number: null, tags: [], status: 'in_place', lent_to: null, lent_on: null, warranty_until: null, location_id: null, owner_member_id: null, notes: null, photo_path: null, purchased_on: null },
      home_locations: { kind: 'room', parent_id: null, notes: null },
      inventory_moves: { from_location_id: null, to_location_id: null, moved_by: null, reason: null },
    },
  });
  db.seed('home_locations', [
    { id: 'office', family_id: FAMILY, name: 'Office', kind: 'room', parent_id: null },
    { id: 'drawer', family_id: FAMILY, name: 'Top drawer', kind: 'drawer', parent_id: 'office' },
    { id: 'garage', family_id: FAMILY, name: 'Garage', kind: 'garage', parent_id: null },
    { id: 'shelf', family_id: FAMILY, name: 'Shelf B', kind: 'shelf', parent_id: 'garage' },
    { id: 'other-garage', family_id: OTHER_FAMILY, name: 'Garage', kind: 'garage', parent_id: null },
  ]);
  db.seed('inventory_items', [
    { id: 'passports', family_id: FAMILY, name: 'Passports', category: 'documents', location_id: 'drawer', tags: ['travel'] },
    { id: 'helmet', family_id: FAMILY, name: 'Ski helmet', category: 'sports', location_id: 'shelf', brand: 'Giro' },
    { id: 'lost-key', family_id: FAMILY, name: 'Spare key', category: 'keys', location_id: null, status: 'lost' },
    { id: 'sold', family_id: FAMILY, name: 'Old passports', category: 'documents', location_id: 'drawer', status: 'disposed' },
    { id: 'theirs', family_id: OTHER_FAMILY, name: 'Passports', category: 'documents', location_id: 'other-garage' },
  ]);
  db.seed('inventory_moves', [
    { id: 'mv-1', family_id: FAMILY, item_id: 'passports', from_location_id: 'drawer', to_location_id: 'drawer', moved_at: '2026-08-20T10:00:00Z', reason: 'confirmed' },
    { id: 'mv-2', family_id: FAMILY, item_id: 'passports', from_location_id: 'garage', to_location_id: 'drawer', moved_at: '2026-06-01T10:00:00Z', reason: 'moved in' },
    { id: 'mv-3', family_id: OTHER_FAMILY, item_id: 'theirs', from_location_id: 'other-garage', to_location_id: 'other-garage', moved_at: '2026-09-01T10:00:00Z', reason: 'confirmed' },
  ]);
  return db;
}

function scopeWith(db: InMemorySupabase, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'member',
    tz: 'America/New_York', now: NOW, ...extra,
  };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('findItems', () => {
  it("answers \"where's the passport\" with the room › container path and the last confirmation", async () => {
    const db = makeDb();
    const res = await findItems(scopeWith(db), { query: "Where's the passport?" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    const hit = res.data[0];
    expect(hit.item.id).toBe('passports');
    expect(hit.where).toBe('Office › Top drawer');
    expect(hit.path).toEqual(['Office', 'Top drawer']);
    expect(hit.lastConfirmed).toEqual({ moveId: 'mv-1', at: '2026-08-20T10:00:00Z', locationId: 'drawer' });
    expect(hit.lastMovedAt).toBe('2026-06-01T10:00:00Z');
  });

  it('never reaches into another family and never returns what was disposed of', async () => {
    const db = makeDb();
    const res = await findItems(scopeWith(db, { familyId: OTHER_FAMILY }), { query: 'passports' });
    expect(res.ok && res.data.map((h) => h.item.id)).toEqual(['theirs']);
    const mine = await findItems(scopeWith(db), { query: 'passports' });
    expect(mine.ok && mine.data.map((h) => h.item.id)).toEqual(['passports']);
  });

  it('refuses an empty question and caps the limit', async () => {
    const db = makeDb();
    expect(await findItems(scopeWith(db), { query: '   ' })).toMatchObject({ ok: false, code: 'invalid_input' });
    const res = await findItems(scopeWith(db), { query: 'a', limit: 1000 });
    expect(res.ok).toBe(true);
  });

  it('fails closed when a read fails, and says so in the log', async () => {
    const broken = {
      from: () => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        Object.assign(chain, { select: self, eq: self, neq: self, in: self, order: self, limit: self, then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }) });
        return chain;
      },
    } as unknown as SupabaseClient<Database>;
    const res = await findItems(scopeWith(makeDb(), { db: broken }), { query: 'passport' });
    expect(res).toMatchObject({ ok: false, code: 'db' });
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.startsWith('[service:inventory]') && line.endsWith('read failed'))).toBe(true);
  });
});

describe('recordMove', () => {
  it('updates the item and writes a family-scoped history row naming who moved it', async () => {
    const db = makeDb();
    const res = await recordMove(scopeWith(db), { itemId: 'passports', toLocationId: 'shelf', reason: 'packed for the trip' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.where).toBe('Garage › Shelf B');
    expect(res.data.from).toBe('Office › Top drawer');
    expect(db.table('inventory_items').find((i) => i.id === 'passports')?.location_id).toBe('shelf');
    const row = db.table('inventory_moves').find((m) => m.id === res.data.move.id)!;
    expect(row).toMatchObject({
      family_id: FAMILY, item_id: 'passports', from_location_id: 'drawer', to_location_id: 'shelf', moved_by: 'member-1', created_by: 'auth-1', reason: 'packed for the trip',
    });
    expect(row.moved_at).toBe(NOW.toISOString());
  });

  it('marks a lost item found when it turns up somewhere', async () => {
    const db = makeDb();
    const res = await recordMove(scopeWith(db), { itemId: 'lost-key', toLocationId: 'drawer' });
    expect(res.ok && res.data.item.status).toBe('in_place');
    expect(db.table('inventory_items').find((i) => i.id === 'lost-key')?.status).toBe('in_place');
  });

  it("refuses another family's item or location, writing nothing", async () => {
    const db = makeDb();
    const before = db.table('inventory_moves').length;
    expect(await recordMove(scopeWith(db), { itemId: 'theirs', toLocationId: 'drawer' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await recordMove(scopeWith(db), { itemId: 'passports', toLocationId: 'other-garage' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('inventory_moves')).toHaveLength(before);
    expect(db.table('inventory_items').find((i) => i.id === 'passports')?.location_id).toBe('drawer');
  });
});

describe('confirmItem', () => {
  it('writes a move with from = to and the confirmed reason, leaving the item where it is', async () => {
    const db = makeDb();
    const res = await confirmItem(scopeWith(db), { itemId: 'helmet' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.where).toBe('Garage › Shelf B');
    const row = db.table('inventory_moves').find((m) => m.id === res.data.move.id)!;
    expect(row).toMatchObject({ family_id: FAMILY, item_id: 'helmet', from_location_id: 'shelf', to_location_id: 'shelf', reason: 'confirmed', moved_by: 'member-1' });
    expect(db.table('inventory_items').find((i) => i.id === 'helmet')?.location_id).toBe('shelf');

    // The finder now reports this confirmation as the latest.
    const found = await findItems(scopeWith(db), { query: 'ski helmet' });
    expect(found.ok && found.data[0].lastConfirmed?.moveId).toBe(res.data.move.id);
  });

  it('records the household trail entry for the confirmation', async () => {
    const db = makeDb();
    await confirmItem(scopeWith(db), { itemId: 'helmet' });
    expect(db.table('audit_logs').some((row) => String((row.metadata as { title?: string })?.title ?? '').includes('Confirmed Ski helmet'))).toBe(true);
  });
});

describe('resolveLocationByName', () => {
  it('matches exactly, then uniquely, and asks when it cannot decide', async () => {
    const db = makeDb();
    expect((await resolveLocationByName(scopeWith(db), 'the garage')).ok).toBe(true);
    expect(await resolveLocationByName(scopeWith(db), 'Garage')).toMatchObject({ ok: true, data: { id: 'garage' } });
    expect(await resolveLocationByName(scopeWith(db), 'drawer')).toMatchObject({ ok: true, data: { id: 'drawer' } });
    expect(await resolveLocationByName(scopeWith(db), 'attic')).toEqual({ ok: true, data: null });
    db.seed('home_locations', [{ id: 'shelf-a', family_id: FAMILY, name: 'Shelf A', kind: 'shelf', parent_id: 'garage' }]);
    expect(await resolveLocationByName(scopeWith(db), 'shelf')).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});
