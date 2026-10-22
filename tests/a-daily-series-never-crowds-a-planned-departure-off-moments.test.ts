// A daily series never crowds a planned departure off the Moments page (R1).
//
// The schedule loader reads events through the shared occurrence reader, so a
// recurring series arrives once per occurrence in the window. Its
// `eventLimit` used to cut that merged list, and Moments asks for 24 over 30
// days: two daily series fill 24 slots in under two weeks. A one-off planned
// 18 days out was cut from the model without anyone being told, and with it
// the departure it had a plan for. The page then showed the category buffer
// instead of the saved "Leave by", as if no plan had been made.
//
// The cap is for one-off events now. A series is read whole. A window that
// holds more occurrences than the model reads is refused, never answered with
// a shorter list. Driven through the real page and the real loader against an
// in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam-1';
const TZ = 'America/New_York';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  view: { props: null as null | { departures?: Record<string, { leaveByISO: string; travelMinutes: number }> | null; departuresFailed?: boolean } },
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: {} }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// The view is a client component; what the page hands it is the subject here.
vi.mock('@/components/moments/moments-view', () => ({
  MomentsView: (props: typeof mocks.view.props) => { mocks.view.props = props; return null; },
}));
vi.mock('@/components/moments/moment-organizer', () => ({ MomentOrganizer: () => null }));

const MomentsPage = (await import('@/app/(app)/dashboard/moments/page')).default;
const { loadScheduleIntelligence } = await import('@/lib/schedule/intelligence-server');

const TOURNAMENT = '60000000-0000-4000-8000-000000000001';
const DROP_OFF = '60000000-0000-4000-8000-000000000002';
const PRACTICE = '60000000-0000-4000-8000-000000000003';
// Sunday 1 November 10:00 New York, 18 days after the page is opened.
const TOURNAMENT_AT = '2026-11-01T15:00:00.000Z';
// Its plan: 25 min drive × 1.0 + 10 park + 5 buffer = 40 minutes before.
const TOURNAMENT_LEAVE = '2026-11-01T14:20:00.000Z';

let db: InMemorySupabase;

