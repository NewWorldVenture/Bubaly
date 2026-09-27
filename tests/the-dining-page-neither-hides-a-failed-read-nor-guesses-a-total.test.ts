// /dashboard/dining made two separate false statements to a family.
//
// ONE — a refused read was reported as an empty life. The page wrapped both of
// its reads in
//
//     const safe = async (q) => { try { return (await q).data ?? []; } catch { return []; } };
//
// and a Supabase query RESOLVES with { data: null, error } for everything the
// database answers, including every error it reports. So an RLS denial, a
// statement timeout, a dropped column or a reset connection all arrived as `[]`,
// byte-identical to a family that has genuinely saved nothing — "No saved
// restaurants yet", "No dining-out history yet", and "Spend · 30d $0.00", a
// confident money figure rather than a mere absence. Nothing was logged, so a
// partial outage on this one table was invisible to whoever had to fix it. The
// page's two primary buttons are "Add place" and "Log visit" and 0104 puts no
// unique constraint on the table, so a family believing the lie re-enters rows
// that already exist and double-counts their own spend permanently.
//
// TWO — the stat tiles were derived from the capped lists. The page fetches 50
// restaurants and 30 visits for the two lists, which is fine; it then computed
// "Visits · 30d", "Spend · 30d" and "Avg rating" from those same arrays, which is
// not. A family that eats out more than once a day sees a month's spend summed
// from at most thirty receipts, printed to the cent, with nothing on the page
// saying it is partial. "Avg rating" is worse than arbitrary: the fill order is
// `rating` desc, so the tile drops the worst places and always flatters.
//
// These assert what a parent reads off the screen and what an operator finds in
// the log — not the shape of the code that produces it.
import type { ReactNode } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import { formatCents } from '@/lib/wallet/ledger';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', async () => {
  // The page is invoked directly, outside a request scope, so cookies() is
  // unavailable. Resolve through the real catalogue so the assertions keep
  // checking the words a person sees.
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/dashboard/dining' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import DiningPage from '@/app/(app)/dashboard/dining/page';
import { withLocale } from './helpers/render-translated';

// The reader's locale, stated rather than defaulted: every money figure below is
// what the real formatter prints for THIS locale, not a hand-typed literal.
const LOCALE: LocaleCode = 'en-US';
const money = (cents: number) => formatCents(cents, 'USD', LOCALE);

const render = async () => renderRaw(withLocale((await DiningPage()) as ReactNode, LOCALE));

type Filter = { method: string; key: string; value: unknown };
type Recorded = { select: string; options?: { count?: string; head?: boolean }; filters: Filter[]; limit: number | null };
type Reply = { data: unknown[] | null; count?: number | null; error: unknown };

let recorded: Recorded[];
let replies: Record<string, Reply>;

// Which of the page's reads this is, named by what it asks for rather than by
// its position, so the classification survives a reordering.
function classify(q: Recorded): string {
  const eq = (key: string) => q.filters.find((f) => f.method === 'eq' && f.key === key)?.value;
  if (q.options?.head) return 'favoriteCount';
  if (q.filters.some((f) => f.method === 'gte' && f.key === 'visited_at')) return 'window';
  if (q.select.trim() === 'rating') return 'ratings';
  return eq('kind') === 'visit' ? 'visits' : 'restaurants';
}

// A chainable PostgREST stub. It applies `.limit()` by slicing, the way the
// database does — that is what makes a tile derived from a capped list come out
// wrong here exactly as it does in production.
function from(_table: string) {
  const record: Recorded = { select: '', filters: [], limit: null };
  recorded.push(record);
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: (selection: string, options?: Recorded['options']) => { record.select = selection; record.options = options; return query; },
    order: () => query,
    limit: (n: number) => { record.limit = n; return query; },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      const reply = replies[classify(record)] ?? { data: [], count: 0, error: null };
      if (reply.error instanceof Error) return Promise.reject(reply.error).then(resolve, reject);
      const rows = reply.data;
      const capped = rows && record.limit != null && !record.options?.head ? rows.slice(0, record.limit) : rows;
      return Promise.resolve({ data: capped, count: reply.count ?? null, error: reply.error ?? null }).then(resolve, reject);
    },
  });
  for (const method of ['eq', 'neq', 'in', 'is', 'not', 'lt', 'lte', 'gt', 'gte']) {
    query[method] = (key: string, value: unknown) => { record.filters.push({ method, key, value }); return query; };
  }
  return query;
}

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1', role: 'parent', display_name: 'Sam' }, family: { id: 'fam-1', name: 'Rivera', timezone: 'UTC' } },
};

