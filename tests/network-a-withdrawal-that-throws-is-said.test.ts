// A leave, or a contributing scope switched off, whose server action THROWS.
//
// N8-withdrawal-during-run/action-throw-unhandled and
// withdraw-swallows-a-thrown-action (round 5, one defect). Round 4 moved the
// leave and the contributing switch-off into withdrawFromNetworkAction, and the
// module's withdraw() awaited it inside try/finally with no catch. The action
// reads the session outside its own try (requireUserContext throws "Account
// context is temporarily unavailable." when a membership or family read
// fails), and the call itself rejects when the device is offline or a deploy
// has retired this tab's action id. Each time the click became an unhandled
// rejection: no toast, the switch as it was, and nothing to say the leave had
// not happened. The client write it replaced answered `{ error }` and was said.
// The repo's rule is that a thrown action reaches the person who pressed the
// button (tests/a-thrown-action-does-not-leave-a-button-spinning.test.ts).
//
// The real IntelligenceModule and its real server action, on the in-memory
// database; the session read is what throws.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
/** Set, the server's session read throws instead of answering. */
const session = vi.hoisted(() => ({ fails: null as Error | null }));

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
  requireUserContext: async () => {
    if (session.fails) throw session.fails;
    return {
      user: { id: h.app.userId, email: null },
      active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } },
    };
  },
}));
vi.mock('@/lib/supabase/server', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return { createServer: async () => clientFor(h), createServiceClient: () => clientFor(h) };
});

const { IntelligenceModule } = await import('@/components/modules/intelligence-module');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const JOIN = 'Join the network';
const TIMING = 'Timing patterns';
const BENCHMARKS = 'Gentle benchmarks';
const NOT_SAVED = "That change wasn't saved — you may not have permission. Refresh and try again.";
const UNAVAILABLE = new Error('Account context is temporarily unavailable.');
const WRITES = ['insert', 'upsert', 'update', 'delete'];

let db: InMemorySupabase;
const screen = () => render(h.hooks, createElement(IntelligenceModule, {}));
const disabled = (name: string) => byName(screen(), name).props.disabled;
const writes = () => h.calls.filter((c) => c.calls.some((verb) => WRITES.includes(verb)));

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ uniques: { network_contributions: [['family_id']], app_settings: [['key']] } });
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  h.fault = null;
  h.calls = [];
  h.toasts = { success: [], error: [] };
  session.fails = null;
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-1', role: 'parent' });
  db.seed('network_consent', [{
    id: 'consent-1', family_id: FAMILY, enabled: true,
    scopes: { timing: true, benchmarks: true, recommendations: false },
    consented_by: 'user-1', consented_at: '2026-10-01T00:00:00.000Z',
  }]);
  db.seed('network_contributions', [
    { family_id: FAMILY, cohort_key: 'kids:6–9|size:3–4', features: {}, metrics: { dinner_habit: 'often (4–5)' }, scopes: { benchmarks: true } },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a withdrawal whose action throws is said to the member who pressed it', () => {
  it.each([
    ['Leave', JOIN],
    ['the benchmarks switch-off', BENCHMARKS],
  ])('%s: one error toast, no success, the switch as stored, and every toggle back', async (_what, name) => {
    session.fails = UNAVAILABLE;
    const tree = screen();
    // The click settles: the rejection is the module's to handle, not the page's.
    await expect(click(byName(tree, name))).resolves.toBeUndefined();
    expect(h.toasts.error).toEqual([NOT_SAVED]);
    expect(h.toasts.success).toEqual([]);
    // Logged for whoever reads the server logs, and the raw text is not shown.
    expect(console.error).toHaveBeenCalledWith('[intelligence] withdrawal failed', UNAVAILABLE);
    expect(h.toasts.error[0]).not.toContain('Account context');
    // Nothing was written, and the screen still shows the row as stored.
    expect(writes()).toEqual([]);
    expect(db.table('network_consent')[0]).toMatchObject({ enabled: true, scopes: { timing: true, benchmarks: true } });
    expect(db.table('network_contributions')).toHaveLength(1);
    expect(byName(screen(), JOIN).props['aria-checked']).toBe(true);
    expect(byName(screen(), BENCHMARKS).props['aria-checked']).toBe(true);
    // The toggles come back, so the member can try again.
    for (const toggle of [JOIN, TIMING, BENCHMARKS]) expect(disabled(toggle)).toBe(false);
  });

  it('after a failed attempt, the same Leave goes through once the session reads again', async () => {
    session.fails = UNAVAILABLE;
    await click(byName(screen(), JOIN));
    session.fails = null;
    h.toasts = { success: [], error: [] };
    await click(byName(screen(), JOIN));
    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toHaveLength(1);
    expect(db.table('network_consent')[0]).toMatchObject({ enabled: false });
    expect(db.table('network_contributions')).toEqual([]);
  });
});