const event = (id: string, extra: Record<string, unknown>) => ({
  id, family_id: FAMILY, title: 'Event', description: null, location: null, category: 'general',
  starts_at: '2026-09-01T11:30:00.000Z', ends_at: '2026-09-01T12:00:00.000Z', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: 'kid', feed_id: null, external_uid: null,
  created_by: 'user-1', created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z', ...extra,
});
const dailySeries = (id: string, title: string, startsAt: string, endsAt: string) =>
  event(id, { title, starts_at: startsAt, ends_at: endsAt, recurrence: 'daily' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.view.props = null;
  db = createInMemorySupabase({ maxRows: 1000 });
  db.seed('family_members', [
    { id: 'mom', family_id: FAMILY, display_name: 'Maria', role: 'parent', is_active: true, birthday: null },
    { id: 'kid', family_id: FAMILY, display_name: 'Emma', role: 'child', is_active: true, birthday: null },
  ]);
  db.seed('calendar_events', [
    // Two daily series that began in September: 07:30 drop-off and 17:00 practice.
    dailySeries(DROP_OFF, 'School drop-off', '2026-09-01T11:30:00.000Z', '2026-09-01T12:00:00.000Z'),
    dailySeries(PRACTICE, 'Practice', '2026-09-01T21:00:00.000Z', '2026-09-01T22:30:00.000Z'),
    event(TOURNAMENT, { title: 'Tournament', category: 'sports', location: 'County Park', starts_at: TOURNAMENT_AT, ends_at: '2026-11-01T19:00:00.000Z' }),
  ]);
  db.seed('departure_plans', [{
    id: '60000000-0000-4000-8000-0000000000aa', family_id: FAMILY, created_by: 'user-1', event_id: TOURNAMENT,
    reminder_event_id: null, title: 'Tournament', origin: 'Home', destination: 'County Park', event_start: TOURNAMENT_AT,
    prep_minutes: 30, park_minutes: 10, buffer_minutes: 5, drive_seconds: 1500, traffic_factor: 1, weather_delay_minutes: 0,
    weather_summary: null, leave_by: TOURNAMENT_LEAVE, last_checked_at: '2026-10-10T00:00:00.000Z', status: 'active',
    updated_at: '2026-10-10T00:00:00.000Z',
  }]);
  mocks.createServer.mockResolvedValue(db);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1', email: 'parent@example.com' }, memberships: [],
    active: { familyId: FAMILY, family: { id: FAMILY, timezone: TZ }, role: 'parent', member: { id: 'mom' } },
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const open = async () => {
  renderToStaticMarkup((await MomentsPage()) as React.ReactElement);
  expect(mocks.view.props).not.toBeNull();
  return mocks.view.props!;
};

describe('the Moments page with two daily series', () => {
  it('still hands the view the planned departure of a one-off 18 days out', async () => {
    const props = await open();
    expect(props.departuresFailed).toBe(false);
    expect(props.departures?.[TOURNAMENT]).toEqual({ leaveByISO: TOURNAMENT_LEAVE, travelMinutes: 40 });
  });

  it('the loader holds every series occurrence in the window and the one-off', async () => {
    const res = await loadScheduleIntelligence(db as never, {
      familyId: FAMILY, tz: TZ, now: new Date(), fromMs: Date.now(), horizonDays: 30, eventLimit: 24,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.data.events.map((e) => e.eventId);
    // Every day of each series in the 30 days, so neither one used up the cap:
    // 15 October to 12 November for the 07:30 drop-off (today's has passed),
    // 14 October to 12 November for the 17:00 practice.
    expect(ids.filter((id) => id === DROP_OFF)).toHaveLength(29);
    expect(ids.filter((id) => id === PRACTICE)).toHaveLength(30);
    expect(ids).toContain(TOURNAMENT);
    expect(res.data.departures[TOURNAMENT]).toMatchObject({ leaveByISO: TOURNAMENT_LEAVE, source: 'drive_time' });
  });
});

describe('the one-off cap', () => {
  it('reads the earliest one-offs and leaves out everything from the first one it did not read', async () => {
    // 26 one-offs, one a day at noon New York, from tomorrow; the cap is 24.
    db.replace('calendar_events', [
      dailySeries(PRACTICE, 'Practice', '2026-09-01T21:00:00.000Z', '2026-09-01T22:30:00.000Z'),
      ...Array.from({ length: 26 }, (_, i) => event(`61000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, {
        title: `Errand ${i + 1}`, starts_at: new Date(Date.parse('2026-10-15T16:00:00.000Z') + i * 86_400_000).toISOString(),
        ends_at: new Date(Date.parse('2026-10-15T16:30:00.000Z') + i * 86_400_000).toISOString(),
      })),
    ]);
    const res = await loadScheduleIntelligence(db as never, {
      familyId: FAMILY, tz: TZ, now: new Date(), fromMs: Date.now(), horizonDays: 30, eventLimit: 24,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const oneOffs = res.data.events.filter((e) => e.eventId !== PRACTICE);
    expect(oneOffs).toHaveLength(24);
    // The 25th errand was not read, so no practice from its start on is answered
    // for: it could clash with that errand and the model would call it clear.
    const firstUnread = Date.parse('2026-10-15T16:00:00.000Z') + 24 * 86_400_000;
    const practices = res.data.events.filter((e) => e.eventId === PRACTICE);
    expect(practices.length).toBeGreaterThan(20);
    expect(practices.every((e) => Date.parse(e.startsAt) < firstUnread)).toBe(true);
  });
});

describe('a window with more occurrences than the model reads', () => {
  beforeEach(() => {
    // 70 daily series: more than 2,000 occurrences in 30 days.
    db.replace('calendar_events', [
      ...Array.from({ length: 70 }, (_, i) => dailySeries(`62000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, `Series ${i + 1}`,
        new Date(Date.parse('2026-09-01T11:00:00.000Z') + i * 60_000).toISOString(),
        new Date(Date.parse('2026-09-01T11:10:00.000Z') + i * 60_000).toISOString())),
      event(TOURNAMENT, { title: 'Tournament', category: 'sports', location: 'County Park', starts_at: TOURNAMENT_AT, ends_at: '2026-11-01T19:00:00.000Z' }),
    ]);
  });

  it('is refused by the loader, never answered with a shorter list', async () => {
    const res = await loadScheduleIntelligence(db as never, {
      familyId: FAMILY, tz: TZ, now: new Date(), fromMs: Date.now(), horizonDays: 30, eventLimit: 24,
    });
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect(console.error).toHaveBeenCalledWith('[schedule] calendar events read failed', expect.anything());
  });

  it('tells the Moments view its departures could not be read', async () => {
    const props = await open();
    expect(props.departuresFailed).toBe(true);
    expect(props.departures).toEqual({});
  });
});
