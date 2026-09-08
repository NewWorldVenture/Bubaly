// `searchHousehold` against real tables, through the in-memory PostgREST fake.
//
// The three things worth proving here are the three a reviewer would ask about:
// it actually reaches every source (eleven, not the two the module search boxes
// covered), every hit carries the evidence a person can check, and the role
// boundary is enforced by NOT QUERYING the money sources rather than by
// filtering them out afterwards — which is the difference between a boundary
// and a coat of paint.
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { searchHousehold, MANAGER_ONLY_KINDS, MIN_QUERY_CHARS } from '@/lib/services/search';
import type { ServiceScope } from '@/lib/services/types';
import type { MemberRole } from '@/lib/constants/roles';

const FAMILY = 'family-1';
const OTHER_FAMILY = 'family-2';
const NOW = new Date('2026-07-04T12:00:00Z');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function scopeFor(role: MemberRole | 'system'): ServiceScope {
  return {
    db: db as unknown as SupabaseClient<Database>,
    familyId: FAMILY,
    userId: 'user-1',
    memberId: 'member-1',
    role,
    actorKind: role === 'system' ? 'system' : 'member',
    tz: 'America/Chicago',
    now: NOW,
  };
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();

  db.seed('documents', [
    { id: 'doc-1', family_id: FAMILY, title: 'Furnace warranty scan', category: 'home', is_secure: false, expires_at: null, updated_at: '2026-06-30T00:00:00Z' },
    // Secure Vault: a manager sees it, a child does not.
    { id: 'doc-2', family_id: FAMILY, title: 'Furnace purchase contract', category: 'legal', is_secure: true, expires_at: null, updated_at: '2026-06-29T00:00:00Z' },
    { id: 'doc-3', family_id: OTHER_FAMILY, title: 'Furnace warranty (neighbours)', category: 'home', is_secure: false, expires_at: null, updated_at: '2026-06-30T00:00:00Z' },
  ]);
  db.seed('inventory_items', [
    { id: 'item-1', family_id: FAMILY, name: 'Furnace filter', brand: 'Honeywell', model: null, serial_number: 'X72-9911', notes: null, purchased_on: '2026-06-01', updated_at: '2026-06-02T00:00:00Z' },
  ]);
  db.seed('trips', [
    { id: 'trip-1', family_id: FAMILY, name: 'Furnace install site visit', destination: 'Madison', notes: null, start_date: '2026-05-02', updated_at: '2026-05-02T00:00:00Z' },
  ]);
  db.seed('vacations', [
    { id: 'vac-1', family_id: FAMILY, title: 'Lisbon in October', destination: 'Lisbon', description: 'furnace off while away', notes: null, start_date: '2026-10-02', updated_at: '2026-06-20T00:00:00Z' },
  ]);
  db.seed('family_decisions', [
    { id: 'dec-1', family_id: FAMILY, question: 'Replace or repair the furnace?', detail: null, status: 'open', updated_at: '2026-06-25T00:00:00Z' },
  ]);
  db.seed('calendar_events', [
    { id: 'evt-1', family_id: FAMILY, title: 'Furnace service', description: null, location: 'Home', starts_at: '2026-07-08T15:00:00Z', updated_at: '2026-06-28T00:00:00Z' },
  ]);
  db.seed('notes', [
    { id: 'note-1', family_id: FAMILY, title: 'Basement', body: 'The furnace filter is behind the stairs', updated_at: '2026-06-10T00:00:00Z' },
  ]);
  db.seed('family_facts', [
    { id: 'fact-1', family_id: FAMILY, label: 'Furnace serviced by', value: 'Kellner Heating', notes: null, category: 'other', updated_at: '2026-05-20T00:00:00Z' },
  ]);
  db.seed('bills', [
    { id: 'bill-1', family_id: FAMILY, name: 'Furnace maintenance plan', category: 'home', due_date: '2026-07-20', status: 'unpaid', updated_at: '2026-06-15T00:00:00Z' },
  ]);
  db.seed('home_warranties', [
    { id: 'war-1', family_id: FAMILY, name: 'Furnace warranty', provider: 'Carrier', coverage: 'Parts and labour', warranty_type: 'appliance', policy_number: 'PN-55512', notes: null, expires_on: '2027-03-01', deleted_at: null, updated_at: '2026-06-18T00:00:00Z' },
    { id: 'war-2', family_id: FAMILY, name: 'Furnace warranty (replaced)', provider: 'Carrier', coverage: null, warranty_type: 'appliance', policy_number: null, notes: null, expires_on: '2020-01-01', deleted_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
  ]);
  db.seed('renewals', [
    { id: 'ren-1', family_id: FAMILY, title: 'Furnace service contract', category: 'home', notes: null, expires_at: '2026-09-01', status: 'active', updated_at: '2026-06-05T00:00:00Z' },
  ]);
});

