// One household, two tabs: the second still holds the scope map it loaded.
//
// N8-withdrawal-during-run/stale-scope-map-regrants (round 5). toggleScope
// built the whole next map as { ...consent.scopes, [k]: !consent.scopes[k] }
// from the row its tab had loaded, and network_consent is not realtime, so a
// change made in another tab never reached it. Both writes took that map as
// given: the module's direct update (switching timing or recommendations, or
// switching any scope ON) filtered only on family_id and enabled, and
// withdrawFromNetworkAction wrote the map it was sent. So after a manager
// switched "Gentle benchmarks" off in one tab (confirmed, the stored row
// deleted), switching "Timing patterns" off in the other wrote benchmarks
// back ON, and the next nightly run stored and the next epoch published that
// household's benchmark metrics again — a consent nobody gave.
//
// Now the switch-off sends only the scope it turns off, which the server
// switches off in the map STORED at that moment (a withdrawal only narrows),
// and the direct write is a compare-and-set on the map the screen built from:
// changed elsewhere, nothing is written, the member is told, and the screen
// reads the row again.
//
// The real IntelligenceModule and its real server action on the in-memory
// database. A "tab" is a render: its handlers keep the row that render read,
// exactly as an open tab's do.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/app/page-header', async () => ({ PageHeader: (await import('./helpers/module-harness')).ui.PageHeader }));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.app.userId, email: null },
    active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return { createServer: async () => clientFor(h), createServiceClient: () => h.db };
});

const { IntelligenceModule } = await import('@/components/modules/intelligence-module');
const { withdrawFromNetworkAction } = await import('@/app/(app)/dashboard/intelligence/actions');
const { contributesToNetwork } = await import('@/lib/network/aggregate');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const ME = 'user-1';
const TIMING = 'Timing patterns';
const BENCHMARKS = 'Gentle benchmarks';
const SUGGESTIONS = 'Crowd-rated suggestions';
const JOIN = 'Join the network';
const SAVED = 'Preferences saved';
const NOT_SAVED = "That change wasn't saved — you may not have permission. Refresh and try again.";
const ON_SCREEN = { expectedFamilyId: FAMILY, expectedUserId: ME };

let db: InMemorySupabase;
/** A tab: one render, whose handlers keep the row it read. */
const tab = () => render(h.hooks, createElement(IntelligenceModule, {}));
const stored = () => db.table('network_consent').find((r) => r.family_id === FAMILY)!;
const scopes = () => stored().scopes as Record<string, boolean>;
const on = (tree: ReturnType<typeof tab>, name: string) => byName(tree, name).props['aria-checked'];

function seed(initial: Record<string, boolean>) {
  db.seed('network_consent', [{
    id: 'consent-1', family_id: FAMILY, enabled: true, scopes: initial,
    consented_by: ME, consented_at: '2026-10-01T00:00:00.000Z',
  }]);
  db.seed('network_contributions', [
    { family_id: FAMILY, cohort_key: 'kids:6–9|size:3–4', features: {}, metrics: { dinner_habit: 'often (4–5)' }, scopes: { benchmarks: true } },
  ]);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ uniques: { network_contributions: [['family_id']], app_settings: [['key']] } });
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  h.fault = null;
  h.calls = [];
  h.refreshes = [];
  h.toasts = { success: [], error: [] };
  Object.assign(h.app, { familyId: FAMILY, userId: ME, role: 'parent' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a confirmed benchmarks switch-off stays off, whatever another tab still shows', () => {
  it('switching timing OFF in the stale tab writes nothing, says so, and shows the stored row', async () => {
    seed({ timing: true, benchmarks: true, recommendations: false });
    const second = tab();   // loads timing and benchmarks on
    const first = tab();
    await click(byName(first, BENCHMARKS));
    expect(scopes()).toEqual({ timing: true, benchmarks: false, recommendations: false });
    expect(db.table('network_contributions')).toEqual([]);
    h.toasts = { success: [], error: [] };

    await click(byName(second, TIMING));
    // Benchmarks is still off: the next run neither stores nor publishes it.
    expect(scopes()).toEqual({ timing: true, benchmarks: false, recommendations: false });
    expect(contributesToNetwork(scopes())).toBe(false);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([NOT_SAVED]);
    // The tab read the row again, so the next tap builds from what is stored …
    const fresh = tab();
    expect(on(fresh, BENCHMARKS)).toBe(false);
    expect(on(fresh, TIMING)).toBe(true);
    // … and the same tap now does what it says, and only that.
    await click(byName(fresh, TIMING));
    expect(scopes()).toEqual({ timing: false, benchmarks: false, recommendations: false });
    expect(h.toasts.success).toEqual([SAVED]);
  });

  it('switching another scope ON in the stale tab does not switch benchmarks back on either', async () => {
    seed({ timing: true, benchmarks: true, recommendations: false });
    const second = tab();
    await click(byName(tab(), BENCHMARKS));
    await click(byName(second, SUGGESTIONS));
    expect(scopes()).toEqual({ timing: true, benchmarks: false, recommendations: false });
    expect(contributesToNetwork(scopes())).toBe(false);
  });

  it('switching benchmarks off in the stale tab does not switch timing back on, and still switches benchmarks off', async () => {
    seed({ timing: true, benchmarks: true, recommendations: false });
    const second = tab();
    await click(byName(tab(), TIMING));
    expect(scopes()).toEqual({ timing: false, benchmarks: true, recommendations: false });
    h.toasts = { success: [], error: [] };

    // A switch-off is a withdrawal, and is never refused for being stale: it
    // switches off, in the map stored now, the one scope it names.
    await click(byName(second, BENCHMARKS));
    expect(scopes()).toEqual({ timing: false, benchmarks: false, recommendations: false });
    expect(db.table('network_contributions')).toEqual([]);
    expect(h.toasts.success).toEqual([SAVED]);
  });
});

