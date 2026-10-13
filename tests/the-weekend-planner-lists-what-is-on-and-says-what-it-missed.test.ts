import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { normalizeTicketmaster } from '@/lib/weekend/normalize';
import { byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The Weekend Planner, the REAL WeekendModule, reading an in-memory database
// capped at PostgREST's db-max-rows (1,000).
//
//   S14  weekend_events was read unbounded and unordered from a table that only
//        grows: past 1,000 rows the upcoming list and the shortlist were an
//        arbitrary 1,000 — upcoming events and planned ones went missing
//   S11  an all-day event (midnight to midnight where the family is) was hidden
//        an hour into its own day and labelled with a clock time
//   S13  a search whose sources failed was toasted as "No events found"

type Fetcher = (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const live = vi.hoisted(() => ({
  queries: new Map<string, { fetcher: Fetcher; data: unknown[]; error: string | null; loaded: boolean }>(),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return {
    useRealtimeQuery: ({ table, deps, fetcher }: { table: string; deps?: unknown[]; fetcher: Fetcher }) => {
      const key = `${table}|${JSON.stringify(deps ?? [])}`;
      let query = live.queries.get(key);
      if (!query) { query = { fetcher, data: [], error: null, loaded: false }; live.queries.set(key, query); }
      query.fetcher = fetcher;
      const entry = query;
      const reread = async () => {
        const { data, error } = await entry.fetcher(clientFor(h));
        entry.loaded = true;
        entry.error = error ? error.message : null;
        if (!error) entry.data = data ?? [];
        return !error;
      };
      return {
        data: entry.data, loading: !entry.loaded, error: entry.error, stale: false, updatedAt: 0,
        refresh: async () => { await reread(); },
        refreshAndConfirm: async () => ((await reread()) ? { ok: true as const } : { ok: false as const, reason: 'error' as const }),
        setData: (update: unknown[] | ((rows: unknown[]) => unknown[])) => {
          entry.data = typeof update === 'function' ? update(entry.data) : update;
        },
      };
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);

const { WeekendModule } = await import('@/components/modules/weekend-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetHookSlots(h.hooks);
  live.queries.clear();
  // PostgREST's db-max-rows on a default Supabase project.
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'America/Los_Angeles';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function show(): Promise<ReactNode> {
  const { clientFor } = await import('./helpers/module-harness');
  for (let pass = 0; pass < 6; pass++) {
    render(h.hooks, createElement(WeekendModule));
    const pending = [...live.queries.values()].filter((q) => !q.loaded);
    if (!pending.length) break;
    for (const query of pending) {
      const { data, error } = await query.fetcher(clientFor(h));
      query.loaded = true;
      query.error = error ? error.message : null;
      query.data = error ? [] : data ?? [];
    }
  }
  return render(h.hooks, createElement(WeekendModule));
}

function event(id: string, title: string, starts_at: string, extra: Record<string, unknown> = {}) {
  return {
    id, family_id: FAMILY, source: 'feed:Library', external_id: id, title, category: null, description: null,
    venue_name: null, address: null, city: null, region: null, postal_code: null, latitude: null, longitude: null,
    starts_at, ends_at: null, url: null, image_url: null, price_min_cents: null, price_max_cents: null, currency: 'USD',
    distance_miles: null, is_family_friendly: false, search_zip: '94110', search_radius: 25, discovered_at: starts_at, created_by: 'user-1', ...extra,
  };
}

describe('S14 — the planner reads what is coming up and what is planned, however many old events there are', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-13T19:00:00Z'));
    // 1,100 events from past searches, written first.
    db.seed('weekend_events', Array.from({ length: 1100 }, (_, i) =>
      event(`old-${String(i).padStart(4, '0')}`, `Past event ${i}`, new Date(Date.parse('2025-01-01T18:00:00Z') + i * 3_600_000).toISOString())));
    // Then this week's, and an event a plan points at.
    db.seed('weekend_events', [
      event('new-1', 'Pumpkin patch', '2026-10-17T17:00:00Z'),
      event('planned-1', 'Harvest festival', '2026-10-18T18:00:00Z'),
    ]);
    db.seed('weekend_plans', [{ id: 'plan-1', family_id: FAMILY, event_id: 'planned-1', status: 'going', created_by: 'user-1' }]);
  });

  it('lists the upcoming event and keeps the planned one on the shortlist', async () => {
    const tree = await show();

    expect(has(tree, 'Pumpkin patch')).toBe(true);
    expect(has(tree, 'Harvest festival')).toBe(true);
    expect(has(tree, t('weekend.noUpcomingEventsYet'))).toBe(false);
    expect(has(tree, 'Past event 0')).toBe(false);
  });
});

describe('S11 — an all-day event shows all day, on its own day', () => {
  it('on Saturday morning, Saturday\'s all-day fair is listed as "All day"', async () => {
    // Saturday 17 October 2026, 10 AM Pacific.
    vi.setSystemTime(new Date('2026-10-17T17:00:00Z'));
    // As discovery now stores it: midnight to midnight, Pacific.
    db.seed('weekend_events', [event('fair-1', 'Library book fair', '2026-10-17T07:00:00Z', { ends_at: '2026-10-18T07:00:00Z' })]);

    const tree = await show();

    expect(has(tree, 'Library book fair')).toBe(true);
    expect(has(tree, t('firstBriefDisplay.allDay'))).toBe(true);
    expect(has(tree, '12:00 AM')).toBe(false);
  });

  it('a timed event an hour and more past is still left off', async () => {
    vi.setSystemTime(new Date('2026-10-17T17:00:00Z'));
    db.seed('weekend_events', [event('brunch-1', 'Pancake brunch', '2026-10-17T15:00:00Z')]);

    const tree = await show();

    expect(has(tree, 'Pancake brunch')).toBe(false);
  });
});

// What discovery stores for a provider in another zone, rendered where the
// family is: the normalizer the route calls, then the planner the family sees.
describe('S11 — a provider in another zone: a date is that date, a time is that time', () => {
  /** A Ticketmaster event as discovery stores it for a family in California. */
  function discovered(id: string, raw: Record<string, unknown>) {
    const row = normalizeTicketmaster({ id, ...raw } as Parameters<typeof normalizeTicketmaster>[0], 'America/Los_Angeles');
    return event(id, row.title, row.starts_at!, { source: 'ticketmaster', ends_at: row.ends_at });
  }

  it('a Chicago fair dated Saturday is listed under Saturday, all day', async () => {
    // Friday 16 October 2026, 10 AM Pacific.
    vi.setSystemTime(new Date('2026-10-16T17:00:00Z'));
    db.seed('weekend_events', [discovered('tm-fair', { name: 'County fair', dates: { start: { localDate: '2026-10-17' }, timezone: 'America/Chicago' } })]);

    const tree = await show();

    expect(has(tree, 'County fair')).toBe(true);
    expect(has(tree, 'Saturday, Oct 17')).toBe(true);
    expect(has(tree, 'Friday, Oct 16')).toBe(false);
    expect(has(tree, t('firstBriefDisplay.allDay'))).toBe(true);
    expect(has(tree, '10:00 PM')).toBe(false);
  });

  it('control: a Chicago show at 6 PM is listed at 4 PM Saturday, not all day', async () => {
    vi.setSystemTime(new Date('2026-10-16T17:00:00Z'));
    db.seed('weekend_events', [discovered('tm-show', { name: 'Evening show', dates: { start: { localDate: '2026-10-17', localTime: '18:00:00', dateTime: '2026-10-17T23:00:00Z' }, timezone: 'America/Chicago' } })]);

    const tree = await show();

    expect(has(tree, 'Evening show')).toBe(true);
    expect(has(tree, 'Saturday, Oct 17')).toBe(true);
    expect(has(tree, '4:00 PM')).toBe(true);
    expect(has(tree, t('firstBriefDisplay.allDay'))).toBe(false);
  });
});

describe('S13 — a search whose sources failed says so', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-10-13T19:00:00Z')); });

  async function searchWith(reply: Record<string, unknown>, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } })));
    db.seed('weekend_searches', [{ id: 's-1', family_id: FAMILY, zip: '94110', radius_miles: 25, days: 6, result_count: 0, last_run_at: '2026-10-12T19:00:00Z', created_by: 'user-1' }]);
    const tree = await show();
    await click(byName(tree, new RegExp(t('weekend.findEvents'))));
  }

  it('warns that the list may be missing events when a source did not answer', async () => {
    await searchWith({ count: 0, zip: '94110', radius: 25, days: 6, sources: ['feed:Library'], errors: { ticketmaster: 'HTTP 503' } });

    expect(h.toasts.error).toContain(t('weekend.someSourcesUnreachable'));
  });

  it('says only "no events" when every source answered', async () => {
    await searchWith({ count: 0, zip: '94110', radius: 25, days: 6, sources: ['ticketmaster'], errors: {} });

    expect(h.toasts.success).toContain(t('weekend.noEventsNear', { zip: '94110', days: 6 }));
    expect(h.toasts.error).toEqual([]);
  });

  it('shows the route\'s own words when every source failed', async () => {
    await searchWith({ error: t('discover.eventSourcesUnreachable'), errors: { ticketmaster: 'HTTP 503' } }, 502);

    expect(h.toasts.error).toEqual([t('discover.eventSourcesUnreachable')]);
    expect(h.toasts.success).toEqual([]);
  });

  it('warns when a saved feed failed, though another source answered', async () => {
    await searchWith({ count: 1, zip: '94110', radius: 25, days: 6, sources: ['ticketmaster'], errors: { feedsFailed: 'Some of your saved local feeds could not be read.' } });

    expect(h.toasts.error).toContain(t('weekend.someSourcesUnreachable'));
  });

  it('says feeds left for the next search will be read then, not that they could not be reached', async () => {
    await searchWith({ count: 1, zip: '94110', radius: 25, days: 6, sources: ['ticketmaster'], errors: { feedsSkipped: 'Some of your saved local feeds were left for the next search.' } });

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toContain(t('weekend.someFeedsLeftForNextSearch'));
  });

  it('says both when one feed failed and others were left', async () => {
    await searchWith({ count: 1, zip: '94110', radius: 25, days: 6, sources: ['ticketmaster'], errors: { feedsFailed: 'x', feedsSkipped: 'y' } });

    expect(h.toasts.error).toEqual([t('weekend.someSourcesUnreachable')]);
    expect(h.toasts.success).toContain(t('weekend.someFeedsLeftForNextSearch'));
  });
});

describe('S13 — what a search found shows without a reload', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-10-13T19:00:00Z')); });

  it('lists the event the search just saved', async () => {
    // The route writes what it found, then answers; these tables are not published to realtime.
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.seed('weekend_events', [event('found-1', 'Pumpkin patch', '2026-10-17T17:00:00Z')]);
      return new Response(JSON.stringify({ count: 1, zip: '94110', radius: 25, days: 6, sources: ['feed:Library'], errors: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    db.seed('weekend_searches', [{ id: 's-1', family_id: FAMILY, zip: '94110', radius_miles: 25, days: 6, result_count: 0, last_run_at: '2026-10-12T19:00:00Z', created_by: 'user-1' }]);
    const before = await show();
    expect(has(before, 'Pumpkin patch')).toBe(false);

    await click(byName(before, new RegExp(t('weekend.findEvents'))));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.toasts.success).toContain(t('weekend.foundOneEventNear', { zip: '94110' }));
    expect(has(await show(), 'Pumpkin patch')).toBe(true);
  });
});
