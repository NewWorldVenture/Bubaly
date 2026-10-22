import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, has, nodes, render, settle, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Two screens over tables no realtime publication carries, so nothing tells
// them about their own writes: the REAL TripPacking and DevicesModule, against
// an in-memory database. Their lists change only when the component re-reads.
//
//   S8  Smart list pressed twice wrote a second "Master list" and every
//       suggestion again; a ticked box snapped back and the next tap wrote the
//       same value; a removed item stayed on screen
//   S9  an added device never appeared (and a second Add saved it twice);
//       status taps kept writing the same value from the stale status; a
//       deleted device stayed on screen

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

const { TripPacking } = await import('@/components/vacations/trip-packing');
const { DevicesModule } = await import('@/components/modules/devices-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  resetHookSlots(h.hooks);
  live.queries.clear();
  db = createInMemorySupabase({
    defaults: {
      vacation_packing_items: { packed: false, quantity: 1, ai_suggested: false, member_id: null },
      smart_devices: { room: null, brand: null, last_state: null, note: null, status: 'unknown', integration: 'manual', type: 'light' },
    },
  });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.stubGlobal('confirm', () => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function show(element: () => ReturnType<typeof createElement>): Promise<ReactNode> {
  const { clientFor } = await import('./helpers/module-harness');
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
  return render(h.hooks, element());
}

describe('S8 — the packing tab shows its own writes', () => {
  const packing = () => createElement(TripPacking, { vacationId: 'trip-1' });
  const checkboxes = (tree: ReactNode) => nodes(tree).filter((n) => n.type === 'input' && n.props.type === 'checkbox');

  beforeEach(() => {
    db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Lake week', kind: 'domestic', is_international: false, start_date: '2026-10-20', end_date: '2026-10-24' }]);
  });

  it('a second Smart list press writes no second master list and no item twice', async () => {
    await click(byName(await show(packing), new RegExp(t('tripPacking.smartList'))));
    const first = db.table('vacation_packing_items').length;
    expect(first).toBeGreaterThan(0);

    await click(byName(await show(packing), new RegExp(t('tripPacking.smartList'))));

    expect(db.table('vacation_packing_lists').filter((row) => row.is_master)).toHaveLength(1);
    expect(db.table('vacation_packing_items')).toHaveLength(first);
    expect(h.toasts.error).toContain(t('tripPacking.yourListAlreadyCoversThe'));
    // And the screen lists what was added.
    expect(checkboxes(await show(packing))).toHaveLength(first);
  });

  it('a box ticked twice is unticked, not written "packed" twice', async () => {
    db.seed('vacation_packing_lists', [{ id: 'list-1', family_id: FAMILY, vacation_id: 'trip-1', name: 'Master list', is_master: true }]);
    db.seed('vacation_packing_items', [{ id: 'item-1', family_id: FAMILY, vacation_id: 'trip-1', list_id: 'list-1', name: 'Sunscreen', category: 'toiletries', packed: false }]);

    change(checkboxes(await show(packing))[0] as Node, true);
    await settle();
    expect(db.table('vacation_packing_items')[0].packed).toBe(true);
    change(checkboxes(await show(packing))[0] as Node, false);
    await settle();

    expect(db.table('vacation_packing_items')[0].packed).toBe(false);
  });

  it('a removed item leaves the list', async () => {
    db.seed('vacation_packing_lists', [{ id: 'list-1', family_id: FAMILY, vacation_id: 'trip-1', name: 'Master list', is_master: true }]);
    db.seed('vacation_packing_items', [{ id: 'item-1', family_id: FAMILY, vacation_id: 'trip-1', list_id: 'list-1', name: 'Sunscreen', category: 'toiletries' }]);

    await click(byName(await show(packing), t('a11y.delete')));

    expect(db.table('vacation_packing_items')).toEqual([]);
    expect(has(await show(packing), 'Sunscreen')).toBe(false);
    expect(h.toasts.error).toEqual([]);
  });
});

describe('S9 — the devices list shows its own writes', () => {
  const devices = () => createElement(DevicesModule);
  const cycleButton = (tree: ReactNode) => nodes(tree).find((n) => n.type === 'button' && n.props.title === t('devices.cycleStatus')) as Node;

  it('an added device appears, so nobody adds it twice', async () => {
    await click(byName(await show(devices), new RegExp(t('devices.addDevice'))));
    const opened = await show(devices);
    change(nodes(opened).find((n) => n.type === 'input' && n.props.placeholder === t('devices.livingRoomLamp')) as Node, 'Hall lamp');
    await submit(form(await show(devices)));

    expect(db.table('smart_devices').map((row) => row.name)).toEqual(['Hall lamp']);
    expect(has(await show(devices), 'Hall lamp')).toBe(true);
  });

  it('each status tap steps from the status it last saved', async () => {
    db.seed('smart_devices', [{ id: 'dev-1', family_id: FAMILY, name: 'Porch light', status: 'online' }]);

    await click(cycleButton(await show(devices)));
    expect(db.table('smart_devices')[0].status).toBe('offline');
    await click(cycleButton(await show(devices)));

    expect(db.table('smart_devices')[0].status).toBe('unknown');
  });

  it('a deleted device leaves the list', async () => {
    db.seed('smart_devices', [{ id: 'dev-1', family_id: FAMILY, name: 'Porch light', status: 'online' }]);

    await click(byName(await show(devices), t('devices.delete')));

    expect(db.table('smart_devices')).toEqual([]);
    expect(has(await show(devices), 'Porch light')).toBe(false);
  });
});
