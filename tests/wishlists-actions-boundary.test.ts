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
        limit: () => Promise.resolve(result),
        then: (onF: (v: TableResult) => unknown) => Promise.resolve(result).then(onF),
      };
      return chain;
    },
  };
}

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

  it('words both refusals through the catalogue', () => {
    expectTranslates(source, 'wishlistsActions.couldNotCheckWhatYou', 'Could not check what you already own. Refresh and try again.');
    expectTranslates(source, 'wishlistsActions.sayWhatYouReThinking', 'Say what you’re thinking of buying.');
  });
});

describe('the Before you buy panel', () => {
  const panel = fs.readFileSync('components/wishlists/before-you-buy.tsx', 'utf8');

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
