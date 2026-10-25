// "A scan is already running" tells the parent what to do, because the page
// will not update itself.
//
// A manager who presses "Scan for tips" while another run holds the family's
// learning lease (the nightly cron, or another manager's scan) is answered
// guardian.aScanIsAlreadyRunning, shown as an error toast. It said "Its tips
// will appear here in a moment". The Guardian dashboard has no polling and no
// realtime subscription, and router.refresh() runs only after its OWN scan
// created something, so the other run's tips appeared only after a reload the
// copy never asked for. Driven through the real dashboard and the real server
// action, with the lease held, in every base catalogue.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const seam = vi.hoisted(() => ({ locale: 'en-US', refresh: vi.fn() }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: seam.refresh }) }));
// The server action's own request: the reader's language comes from the
// locale cookie, as in production (lib/i18n/server.ts).
vi.mock('next/headers', async () => {
  const { LOCALE_COOKIE } = await import('@/lib/i18n/locales');
  return {
    cookies: async () => ({ get: (name: string) => (name === LOCALE_COOKIE ? { value: seam.locale } : undefined) }),
    headers: async () => new Headers(),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u-parent' }, active: { familyId: FAMILY, role: 'parent', member: { id: 'm-parent' } } }),
}));

const { GuardianDashboard } = await import('@/components/guardian/guardian-dashboard');
const { generateGuardianSuggestionsAction } = await import('@/app/(app)/guardian/actions');
const { learningLeaseKey } = await import('@/lib/guardian/learning-lease');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-20T02:00:00.000Z');
const KEY = 'guardian.aScanIsAlreadyRunning';
const dashboard = () => createElement(GuardianDashboard, {
  recentComms: [], suggestions: [], escalations: [], memberProfiles: [],
  stats: { totalCalls: 0, blockedToday: 0, scamsBlocked: 0, screened: 0 }, isTwilioConfigured: false,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  seam.locale = 'en-US';
  seam.refresh.mockReset();
  const db = createInMemorySupabase({ uniques: { app_settings: [['key']] } });
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC', closed_at: null }]);
  // Another run is learning for the family right now: the nightly cron's lease.
  db.seed('app_settings', [{ key: learningLeaseKey(FAMILY), value: { token: 'the-nightly-run' }, updated_at: NOW.toISOString() }]);
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('pressing "Scan for tips" while another run holds the lease', () => {
  it('the dashboard does not refresh on its own, so the toast asks for the reload', async () => {
    let tree = render(h.hooks, dashboard());
    await click(byName(tree, 'Scan for tips', 'button'));
    tree = render(h.hooks, dashboard());

    expect(h.toasts.error).toEqual([translate(getMessages('en-US'), KEY)]);
    // Nothing on this page will bring the other run's tips in: no refresh,
    // and the empty state is still what is shown.
    expect(seam.refresh).not.toHaveBeenCalled();
    expect(has(tree, translate(getMessages('en-US'), 'guardianDashboard.noSuggestionsRightNowTap'))).toBe(true);
    // The defect: "Its tips will appear here in a moment."
    expect(h.toasts.error[0]).not.toMatch(/appear here|in a moment/i);
    expect(h.toasts.error[0]).toMatch(/reload this page/i);
  });

  // [locale, what the old copy promised, what the page needs the reader to do]
  it.each<[LocaleCode, RegExp, RegExp]>([
    ['en-US', /appear here in a moment/i, /reload this page/i],
    ['de-DE', /erscheinen gleich hier/i, /seite .*neu/i],
    ['es-ES', /aparecerán aquí en un momento/i, /vuelve a cargar esta página/i],
    ['fr-FR', /apparaîtront ici dans un instant/i, /rechargez cette page/i],
    ['it-IT', /compariranno qui tra un momento/i, /ricarica questa pagina/i],
    ['nl-NL', /verschijnen hier zo meteen/i, /pagina .*opnieuw/i],
    ['pt-PT', /vão aparecer aqui dentro de momentos/i, /recarregue esta página/i],
  ])('in %s the action says the same, in the reader\'s own language', async (locale, promise, ask) => {
    seam.locale = locale;
    const answer = await generateGuardianSuggestionsAction();
    expect(answer).toEqual({ ok: false, error: translate(getMessages(locale), KEY) });
    if (!answer.ok) {
      if (locale !== 'en-US') expect(answer.error, 'fell back to English').not.toBe(translate(getMessages('en-US'), KEY));
      expect(answer.error).not.toMatch(promise);
      expect(answer.error).toMatch(ask);
    }
  });
});
