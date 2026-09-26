// Refreshing a Smart Departure plan must never turn a refused calendar write
// into "this plan has no head-out event".
//
// `upsertHeadOutEvent` (app/(app)/dashboard/trip-intel/actions.ts) returned
// `string | null`, and its UPDATE branch was:
//
//     const { error } = await supabase.from('calendar_events').update(fields)…
//     if (error) return null;
//
// so a refused UPDATE arrived at the caller as the same null that means "there
// is no event". `refreshDeparturePlanAction` wrote that null straight back into
// `departure_plans.reminder_event_id` and returned `{ ok: true }`. The family
// gets the green "Updated with live traffic & weather" toast, the Trip Intel
// card moves to the new leave-by, and the "🚗 Head out for Soccer game" event —
// which is what they actually watch — still sits on the calendar at the OLD
// time, now with nothing pointing at it. The next refresh sees a null link and
// creates a SECOND event beside the stale one; deleting the plan removes only
// the newer copy.
//
// The guard is the one the anniversary toggle already has
// (app/(app)/dashboard/relationship/actions.ts: "the link is only cleared once
// the event is actually gone"): read the error, write nothing, tell the caller.
//
// These drive the real actions with the calendar write failing and require the
// failure to produce a DIFFERENT outcome than a healthy run. Before the fix the
// "writes nothing / reports the failure" cases below failed, because a refused
// calendar write was indistinguishable from a successful one.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Outcome = { data: unknown; error: unknown };

const db = vi.hoisted(() => ({
  /** The stored plan the refresh re-computes, already linked to a head-out event. */
  planRead: { data: null as unknown, error: null as unknown } as Outcome,
  calendarUpdate: { data: null as unknown, error: null as unknown } as Outcome,
  calendarInsert: { data: null as unknown, error: null as unknown } as Outcome,
}));

/** Every write the action actually issued. */
const writes = vi.hoisted(() => ({
  list: [] as { table: string; op: 'insert' | 'update'; values: Record<string, unknown> }[],
}));

function fakeClient() {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    // A bare select settles as the table's read; insert/update re-point it.
    let settle: () => Promise<Outcome> = async () =>
      table === 'departure_plans' ? db.planRead : { data: null, error: null };
    for (const method of ['select', 'eq', 'order', 'limit']) chain[method] = () => chain;
    chain.update = (values: Record<string, unknown>) => {
      writes.list.push({ table, op: 'update', values });
      settle = async () => (table === 'calendar_events' ? db.calendarUpdate : { data: null, error: null });
      return chain;
    };
    chain.insert = (values: Record<string, unknown>) => {
      writes.list.push({ table, op: 'insert', values });
      settle = async () => (table === 'calendar_events' ? db.calendarInsert : { data: { id: 'plan-new' }, error: null });
      return chain;
    };
    chain.maybeSingle = () => settle();
    chain.single = () => settle();
    chain.then = (...args: unknown[]) => settle().then(...(args as [never, never]));
    return chain;
  };
  return { from: builder };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeClient() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtDate: () => '6:03 PM' }) }));

const { refreshDeparturePlanAction, saveDeparturePlanAction } =
  await import('@/app/(app)/dashboard/trip-intel/actions');

// The soccer game, already on the calendar as "🚗 Head out for Soccer game".
const STORED_PLAN = {
  id: 'plan-1',
  title: 'Soccer game',
  event_start: '2026-06-26T19:00:00.000Z',
  prep_minutes: 30,
  park_minutes: 10,
  buffer_minutes: 5,
  destination: 'Riverside Fields',
  origin: 'Home',
  reminder_event_id: 'evt-1',
};

const LIVE = { id: 'plan-1', driveSeconds: 1500, trafficFactor: 1.4, weatherDelayMinutes: 12, weatherSummary: '🌧 Rain, 14°/9°' };

const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

const planWrites = () => writes.list.filter((w) => w.table === 'departure_plans');

beforeEach(() => {
  writes.list.length = 0;
  db.planRead = { data: { ...STORED_PLAN }, error: null };
  db.calendarUpdate = { data: null, error: null };
  db.calendarInsert = { data: { id: 'evt-new' }, error: null };
});

describe('refreshing a departure plan when the head-out event cannot be moved', () => {
  it('writes nothing to the plan when the calendar UPDATE is refused', async () => {
    db.calendarUpdate = { data: null, error: TIMEOUT };

    const result = await refreshDeparturePlanAction(LIVE);

    // The old code wrote { …, reminder_event_id: null } here, cutting the link
    // to an event that is still on the calendar at the old leave-by.
    expect(planWrites(), 'a refused calendar write must not be followed by a plan write').toEqual([]);
    expect(result.ok, 'a refresh that did not reach the calendar is not ok').toBe(false);
  });

  it('reports the refusal to the caller instead of a silent ok', async () => {
    db.calendarUpdate = { data: null, error: { code: '42501', message: 'permission denied for relation calendar_events' } };

    const result = await refreshDeparturePlanAction(LIVE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.length > 0, 'the caller needs something to show').toBe(true);
  });

  // The heart of it: the plan may never be told "there is no head-out event"
  // because the write that would have moved one was refused. That null is what
  // strands the stale event and duplicates it on the next refresh.
  it('never writes a null link over an event that is still on the calendar', async () => {
    db.calendarUpdate = { data: null, error: TIMEOUT };

    await refreshDeparturePlanAction(LIVE);

    expect(
      planWrites().map((w) => w.values.reminder_event_id),
      'evt-1 is still on the calendar; nothing may record that it is not',
    ).not.toContain(null);
  });
});

// Negative controls. Without these, "writes nothing" above would also pass on an
// action that refuses every refresh.
describe('refreshing a departure plan when the calendar accepts the write', () => {
  it('persists the new leave-by and keeps the existing link', async () => {
    const result = await refreshDeparturePlanAction(LIVE);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(planWrites()).toHaveLength(1);
    expect(planWrites()[0].values).toMatchObject({ reminder_event_id: 'evt-1', drive_seconds: 1500 });
  });

  it('links the event it just created for a plan that had none', async () => {
    db.planRead = { data: { ...STORED_PLAN, reminder_event_id: null }, error: null };

    const result = await refreshDeparturePlanAction(LIVE);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(planWrites()[0].values).toMatchObject({ reminder_event_id: 'evt-new' });
  });
});

describe('saving a departure plan when the head-out event cannot be created', () => {
  const NEW_PLAN = {
    title: 'Soccer game',
    eventStart: '2026-06-26T19:00:00.000Z',
    origin: 'Home',
    destination: 'Riverside Fields',
    prepMinutes: 30,
    parkMinutes: 10,
    bufferMinutes: 5,
    driveSeconds: 1200,
    trafficFactor: 1,
    weatherDelayMinutes: 0,
  };

  it('does not save a plan whose calendar INSERT was refused', async () => {
    db.calendarInsert = { data: null, error: TIMEOUT };

    const result = await saveDeparturePlanAction(NEW_PLAN);

    // An INSERT that errored may still have landed; storing the plan with a null
    // link strands that event and duplicates it on the first refresh.
    expect(planWrites()).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('still saves the plan with its link when the calendar accepts', async () => {
    const result = await saveDeparturePlanAction(NEW_PLAN);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(planWrites()[0].values).toMatchObject({ reminder_event_id: 'evt-new', title: 'Soccer game' });
  });
});
