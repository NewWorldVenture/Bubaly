import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';

// N3-S1 — the Family Command Center, the REAL server page, against an
// in-memory database whose responses stop at 1,000 rows like PostgREST's
// db-max-rows.
//
// It ran /dashboard/conflicts' check on its own read of raw calendar rows by
// `starts_at`, between now and the end of the week. A recurring event is ONE
// row whose `starts_at` is its first occurrence (lib/calendar/occurrences.ts),
// so a weekly practice created last month was never read and a one-off booked
// over it was not a clash; and the unlimited read stopped at the server's cap
// without a word. Either way the page then said "Everything looks handled for
// the week."

const FAMILY = 'ours';
const NY = 'America/New_York';
/** Wednesday 14 October 2026, noon in New York. */
const NOW = new Date('2026-10-14T16:00:00.000Z');
const WEEK = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = { user: { id: 'me' }, active: { familyId: 'ours', role: 'parent', member: { id: 'member', role: 'parent', display_name: 'Pat' }, family: { timezone: 'America/New_York' } } };
  return { requireUserContext: async () => ctx, requireFeature: async () => ctx };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr, getMessages } = await import('@/lib/i18n/messages');
  const { DEFAULT_LOCALE, localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault(DEFAULT_LOCALE), source: 'default', messages: getMessages(DEFAULT_LOCALE) }),
  };
});
vi.mock('@/lib/operating-index/server', () => ({ loadOperatingIndex: async () => ({ change: null }) }));

const { default: CommandCenter } = await import('@/app/(app)/dashboard/command-center/page');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const ALL_CLEAR = 'Everything looks handled for the week.';
let db: InMemorySupabase;

/** Every string the page's own markup carries, without rendering its components. */
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  return textOf(node.props.children);
}
const page = async () => textOf(await CommandCenter());

/** The week list's rows: each <li> with its React key and its own text. */
function rows(node: ReactNode, out: { key: string | null; text: string }[] = []) {
  if (Array.isArray(node)) { node.forEach((child) => rows(child, out)); return out; }
  if (!isValidElement<{ children?: ReactNode }>(node)) return out;
  if (node.type === 'li') out.push({ key: node.key, text: textOf(node.props.children) });
  else rows(node.props.children, out);
  return out;
}

const event = (row: Record<string, unknown>) => ({
  family_id: FAMILY, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: 'member', ends_at: null, ...row,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // A household with nothing else outstanding: every dinner planned, no
  // chores overdue, no documents expiring — the all-clear rests on the calendar.
  db.seed('family_members', [{ id: 'member', family_id: FAMILY, display_name: 'Pat', color: null, is_active: true }]);
  db.seed('meal_plans', WEEK.map((day) => ({ id: `dinner-${day}`, family_id: FAMILY, plan_date: day, meal_type: 'dinner' })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Command Center checks every occurrence in the week', () => {
  it('flags a one-off booked over a weekly practice created last month', async () => {
    db.seed('calendar_events', [
      // Wednesdays 17:00–18:00 in New York since 2 September.
      event({ id: 'swim', title: 'Swim practice', starts_at: '2026-09-02T21:00:00.000Z', ends_at: '2026-09-02T22:00:00.000Z', recurrence: 'weekly' }),
      // Today, 17:30–18:15.
      event({ id: 'dentist', title: 'Dentist', starts_at: '2026-10-14T21:30:00.000Z', ends_at: '2026-10-14T22:15:00.000Z' }),
    ]);
    const text = await page();
    expect(text).toContain('Schedule conflict: “Swim practice” overlaps “Dentist”');
    expect(text).not.toContain(ALL_CLEAR);
    expect(text).not.toContain(t('dashboardCommandCenter.noConflictsOrGapsDetectedThis'));
  });

  it('says so when the week is too full to check whole, instead of the all-clear', async () => {
    // 1,001 all-day events, every one assigned and none a clash: past the
    // server's 1,000-row cap and past the 500 the check reads.
    db.seed('calendar_events', Array.from({ length: 1001 }, (_, i) => event({
      id: `e-${String(i).padStart(4, '0')}`, title: `Day ${i}`, all_day: true, starts_at: `${WEEK[i % 7]}T00:00:00.000Z`,
    })));
    const text = await page();
    expect(text).toContain(t('commandCenter.onlyTheFirstEventsWereChecked', { count: 500 }));
    expect(text).not.toContain(ALL_CLEAR);
    expect(text).not.toContain(t('dashboardCommandCenter.noConflictsOrGapsDetectedThis'));
  });

  it('does not give the all-clear over a calendar it could not read', async () => {
    h.db = withFaults(db, (table) => (table === 'calendar_events' ? { message: 'Fixture read refused' } : null));
    const text = await page();
    expect(text).toContain(t('conflicts.couldNotCheckForClashes'));
    expect(text).not.toContain(ALL_CLEAR);
    expect(text).not.toContain(t('dashboardCommandCenter.noConflictsOrGapsDetectedThis'));
  });

  it('badges only the occurrence of a daily series that clashes, and keys each occurrence apart', async () => {
    db.seed('calendar_events', [
      // Daily 08:00–08:30 in New York since 1 September.
      event({ id: 'school-run', title: 'School run', starts_at: '2026-09-01T12:00:00.000Z', ends_at: '2026-09-01T12:30:00.000Z', recurrence: 'daily' }),
      // Thursday 08:15–08:45.
      event({ id: 'call', title: 'Call', starts_at: '2026-10-15T12:15:00.000Z', ends_at: '2026-10-15T12:45:00.000Z' }),
    ]);
    const week = rows(await CommandCenter());
    const schoolRuns = week.filter((row) => row.text.includes('School run'));
    expect(schoolRuns.length).toBeGreaterThan(1);
    expect(new Set(week.map((row) => row.key)).size).toBe(week.length);
    const badged = week.filter((row) => row.text.includes(t('commandCenter.conflict')));
    // The Thursday school run and the call it overlaps; no other day's run.
    expect(badged.map((row) => row.key)).toEqual(['school-run@2026-10-15T12:00:00.000Z', 'call@2026-10-15T12:15:00.000Z']);
  });

  it('a quiet week read whole still gets the all-clear', async () => {
    db.seed('calendar_events', [
      event({ id: 'swim', title: 'Swim practice', starts_at: '2026-09-02T21:00:00.000Z', ends_at: '2026-09-02T22:00:00.000Z', recurrence: 'weekly' }),
      event({ id: 'lunch', title: 'Lunch', starts_at: '2026-10-15T16:00:00.000Z', ends_at: '2026-10-15T17:00:00.000Z' }),
    ]);
    const text = await page();
    expect(text).toContain(ALL_CLEAR);
    expect(text).toContain(t('dashboardCommandCenter.noConflictsOrGapsDetectedThis'));
    expect(text).not.toContain(t('commandCenter.onlyTheFirstEventsWereChecked', { count: 500 }));
  });
});