describe('searchHousehold — coverage and evidence', () => {
  it('reaches all eleven sources for a parent and returns the warranty first', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'furnace warranty');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.searched).toEqual(expect.arrayContaining([
      'documents', 'inventory_items', 'trips', 'vacations', 'family_decisions',
      'calendar_events', 'notes', 'family_facts', 'bills', 'home_warranties', 'renewals',
    ]));
    expect(result.data.searched).toHaveLength(11);
    expect(result.data.partial).toEqual([]);

    // The record literally called "Furnace warranty" wins over the eight rows
    // that merely mention a furnace.
    expect(result.data.hits[0]).toMatchObject({ kind: 'warranty', id: 'war-1', table: 'home_warranties' });
  });

  it('gives every hit its evidence — source table, a date where the row has one, and an existing route', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'furnace');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const hit of result.data.hits) {
      expect(hit.table, hit.id).toBeTruthy();
      expect(hit.href, hit.id).toMatch(/^\/dashboard\//);
      expect(hit.score, hit.id).toBeGreaterThan(0);
    }
    const event = result.data.hits.find((h) => h.kind === 'event');
    expect(event).toMatchObject({ table: 'calendar_events', occurredAt: '2026-07-08T15:00:00Z', href: '/dashboard/calendar' });

    // Vacations are the one source with a per-record page; everything else
    // links to the list the record already lives on.
    const vacation = result.data.hits.find((h) => h.kind === 'vacation');
    expect(vacation?.href).toBe('/dashboard/vacations/vac-1');
  });

  it('matches columns the card never shows, and still returns the row', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'X72-9911');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits.map((h) => h.id)).toContain('item-1');
    // The serial number matched but is not published back out.
    expect(JSON.stringify(result.data.hits)).not.toContain('X72-9911');
  });

  it('never returns a policy number, even to a parent whose warranty matched', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'furnace warranty');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.data.hits)).not.toContain('PN-55512');
  });

  it('stays inside the family and skips soft-deleted warranties', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'furnace warranty');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.data.hits.map((h) => h.id);
    expect(ids).not.toContain('doc-3');
    expect(ids).not.toContain('war-2');
  });
});

describe('searchHousehold — who may search what', () => {
  it('does not query the money sources for a child, and says which kinds were withheld', async () => {
    const result = await searchHousehold(scopeFor('child'), 'furnace warranty');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.searched).not.toContain('bills');
    expect(result.data.searched).not.toContain('home_warranties');
    expect(result.data.searched).not.toContain('renewals');
    expect(result.data.hits.some((h) => MANAGER_ONLY_KINDS.includes(h.kind))).toBe(false);
    // Honest about the gap rather than implying the household owns no bills.
    expect(result.data.withheld).toEqual([...MANAGER_ONLY_KINDS]);
  });

  it('withholds a Secure Vault document from a child but not from a parent', async () => {
    const child = await searchHousehold(scopeFor('child'), 'furnace');
    const parent = await searchHousehold(scopeFor('parent'), 'furnace');
    expect(child.ok && parent.ok).toBe(true);
    if (!child.ok || !parent.ok) return;
    expect(child.data.hits.map((h) => h.id)).not.toContain('doc-2');
    expect(parent.data.hits.map((h) => h.id)).toContain('doc-2');
  });

  it('treats a cron with no human behind it the same way it treats a child', async () => {
    const result = await searchHousehold(scopeFor('system'), 'furnace warranty');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.withheld).toEqual([...MANAGER_ONLY_KINDS]);
    expect(result.data.hits.map((h) => h.id)).not.toContain('doc-2');
  });
});

describe('searchHousehold — the query itself', () => {
  it('refuses a query too short to mean anything', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'f');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_input');
    expect(result.error).toContain(String(MIN_QUERY_CHARS));
  });

  it('refuses a bare wildcard rather than matching the whole house', async () => {
    // `%` and `_` are LIKE wildcards; neutralising them leaves nothing to search.
    const result = await searchHousehold(scopeFor('parent'), '%%');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_input');
  });

  it('survives punctuation that would otherwise be parsed as extra or() clauses', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'furnace, warranty (carrier)');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.query).toBe('furnace warranty carrier');
  });

  it('caps the number of hits it returns', async () => {
    const result = await searchHousehold(scopeFor('parent'), 'furnace', 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits).toHaveLength(3);
  });
});
