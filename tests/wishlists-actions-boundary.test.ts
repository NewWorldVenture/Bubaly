// The "Before you buy" server action's read boundary (M17).
//
// The failure this guards against is the quiet one: six reads assembled with
// Promise.all, one of them refused by RLS, and the advisor cheerfully reports
// "nothing matching in your inventory" off a query that never returned a row.
// That is a reassuring lie about the family's own possessions, so the action
// has to fail closed and say so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { expectSays, expectTranslates } from './helpers/translated';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  budgetVsActual: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/services/finances', () => ({ budgetVsActual: mocks.budgetVsActual }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => SOURCE_MESSAGES[key] ?? key };
});

type Row = Record<string, unknown>;
type TableResult = { data: Row[] | null; error: unknown };

/** Records every filter the action applied, so "family-scoped" is proven, not assumed. */
type Seen = { table: string; filters: [string, unknown][] };

function client(results: Record<string, TableResult>, seen: Seen[]) {
  return {
    from(table: string) {
      const entry: Seen = { table, filters: [] };
      seen.push(entry);
      const result = results[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (key: string, value: unknown) => { entry.filters.push([key, value]); return chain; },
        order: () => chain,
        limit: () => Promise.resolve(result),
        then: (onF: (v: TableResult) => unknown) => Promise.resolve(result).then(onF),
      };
      return chain;
    },
  };
}

