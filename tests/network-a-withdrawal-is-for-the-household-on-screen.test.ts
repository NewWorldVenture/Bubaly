// A leave, or a contributing scope switched off, from a tab that shows a
// household the account is no longer active in.
//
// N8-withdrawal-during-run/stale-tab-wrong-family (round 4, re-fix 1). Round 4
// moved the leave and the contributing scope's switch-off into a server
// action, and the action took the household from requireUserContext():
// `ctx.active.familyId`, which is user_preferences.active_family_id, shared by
// every tab and device of the account. The module sent no household of its
// own. So with household A on screen and B chosen in another tab, "Leave"
// withdrew B's consent and deleted B's stored row, and said "Left the network"
// over A, which went on contributing and being published. A scope switch-off
// wrote A's whole scope map onto B, switching B's other scopes on as well.
//
// Now the module names the household and the member on screen
// (expectedFamilyId, expectedUserId), and the action refuses anything but the
// active ones before it checks the role and before it takes the publication
// claim: nothing is written for either household, no success is said, and the
// error says to refresh. The repo's pattern for this is the autopilot action's
// `contextChanged` (app/(app)/dashboard/autopilot/actions.ts).
//
// Driven through the real IntelligenceModule on hook slots and its real server
// action, against the in-memory database; only the session is stubbed.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
/** What the server's session says, when it differs from the screen (another tab, another sign-in). */
const session = vi.hoisted(() => ({ familyId: null as string | null, userId: null as string | null, role: null as string | null }));

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
    user: { id: session.userId ?? h.app.userId, email: null },
    active: {
      familyId: session.familyId ?? h.app.familyId,
      role: session.role ?? (h.app as { role?: string }).role ?? 'parent',
      member: { id: 'member-1' }, family: { timezone: 'UTC' },
    },
  }),
}));
// Both clients the action makes are recorded (h.calls), so a refusal can be
// shown to have sent nothing: not the consent write, not the delete, not the claim.
vi.mock('@/lib/supabase/server', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return { createServer: async () => clientFor(h), createServiceClient: () => clientFor(h) };
});

const { IntelligenceModule } = await import('@/components/modules/intelligence-module');
const { withdrawFromNetworkAction } = await import('@/app/(app)/dashboard/intelligence/actions');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ME = 'user-1';
const JOIN = 'Join the network';
const BENCHMARKS = 'Gentle benchmarks';
const CONTEXT_CHANGED = 'Your account or active household changed since this page loaded, so nothing was changed. Refresh the page and try again.';
const LEFT = 'Left the network. Your data is no longer used and your stored contribution is deleted. Summaries already published this month keep your share, mixed with at least 20 families and noise, until next month’s update.';
const WRITES = ['insert', 'upsert', 'update', 'delete'];

let db: InMemorySupabase;
let before: Map<string, unknown>;

const screen = () => render(h.hooks, createElement(IntelligenceModule, {}));
const consentOf = (familyId: string) => db.table('network_consent').find((r) => r.family_id === familyId);
const storedOf = (familyId: string) => db.table('network_contributions').filter((r) => r.family_id === familyId);
/** Every table the action could change, as it stands. */
const snapshot = () => new Map<string, unknown>(['network_consent', 'network_contributions', 'app_settings']
  .map((table) => [table, structuredClone(db.table(table))]));