describe('the action itself only narrows', () => {
  it('a whole map that would switch scopes on switches off only what it says is off', async () => {
    seed({ timing: false, benchmarks: true, recommendations: false });
    expect(await withdrawFromNetworkAction({ scopes: { timing: true, benchmarks: false, recommendations: true } }, ON_SCREEN))
      .toMatchObject({ ok: true });
    expect(scopes()).toEqual({ timing: false, benchmarks: false, recommendations: false });
    expect(db.table('network_contributions')).toEqual([]);
  });

  it('a change that switches nothing off is not a withdrawal, and writes nothing', async () => {
    seed({ timing: false, benchmarks: true, recommendations: false });
    const before = structuredClone(stored());
    for (const change of [{ scopes: { timing: true } }, { scopes: {} }]) {
      expect(await withdrawFromNetworkAction(change, ON_SCREEN)).toEqual({ ok: false, error: NOT_SAVED });
    }
    expect(stored()).toEqual(before);
    expect(db.table('network_contributions')).toHaveLength(1);
  });
});

// The join, too, wrote the map its tab had loaded: an upsert keyed on the
// family alone. A tab that still showed the household out of the network
// joined it with that old map over whatever was chosen since, and a map read
// from a row that was out with scopes on switched those scopes back on. It is
// a compare-and-set now: on the row read (still out, the same map), or, with
// no row read, an insert that writes nothing over a row that exists.
describe('joining from a stale tab is written against the row it read', () => {
  it('a tab that read the household out with benchmarks on does not join over a benchmarks switch-off made since', async () => {
    db.seed('network_consent', [{
      id: 'consent-1', family_id: FAMILY, enabled: false, scopes: { timing: false, benchmarks: true, recommendations: false },
      consented_by: null, consented_at: null,
    }]);
    const second = tab();   // out of the network, benchmarks on in its map
    await click(byName(tab(), JOIN));
    expect(stored()).toMatchObject({ enabled: true, scopes: { benchmarks: true } });
    await click(byName(tab(), BENCHMARKS));
    expect(scopes()).toEqual({ timing: false, benchmarks: false, recommendations: false });
    h.toasts = { success: [], error: [] };
    h.refreshes = [];

    await click(byName(second, JOIN));
    expect(stored()).toMatchObject({ enabled: true });
    expect(scopes()).toEqual({ timing: false, benchmarks: false, recommendations: false });
    expect(contributesToNetwork(scopes())).toBe(false);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([NOT_SAVED]);
    // It read the row again: the screen shows the household in, benchmarks off.
    expect(h.refreshes).toEqual(['network_consent']);
    expect(on(tab(), JOIN)).toBe(true);
    expect(on(tab(), BENCHMARKS)).toBe(false);
  });

  it('a tab that read no row does not join over the row another tab wrote since', async () => {
    const second = tab();   // no consent row yet
    await click(byName(tab(), JOIN));
    await click(byName(tab(), TIMING));
    expect(stored()).toMatchObject({ enabled: true, scopes: { timing: true } });
    h.toasts = { success: [], error: [] };

    await click(byName(second, JOIN));
    expect(stored()).toMatchObject({ enabled: true, scopes: { timing: true } });
    expect(db.table('network_consent')).toHaveLength(1);
    expect(h.toasts.error).toEqual([NOT_SAVED]);
    expect(h.toasts.success).toEqual([]);
  });

  it('control: a current tab joins with no row, and joins again after leaving', async () => {
    await click(byName(tab(), JOIN));
    expect(stored()).toMatchObject({ enabled: true, consented_by: ME, scopes: {} });
    expect(h.toasts.success).toEqual([SAVED]);
    await click(byName(tab(), JOIN));   // leave
    expect(stored()).toMatchObject({ enabled: false, scopes: {} });
    h.toasts = { success: [], error: [] };
    await click(byName(tab(), JOIN));   // join the row that is out
    expect(stored()).toMatchObject({ enabled: true, consented_by: ME, scopes: {} });
    expect(h.toasts).toEqual({ success: [SAVED], error: [] });
  });
});