/** A `family_facts` row as the memory service reads it — whole, not a projection. */
const factRow = (over: Record<string, unknown>): Row => ({
  member_id: null,
  category: 'preference',
  is_pinned: false,
  expires_at: null,
  source: 'user',
  confidence: 100,
  notes: null,
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const OK_ROWS: Record<string, TableResult> = {
  inventory_items: {
    data: [{
      id: 'i-1', name: 'Cordless drill', category: 'tools', location_id: null, quantity: 1, value_cents: null,
      brand: 'Bosch', model: 'GSR 18V', serial_number: null, tags: [], status: 'in_place',
      lent_to: null, lent_on: null, warranty_until: null,
    }],
    error: null,
  },
  home_locations: { data: [], error: null },
  home_assets: { data: [], error: null },
  wardrobe_items: { data: [], error: null },
  wishlist_items: { data: [], error: null },
  family_facts: { data: [], error: null },
};

const source = fs.readFileSync('app/(app)/dashboard/wishlists/actions.ts', 'utf8');

describe('adviseBeforeBuying', () => {
  beforeEach(() => {
    mocks.requireUserContext.mockResolvedValue({
      active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' }, family: { timezone: 'UTC' } },
      user: { id: 'user-1' },
    });
    mocks.budgetVsActual.mockResolvedValue({ ok: true, data: { budgets: [] } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('scopes every read to the caller’s family', async () => {
    const seen: Seen[] = [];
    mocks.createServer.mockResolvedValue(client(OK_ROWS, seen));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'Cordless drill' });
    expect(result.ok).toBe(true);

    expect(seen.map((s) => s.table).sort()).toEqual([
      'family_facts', 'home_assets', 'home_locations', 'inventory_items', 'wardrobe_items', 'wishlist_items',
    ]);
    for (const entry of seen) {
      expect(entry.filters, `${entry.table} must be family-scoped`).toContainEqual(['family_id', 'fam-1']);
    }
  });

  it('returns the deterministic duplicate the family’s own rows prove', async () => {
    mocks.createServer.mockResolvedValue(client(OK_ROWS, []));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'Cordless drill' });
    if (!result.ok) throw new Error('expected advice');
    expect(result.advice.duplicates.map((d) => d.name)).toEqual(['Cordless drill']);
    expect(result.advice.reason).toBe('owned_duplicate');
    expect(result.budgetRestricted).toBe(false);
  });

  it.each(['inventory_items', 'home_assets', 'wardrobe_items', 'wishlist_items', 'family_facts', 'home_locations'])(
    'fails visibly when the %s read fails, instead of reporting nothing owned',
    async (table) => {
      mocks.createServer.mockResolvedValue(client({ ...OK_ROWS, [table]: { data: null, error: { message: 'permission denied' } } }, []));
      const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

      const result = await adviseBeforeBuying({ text: 'Cordless drill' });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error).toContain('Could not check what you already own');
      expect(console.error).toHaveBeenCalledWith(`[purchase-advisor] ${table} read failed`, expect.anything());
    },
  );

  it('fails visibly when the budget read fails', async () => {
    mocks.createServer.mockResolvedValue(client(OK_ROWS, []));
    mocks.budgetVsActual.mockResolvedValue({ ok: false, error: 'Could not load your budgets.', code: 'db' });
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'Cordless drill' });
    expect(result.ok).toBe(false);
    expect(console.error).toHaveBeenCalledWith('[purchase-advisor] budgets read failed', expect.anything(), 'db');
  });

  it('keeps the advice but flags the missing money half when the role may not read finances', async () => {
    mocks.createServer.mockResolvedValue(client(OK_ROWS, []));
    mocks.budgetVsActual.mockResolvedValue({ ok: false, error: 'Family finances are private.', code: 'denied' });
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'Cordless drill', priceDollars: 90 });
    if (!result.ok) throw new Error('a refusal to read finances is not a read failure');
    expect(result.budgetRestricted).toBe(true);
    expect(result.advice.duplicates).toHaveLength(1);
  });

  it('checks the price against the budget the finance service reports', async () => {
    mocks.createServer.mockResolvedValue(client({ ...OK_ROWS, inventory_items: { data: [], error: null } }, []));
    mocks.budgetVsActual.mockResolvedValue({
      ok: true,
      data: { budgets: [{ category: 'Tools', limit: 200, spent: 185 }] },
    });
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'Sander', priceDollars: 10, budgetCategory: 'Tools' });
    if (!result.ok) throw new Error('expected advice');
    expect(result.advice.budget).toMatchObject({ category: 'Tools', limitCents: 20_000, spentCents: 18_500 });
    expect(result.advice.verdict).toBe('tight');
  });

  it('refuses an empty candidate rather than searching for nothing', async () => {
    mocks.createServer.mockResolvedValue(client(OK_ROWS, []));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');
    const result = await adviseBeforeBuying({ text: '   ' });
    expect(result.ok).toBe(false);
  });

  // The action used to read `family_facts` with a raw select, which walks
  // straight past the memory service's boundary: medical and account facts (and
  // sensitive wording anywhere) are for the adults who manage the family, and an
  // expired fact is not a current preference.
  const MEMORY_ROWS: Record<string, TableResult> = {
    ...OK_ROWS,
    inventory_items: { data: [], error: null },
    family_facts: {
      data: [
        factRow({ id: 'f-1', category: 'medical', label: 'Liam allergy', value: 'Peanuts' }),
        factRow({ id: 'f-2', category: 'preference', label: 'Butter', value: 'Prefers unsalted butter' }),
      ],
      error: null,
    },
  };

  it('never hands a child a medical fact, whatever the purchase matches', async () => {
    mocks.requireUserContext.mockResolvedValue({
      active: { familyId: 'fam-1', role: 'child', member: { id: 'mem-2' }, family: { timezone: 'UTC' } },
      user: { id: 'user-2' },
    });
    mocks.createServer.mockResolvedValue(client(MEMORY_ROWS, []));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'peanut butter maker' });
    if (!result.ok) throw new Error('expected advice');
    expect(result.advice.preferences.map((p) => p.id)).toEqual(['f-2']);
  });

  it('still shows the same fact to a parent, so it is a role boundary and not a blanket drop', async () => {
    mocks.createServer.mockResolvedValue(client(MEMORY_ROWS, []));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'peanut butter maker' });
    if (!result.ok) throw new Error('expected advice');
    expect(result.advice.preferences.map((p) => p.id).sort()).toEqual(['f-1', 'f-2']);
  });

  it('does not render a fact whose shelf life has run out as a current preference', async () => {
    mocks.createServer.mockResolvedValue(client({
      ...OK_ROWS,
      inventory_items: { data: [], error: null },
      family_facts: {
        data: [factRow({ id: 'f-3', label: 'Coat size', value: 'Winter coat 6Y', expires_at: '2020-01-01T00:00:00.000Z' })],
        error: null,
      },
    }, []));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'winter coat' });
    if (!result.ok) throw new Error('expected advice');
    expect(result.advice.preferences).toEqual([]);
  });

  it('does not report the wish it was opened from as already on a wish list', async () => {
    mocks.createServer.mockResolvedValue(client({
      ...OK_ROWS,
      inventory_items: { data: [], error: null },
      wishlist_items: {
        data: [{ id: 'w-1', member_id: 'mem-9', title: 'Lego botanicals set', price: null, is_purchased: true }],
        error: null,
      },
    }, []));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    const result = await adviseBeforeBuying({ text: 'Lego botanicals set', excludeWishId: 'w-1' });
    if (!result.ok) throw new Error('expected advice');
    expect(result.advice.alreadyOnList).toEqual([]);
    expect(result.advice.reason).toBe('clear');
    expect(result.advice.verdict).toBe('clear');
  });

  it('never tells the owner of a wish that their present has been bought', async () => {
    mocks.createServer.mockResolvedValue(client({
      ...OK_ROWS,
      inventory_items: { data: [], error: null },
      wishlist_items: {
        data: [{ id: 'w-2', member_id: 'mem-1', title: 'Lego botanicals set', price: null, is_purchased: true }],
        error: null,
      },
    }, []));
    const { adviseBeforeBuying } = await import('@/app/(app)/dashboard/wishlists/actions');

    // mem-1 is the caller: this is their own wish, and 00431_wishlists.sql keeps
    // `is_purchased` hidden from them so the gift stays a surprise.
    const result = await adviseBeforeBuying({ text: 'Lego botanicals set' });
    if (!result.ok) throw new Error('expected advice');
    expect(result.advice.alreadyOnList.map((w) => w.purchased)).toEqual([false]);
    expect(result.advice.reason).toBe('clear');
  });

  it('words both refusals through the catalogue', () => {
    expectTranslates(source, 'wishlistsActions.couldNotCheckWhatYou', 'Could not check what you already own. Refresh and try again.');
    expectTranslates(source, 'wishlistsActions.sayWhatYouReThinking', 'Say what you’re thinking of buying.');
  });
});