/** The statements sent since `from`: writes, and anything touching the publication claim. */
const sentSince = (from: number) => h.calls.slice(from)
  .filter((c) => c.table === 'app_settings' || c.calls.some((verb) => WRITES.includes(verb)))
  .map((c) => `${c.table}.${c.calls.join('.')}`);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ uniques: { network_contributions: [['family_id']], app_settings: [['key']] } });
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  h.fault = null;
  h.calls = [];
  h.toasts = { success: [], error: [] };
  Object.assign(h.app, { familyId: A, userId: ME, role: 'parent' });
  Object.assign(session, { familyId: null, userId: null, role: null });
  // Both households are in the network and have a stored contribution. A also
  // shares timing, B does not: a scope map written onto the wrong household
  // would switch B's timing on.
  db.seed('network_consent', [
    { id: 'consent-a', family_id: A, enabled: true, scopes: { timing: true, benchmarks: true, recommendations: false }, consented_by: ME, consented_at: '2026-10-01T00:00:00.000Z' },
    { id: 'consent-b', family_id: B, enabled: true, scopes: { timing: false, benchmarks: true, recommendations: false }, consented_by: ME, consented_at: '2026-10-01T00:00:00.000Z' },
  ]);
  for (const family of [A, B]) {
    db.seed('network_contributions', [{ family_id: family, cohort_key: 'kids:6–9|size:3–4', features: {}, metrics: { dinner_habit: 'often (4–5)' }, scopes: { benchmarks: true } }]);
  }
  before = snapshot();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a tab still showing household A after B was chosen elsewhere', () => {
  beforeEach(() => { session.familyId = B; });

  it('Leave withdraws neither household, says nothing succeeded, and asks for a refresh', async () => {
    const tree = screen();
    const sent = h.calls.length;
    await click(byName(tree, JOIN));

    expect(consentOf(A)).toMatchObject({ enabled: true, scopes: { timing: true, benchmarks: true } });
    expect(consentOf(B)).toMatchObject({ enabled: true, scopes: { timing: false, benchmarks: true } });
    expect(storedOf(A)).toHaveLength(1);
    expect(storedOf(B)).toHaveLength(1);
    expect(snapshot()).toEqual(before);
    // Refused before the claim: not even app_settings was asked.
    expect(sentSince(sent)).toEqual([]);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([CONTEXT_CHANGED]);
    // The screen still shows A as it is, not B's row.
    expect(byName(screen(), JOIN).props['aria-checked']).toBe(true);
    expect(byName(screen(), BENCHMARKS).props['aria-checked']).toBe(true);
  });

  it('switching a contributing scope off writes A\'s scope map onto neither household', async () => {
    const tree = screen();
    const sent = h.calls.length;
    await click(byName(tree, BENCHMARKS));

    expect(consentOf(B)!.scopes).toEqual({ timing: false, benchmarks: true, recommendations: false });
    expect(consentOf(A)!.scopes).toEqual({ timing: true, benchmarks: true, recommendations: false });
    expect(snapshot()).toEqual(before);
    expect(sentSince(sent)).toEqual([]);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([CONTEXT_CHANGED]);
  });

  it('is refused for the household, not for the role: a member who manages A but not B is told to refresh', async () => {
    session.role = 'teen';
    await click(byName(screen(), JOIN));
    expect(h.toasts.error).toEqual([CONTEXT_CHANGED]);
    expect(snapshot()).toEqual(before);
  });
});

describe('a tab signed in as someone else since it loaded', () => {
  it('is refused the same way, even for the same household', async () => {
    session.userId = 'user-2';
    const tree = screen();
    const sent = h.calls.length;
    await click(byName(tree, JOIN));
    expect(snapshot()).toEqual(before);
    expect(sentSince(sent)).toEqual([]);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([CONTEXT_CHANGED]);
  });
});

describe('the action itself names its household or does nothing', () => {
  it('a call with no household, or a malformed one, is refused before anything is sent', async () => {
    for (const expected of [undefined, null, {}, { expectedFamilyId: A }, { expectedFamilyId: [A], expectedUserId: ME }, { expectedFamilyId: B, expectedUserId: ME }]) {
      const sent = h.calls.length;
      expect(await withdrawFromNetworkAction({ leave: true }, expected as never), JSON.stringify(expected))
        .toEqual({ ok: false, error: CONTEXT_CHANGED });
      expect(sentSince(sent)).toEqual([]);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe('the household on screen, still the active one, leaves as before', () => {
  it('only A is withdrawn and forgotten; B is untouched', async () => {
    session.familyId = A;
    await click(byName(screen(), JOIN));
    expect(consentOf(A)).toMatchObject({ enabled: false });
    expect(storedOf(A)).toEqual([]);
    expect(consentOf(B)).toMatchObject({ enabled: true, scopes: { timing: false, benchmarks: true } });
    expect(storedOf(B)).toHaveLength(1);
    expect(h.toasts.success).toEqual([LEFT]);
    expect(h.toasts.error).toEqual([]);
  });
});
