// "Where is the passport?" searches the WHOLE inventory, or says it could not.
//
// `inventory.find` read the catalogue with `.limit(2000)`, newest-touched first.
// PostgREST answers one request with at most `db-max-rows` — 1,000 on a default
// project — so a household past 1,000 items had its least recently touched
// ones (the passport, the spare key: the things that never move) cut off, and
// the assistant answered "Nothing in the inventory matches" as a fact. The same
// read resolves the item `inventory.recordMove` is told about by name.
//
// Driven through `executeTool` over an in-memory database that applies the
// real server's 1,000-row cap.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));

import { executeTool } from '@/lib/ai/tools/execute';

const FAMILY = '00000000-0000-4000-8000-0000000c2501';
const PARENT = { user: '00000000-0000-4000-8000-0000000c2502', member: '00000000-0000-4000-8000-0000000c2503' };
const NOW = '2026-10-05T18:00:00Z';

type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const scope = (): ServiceScope => ({
  db, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'ai', tz: 'America/Los_Angeles', now: new Date(NOW),
});

/** `count` everyday items, touched recently, plus the passport — filed years ago and never moved since. */
function catalogue(count: number): void {
  db.seed('inventory_items', [
    { id: 'passports', family_id: FAMILY, name: 'Passports', category: 'documents', location_id: 'drawer', updated_at: '2021-03-01T00:00:00Z' },
    ...Array.from({ length: count }, (_, i) => ({
      id: `item-${String(i).padStart(5, '0')}`, family_id: FAMILY, name: `Board game ${i}`, category: 'other', location_id: 'garage',
      updated_at: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 60_000).toISOString(),
    })),
  ]);
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    maxRows: 1000,
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      inventory_items: { quantity: 1, value_cents: null, brand: null, model: null, serial_number: null, tags: [], status: 'in_place', lent_to: null, lent_on: null, warranty_until: null, owner_member_id: null, notes: null },
      home_locations: { kind: 'room', parent_id: null, notes: null },
      inventory_moves: { from_location_id: null, to_location_id: null, moved_by: null, reason: null },
    },
  }) as DB;
  holder.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'America/Los_Angeles' }]);
  db.seed('family_members', [{ id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true }]);
  db.seed('home_locations', [
    { id: 'office', family_id: FAMILY, name: 'Office', kind: 'room', parent_id: null },
    { id: 'drawer', family_id: FAMILY, name: 'Top drawer', kind: 'drawer', parent_id: 'office' },
    { id: 'garage', family_id: FAMILY, name: 'Garage', kind: 'garage', parent_id: null },
  ]);
});

describe('inventory.find covers the whole catalogue', () => {
  it('finds the passport behind 1,200 more recently touched items', async () => {
    catalogue(1200);
    const out = await executeTool(scope(), 'inventory.find', { query: 'passport' });
    expect(out).toMatchObject({ status: 'ok', data: { found: true } });
    if (out.status !== 'ok') return;
    expect((out.data as { items: { id: string; where: string }[] }).items[0]).toMatchObject({ id: 'passports', where: 'Office › Top drawer' });
  });

  it('records a move against the passport named by name, not against nothing', async () => {
    catalogue(1200);
    const out = await executeTool(scope(), 'inventory.recordMove', { item: 'passport', confirm: true });
    expect(out).toMatchObject({ status: 'ok', data: { item_id: 'passports', confirmed: true } });
  });

  it('a catalogue past the ceiling is a failed search, never "nothing matches"', async () => {
    catalogue(10_000);
    const out = await executeTool(scope(), 'inventory.find', { query: 'passport' });
    expect(out).toMatchObject({
      status: 'error',
      error: 'The home inventory is larger than Bubaly can search in one go, so it cannot say for sure where that is.',
    });
  });
});