describe('the Before you buy panel', () => {
  const panel = fs.readFileSync('components/wishlists/before-you-buy.tsx', 'utf8');
  const module_ = fs.readFileSync('components/modules/wishlists-module.tsx', 'utf8');

  it('is offered on someone else’s list only, like every other gift signal', () => {
    // The advice carries whether a wish has already been bought. The owner of
    // the wish is the one person the product hides that from, so the trigger
    // lives inside the same `!isOwnList` gate as the badge and Mark bought.
    const gate = module_.indexOf('{!isOwnList && (');
    expect(gate).toBeGreaterThan(-1);
    expect(module_.indexOf('<BeforeYouBuy')).toBeGreaterThan(gate);
    expect(module_.match(/<BeforeYouBuy/g)).toHaveLength(1);
  });

  it('tells the advisor which wish it was opened from', () => {
    expect(module_).toContain('wishId={w.id}');
    expect(panel).toContain('excludeWishId: wishId ?? null');
  });

  it('renders the deterministic verdict itself, with the model only as an extra', () => {
    expect(panel).toContain('import { adviseBeforeBuying');
    expect(panel).toContain('VERDICT_KEYS[advice.verdict]');
    expect(panel).toContain('REASON_KEYS[advice.reason]');
    // The AI affordance lives inside the branch that already holds the verdict,
    // so an unconfigured provider costs the market ideas and nothing else.
    expect(panel.indexOf('VERDICT_KEYS[advice.verdict]')).toBeLessThan(panel.indexOf('kind="purchase_advisor"'));
    expect(panel).not.toContain('isAIConfigured');
    expect(panel).not.toContain('/api/ai/');
  });

  it('fails visibly instead of showing a calm empty panel', () => {
    expect(panel).toContain('<ErrorState message={result.error} onRetry=');
  });

  it('says plainly that nothing in it is paid for', () => {
    expectSays(
      panel,
      'beforeYouBuy.nothingHereIsSponsoredNo',
      'Checked against your family’s own records. Nothing here is sponsored and no retailer pays for a place in it.',
    );
  });
});

// The optional "market ideas" button re-runs the same advice inside an LLM
// prompt. That path has its own boundary to keep: it is the only place
// `family_facts` reaches a model, and an unchecked read there would assert a
// healthy "nothing owned" to the model off a query that never returned.
describe('the market-ideas insight route', () => {
  const route = fs.readFileSync('app/api/ai/insights/route.ts', 'utf8');
  const advisorCase = route.slice(route.indexOf("case 'purchase_advisor'"), route.indexOf("case 'home'"));

  it('fails closed on every read rather than describing an empty result as nothing owned', () => {
    for (const table of ['inventory_items', 'home_locations', 'home_assets', 'wardrobe_items', 'wishlist_items', 'family_facts']) {
      expect(advisorCase, table).toContain(`['${table}', `);
    }
    expect(advisorCase).toContain('required([');
    expect(route).toContain('function required(');
  });

  it('applies the memory service’s boundary to the facts it puts in the prompt', () => {
    expect(route).toContain("import { isExpiredFact, isSensitiveMemory } from '@/lib/services/memory'");
    expect(advisorCase).toContain('isExpiredFact(');
    expect(advisorCase).toContain('isSensitiveMemory(');
    expect(advisorCase).toContain('isManager(viewer.role)');
  });

  it('strips gift state from the caller’s own wishes before the model sees them', () => {
    expect(advisorCase).toContain('is_purchased: false');
  });
});
