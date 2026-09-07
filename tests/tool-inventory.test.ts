// Contract tests for the inventory tools: registered under the trust domain
// the policies are written against, honest about reads and writes, strict
// about their inputs, and — through the service — answering "where's the
// passport" with the location path rather than a guess.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTool, listTools } from '@/lib/ai/tools/registry';
import { toolInputSchema } from '@/lib/ai/tools/legacy-adapter';
import { toolsForIntent } from '@/lib/ai/planner/prompts';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-05T12:00:00Z');
const FAMILY = 'fam-1';

function makeDb(): InMemorySupabase {
  const db = createInMemorySupabase({
    defaults: {
      inventory_items: { category: 'other', quantity: 1, value_cents: null, brand: null, model: null, serial_number: null, tags: [], status: 'in_place', lent_to: null, lent_on: null, warranty_until: null, location_id: null, owner_member_id: null, notes: null },
      home_locations: { kind: 'room', parent_id: null, notes: null },
      inventory_moves: { from_location_id: null, to_location_id: null, moved_by: null, reason: null },
    },
  });
  db.seed('home_locations', [
    { id: 'office', family_id: FAMILY, name: 'Office', kind: 'room', parent_id: null },
    { id: 'drawer', family_id: FAMILY, name: 'Top drawer', kind: 'drawer', parent_id: 'office' },
    { id: 'garage', family_id: FAMILY, name: 'Garage', kind: 'garage', parent_id: null },
  ]);
  db.seed('inventory_items', [
    { id: 'passports', family_id: FAMILY, name: 'Passports', category: 'documents', location_id: 'drawer' },
    { id: 'helmet', family_id: FAMILY, name: 'Ski helmet', category: 'sports', location_id: 'garage' },
    { id: 'helmet-2', family_id: FAMILY, name: 'Bike helmet', category: 'sports', location_id: 'garage' },
  ]);
  db.seed('inventory_moves', [
    { id: 'mv-1', family_id: FAMILY, item_id: 'passports', from_location_id: 'drawer', to_location_id: 'drawer', moved_at: '2026-09-01T10:00:00Z', reason: 'confirmed' },
  ]);
  return db;
}

