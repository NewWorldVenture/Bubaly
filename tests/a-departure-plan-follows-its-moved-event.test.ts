// A Smart Departure follows the event it was planned for (N7).
//
// `departure_plans.event_start` is a copy of the event's start, taken when the
// plan was saved, and the plan's "🚗 Head out" calendar event sits at the
// leave-by computed from it. Moving the game from Saturday 10:00 to Sunday
// 14:00 changed only calendar_events: the head-out reminder stayed on Saturday
// morning (and was pushed by the notifications run), the Trip Intel card still
// said "arrive by Saturday 10:00", and Refresh recomputed from the stale copy
// and wrote the head-out back onto Saturday.
//
// Driven through the real calendar edit action, the real conflict quick fix,
// the assistant's real calendar tools (which the week planner runs too) and the
// real Trip Intel refresh against an in-memory database. The calendar service
// is where every one of them writes the move, so that is where the plan
// follows it: once per move, whoever made it.
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

const { updateCalendarEventAction } = await import('@/app/(app)/dashboard/calendar/actions');
const { rescheduleEventAction } = await import('@/app/(app)/dashboard/conflicts/actions');
const { refreshDeparturePlanAction } = await import('@/app/(app)/dashboard/trip-intel/actions');
const { calendarTools } = await import('@/lib/ai/tools/calendar');
const { planWeekTemplate } = await import('@/lib/ai/planner/templates/plan-week');

const GAME = '50000000-0000-4000-8000-000000000001';
const HEAD_OUT = '50000000-0000-4000-8000-000000000002';
const PLAN = '50000000-0000-4000-8000-000000000003';
// Saturday 17 October 10:00 New York, and the leave-by its plan computed:
// 25 min drive ×1.0 + 0 weather + 10 park + 5 buffer = 40 min before → 09:20.
const SATURDAY = '2026-10-17T14:00:00.000Z';
const SATURDAY_LEAVE = '2026-10-17T13:20:00.000Z';
// Sunday 18 October 14:00 New York.
const SUNDAY = '2026-10-18T18:00:00.000Z';
const SUNDAY_LEAVE = '2026-10-18T17:20:00.000Z';
let db: InMemorySupabase;

