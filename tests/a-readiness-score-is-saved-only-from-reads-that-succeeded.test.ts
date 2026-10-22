import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { nodes, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// S17 — the trip overview saved a readiness score computed from reads that
// FAILED. Each of its sixteen reads leaves its section empty when it fails, an
// empty section scores 0, and the effect that persists the score checked only
// `loading` and the trip: so a transient failure of, say, the packing read
// inserted a lower score into vacation_travel_scores while the page itself
// showed "could not load" — and the trips list and the reports then showed it
// as the trip's readiness.
//
// The REAL TripOverview, its own reads against an in-memory database, one read
// failing as a transient error does.

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
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => ({ ...(await import('./helpers/module-harness')).ui, LoadingBlock: () => null }));
vi.mock('@/components/ui/button-link', async () => ({ ButtonLink: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const { TripOverview } = await import('@/components/vacations/trip-overview');

const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  resetHookSlots(h.hooks);
  live.queries.clear();
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Lake week', kind: 'domestic', status: 'planning', is_international: false, start_date: '2026-10-20', end_date: '2026-10-24', timezone: 'UTC' }]);
  db.seed('vacation_members', [{ id: 'vm-1', family_id: FAMILY, vacation_id: 'trip-1', member_id: 'member-1' }]);
  db.seed('vacation_lodging', [{ id: 'lodge-1', family_id: FAMILY, vacation_id: 'trip-1', name: 'Cabin', booked: true }]);
  db.seed('vacation_packing_items', [
    { id: 'p-1', family_id: FAMILY, vacation_id: 'trip-1', name: 'Sunscreen', category: 'toiletries', packed: true, quantity: 1 },
    { id: 'p-2', family_id: FAMILY, vacation_id: 'trip-1', name: 'Boots', category: 'clothing', packed: true, quantity: 1 },
  ]);
  db.seed('vacation_documents', [{ id: 'd-1', family_id: FAMILY, vacation_id: 'trip-1', title: 'Cabin booking' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function show(): Promise<ReactNode> {
  const { clientFor } = await import('./helpers/module-harness');
  const element = () => createElement(TripOverview, { vacationId: 'trip-1' });
  for (let pass = 0; pass < 6; pass++) {
    render(h.hooks, element());
    const pending = [...live.queries.values()].filter((q) => !q.loaded);
    if (!pending.length) break;
    for (const query of pending) {
      const { data, error } = await query.fetcher(clientFor(h));
      query.loaded = true;
      query.error = error ? error.message : null;
      query.data = error ? [] : data ?? [];
    }
  }
  const tree = render(h.hooks, element());
  // The persist effect's own reads and write.
  for (let i = 0; i < 5; i++) await settle();
  return tree;
}

describe('the readiness score is saved only from a complete read', () => {
  it.each(['vacation_packing_items', 'vacation_lodging', 'vacation_documents', 'vacation_members'])(
    'with the %s read failing, the page says so and no score is saved', async (table) => {
      h.fault = (name, calls) => (name === table && calls.includes('select') ? { message: 'upstream timeout' } : null);

      const tree = await show();

      expect(nodes(tree).some((n) => n.props.role === 'alert')).toBe(true);
      expect(db.table('vacation_travel_scores')).toEqual([]);
    },
  );

  it('with every read healthy, the score is saved once', async () => {
    await show();

    const scores = db.table('vacation_travel_scores');
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ family_id: FAMILY, vacation_id: 'trip-1' });
    expect(Number(scores[0].score)).toBeGreaterThan(0);
  });
});