function scopeWith(db: InMemorySupabase, extra?: Partial<ServiceScope>): ServiceScope {
  return { db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW, ...extra };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('registration', () => {
  it('registers both tools under home_maintenance with honest read/write metadata', () => {
    const find = getTool('inventory.find')!;
    const move = getTool('inventory.recordMove')!;
    expect(find).toMatchObject({ domain: 'home_maintenance', capability: 'view', risk: 'low', readOnly: true });
    expect(move).toMatchObject({ domain: 'home_maintenance', capability: 'create', risk: 'low', readOnly: false });
    expect(typeof move.idempotencyFrom).toBe('function');
    expect(move.resource?.({ move_id: 'm-1' })).toEqual({ table: 'inventory_moves', id: 'm-1' });
  });

  it('keeps the flat spellings a person or an old approval might use', () => {
    for (const alias of ['where_is', 'find_item', 'inventory_find']) expect(getTool(alias)?.name, alias).toBe('inventory.find');
    for (const alias of ['move_item', 'confirm_item_location', 'inventory_recordMove']) expect(getTool(alias)?.name, alias).toBe('inventory.recordMove');
  });

  it('expresses both inputs as strict JSON Schema and refuses a find with no query', () => {
    for (const name of ['inventory.find', 'inventory.recordMove']) {
      const schema = toolInputSchema(getTool(name)!);
      expect(schema, name).not.toBeNull();
      expect(schema?.additionalProperties).toBe(false);
    }
    expect(getTool('inventory.find')!.input.safeParse({}).success).toBe(false);
    expect(getTool('inventory.find')!.input.safeParse({ query: 'passport' }).success).toBe(true);
    expect(getTool('inventory.recordMove')!.input.safeParse({ item: 'passports', confirm: 'yes' }).success).toBe(false);
  });

  it('is offered wherever a question is answered, so "where is" can reach it', () => {
    const names = toolsForIntent('answer_question', listTools()).map((t) => t.name);
    expect(names).toContain('inventory.find');
  });
});

describe('inventory.find', () => {
  it('returns the location path, the confirmation day and a summary a person can read', async () => {
    const db = makeDb();
    const tool = getTool('inventory.find')!;
    const res = await tool.execute(scopeWith(db), { query: "Where's the passport?" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.data as { found: boolean; items: { id: string; where: string; path: string[]; last_confirmed_at: string | null; last_confirmed: string | null }[] };
    expect(out.found).toBe(true);
    expect(out.items[0]).toMatchObject({ id: 'passports', where: 'Office › Top drawer', path: ['Office', 'Top drawer'], last_confirmed_at: '2026-09-01T10:00:00Z' });
    expect(out.items[0].last_confirmed).toBeTruthy();
    expect(tool.output.safeParse(out).success).toBe(true);
    expect(tool.summarize({ query: "Where's the passport?" }, out)).toMatch(/^Passports: Office › Top drawer — confirmed /);
  });

  it('says plainly when nothing matches, and fails closed when the catalogue cannot be read', async () => {
    const db = makeDb();
    const tool = getTool('inventory.find')!;
    const none = await tool.execute(scopeWith(db), { query: 'unicorn' });
    expect(none.ok && (none.data as { found: boolean }).found).toBe(false);
    expect(tool.summarize({ query: 'unicorn' }, none.ok ? none.data : {})).toBe('Nothing in the inventory matches "unicorn"');

    const broken = { from: () => { const c: Record<string, unknown> = {}; const self = () => c; Object.assign(c, { select: self, eq: self, neq: self, in: self, order: self, limit: self, then: (r: (v: unknown) => void) => r({ data: null, error: { code: 'XX000', message: 'boom' } }) }); return c; } } as unknown as SupabaseClient<Database>;
    expect(await tool.execute(scopeWith(db, { db: broken }), { query: 'passport' })).toMatchObject({ ok: false, code: 'db' });
  });
});

describe('inventory.recordMove', () => {
  it('moves an item named in words to a location named in words, writing the family-scoped row', async () => {
    const db = makeDb();
    const tool = getTool('inventory.recordMove')!;
    const res = await tool.execute(scopeWith(db), { item: 'passports', to_location: 'the garage', reason: 'packed' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.data as { move_id: string; confirmed: boolean; where: string; from: string; name: string };
    expect(out).toMatchObject({ confirmed: false, where: 'Garage', from: 'Office › Top drawer', name: 'Passports' });
    expect(db.table('inventory_moves').find((m) => m.id === out.move_id)).toMatchObject({ family_id: FAMILY, item_id: 'passports', from_location_id: 'drawer', to_location_id: 'garage', reason: 'packed', moved_by: 'member-1' });
    expect(tool.summarize({}, out)).toBe('Moved Passports to Garage');
    expect(tool.output.safeParse(out).success).toBe(true);
  });

  it('records "it is still here" as a move with from = to and the confirmed reason', async () => {
    const db = makeDb();
    const tool = getTool('inventory.recordMove')!;
    const res = await tool.execute(scopeWith(db), { item_id: 'passports', confirm: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.data as { move_id: string; confirmed: boolean; where: string };
    expect(out.confirmed).toBe(true);
    expect(db.table('inventory_moves').find((m) => m.id === out.move_id)).toMatchObject({ family_id: FAMILY, from_location_id: 'drawer', to_location_id: 'drawer', reason: 'confirmed' });
    expect(tool.summarize({ confirm: true }, out)).toBe('Confirmed Passports is still in Office › Top drawer');
    expect(tool.idempotencyFrom?.({ item_id: 'passports', confirm: true }, scopeWith(db))).toBe('inventory.recordMove:passports:confirm');
  });

  it('asks rather than guesses when the item or the place is ambiguous or missing', async () => {
    const db = makeDb();
    const tool = getTool('inventory.recordMove')!;
    expect(await tool.execute(scopeWith(db), {})).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await tool.execute(scopeWith(db), { item: 'helmet', to_location: 'office' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await tool.execute(scopeWith(db), { item: 'passports' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await tool.execute(scopeWith(db), { item: 'passports', to_location: 'attic' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await tool.execute(scopeWith(db), { item: 'unicorn', to_location: 'garage' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('inventory_moves')).toHaveLength(1);
  });

  it('verifies the row it wrote is really there', async () => {
    const db = makeDb();
    const tool = getTool('inventory.recordMove')!;
    const res = await tool.execute(scopeWith(db), { item_id: 'helmet', to_location_id: 'drawer' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const verdict = await tool.verify!(scopeWith(db), {}, res.data);
    expect(verdict).toMatchObject({ ok: true, data: { verified: true } });
    const gone = await tool.verify!(scopeWith(db), {}, { ...(res.data as object), move_id: 'nope' });
    expect(gone).toMatchObject({ ok: true, data: { verified: false } });
  });
});
