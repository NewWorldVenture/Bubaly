// The six calendar EVENT actions (app/(app)/dashboard/calendar/actions.ts),
// called the way the calendar module calls them, by every role of one
// household, with a second household beside it.
//
// WHERE THE POLICY COMES FROM. The actions add no role check of their own: they
// build a ServiceScope from the session (family from the SESSION, never from
// the browser) and hand it to lib/services/calendar, which filters every read,
// update and delete on `family_id` and checks an assignee belongs to the
// caller's family. The role boundary is the database's:
//
//   - 01050 / 0339: calendar_events select, insert, update and delete are
//     `is_family_member(family_id)`; 0339 adds a RESTRICTIVE insert guard
//     (`created_by is null or created_by = auth.uid() or can_manage_family`).
//   - 0464: a BEFORE INSERT/UPDATE/DELETE trigger refuses (42501) a caller whose
//     role in the row's family is `guest` — "a guest views the household; it
//     does not rewrite it". Its header leaves children, teens and caregivers
//     open on purpose (ROLE-SCOPE-001).
//   - lib/trust/engine.ts: teen view/create/edit, child view/create, caregiver
//     view/create/edit, guest view — agreeing with the database on creating,
//     and on a guest; NOT agreeing on a child's edit or on deletes by a teen,
//     child or caregiver (the database lets them; the engine does not list
//     the capability). Those combinations are left unpinned here and reported
//     as an owner decision.
//   - lib/auth/guest-scope.ts keeps the calendar open to a guest (to read).
//
// The in-memory client has no triggers, so 0464 is modelled the way Postgres
// answers it — `{ data: null, error: 42501 }` on a write — for a guest caller
// only. What that pins is the action's half: a refused write is reported as a
// refusal, nothing lands, and the page is not revalidated.
//
// A cross-family id is the other boundary these cases pin. The in-memory
// client applies no RLS either, so a household-B id reaching a household-B row
// here is exactly what the service's own `family_id` filter must stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { syntheticChildEmail } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const {
  applyRoutineToCalendarAction, createCalendarEventAction, deleteCalendarEventAction,
  eventScheduleInsightsAction, undoCalendarEventsAction, updateCalendarEventAction,
} = await import('@/app/(app)/dashboard/calendar/actions');

const FAM_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAM_B = 'bbbbbbbb-0000-4000-8000-000000000001';

type Who = 'parent' | 'adult' | 'teen' | 'child' | 'kidLogin' | 'caregiver' | 'guest';
const ROLE_OF: Record<Who, string> = {
  parent: 'parent', adult: 'adult', teen: 'teen', child: 'child', kidLogin: 'child', caregiver: 'caregiver', guest: 'guest',
};
const MEMBER: Record<Who, string> = {
  parent: 'a0000000-0000-4000-8000-000000000001',
  adult: 'a0000000-0000-4000-8000-000000000002',
  teen: 'a0000000-0000-4000-8000-000000000003',
  child: 'a0000000-0000-4000-8000-000000000004',
  kidLogin: 'a0000000-0000-4000-8000-000000000005',
  caregiver: 'a0000000-0000-4000-8000-000000000006',
  guest: 'a0000000-0000-4000-8000-000000000007',
};
const USER: Record<Who, string> = {
  parent: 'c0000000-0000-4000-8000-000000000001',
  adult: 'c0000000-0000-4000-8000-000000000002',
  teen: 'c0000000-0000-4000-8000-000000000003',
  child: 'c0000000-0000-4000-8000-000000000004',
  kidLogin: 'c0000000-0000-4000-8000-000000000005',
  caregiver: 'c0000000-0000-4000-8000-000000000006',
  guest: 'c0000000-0000-4000-8000-000000000007',
};
const B_PARENT = 'b0000000-0000-4000-8000-000000000001';
const B_KID = 'b0000000-0000-4000-8000-000000000002';

const EVENT_A = 'e0000000-0000-4000-8000-00000000000a';
const EVENT_A2 = 'e0000000-0000-4000-8000-00000000000b';
const EVENT_B = 'e0000000-0000-4000-8000-0000000000b1';

const SUBMISSION = '11111111-1111-4111-8111-111111111111';
const PERMISSION = /permission/i;
const NOT_FOUND = 'That event could not be found.';
const PATH = '/dashboard/calendar';

let db: InMemorySupabase;
let caller: Who | null = null;

function signedInAs(who: Who) {
  caller = who;
  mocks.requireUserContext.mockResolvedValue({
    user: { id: USER[who], email: who === 'kidLogin' ? syntheticChildEmail('mia') : `${who}@example.com` },
    memberships: [],
    active: {
      familyId: FAM_A,
      family: { id: FAM_A, name: 'Household A', timezone: 'America/New_York' },
      role: ROLE_OF[who],
      member: { id: MEMBER[who], family_id: FAM_A, role: ROLE_OF[who] },
    },
  });
}

