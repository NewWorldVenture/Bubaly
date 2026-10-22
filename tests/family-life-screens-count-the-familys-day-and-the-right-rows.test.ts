import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { suggestMilestones } from '@/lib/independence/progression';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, clientFor, expand, has, nodes, render, settle, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Family-life screens, driven as a person drives them (module-harness: the real
// component, its own reads and writes, the real lib helpers and family clock).
//
//   pets           a removed pet's records kept counting (F10); Care needs
//                  used the device's day (F23)
//   screen time    the streak and the week counted Greenwich's day (F11)
//   journal        dated entries with the database's UTC day (F12); a fallback
//                  prompt was shown as if personalised, silently (F36)
//   subscriptions  "Mark used today" read back as a future date east of UTC (F13)
//   rides          the oldest 1,000 rides only (F40)
//   habits         the newest 1,000 logs only, streaks from a prefix (F40)
//   independence   a skipped rung was suggested again (F18)
//   autopilot      a guest was listed the household's subscription charges (F1/F4)
//   auto           renewal badges a day off (F8); rental times in UTC (F21)

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const reg = vi.hoisted(() => ({ fetchers: new Map<string, (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>>(), info: [] as string[] }));
const mocked = vi.hoisted(() => ({ startMilestone: vi.fn(async () => ({ ok: true })) }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const harness = (await import('./helpers/module-harness')).realtimeQueryModule(h);
  return {
    useRealtimeQuery: (opts: { table: string; fetcher: (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> }) => {
      reg.fetchers.set(opts.table, opts.fetcher);
      return harness.useRealtimeQuery(opts as never);
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => {
  const base = (await import('./helpers/module-harness')).toastModule(h);
  return { useToast: () => ({ ...base.useToast(), toast: (message: string) => { reg.info.push(message); } }) };
});
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/card', async () => {
  const { createElement: el } = await import('react');
  return { Card: ({ children }: { children?: ReactNode }) => el('div', null, children) };
});
vi.mock('@/components/home/field', async () => {
  const { createElement: el } = await import('react');
  return { Field: ({ label, children }: { label?: ReactNode; children?: ReactNode }) => el('label', null, label, children) };
});
vi.mock('@/components/ui/action-error', () => ({ ActionError: () => null, useActionError: () => ({ message: null, run: async (fn: () => Promise<unknown>) => { await fn(); return true; } }) }));
vi.mock('@/components/ai/why-this', () => ({ WhyThis: () => null }));
vi.mock('@/components/modules/savings-coach-card', () => ({ SavingsCoachCard: () => null }));
vi.mock('@/components/modules/subscription-price-history-review', () => ({ SubscriptionPriceHistoryReview: () => null }));
vi.mock('@/lib/hooks/use-speech-recognition', () => ({ useSpeechRecognition: () => ({ listening: false, transcript: '', supported: false, start: () => {}, stop: () => {}, reset: () => {} }) }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/app/(app)/dashboard/independence/actions', () => ({ startMilestoneAction: mocked.startMilestone, achieveMilestoneAction: vi.fn(), skipMilestoneAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/autopilot/actions', () => ({ resolveAutopilotSuggestionAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/trust/actions', () => ({ acceptPolicySuggestionAction: vi.fn() }));
vi.mock('@/app/(app)/dashboard/auto/actions', () => ({ saveLicenseAction: vi.fn(), deleteLicenseAction: vi.fn(), saveRentalAction: vi.fn(), deleteRentalAction: vi.fn() }));

const { PetsModule } = await import('@/components/modules/pets-module');
const { ScreenTimeModule } = await import('@/components/modules/screen-time-module');
const { JournalModule } = await import('@/components/modules/journal-module');
const { SubscriptionsModule } = await import('@/components/modules/subscriptions-module');
const { RidesModule } = await import('@/components/modules/rides-module');
const { HabitsModule } = await import('@/components/modules/habits-module');
const { IndependenceModule } = await import('@/components/modules/independence-module');
const { AutopilotModule } = await import('@/components/modules/autopilot-module');
const { LicensesClient } = await import('@/components/auto/licenses-client');
const { RentalsClient } = await import('@/components/auto/rentals-client');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  reg.fetchers.clear(); reg.info = [];
  h.timeZone = 'UTC';
  h.app.members = [{ id: 'member-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null }];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'UTC' };
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' });
});
afterEach(async () => { await settle(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** What the module's own read returns now, as a realtime refetch would put it on screen. */
async function refetch(table: string) {
  const fetcher = reg.fetchers.get(table);
  if (!fetcher) throw new Error(`no fetcher registered for ${table}`);
  const { data, error } = await fetcher(clientFor(h));
  if (error) { h.readErrors[table] = error.message; return; }
  delete h.readErrors[table];
  h.rows[table] = (data ?? []) as Record<string, unknown>[];
}

/** 10:30 at Greenwich: the 12th in UTC, Los Angeles and Tokyo — the 13th on Kiritimati. */
const KIRITIMATI_MIDNIGHT = new Date('2026-10-12T10:30:00Z');

describe('pets', () => {
  const screen = () => render(h.hooks, createElement(PetsModule));

  it('a removed pet\'s care records leave Care status and Upcoming care (F10)', () => {
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    db.seed('pets', [
      { id: 'rex', family_id: FAMILY, name: 'Rex', species: 'fish', breed: null, is_active: true, birthday: null },
      { id: 'tom', family_id: FAMILY, name: 'Old Tom', species: 'cat', breed: null, is_active: false, birthday: null },
    ]);
    db.seed('pet_care_records', [
      { id: 'c1', family_id: FAMILY, pet_id: 'tom', kind: 'medication', title: 'Heartworm pill', record_date: '2026-06-01', next_due: '2026-09-01' },
    ]);
    // The list as the module's own read returns it: active pets only.
    h.rows.pets = db.table('pets').filter((p) => p.is_active);
    const tree = screen();
    expect(has(tree, 'Heartworm pill')).toBe(false);
    expect(has(tree, '1 overdue')).toBe(false);
  });

  it('Care needs counts the family\'s day, like Care status beside it (F23)', () => {
    vi.setSystemTime(KIRITIMATI_MIDNIGHT);
    h.timeZone = 'Pacific/Kiritimati';
    db.seed('pets', [{ id: 'rex', family_id: FAMILY, name: 'Rex', species: 'fish', breed: null, is_active: true, birthday: null }]);
    db.seed('pet_care_records', [
      { id: 'c1', family_id: FAMILY, pet_id: 'rex', kind: 'vet_visit', title: 'Dental cleaning', record_date: '2026-04-13', next_due: '2026-10-13' },
    ]);
    const tree = screen();
    expect(has(tree, 'Due in 0 days')).toBe(true);
    expect(has(tree, 'Due in 1 day')).toBe(false);
  });
});

describe('screen time', () => {
  it('a Los Angeles evening over the limit shows no under-limit streak, and a family week (F11)', () => {
    // 18:00 on Monday 12 October in Los Angeles; already the 13th at Greenwich.
    vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
    h.timeZone = 'America/Los_Angeles';
    h.app.members = [{ id: 'kid', display_name: 'Kit', role: 'child', is_active: true, color: null, birthday: null }];
    db.seed('screen_time_limits', [{ id: 'l1', family_id: FAMILY, member_id: 'kid', daily_minutes: 120 }]);
    db.seed('screen_time_entries', [
      { id: 'e1', family_id: FAMILY, member_id: 'kid', entry_date: '2026-10-12', minutes: 160, category: 'gaming' },
      // Six family days back: inside the family's week, outside Greenwich's.
      { id: 'e2', family_id: FAMILY, member_id: 'kid', entry_date: '2026-10-06', minutes: 100, category: 'educational' },
    ]);
    const tree = render(h.hooks, createElement(ScreenTimeModule));
    expect(has(tree, t('screenTime.overBy', { time: '40m' }))).toBe(true);
    expect(has(tree, t('screenTime.dUnder'))).toBe(false);
    expect(has(tree, `4h 20m ${t('screenTime.thisWeek')}`)).toBe(true);
  });
});

describe('journal', () => {
  it('a new entry is dated on the family\'s day (F12)', async () => {
    // 18:00 on 12 October in Los Angeles; the database's UTC day is the 13th.
    vi.setSystemTime(new Date('2026-10-13T01:00:00Z'));
    h.timeZone = 'America/Los_Angeles';
    await click(byName(render(h.hooks, createElement(JournalModule)), t('journal.writeAboutThis')));
    const tree = render(h.hooks, createElement(JournalModule));
    const body = nodes(tree).find((n) => n.type === 'textarea')!;
    (body.props.onChange as (e: unknown) => void)({ target: { value: 'A good day at the lake.' } });
    const { submit, form } = await import('./helpers/module-harness');
    await submit(form(render(h.hooks, createElement(JournalModule))));
    expect(db.table('journal_entries')).toEqual([expect.objectContaining({ body: 'A good day at the lake.', entry_date: '2026-10-12' })]);
  });

  it('Personalize says so when it could only give the prompt of the day (F36)', async () => {
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ prompt: 'What are you grateful for?', source: 'evergreen' }), { status: 200 }));
    await click(byName(render(h.hooks, createElement(JournalModule)), t('journal.personalize')));
    expect(reg.info).toEqual([t('journalModule.personalizingIsUnavailableRightNow')]);
  });
});

describe('subscriptions', () => {
  it('"Mark used today" before Sydney\'s 11am reads back as today, not the future (F13)', async () => {
    // 09:00 on 13 October in Sydney; still the 12th at Greenwich.
    vi.setSystemTime(new Date('2026-10-12T22:00:00Z'));
    h.timeZone = 'Australia/Sydney';
    h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'Australia/Sydney' };
    db.seed('subscriptions_tracked', [{ id: 's1', family_id: FAMILY, name: 'Netflix', cost_cents: 1599, cadence: 'monthly', category: 'Streaming', status: 'active', next_charge: null, last_used: null, note: null }]);
    const screen = () => render(h.hooks, createElement(SubscriptionsModule));
    const mark = nodes(screen()).find((n) => n.type === 'button' && (n.props['aria-label'] === t('subscriptions.markUsedToday') || n.props.title === t('subscriptions.markUsedToday') || text(n).includes(t('subscriptions.markUsedToday'))));
    expect(mark, 'the Mark used today control').toBeTruthy();
    await click(mark!);
    expect(db.table('subscriptions_tracked')[0].last_used).toBe('2026-10-13');
    await refetch('subscriptions_tracked');
    const tree = screen();
    expect(has(tree, t('subscriptionsModule.usage.future'))).toBe(false);
  });
});

describe('rides', () => {
  it('a family past 1,000 rides still sees the one it has today (F40)', async () => {
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    (h.app as Record<string, unknown>).role = 'parent';
    db.seed('rides', Array.from({ length: 1001 }, (_, i) => ({
      id: `past-${String(i).padStart(4, '0')}`, family_id: FAMILY, title: `Old ride ${i}`,
      ride_date: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10), pickup_time: null, dropoff_time: null,
      driver_id: null, rider_ids: [], status: 'completed', pickup_location: null, dropoff_location: null, notes: null,
    })));
    db.seed('rides', [{ id: 'today', family_id: FAMILY, title: 'Practice pickup', ride_date: '2026-10-12', pickup_time: '17:00:00', dropoff_time: null, driver_id: null, rider_ids: [], status: 'planned', pickup_location: null, dropoff_location: null, notes: null }]);
    render(h.hooks, createElement(RidesModule));
    await refetch('rides');
    expect(has(render(h.hooks, createElement(RidesModule)), 'Practice pickup')).toBe(true);
  });
});

describe('habits', () => {
  it('reads every log in its window, not the newest 1,000 (F40)', async () => {
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    const day = (n: number) => new Date(Date.UTC(2026, 9, 12 - n)).toISOString().slice(0, 10);
    db.seed('habits', Array.from({ length: 10 }, (_, k) => ({ id: `h${k}`, family_id: FAMILY, title: `Habit ${k}`, cadence: 'daily', target_per_period: 1, weekdays: null, is_active: true, sort_order: k, color: null, member_id: 'member-1' })));
    const logs: Record<string, unknown>[] = [];
    for (let n = 0; n < 115; n++) logs.push({ id: `a-${n}`, family_id: FAMILY, habit_id: 'h0', member_id: 'member-1', log_date: day(n), count: 1 });
    for (let k = 1; k < 10; k++) for (let n = 0; n < 100; n++) logs.push({ id: `b${k}-${n}`, family_id: FAMILY, habit_id: `h${k}`, member_id: 'member-1', log_date: day(n), count: 1 });
    db.seed('habit_logs', logs);
    // One render pass registers the module's own read. (Its no-deps layout
    // effect re-queues on every pass, so the harness's settle loop never ends.)
    expand(createElement(HabitsModule), h.hooks);
    await refetch('habit_logs');
    expect(h.readErrors.habit_logs).toBeUndefined();
    expect(h.rows.habit_logs).toHaveLength(1015);
  });
});

describe('independence', () => {
  it('a skipped rung is not suggested again (F18)', () => {
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    const kid = { id: 'kid', display_name: 'Kit', role: 'child', birthday: '2018-03-01', color: null };
    const first = suggestMilestones(8, new Set())[0];
    const rows = [{ id: 'r1', family_id: FAMILY, member_id: 'kid', domain: first.domain, title: first.title, status: 'skipped', achieved_at: null, evidence: null, points: first.points, age_band: first.ageBand, description: first.description, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }];
    const tree = render(h.hooks, createElement(IndependenceModule, { kids: [kid], rows: rows as never }));
    expect(has(tree, first.title)).toBe(false);
  });
});

describe('autopilot', () => {
  const card = { family_id: FAMILY, status: 'open', urgency: 2, confidence: 76, action_type: 'review_subscription', action_label: 'Review', detail: 'Heads up.', created_at: '2026-10-12T06:30:00Z', updated_at: '2026-10-12T06:30:00Z', resolved_at: null, resolved_by: null, expires_at: null, created_by: null };

  it('a guest is not listed the household\'s subscription charges; a parent is (F1/F4)', () => {
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    db.seed('autopilot_suggestions', [{ ...card, id: 'sug-1', kind: 'finance', title: '$15.99 charge: Netflix tomorrow', source_kind: 'subscriptions_tracked', source_id: 'sub-1', member_id: null, dedupe_key: 'sub-charge:sub-1:2026-10-13', payload: {} }]);
    (h.app as Record<string, unknown>).role = 'guest';
    h.app.selfMember = { id: 'neighbour', display_name: 'Ned', role: 'guest', is_active: true, color: null, birthday: null, family_id: FAMILY };
    const asGuest = render(h.hooks, createElement(AutopilotModule as (props: { preview?: boolean }) => ReactNode, { preview: true }));
    expect(has(asGuest, 'Netflix')).toBe(false);

    resetHookSlots(h.hooks);
    (h.app as Record<string, unknown>).role = 'parent';
    h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
    expect(has(render(h.hooks, createElement(AutopilotModule as (props: { preview?: boolean }) => ReactNode, { preview: true })), 'Netflix')).toBe(true);
  });
});

describe('auto', () => {
  it('a licence expiring today reads "Renew in 0d" all of a Los Angeles evening (F8)', () => {
    // 17:30 on 12 October in Los Angeles — UTC midnight has passed.
    vi.setSystemTime(new Date('2026-10-13T00:30:00Z'));
    h.timeZone = 'America/Los_Angeles';
    const tree = render(h.hooks, createElement(LicensesClient, {
      licenses: [{ id: 'l1', family_id: FAMILY, holder_name: 'Pat', expires_on: '2026-10-12', state: 'CA', license_class: 'C', license_number: null, member_id: null, notes: null } as never],
      members: [],
    }));
    expect(has(tree, 'Renew in 0d')).toBe(true);
    expect(has(tree, 'Expired')).toBe(false);
  });

  it('a rental\'s edit form shows the pickup on the family\'s clock (F21)', async () => {
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
    h.timeZone = 'America/New_York';
    const rental = { id: 'r1', family_id: FAMILY, company: 'Enterprise', pickup_at: '2026-10-15T05:00:00.000Z', return_at: null, status: 'upcoming', vehicle_desc: null, confirmation_number: null, pickup_location: null, dropoff_location: null, daily_rate: null, total_cost: null, coverage: null, notes: null };
    const screen = () => render(h.hooks, createElement(RentalsClient, { rentals: [rental as never] }));
    await click(byName(screen(), t('rentalsClient.edit')));
    const pickup = nodes(screen()).find((n) => n.type === 'input' && n.props.name === 'pickup_at')!;
    expect(pickup.props.defaultValue).toBe('2026-10-15T01:00');
  });
});
