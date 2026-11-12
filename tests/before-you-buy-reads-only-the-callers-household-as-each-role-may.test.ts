// Call-level role tests for adviseBeforeBuying (Register B group 6), driven
// through the REAL exported action, the real purchase, memory and finance
// services and the real advisor, against the in-memory PostgREST fake with two
// households seeded.
//
// The action writes nothing. Its boundary is what it READS, and the policy is
// taken from the sources:
//   • wish lists, inventory and wardrobes are not withheld from any role
//     (lib/auth/guest-scope.ts GUEST_WITHHELD_PREFIXES has no /dashboard/wishlists),
//     so every member gets the advice;
//   • budgets are money, private to the managers: lib/services/finances
//     assertFinanceReader (isManager or system) — a refusal is reported as
//     `budgetRestricted`, not as a failure (lib/services/purchases);
//   • medical memories are for the managers: lib/memory/facts.ts factsVisibleTo;
//   • every read is filtered to the caller's family (lib/services/purchases),
//     so another household's rows never reach the advice, whatever id is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type Ctx = { user: { id: string }; active: { familyId: string; role: string; member: { id: string }; family: { name: string; timezone: string } } };
const holder = vi.hoisted(() => ({ db: null as unknown, ctx: null as Ctx | null }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!holder.ctx) throw new Error('NEXT_REDIRECT;/login');
    return holder.ctx;
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { adviseBeforeBuying } from '@/app/(app)/dashboard/wishlists/actions';

const FAM_A = '0a000000-0000-4000-8000-00000000000a';
const FAM_B = '0b000000-0000-4000-8000-00000000000b';
const DRILL_A = '0a000000-0000-4000-8000-0000000000a1';
const DRILL_B = '0b000000-0000-4000-8000-0000000000b1';
const WISH_A = '0a000000-0000-4000-8000-0000000000a2';
const WISH_B = '0b000000-0000-4000-8000-0000000000b2';
const MEDICAL_A = '0a000000-0000-4000-8000-0000000000a3';
const PREF_A = '0a000000-0000-4000-8000-0000000000a4';
const PREF_B = '0b000000-0000-4000-8000-0000000000b4';
const OWNER_A = '0a000000-0000-4000-8000-0000000000aa';
const OWNER_B = '0b000000-0000-4000-8000-0000000000bb';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const ctxFor = (role: Role): Ctx => ({
  user: { id: `0a000000-0000-4000-9000-00000000000${ROLES.indexOf(role) + 1}` },
  active: { familyId: FAM_A, role, member: { id: `0a000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}` }, family: { name: 'Family A', timezone: 'UTC' } },
});

const TABLES = ['inventory_items', 'home_locations', 'home_assets', 'wardrobe_items', 'wishlist_items', 'family_facts', 'budgets', 'transactions'];

const fact = (id: string, family: string, category: string, label: string, value: string) => ({
  id, family_id: family, member_id: null, category, label, value, is_pinned: false, expires_at: null,
  source: 'user', confidence: 100, notes: null, updated_at: '2026-07-01T00:00:00.000Z',
});
const drill = (id: string, family: string) => ({
  id, family_id: family, name: 'Cordless drill', category: 'tools', location_id: null, quantity: 1, value_cents: null,
  brand: 'Bosch', model: 'GSR 18V', serial_number: null, tags: [], status: 'in_place', lent_to: null, lent_on: null, warranty_until: null,
});

let db: InMemorySupabase;
const snapshot = () => JSON.stringify(TABLES.map((t) => db.table(t)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('inventory_items', [drill(DRILL_A, FAM_A), drill(DRILL_B, FAM_B)]);
  db.seed('wishlist_items', [
    { id: WISH_A, family_id: FAM_A, member_id: OWNER_A, title: 'Cordless drill', price: null, is_purchased: false },
    { id: WISH_B, family_id: FAM_B, member_id: OWNER_B, title: 'Cordless drill', price: null, is_purchased: true },
  ]);
  db.seed('family_facts', [
    fact(MEDICAL_A, FAM_A, 'medical', 'Drill noise', 'Liam has a hearing condition; no loud drill near him'),
    fact(PREF_A, FAM_A, 'preference', 'Drill brand', 'We prefer Bosch drill batteries'),
    fact(PREF_B, FAM_B, 'preference', 'Drill brand', 'Family B prefers Makita drill batteries'),
  ]);
  db.seed('budgets', [
    { id: '0a000000-0000-4000-8000-0000000000a5', family_id: FAM_A, category: 'Tools', amount: 200, period: 'monthly', created_at: '2026-01-01T00:00:00Z' },
    { id: '0b000000-0000-4000-8000-0000000000b5', family_id: FAM_B, category: 'Tools', amount: 9000, period: 'monthly', created_at: '2025-01-01T00:00:00Z' },
  ]);
  db.seed('transactions', [
    { id: '0a000000-0000-4000-8000-0000000000a6', family_id: FAM_A, date: '2026-07-10', type: 'expense', category: 'Tools', amount: -185 },
    { id: '0b000000-0000-4000-8000-0000000000b6', family_id: FAM_B, date: '2026-07-10', type: 'expense', category: 'Tools', amount: -4000 },
  ]);
  holder.db = db;
  holder.ctx = null;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ASK = { text: 'Cordless drill', priceDollars: 10, budgetCategory: 'Tools' };

describe('adviseBeforeBuying: every member gets advice from their own household, nothing written', () => {
  it.each(['parent', 'adult'] as const)('ACTION-AA8B11ACA10C a %s sees A’s own drill, wish, both memories and A’s budget', async (role) => {
    holder.ctx = ctxFor(role);
    const before = snapshot();
    const result = await adviseBeforeBuying(ASK);
    if (!result.ok) throw new Error(`expected advice, got ${result.error}`);
    expect(result.advice.duplicates.map((d) => d.id)).toEqual([DRILL_A]);
    expect(result.advice.alreadyOnList.map((w) => w.id)).toEqual([WISH_A]);
    expect(result.advice.preferences.map((p) => p.id).sort()).toEqual([MEDICAL_A, PREF_A].sort());
    expect(result.budgetRestricted).toBe(false);
    expect(result.advice.budget).toMatchObject({ category: 'Tools', limitCents: 20_000, spentCents: 18_500, unbudgeted: false });
    expect(snapshot()).toBe(before);
  });

  it.each(['teen', 'child', 'guest'] as const)('ACTION-AA8B11ACA10C a %s gets the advice without the money half or the medical memory', async (role) => {
    holder.ctx = ctxFor(role);
    const before = snapshot();
    const result = await adviseBeforeBuying(ASK);
    if (!result.ok) throw new Error(`expected advice, got ${result.error}`);
    expect(result.advice.duplicates.map((d) => d.id)).toEqual([DRILL_A]);
    expect(result.advice.alreadyOnList.map((w) => w.id)).toEqual([WISH_A]);
    expect(result.advice.preferences.map((p) => p.id)).toEqual([PREF_A]);
    expect(result.budgetRestricted).toBe(true);
    expect(result.advice.budget).toMatchObject({ limitCents: 0, spentCents: 0, unbudgeted: true });
    expect(snapshot()).toBe(before);
  });

  // Medical memories for a caregiver are an owner decision (guest-scope.ts says
  // a babysitter needs medical information; facts.ts hides it from every
  // non-manager), so this case pins the money boundary and the family filter only.
  it('ACTION-AA8B11ACA10C a caregiver gets A’s own advice without the money half', async () => {
    holder.ctx = ctxFor('caregiver');
    const before = snapshot();
    const result = await adviseBeforeBuying(ASK);
    if (!result.ok) throw new Error(`expected advice, got ${result.error}`);
    expect(result.advice.duplicates.map((d) => d.id)).toEqual([DRILL_A]);
    expect(result.advice.alreadyOnList.map((w) => w.id)).toEqual([WISH_A]);
    expect(result.advice.preferences.map((p) => p.id)).not.toContain(PREF_B);
    expect(result.budgetRestricted).toBe(true);
    expect(result.advice.budget).toMatchObject({ limitCents: 0, spentCents: 0, unbudgeted: true });
    expect(snapshot()).toBe(before);
  });

  it('ACTION-AA8B11ACA10C a parent of A naming B’s wish id gets nothing of B’s, and A’s own wish still counts', async () => {
    holder.ctx = ctxFor('parent');
    const before = snapshot();
    const result = await adviseBeforeBuying({ ...ASK, excludeWishId: WISH_B });
    if (!result.ok) throw new Error(`expected advice, got ${result.error}`);
    expect(result.advice.alreadyOnList.map((w) => w.id)).toEqual([WISH_A]);
    expect(result.advice.duplicates.map((d) => d.id)).toEqual([DRILL_A]);
    expect(result.advice.preferences.map((p) => p.id)).not.toContain(PREF_B);
    expect(snapshot()).toBe(before);
  });

  it('ACTION-AA8B11ACA10C an empty candidate is refused before any read', async () => {
    holder.ctx = ctxFor('parent');
    const result = await adviseBeforeBuying({ text: '   ' });
    expect(result).toEqual({ ok: false, error: 'wishlistsActions.sayWhatYouReThinking' });
    expect(db.log).toEqual([]);
  });

  it('ACTION-AA8B11ACA10C a signed-out caller is redirected before any read', async () => {
    await expect(adviseBeforeBuying(ASK)).rejects.toThrow('NEXT_REDIRECT');
    expect(db.log).toEqual([]);
  });
});