const calendarRow = (id: string, extra: Record<string, unknown>) => ({
  id, family_id: 'fam-1', title: 'Soccer game', description: null, location: 'City Fields', category: 'sports',
  starts_at: SATURDAY, ends_at: '2026-10-17T15:30:00.000Z', all_day: false, recurrence: 'none', recurrence_until: null,
  assignee_id: null, feed_id: null, external_uid: null, created_by: 'user-1', idempotency_key: null,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...extra,
});
const plan = () => db.table('departure_plans').find((r) => r.id === PLAN)!;
const headOut = () => db.table('calendar_events').find((r) => r.id === HEAD_OUT)!;
const ms = (value: unknown) => Date.parse(String(value));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
  db = createInMemorySupabase();
  h.db = db;
  db.seed('calendar_events', [
    calendarRow(GAME, {}),
    calendarRow(HEAD_OUT, { title: '🚗 Head out for Soccer game', starts_at: SATURDAY_LEAVE, ends_at: '2026-10-17T13:25:00.000Z', category: 'general', location: 'Home' }),
  ]);
  db.seed('departure_plans', [{
    id: PLAN, family_id: 'fam-1', created_by: 'user-1', event_id: GAME, reminder_event_id: HEAD_OUT, title: 'Soccer game',
    origin: 'Home', destination: 'City Fields', event_start: SATURDAY, prep_minutes: 30, park_minutes: 10, buffer_minutes: 5,
    drive_seconds: 1500, traffic_factor: 1, weather_delay_minutes: 0, weather_summary: null, leave_by: SATURDAY_LEAVE,
    last_checked_at: '2026-10-10T00:00:00.000Z', status: 'active',
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('moving an event moves the departure planned for it', () => {
  it('the calendar editor moving the game to Sunday moves the plan and its head-out reminder', async () => {
    const res = await updateCalendarEventAction(GAME, { startsAt: SUNDAY, endsAt: '2026-10-18T19:30:00.000Z' });
    expect(res).toMatchObject({ ok: true });
    expect(ms(plan().event_start)).toBe(ms(SUNDAY));
    expect(ms(plan().leave_by)).toBe(ms(SUNDAY_LEAVE));
    expect(ms(headOut().starts_at)).toBe(ms(SUNDAY_LEAVE));
    expect(ms(headOut().ends_at)).toBe(ms(SUNDAY_LEAVE) + 5 * 60_000);
  });

  it('a conflict quick fix moving it does the same', async () => {
    const res = await rescheduleEventAction(GAME, SUNDAY, '2026-10-18T19:30:00.000Z');
    expect(res).toMatchObject({ ok: true });
    expect(ms(plan().event_start)).toBe(ms(SUNDAY));
    expect(ms(headOut().starts_at)).toBe(ms(SUNDAY_LEAVE));
  });

  it('a title edit leaves the plan where it was', async () => {
    const res = await updateCalendarEventAction(GAME, { title: 'Soccer final' });
    expect(res).toMatchObject({ ok: true });
    expect(ms(plan().event_start)).toBe(ms(SATURDAY));
    expect(ms(headOut().starts_at)).toBe(ms(SATURDAY_LEAVE));
  });
});

describe('the assistant and the week planner moving it', () => {
  // N7: the assistant's tools wrote the move through the calendar service and
  // nothing followed it, so the head-out reminder stayed on Saturday morning and
  // the notifications run pushed it there.
  const assistant = () => ({
    db: db as never, familyId: 'fam-1', userId: 'user-1', memberId: 'mom', role: 'parent' as const,
    actorKind: 'ai' as const, tz: 'America/New_York',
  });
  const tool = (name: string) => {
    const found = calendarTools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };

  it('calendar.rescheduleEvent moves the plan and its head-out reminder', async () => {
    const res = await tool('calendar.rescheduleEvent').execute(assistant(), { event_id: GAME, starts_at: SUNDAY });
    expect(res).toMatchObject({ ok: true });
    expect(ms(plan().event_start)).toBe(ms(SUNDAY));
    expect(ms(plan().leave_by)).toBe(ms(SUNDAY_LEAVE));
    expect(ms(headOut().starts_at)).toBe(ms(SUNDAY_LEAVE));
    expect(ms(headOut().ends_at)).toBe(ms(SUNDAY_LEAVE) + 5 * 60_000);
  });

  it('calendar.updateEvent with a new start does the same', async () => {
    const res = await tool('calendar.updateEvent').execute(assistant(), { event_id: GAME, starts_at: SUNDAY, ends_at: '2026-10-18T19:30:00.000Z' });
    expect(res).toMatchObject({ ok: true });
    expect(ms(plan().event_start)).toBe(ms(SUNDAY));
    expect(ms(plan().leave_by)).toBe(ms(SUNDAY_LEAVE));
    expect(ms(headOut().starts_at)).toBe(ms(SUNDAY_LEAVE));
  });

  it('calendar.updateEvent changing only the title leaves the plan where it was', async () => {
    const res = await tool('calendar.updateEvent').execute(assistant(), { event_id: GAME, title: 'Soccer final' });
    expect(res).toMatchObject({ ok: true });
    expect(ms(plan().event_start)).toBe(ms(SATURDAY));
    expect(ms(headOut().starts_at)).toBe(ms(SATURDAY_LEAVE));
  });

  it("the week planner's reschedule step is that tool, so a planner run's move is followed too", async () => {
    const step = planWeekTemplate.steps.find((s) => s.key === 'reschedule');
    expect(step?.toolName).toBe('calendar.rescheduleEvent');
    const res = await tool(step!.toolName!).execute({ ...assistant(), role: 'system' as const, actorKind: 'system' as const, userId: null, memberId: null }, { event_id: GAME, starts_at: SUNDAY });
    expect(res).toMatchObject({ ok: true });
    expect(ms(plan().event_start)).toBe(ms(SUNDAY));
    expect(ms(headOut().starts_at)).toBe(ms(SUNDAY_LEAVE));
  });

  it('a move the calendar refused moves no plan', async () => {
    // Another family's id: the service finds nothing to move.
    const res = await tool('calendar.rescheduleEvent').execute({ ...assistant(), familyId: 'fam-2' }, { event_id: GAME, starts_at: SUNDAY });
    expect(res).toMatchObject({ ok: false });
    expect(ms(plan().event_start)).toBe(ms(SATURDAY));
    expect(ms(headOut().starts_at)).toBe(ms(SATURDAY_LEAVE));
  });
});

describe('Refresh plans from where the event is now', () => {
  it('an event moved by a path that did not follow it is re-planned from its current start', async () => {
    // Moved directly (an import, an older client): the plan still holds Saturday.
    const { data } = await db.from('calendar_events').update({ starts_at: SUNDAY, ends_at: '2026-10-18T19:30:00.000Z' })
      .eq('id', GAME).eq('family_id', 'fam-1').select('id');
    expect(data).toHaveLength(1);

    const res = await refreshDeparturePlanAction({ id: PLAN, driveSeconds: 1500, trafficFactor: 1, weatherDelayMinutes: 0 });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(ms(res.data?.leaveBy)).toBe(ms(SUNDAY_LEAVE));
    expect(ms(plan().event_start)).toBe(ms(SUNDAY));
    expect(ms(headOut().starts_at)).toBe(ms(SUNDAY_LEAVE));
  });
});
