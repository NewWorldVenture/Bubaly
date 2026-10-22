// The Trip Intelligence page fails closed on a failed read (N11).
//
// It dropped every read error: a failed calendar read rendered "No upcoming
// events with a location", and a failed departure_plans read (anything but a
// missing table) hid every active leave-by plan with no notice — so a family
// re-planned a departure it could not see and got a second head-out event.
//
// Rendered for real against an in-memory database.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const io = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({ user: { id: 'user-1' }, active: { familyId: 'fam-1', role: 'parent', family: { timezone: 'America/Los_Angeles' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => io.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

const TripIntelPage = (await import('@/app/(app)/dashboard/trip-intel/page')).default;
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');
const { localeOrDefault } = await import('@/lib/i18n/locales');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

/** One table answers every read with a refusal that is not "missing table". */
function failing(table: string) {
  const realFrom = db.from.bind(db);
  const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 500, statusText: 'Error' };
  const proxy: unknown = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(reply).then(resolve);
      return () => proxy;
    },
  });
  (db as unknown as { from: (t: string) => unknown }).from = (name: string) => (name === table ? proxy : realFrom(name));
}
async function text(): Promise<string> {
  const tree = await TripIntelPage();
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree,
  )).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

beforeEach(() => {
  db = createInMemorySupabase();
  io.db = db;
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  db.seed('family_members', [{ id: 'member-1', family_id: 'fam-1', display_name: 'Ada', color: null, is_active: true }]);
  db.seed('calendar_events', [{ id: 'game', family_id: 'fam-1', title: 'Night game', location: 'Dodger Stadium', starts_at: soon, ends_at: null, all_day: false, category: 'sports', assignee_id: null }]);
  db.seed('departure_plans', [{
    id: 'plan-1', family_id: 'fam-1', title: 'Night game', origin: 'Home', destination: 'Dodger Stadium', event_start: soon,
    prep_minutes: 30, park_minutes: 10, buffer_minutes: 5, drive_seconds: 1500, traffic_factor: 1, weather_delay_minutes: 0, weather_summary: null,
    leave_by: null, last_checked_at: null, dest_lat: null, dest_lng: null, origin_lat: null, origin_lng: null, status: 'active',
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the Trip Intelligence page', () => {
  it('an unread calendar is an error, not "no upcoming events with a location"', async () => {
    failing('calendar_events');
    const page = await text();
    expect(page).toContain(t('tripIntel.couldNotLoadTripIntelligence'));
    expect(page).not.toContain(t('tripIntel.noUpcomingEventsWithALocation'));
  });

  it('unread members are an error too', async () => {
    failing('family_members');
    expect(await text()).toContain(t('tripIntel.couldNotLoadTripIntelligence'));
  });

  it('unread departures are said to be unread, not hidden as none', async () => {
    failing('departure_plans');
    const page = await text();
    expect(page).toContain(t('tripIntel.savedDeparturesUnavailable'));
    expect(page).toContain('Night game');
  });

  it('unread trip research is said to be unread', async () => {
    failing('trip_plans');
    expect(await text()).toContain(t('tripIntel.savedTripResearchUnavailable'));
  });

  it('a readable page shows its plans and no notice', async () => {
    const page = await text();
    expect(page).toContain(t('tripIntel.smartDepartures'));
    expect(page).not.toContain(t('tripIntel.savedDeparturesUnavailable'));
    expect(page).not.toContain(t('tripIntel.couldNotLoadTripIntelligence'));
  });
});
