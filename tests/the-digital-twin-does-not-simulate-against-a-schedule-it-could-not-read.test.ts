// N3 — the Decision Simulator answered "fits cleanly / no conflicts" when the
// calendar read failed. The commitment path kept only `{ data }` from
// readCalendarOccurrences, and the activity projection did the same with its
// calendar and vacations reads, so a failed read became an empty schedule and
// every what-if fitted. The spend path in the same file already refused to
// guess when its own read failed.
//
// Both server actions driven for real against the in-memory database, with the
// one read under test answering an error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { id: 'family-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US') }),
  };
});

const { simulateDecisionAction, projectActivityAction } = await import('@/app/(app)/dashboard/family-digital-twin/actions');

const COULD_NOT_READ = 'Could not read the calendar and trips, so a clash check would be a guess.';
let db: InMemorySupabase;
let failing: string | null;

const commitment = () => simulateDecisionAction({
  kind: 'commitment', memberId: 'member-2', memberName: 'Emma', title: 'Piano lesson',
  startsAt: '2026-10-15T17:00:00Z', durationMin: 60, weeks: 4,
});
const activity = () => projectActivityAction({
  memberId: 'member-2', memberName: 'Emma', activityName: 'Travel soccer',
  startsAt: '2026-10-17T10:00:00Z', durationMin: 90, sessionsPerWeek: 1, weeks: 4,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  failing = null;
  harness.db = withFaults(db, (table) => (table === failing ? { message: 'canceling statement due to statement timeout', code: '57014' } : null));
  // Emma is already at gymnastics exactly when the piano lesson would start.
  db.seed('calendar_events', [{
    id: 'ev-1', family_id: FAMILY, title: 'Gymnastics', starts_at: '2026-10-15T16:30:00Z', ends_at: '2026-10-15T18:00:00Z',
    all_day: false, assignee_id: 'member-2', recurrence: 'none', recurrence_until: null,
  }]);
  db.seed('vacations', [{ id: 'vac-1', family_id: FAMILY, title: 'Half-term trip', start_date: '2026-10-16', end_date: '2026-10-20' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the commitment simulation', () => {
  it('sees the clash when the calendar is read', async () => {
    const result = await commitment();
    expect(result.verdict).not.toBe('clear');
  });

  it('refuses to answer "fits cleanly" when the calendar read fails', async () => {
    failing = 'calendar_events';
    const result = await commitment();
    expect(result.verdict).toBe('conflict');
    expect(result.headline).toBe(COULD_NOT_READ);
    expect(result.impacts).toEqual([{ severity: 'blocker', title: 'Schedule unavailable' }]);
  });
});

describe('the activity projection', () => {
  it('projects against the schedule and the trips it read', async () => {
    const result = await activity();
    expect(result.ok).toBe(true);
  });

  it.each(['calendar_events', 'vacations'])('refuses to project when the %s read fails', async (table) => {
    failing = table;
    const result = await activity();
    expect(result).toEqual({ ok: false, error: COULD_NOT_READ });
  });
});