const NOW = new Date('2026-09-26T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

// 60 saved places: 55 favorites at 4.0, then 5 non-favorites at 1.0, in the order
// the page's `is_favorite desc, rating desc` query returns them. The 50-row list
// therefore holds only favorites rated 4.0.
//   true favorites      55   |   from the list   50
//   true average        3.8  |   from the list   4
const RESTAURANTS = Array.from({ length: 60 }, (_, i) => ({
  id: `r-${i}`, name: `Place ${i}`, kind: 'restaurant', cuisine: 'Italian', category: null,
  price_level: 2, rating: i < 55 ? 4 : 1, distance_km: 1, is_favorite: i < 55,
  amount_cents: null, item_count: null, visited_at: null,
}));

// 45 visits at $28, every one of them inside the trailing 30 days, newest
// first. The 30-row list holds 30 of them.
//   true visits · 30d   45             |   from the list   30
//   true spend · 30d    45 × 2800 ¢    |   from the list   30 × 2800 ¢
const VISITS = Array.from({ length: 45 }, (_, i) => ({
  id: `v-${i}`, name: `Dinner ${i}`, kind: 'visit', cuisine: null, category: null,
  price_level: null, rating: null, distance_km: null, is_favorite: false,
  amount_cents: 2800, item_count: 3, visited_at: daysAgo(i % 29),
}));

function healthyReplies(): Record<string, Reply> {
  return {
    restaurants: { data: RESTAURANTS, count: RESTAURANTS.length, error: null },
    visits: { data: VISITS, count: VISITS.length, error: null },
    favoriteCount: { data: null, count: RESTAURANTS.filter((r) => r.is_favorite).length, error: null },
    window: { data: VISITS.map((v) => ({ amount_cents: v.amount_cents })), count: VISITS.length, error: null },
    ratings: { data: RESTAURANTS.map((r) => ({ rating: r.rating })), count: RESTAURANTS.length, error: null },
  };
}

/** Just the four stat tiles, so a number asserted here cannot be matched by a
 *  rating printed further down one of the lists. */
function tiles(html: string): string {
  const start = html.indexOf('grid-stats');
  const end = html.indexOf('Saved places');
  expect(start, 'the stat row should be on the page').toBeGreaterThan(-1);
  return html.slice(start, end > start ? end : undefined);
}

/** The figure printed on ONE stat tile, found by that tile's label. A "—"
 *  asserted here is this tile's "—", not one another tile happens to print. */
function tile(html: string, label: string): string {
  const card = tiles(html).split('class="stat-card"').slice(1).find((c) => c.includes(`>${label}<`));
  if (!card) throw new Error(`the "${label}" tile should be on the page`);
  // A tile's text nodes are its icon, its figure and its label, in that order.
  const texts = [...card.matchAll(/>([^<]+)</g)].map((m) => m[1]);
  const at = texts.indexOf(label);
  if (at < 1) throw new Error(`the "${label}" tile should print a figure before its label; got ${JSON.stringify(texts)}`);
  return texts[at - 1];
}

// The words a parent reads when a dining read fails: the English sentence from
// the real en-US catalogue, never a pattern loose enough to match the key — an
// error card that reads "dining.couldNotLoadYourDiningOut" is exactly what this
// file must catch. These cases are RED until the central catalogue merge adds
// the key to lib/i18n/messages/*.json (requested alongside this change, and
// merged before it is committed).
const COULD_NOT_LOAD_KEY = 'dining.couldNotLoadYourDiningOut';
const COULD_NOT_LOAD = 'Could not load your dining out from Supabase. Refresh and try again.';

/** The page failed closed: an error card, and nothing a family could act on. */
function expectItFailedClosed(html: string) {
  expect(html, 'an error card').toContain('text-danger');
  expect(html, 'a failed read is not an empty history').not.toContain('No dining-out history yet');
  expect(html, 'nor an empty list of places').not.toContain('No saved restaurants yet');
  expect(html, 'no stat row, so no figure — in particular no spend of zero').not.toContain('grid-stats');
  expect(html).not.toContain(money(0));
  // The page is read-only, so the damage is what the family does next: the two
  // buttons that re-enter data they already have must not be offered.
  expect(html).not.toContain('Log visit');
  expect(html).not.toContain('Add place');
  // Last, so that before the catalogue merge this is the ONE thing that fails.
  expect(SOURCE_MESSAGES[COULD_NOT_LOAD_KEY], `${COULD_NOT_LOAD_KEY} should be in the en-US catalogue`).toBe(COULD_NOT_LOAD);
  expect(html).toContain(COULD_NOT_LOAD);
  expect(html, 'a catalogue key is not a message').not.toContain(COULD_NOT_LOAD_KEY);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  recorded = [];
  replies = healthyReplies();
  mocks.requireUserContext.mockResolvedValue(ctx);
  mocks.createServer.mockResolvedValue({ from });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live fetch is forbidden'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a dining read that failed is not a family with nowhere to eat', () => {
  it('a refused read shows an error, not "no saved restaurants yet" and not a spend of zero', async () => {
    replies.visits = { data: null, error: { code: '42501', message: 'permission denied for table dining_out' } };
    expectItFailedClosed(await render());
  });

  it('the operator can find the outage in the log, code and all', async () => {
    replies.window = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    await render();
    // The code, not only the message: '42501' against '57014' is the difference
    // between a policy to fix and a query to speed up.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[dashboard/dining]'),
      expect.objectContaining({ code: '57014', message: expect.stringContaining('statement timeout') }),
    );
  });

  it.each([
    ['42703', 'column dining_out.category does not exist'],
    ['PGRST204', "Could not find the 'category' column of 'dining_out' in the schema cache"],
  ])('a dropped or renamed column (%s) fails closed — the rows are there, so an empty page would be false', async (code, message) => {
    replies.restaurants = { data: null, error: { code, message } };
    replies.visits = { data: null, error: { code, message } };
    const html = await render();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[dashboard/dining]'),
      expect.objectContaining({ code, message }),
    );
    expectItFailedClosed(html);
  });

  it('a connection that never completed fails closed too, not silently', async () => {
    // A transport failure REJECTS rather than resolving with { error }, which is
    // the half the old try/catch turned into an empty page.
    replies.restaurants = { data: null, error: new Error('ECONNRESET') };
    const html = await render();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[dashboard/dining]'),
      expect.objectContaining({ message: expect.stringContaining('ECONNRESET') }),
    );
    expectItFailedClosed(html);
  });

  it.each([
    ['PGRST205', "Could not find the table 'public.dining_out' in the schema cache"],
    ['42P01', 'relation "public.dining_out" does not exist'],
  ])('a database the dining_out migration has not reached (%s) still renders — logged, and with no invented zero', async (code, message) => {
    const missing = { code, message };
    replies = { restaurants: { data: null, error: missing }, visits: { data: null, error: missing },
      // What supabase-js really hands back for the HEAD count on an absent table:
      // PostgREST answers 404 with no body, which postgrest-js turns into
      // { error: null, count: null } — no error, and no count either.
      favoriteCount: { data: null, count: null, error: null },
      window: { data: null, error: missing }, ratings: { data: null, error: missing } };
    const html = await render();

    // The sanctioned degrade: with no table, no family can have a dining row, so
    // the empty state is true.
    expect(html).toContain('No saved restaurants yet');
    expect(html).not.toContain(COULD_NOT_LOAD);
    expect(html).not.toContain(COULD_NOT_LOAD_KEY);
    // But a read that did not happen is not evidence of a zero — tile by tile,
    // so no tile's "—" can stand in for another's.
    expect(tile(html, 'Favorites'), 'a count the database never returned').toBe('—');
    expect(tile(html, 'Visits · 30d')).toBe('—');
    expect(tile(html, 'Spend · 30d'), 'an unread month is unknown, not a spend of zero').toBe('—');
    expect(tile(html, 'Avg rating')).toBe('—');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[dashboard/dining]'),
      expect.objectContaining({ code, message }),
    );
  });

  it('a genuinely empty family still gets clean empty states, true zeros and a clean log', async () => {
    replies = { restaurants: { data: [], count: 0, error: null }, visits: { data: [], count: 0, error: null },
      favoriteCount: { data: null, count: 0, error: null }, window: { data: [], count: 0, error: null }, ratings: { data: [], count: 0, error: null } };
    const html = await render();
    expect(html).toContain('No saved restaurants yet');
    expect(html).toContain('No dining-out history yet');
    // Here the reads completed and found nothing, so zero IS the fact.
    expect(tile(html, 'Favorites')).toBe('0');
    expect(tile(html, 'Visits · 30d')).toBe('0');
    expect(tile(html, 'Spend · 30d')).toBe(money(0));
    expect(tile(html, 'Avg rating'), 'no rated place has no average').toBe('—');
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('a dining stat tile states the family\'s figure, not the page\'s fetch', () => {
  it('spends and counts the whole trailing month, not the thirty visits it listed', async () => {
    const html = await render();
    // Equality, so the list's figures (30 visits, 30 × 2800 ¢) cannot pass.
    expect(tile(html, 'Visits · 30d'), '45 visits fell inside the window, not the 30 the list fetched').toBe('45');
    expect(tile(html, 'Spend · 30d'), '45 × $28, not the sum of the 30 most recent').toBe(money(45 * 2800));
    // The lists themselves are still capped, and still render.
    expect(html).toContain('Dinner 0');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('averages every rated place, so the tile cannot flatter by dropping the worst', async () => {
    expect(tile(await render(), 'Avg rating'), '(55×4 + 5×1) / 60, not the 4 of the 50 best-rated').toBe('3.8');
  });

  it('counts every favorite, including the ones past the list cap', async () => {
    expect(tile(await render(), 'Favorites'), 'not the 50 the list could hold').toBe('55');
  });

  it('asks the database for the figures, scoped to this family', async () => {
    await render();
    for (const q of recorded) {
      expect(q.filters, q.select).toContainEqual({ method: 'eq', key: 'family_id', value: 'fam-1' });
    }
    const kinds = recorded.map(classify);
    expect(kinds, 'the tiles are counted, not tallied from the lists').toEqual(
      expect.arrayContaining(['favoriteCount', 'window', 'ratings']),
    );
    for (const kind of ['favoriteCount', 'window', 'ratings']) {
      expect(recorded.find((q) => classify(q) === kind)!.options, kind).toMatchObject({ count: 'exact' });
    }
    // The 30-day window is asked of the database, not filtered in the browser.
    const window = recorded.find((q) => classify(q) === 'window')!;
    expect(window.filters).toContainEqual({ method: 'gte', key: 'visited_at', value: new Date(NOW.getTime() - 30 * 86400_000).toISOString() });
  });

  it('reports a total it could not finish as unknown rather than as a partial sum', async () => {
    // More rows in the window than the sum's own bound: the page knows the exact
    // count and knows it did not read them all, so it must not print a figure.
    replies.window = { data: VISITS.map((v) => ({ amount_cents: v.amount_cents })), count: 9_000, error: null };
    const html = await render();
    expect(tile(html, 'Visits · 30d'), 'the count is still exact').toBe('9000');
    expect(tile(html, 'Spend · 30d'), 'but the sum is not a fact about the month').toBe('—');
  });

  it('with no count from the database, a read that hit its bound is "at least", not a figure', async () => {
    // 2000 rows and no count: the page read as many as it asks for, so the month
    // may hold more. Neither the visit count nor the spend is known.
    replies.window = { data: Array.from({ length: 2000 }, () => ({ amount_cents: 2800 })), count: null, error: null };
    const html = await render();
    expect(tile(html, 'Visits · 30d'), 'not the 2000 rows it happened to read').toBe('—');
    expect(tile(html, 'Spend · 30d')).toBe('—');
  });

  it('with no count from the database, a read below its bound is still the whole month', async () => {
    replies.window = { data: VISITS.map((v) => ({ amount_cents: v.amount_cents })), count: null, error: null };
    const html = await render();
    expect(tile(html, 'Visits · 30d')).toBe('45');
    expect(tile(html, 'Spend · 30d')).toBe(money(45 * 2800));
  });
});