/** requireUserContext sends a signed-out caller to /login by throwing a redirect. */
function signedOut() {
  caller = null;
  mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;replace;/login'));
}

function event(id: string, familyId: string, extra: Record<string, unknown> = {}) {
  return {
    id, family_id: familyId, title: 'Event', description: null, location: null, category: 'general',
    starts_at: '2026-10-14T21:00:00.000Z', ends_at: '2026-10-14T22:00:00.000Z', all_day: false,
    recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
    created_by: null, idempotency_key: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...extra,
  };
}

const rowsOf = (familyId: string) => db.table('calendar_events').filter((r) => r.family_id === familyId);
const snapshot = (familyId: string) => structuredClone(rowsOf(familyId));
const rowById = (id: string) => db.table('calendar_events').find((r) => r.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('family_members', [
    ...(Object.keys(MEMBER) as Who[]).map((who) => ({
      id: MEMBER[who], family_id: FAM_A, user_id: USER[who], display_name: who, role: ROLE_OF[who], is_active: true,
    })),
    { id: B_PARENT, family_id: FAM_B, user_id: null, display_name: 'B parent', role: 'parent', is_active: true },
    { id: B_KID, family_id: FAM_B, user_id: null, display_name: 'B kid', role: 'child', is_active: true },
  ]);
  db.seed('calendar_events', [
    // Household A: the child's practice and, over it, a piano lesson — a double booking.
    event(EVENT_A, FAM_A, { title: 'Soccer practice', assignee_id: MEMBER.child, created_by: USER.parent }),
    event(EVENT_A2, FAM_A, { title: 'Piano lesson', assignee_id: MEMBER.child, created_by: USER.parent,
      starts_at: '2026-10-14T21:30:00.000Z', ends_at: '2026-10-14T22:15:00.000Z' }),
    // Household B, at the same hour, even naming A's child: invisible to A.
    event(EVENT_B, FAM_B, { title: 'B family dentist', assignee_id: MEMBER.child,
      starts_at: '2026-10-14T21:15:00.000Z', ends_at: '2026-10-14T21:45:00.000Z' }),
  ]);
  // 0464's guard trigger, as Postgres answers it: a guest's write is a 42501.
  const client = withFaults(db, (table, calls) =>
    table === 'calendar_events' && caller === 'guest'
      && calls.some((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))
      ? { code: '42501', message: 'A guest can see the household but not change it' }
      : null);
  mocks.createServer.mockResolvedValue(client);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const CREATORS: Who[] = ['parent', 'adult', 'teen', 'child', 'kidLogin', 'caregiver'];
const EDITORS: Who[] = ['parent', 'adult', 'teen', 'caregiver'];
const DELETERS: Who[] = ['parent', 'adult'];
const READERS: Who[] = ['parent', 'adult', 'teen', 'child', 'kidLogin', 'caregiver', 'guest'];

describe('createCalendarEventAction', () => {
  it.each(CREATORS)('ACTION-9FEB2DB251E0 the %s adds one event to their own household, under their own name', async (who) => {
    signedInAs(who);
    const before = snapshot(FAM_A);
    const beforeB = snapshot(FAM_B);

    const result = await createCalendarEventAction({
      title: 'School concert', startsAt: '2026-10-20T23:00:00.000Z', endsAt: '2026-10-21T00:30:00.000Z',
      category: 'school', submissionId: SUBMISSION,
    });

    expect(result).toEqual({ ok: true, id: expect.any(String) });
    const added = rowsOf(FAM_A).filter((r) => !before.some((b) => b.id === r.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      id: (result as { id: string }).id, family_id: FAM_A, title: 'School concert', category: 'school',
      starts_at: '2026-10-20T23:00:00.000Z', created_by: USER[who], assignee_id: null,
    });
    expect(rowsOf(FAM_B)).toEqual(beforeB);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(PATH);
  });

  it('ACTION-9FEB2DB251E0 a guest is refused by 0464 and nothing is written', async () => {
    signedInAs('guest');
    const before = structuredClone(db.table('calendar_events'));
    const result = await createCalendarEventAction({ title: 'Grandma visit', startsAt: '2026-10-20T23:00:00.000Z' });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(PERMISSION);
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['parent', 'child'] as Who[])('ACTION-9FEB2DB251E0 the %s cannot assign the event to a household-B member', async (who) => {
    signedInAs(who);
    const before = structuredClone(db.table('calendar_events'));
    const result = await createCalendarEventAction({
      title: 'Sleepover', startsAt: '2026-10-20T23:00:00.000Z', assigneeId: B_KID,
    });
    expect(result).toEqual({ ok: false, error: 'Choose an assignee from your family.' });
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('applyRoutineToCalendarAction', () => {
  const routine = (assigneeId: string | null) => ({
    submissionId: SUBMISSION,
    events: [
      { title: 'Brush teeth', startsAt: '2026-10-19T11:00:00.000Z', endsAt: '2026-10-19T11:10:00.000Z', category: 'health', assigneeId },
      { title: 'Brush teeth', startsAt: '2026-10-20T11:00:00.000Z', endsAt: '2026-10-20T11:10:00.000Z', category: 'health', assigneeId },
    ],
  });

  it.each(CREATORS)("ACTION-A825F244E83B the %s applies a routine as that week's events in their own household", async (who) => {
    signedInAs(who);
    const before = snapshot(FAM_A);
    const beforeB = snapshot(FAM_B);

    const result = await applyRoutineToCalendarAction(routine(MEMBER.child));

    expect(result).toEqual({ ok: true, eventIds: [expect.any(String), expect.any(String)] });
    const added = rowsOf(FAM_A).filter((r) => !before.some((b) => b.id === r.id));
    expect(added.map((r) => r.id).sort()).toEqual([...(result as { eventIds: string[] }).eventIds].sort());
    for (const row of added) {
      expect(row).toMatchObject({ family_id: FAM_A, title: 'Brush teeth', assignee_id: MEMBER.child, created_by: USER[who] });
    }
    expect(rowsOf(FAM_B)).toEqual(beforeB);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(PATH);
  });

  it('ACTION-A825F244E83B a guest is refused by 0464 and no event lands', async () => {
    signedInAs('guest');
    const before = structuredClone(db.table('calendar_events'));
    const result = await applyRoutineToCalendarAction(routine(null));
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(PERMISSION);
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-A825F244E83B a routine naming a household-B member is refused whole', async () => {
    signedInAs('parent');
    const before = structuredClone(db.table('calendar_events'));
    const result = await applyRoutineToCalendarAction(routine(B_KID));
    expect(result).toEqual({ ok: false, error: 'Choose assignees from your family.' });
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('updateCalendarEventAction', () => {
  it.each(EDITORS)('ACTION-038A8197A4CD the %s renames and moves an event of their own household', async (who) => {
    signedInAs(who);
    const beforeB = snapshot(FAM_B);
    const untouched = structuredClone(rowById(EVENT_A2));

    const result = await updateCalendarEventAction(EVENT_A, {
      title: 'Soccer match', startsAt: '2026-10-14T22:00:00.000Z', endsAt: '2026-10-14T23:30:00.000Z',
    }, { startsAt: '2026-10-14T21:00:00.000Z', endsAt: '2026-10-14T22:00:00.000Z', allDay: false, updatedAt: '2026-10-01T00:00:00.000Z' });

    expect(result).toEqual({ ok: true, id: EVENT_A });
    expect(rowById(EVENT_A)).toMatchObject({
      family_id: FAM_A, title: 'Soccer match', starts_at: '2026-10-14T22:00:00.000Z',
      // 0339: the author is fixed at insert; an edit never rewrites it.
      created_by: USER.parent,
    });
    expect(rowById(EVENT_A2)).toEqual(untouched);
    expect(rowsOf(FAM_B)).toEqual(beforeB);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(PATH);
  });

  it('ACTION-038A8197A4CD a guest is refused by 0464 and the event keeps its title and time', async () => {
    signedInAs('guest');
    const before = structuredClone(db.table('calendar_events'));
    const result = await updateCalendarEventAction(EVENT_A, { title: 'Cancelled', startsAt: '2026-10-15T21:00:00.000Z', endsAt: '2026-10-15T22:00:00.000Z' });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(PERMISSION);
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ACTION-038A8197A4CD a household-B event id is not found, and neither household's events change", async () => {
    signedInAs('parent');
    const before = structuredClone(db.table('calendar_events'));
    await expect(updateCalendarEventAction(EVENT_B, { title: 'Hijacked' }))
      .resolves.toEqual({ ok: false, error: NOT_FOUND });
    // And through the opened-copy path the modal uses.
    await expect(updateCalendarEventAction(EVENT_B, { title: 'Hijacked' },
      { startsAt: '2026-10-14T21:15:00.000Z', endsAt: '2026-10-14T21:45:00.000Z', allDay: false, updatedAt: '2026-10-01T00:00:00.000Z' }))
      .resolves.toEqual({ ok: false, error: NOT_FOUND });
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-038A8197A4CD an event cannot be handed to a household-B member', async () => {
    signedInAs('parent');
    const before = structuredClone(db.table('calendar_events'));
    await expect(updateCalendarEventAction(EVENT_A, { assigneeId: B_KID }))
      .resolves.toEqual({ ok: false, error: 'Choose an assignee from your family.' });
    expect(db.table('calendar_events')).toEqual(before);
  });
});

describe('deleteCalendarEventAction', () => {
  it.each(DELETERS)('ACTION-783E8E49F829 the %s removes one event of their own household', async (who) => {
    signedInAs(who);
    const beforeB = snapshot(FAM_B);
    const result = await deleteCalendarEventAction(EVENT_A);
    expect(result).toEqual({ ok: true, id: EVENT_A });
    expect(rowById(EVENT_A)).toBeUndefined();
    expect(rowsOf(FAM_A).map((r) => r.id)).toEqual([EVENT_A2]);
    expect(rowsOf(FAM_B)).toEqual(beforeB);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(PATH);
  });

  it('ACTION-783E8E49F829 a guest is refused by 0464 and the event stays', async () => {
    signedInAs('guest');
    const before = structuredClone(db.table('calendar_events'));
    const result = await deleteCalendarEventAction(EVENT_A);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(PERMISSION);
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-783E8E49F829 a household-B event id is not found and is not removed', async () => {
    signedInAs('parent');
    const before = structuredClone(db.table('calendar_events'));
    await expect(deleteCalendarEventAction(EVENT_B)).resolves.toEqual({ ok: false, error: NOT_FOUND });
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('undoCalendarEventsAction', () => {
  it.each(DELETERS)('ACTION-59D8A2C9CF49 the %s undoes a batch of their own household', async (who) => {
    signedInAs(who);
    const beforeB = snapshot(FAM_B);
    await expect(undoCalendarEventsAction([EVENT_A, EVENT_A2])).resolves.toEqual({ ok: true, removed: 2 });
    expect(rowsOf(FAM_A)).toEqual([]);
    expect(rowsOf(FAM_B)).toEqual(beforeB);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(PATH);
  });

  it('ACTION-59D8A2C9CF49 a guest is refused by 0464 and every event stays', async () => {
    signedInAs('guest');
    const before = structuredClone(db.table('calendar_events'));
    const result = await undoCalendarEventsAction([EVENT_A, EVENT_A2]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(PERMISSION);
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ACTION-59D8A2C9CF49 a household-B id in the batch is not removed, and only the caller's own row is", async () => {
    signedInAs('parent');
    const b = structuredClone(rowById(EVENT_B));
    await expect(undoCalendarEventsAction([EVENT_B])).resolves.toEqual({ ok: true, removed: 0 });
    await expect(undoCalendarEventsAction([EVENT_A, EVENT_B])).resolves.toEqual({ ok: true, removed: 1 });
    expect(rowById(EVENT_B)).toEqual(b);
    expect(rowsOf(FAM_A).map((r) => r.id)).toEqual([EVENT_A2]);
  });
});

describe('eventScheduleInsightsAction', () => {
  it.each(READERS)("ACTION-36DC69B7BB4A the %s reads the schedule check of their own household's event, and it writes nothing", async (who) => {
    signedInAs(who);
    const before = structuredClone(db.table('calendar_events'));
    const result = await eventScheduleInsightsAction(EVENT_A);
    expect(result).toMatchObject({ ok: true });
    const insights = (result as { insights: { kind: string; params?: Record<string, unknown> }[] }).insights;
    const clash = insights.filter((i) => i.kind === 'double_booking');
    // The piano lesson in A — and never B's dentist, though it names the same id at the same hour.
    expect(clash.map((i) => i.params?.other)).toEqual(['Piano lesson']);
    expect(JSON.stringify(insights)).not.toContain('B family dentist');
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ACTION-36DC69B7BB4A a household-B event id is not found, so B's schedule is not read out", async () => {
    signedInAs('parent');
    const result = await eventScheduleInsightsAction(EVENT_B);
    expect(result).toEqual({ ok: false, error: NOT_FOUND });
  });
});

describe('a signed-out caller', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['ACTION-9FEB2DB251E0', () => createCalendarEventAction({ title: 'X', startsAt: '2026-10-20T23:00:00.000Z' })],
    ['ACTION-A825F244E83B', () => applyRoutineToCalendarAction({ events: [{ title: 'X', startsAt: '2026-10-20T23:00:00.000Z' }] })],
    ['ACTION-038A8197A4CD', () => updateCalendarEventAction(EVENT_A, { title: 'X' })],
    ['ACTION-783E8E49F829', () => deleteCalendarEventAction(EVENT_A)],
    ['ACTION-59D8A2C9CF49', () => undoCalendarEventsAction([EVENT_A])],
    ['ACTION-36DC69B7BB4A', () => eventScheduleInsightsAction(EVENT_A)],
  ];
  it.each(calls)('%s is sent to sign in (the redirect is not swallowed) and nothing is written', async (_id, call) => {
    signedOut();
    const before = structuredClone(db.table('calendar_events'));
    await expect(call()).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('calendar_events')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
