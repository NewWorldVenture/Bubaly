// The event detail's "Schedule check" reads the OCCURRENCE the family opened.
//
// N6/N10: a recurring event is stored once, at its first week. The check took
// that stored start and read calendar_events by stored `starts_at` around it,
// so for an ongoing weekly practice it checked a week months past, dropped it
// as ended, and printed "No conflicts found" — while the same child was double
// booked on the week on screen. And no one-off was ever checked against a
// series on its own day, because the series row's start was not in the window.
//
// Driven through the real server action and the real loader against an
// in-memory database.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mom' }, family: { name: 'Fixture', timezone: 'America/New_York' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { eventScheduleInsightsAction } = await import('@/app/(app)/dashboard/calendar/actions');
const { loadScheduleIntelligence } = await import('@/lib/schedule/intelligence-server');

const SERIES = '40000000-0000-4000-8000-000000000001';
const ONE_OFF = '40000000-0000-4000-8000-000000000002';
let db: InMemorySupabase;

function event(id: string, extra: Record<string, unknown>) {
  return {
    id, family_id: 'fam-1', title: 'Event', description: null, location: null, category: 'sports',
    starts_at: '2026-08-04T21:00:00.000Z', ends_at: '2026-08-04T22:30:00.000Z', all_day: false,
    recurrence: 'none', recurrence_until: null, assignee_id: 'kid', feed_id: null, external_uid: null,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  db = createInMemorySupabase();
  h.db = db;
  db.seed('family_members', [
    { id: 'mom', family_id: 'fam-1', display_name: 'Maria', role: 'parent', is_active: true },
    { id: 'kid', family_id: 'fam-1', display_name: 'Emma', role: 'child', is_active: true },
  ]);
  db.seed('calendar_events', [
    // A weekly Tuesday practice that began in August, 17:00 New York.
    event(SERIES, { title: 'Soccer practice', recurrence: 'weekly' }),
    // Emma's piano lesson on Tuesday 13 October, over that week's practice.
    event(ONE_OFF, { title: 'Piano lesson', category: 'general', starts_at: '2026-10-13T21:30:00.000Z', ends_at: '2026-10-13T22:15:00.000Z' }),
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Schedule check of a recurring event', () => {
  it('checks the week that was opened: Emma is double booked on 13 October', async () => {
    const res = await eventScheduleInsightsAction(SERIES, '2026-10-13T21:00:00.000Z');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.insights.map((i) => i.kind)).toContain('double_booking');
    expect(res.insights.find((i) => i.kind === 'double_booking')?.params).toMatchObject({ other: 'Piano lesson', title: 'Soccer practice' });
  });

  it('checks a one-off against the series week on its own day', async () => {
    const res = await eventScheduleInsightsAction(ONE_OFF, '2026-10-13T21:30:00.000Z');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.insights.map((i) => i.kind)).toContain('double_booking');
  });

  it('a week the series does not have is refused, not checked', async () => {
    const res = await eventScheduleInsightsAction(SERIES, '2026-10-14T21:00:00.000Z');
    expect(res.ok).toBe(false);
  });

  it('a week without a clash is checked and found clear', async () => {
    const res = await eventScheduleInsightsAction(SERIES, '2026-10-20T21:00:00.000Z');
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.insights.map((i) => i.kind)).not.toContain('double_booking');
  });

  it('the loader itself sees the series week in a window its stored start is not in', async () => {
    const res = await loadScheduleIntelligence(db as never, {
      familyId: 'fam-1', tz: 'America/New_York', now: new Date(),
      fromMs: Date.parse('2026-10-13T04:00:00.000Z'), toMs: Date.parse('2026-10-14T04:00:00.000Z'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.events.filter((e) => e.eventId === SERIES).map((e) => e.startsAt)).toEqual(['2026-10-13T21:00:00.000Z']);
  });
});
