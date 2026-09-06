// The calendar's Save button and Bubaly write through the same door.
//
// §7: "A parent on a patchy phone connection taps Save twice on a school
// concert and gets two identical events on the family calendar — the same
// double-tap through Bubaly is deduplicated and produces one." The gap was two
// write paths to one table: the assistant's tools went through
// `lib/services/calendar` and its duplicate guard, and the module's modal went
// straight from the browser to PostgREST with none of it.
//
// These cases drive the REAL service against an in-memory Postgres that
// enforces 0256's index the way 0256 wrote it — unique on `(family_id,
// idempotency_key)`, partial, so a null key constrains nothing. That matters:
// with a fake that just replays a script, "the retry was deduplicated" is a
// claim about the fake. Here the second write either loses the probe or loses
// the index, and the assertion is the same either way — one row, one id.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  applyRoutineToCalendarAction, createCalendarEventAction, deleteCalendarEventAction,
  undoCalendarEventsAction, updateCalendarEventAction,
} from '@/app/(app)/dashboard/calendar/actions';

const FAMILY = 'family-1';
const OTHER_FAMILY = 'family-2';

/** A shape `crypto.randomUUID` would produce, which is all `isSubmissionId` accepts. */
const SAVE_ONE = '11111111-1111-4111-8111-111111111111';
const SAVE_TWO = '22222222-2222-4222-8222-222222222222';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/**
 * Run the suite somewhere that is NOT UTC.
 *
 * Without this the datetime-local case is vacuous: `Date.parse` resolves a naive
 * string against the process zone, so on a UTC runner "2026-09-10T19:00" and
 * "2026-09-10T19:00Z" are the same instant and dropping the `Z` the action
 * stamps would change nothing a test could see. Production is UTC, a laptop is
 * not, and the point of stamping it is that the row does not depend on which one
 * ran. Restored afterwards because the worker is shared.
 */
const REAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Chicago'; });
afterAll(() => { if (REAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = REAL_TZ; });

/** Every calendar row in the household, ignoring seeds from other families. */
function events(familyId = FAMILY) {
  return db.table('calendar_events').filter((r) => r.family_id === familyId);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: {
        description: null, location: null, ends_at: null, all_day: false,
        category: 'general', recurrence: 'none', recurrence_until: null,
        assignee_id: null, idempotency_key: null,
      },
    },
    // 0256, as written: partial, so the millions of rows people create by hand
    // (key null) are untouched. The helper skips a unique set whenever one of
    // its columns is null, which is the same rule.
    uniques: { calendar_events: [['family_id', 'idempotency_key']] },
  });
  // `scopeFromUserContext` reads all four of these; a thinner stub throws inside
  // the action's try and turns every case into its catch.
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

const concert = { title: 'School concert', startsAt: '2026-09-10T19:00', endsAt: '2026-09-10T20:30' };

describe('a save that happens twice', () => {
  it('creates one event when the parent presses Save again after a lost response', async () => {
    // The tap that duplicates is not the one the disabled button blocks. It is
    // the one AFTER the write committed and the reply never arrived.
    const first = await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });
    const retry = await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });

    expect(first.ok && retry.ok).toBe(true);
    expect(events()).toHaveLength(1);
    // Not merely "one row survived" — the retry was answered with the row the
    // first attempt wrote, so the modal closes on a real event.
    expect(first.ok && retry.ok && retry.id).toBe(first.ok ? first.id : null);
  });

  it('creates one event when both taps are in flight at once', async () => {
    // Two probes can both read "no", which is exactly why 0256 exists. Whichever
    // way this interleaves — probe catches it, or the index does and the guard
    // re-reads the winner's row — the family gets one concert.
    const [a, b] = await Promise.all([
      createCalendarEventAction({ ...concert, submissionId: SAVE_ONE }),
      createCalendarEventAction({ ...concert, submissionId: SAVE_ONE }),
    ]);

    expect(a.ok, a.ok ? '' : a.error).toBe(true);
    expect(b.ok, b.ok ? '' : b.error).toBe(true);
    expect(events()).toHaveLength(1);
    expect(a.ok && b.ok && a.id).toBe(b.ok ? b.id : null);
  });

  it('creates both when two identical events are composed separately', async () => {
    // Two children, one 4pm piano lesson each. A natural key over title and
    // start would call this a duplicate and silently drop one; a per-composition
    // id gets it right, which is the whole reason the id is minted by the client
    // rather than derived from the event.
    const piano = { title: 'Piano lesson', startsAt: '2026-09-12T16:00' };
    await createCalendarEventAction({ ...piano, submissionId: SAVE_ONE });
    await createCalendarEventAction({ ...piano, submissionId: SAVE_TWO });

    expect(events()).toHaveLength(2);
  });
});

describe('a client that sends no usable submission id', () => {
  it('still saves, un-deduplicated, the way the old path did', async () => {
    // An old cached bundle, or a browser where the id could not be minted.
    // Deduplication is a safety net; refusing a parent's event because a
    // generated id looked wrong would be a worse bug than the one being fixed.
    for (const submissionId of [undefined, 'not-a-uuid', '']) {
      await createCalendarEventAction({ ...concert, submissionId });
    }
    expect(events()).toHaveLength(3);
    // And the partial index constrains none of them — three null keys coexist,
    // which is the property 0256's `where idempotency_key is not null` buys.
    expect(events().every((r) => r.idempotency_key === null)).toBe(true);
  });
});

describe('what the server stores', () => {
  it('keeps a datetime-local value at the instant it has always been stored at', async () => {
    // The form yields a naive wall clock. Postgres resolved it against the
    // connection's UTC `TimeZone`; `Date.parse` on the server would resolve it
    // against the SERVER's zone, which is UTC on Vercel and something else on a
    // laptop. Moving the write must change the write path and nothing else.
    await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });
    expect(events()[0]!.starts_at).toBe('2026-09-10T19:00:00.000Z');
    expect(events()[0]!.ends_at).toBe('2026-09-10T20:30:00.000Z');
  });

  it('leaves an absolute instant alone, so a booked free slot lands where it was offered', async () => {
    await createCalendarEventAction({
      title: 'Family meeting', startsAt: '2026-09-11T13:00:00.000Z', endsAt: '2026-09-11T14:00:00.000Z',
      submissionId: SAVE_ONE,
    });
    expect(events()[0]!.starts_at).toBe('2026-09-11T13:00:00.000Z');
  });

  it('takes family_id and created_by from the session, never from the caller', async () => {
    await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });
    expect(events()[0]!.family_id).toBe(FAMILY);
    // calendar_events.created_by references auth.users, so the auth id is the
    // right one here — not the family_members id the same context also carries.
    expect(events()[0]!.created_by).toBe('user-1');
  });

  it('drops a category or recurrence it does not recognise instead of sending it on', async () => {
    await createCalendarEventAction({
      ...concert, category: 'wedding', recurrence: 'fortnightly', submissionId: SAVE_ONE,
    });
    expect(events()[0]!.category).toBe('general');
    expect(events()[0]!.recurrence).toBe('none');
  });
});

describe('validation that used to live only in the browser', () => {
  it('refuses an event that ends before it starts, and writes nothing', async () => {
    const result = await createCalendarEventAction({
      title: 'Backwards', startsAt: '2026-09-10T20:00', endsAt: '2026-09-10T19:00', submissionId: SAVE_ONE,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/cannot end before it starts/i);
    expect(events()).toHaveLength(0);
  });

  it.each([['', 'a title'], ['   ', 'whitespace for a title']])('refuses %j (%s) and writes nothing', async (title) => {
    const result = await createCalendarEventAction({ title, startsAt: '2026-09-10T19:00', submissionId: SAVE_ONE });
    expect(result.ok).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it('refuses an EDIT that ends before it starts, which the browser was the only thing checking', async () => {
    const created = await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateCalendarEventAction(created.id, {
      startsAt: '2026-09-10T20:00', endsAt: '2026-09-10T19:00',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/cannot end before it starts/i);
    // The original times survive: a refused patch must not half-apply.
    expect(events()[0]!.starts_at).toBe('2026-09-10T19:00:00.000Z');
    expect(events()[0]!.ends_at).toBe('2026-09-10T20:30:00.000Z');
  });

  it('refuses a start time it cannot understand', async () => {
    const result = await createCalendarEventAction({ title: 'Someday', startsAt: 'next Tuesdayish', submissionId: SAVE_ONE });
    expect(result.ok).toBe(false);
    expect(events()).toHaveLength(0);
  });
});

describe('editing and removing another household’s event', () => {
  beforeEach(() => {
    db.seed('calendar_events', [
      { id: 'theirs', family_id: OTHER_FAMILY, title: 'Their dentist', starts_at: '2026-09-15T09:00:00.000Z', created_by: 'user-9' },
    ]);
  });

  it('cannot delete it — the service filters family_id, the old client filtered id alone', async () => {
    // `supabase.from('calendar_events').delete().eq('id', event.id)` left tenancy
    // entirely to RLS: one policy between a mistyped id and someone else's
    // calendar. The service adds the filter the application should have had.
    const result = await deleteCalendarEventAction('theirs');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/could not be found/i);
    expect(events(OTHER_FAMILY)).toHaveLength(1);
  });

  it('cannot update it either', async () => {
    const result = await updateCalendarEventAction('theirs', { title: 'Mine now' });
    expect(result.ok).toBe(false);
    expect(db.table('calendar_events').find((r) => r.id === 'theirs')!.title).toBe('Their dentist');
  });
});

describe('editing and removing the family’s own event', () => {
  it('updates only the fields the modal actually showed', async () => {
    const created = await createCalendarEventAction({
      ...concert, location: 'Auditorium', description: 'Bring the programme', submissionId: SAVE_ONE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The modal has no assignee field. An update built from a spread would send
    // `assignee_id: undefined` and blank whoever the event was for.
    db.table('calendar_events')[0]!.assignee_id = 'member-2';
    const result = await updateCalendarEventAction(created.id, { title: 'School concert (moved)' });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(events()[0]!.title).toBe('School concert (moved)');
    expect(events()[0]!.assignee_id).toBe('member-2');
    expect(events()[0]!.location).toBe('Auditorium');
  });

  it('deletes it', async () => {
    const created = await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect((await deleteCalendarEventAction(created.id)).ok).toBe(true);
    expect(events()).toHaveLength(0);
  });

  it('refuses a delete with no id rather than issuing an unfiltered one', async () => {
    await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });
    const result = await deleteCalendarEventAction('');
    expect(result.ok).toBe(false);
    expect(events()).toHaveLength(1);
  });
});

describe('a caller who is not signed in', () => {
  it('is redirected, not handed an error toast', async () => {
    // `requireUserContext` sends a signed-out caller to /login by calling
    // `redirect()`, and `redirect()` works by THROWING. Resolving the session
    // inside an action's `try` swallows that and answers `{ ok: false }`, so the
    // person sees "Could not add that event" and stays where they are. The
    // resolution sits outside the catch for exactly this reason, and this is the
    // case that says so.
    const redirected = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    mocks.requireUserContext.mockRejectedValueOnce(redirected);

    await expect(createCalendarEventAction({ ...concert, submissionId: SAVE_ONE })).rejects.toThrow('NEXT_REDIRECT');
    expect(events()).toHaveLength(0);
  });

  it.each([
    ['update', () => updateCalendarEventAction('some-id', { title: 'x' })],
    ['delete', () => deleteCalendarEventAction('some-id')],
  ])('is redirected on %s too', async (_name, call) => {
    mocks.requireUserContext.mockRejectedValueOnce(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    );
    await expect(call()).rejects.toThrow('NEXT_REDIRECT');
  });
});

describe('the activity trail, as it stands today', () => {
  it('records nothing for a person acting through the UI', async () => {
    // Deliberate, and pinned here so changing it is a visible diff rather than a
    // surprise: `agent_activity` is the record of what BUBALY did — /dashboard/agents
    // reads it as the agent roster's feed and lib/metric/time-saved-server.ts
    // counts its `done` rows as time the assistant saved. A parent's own edit
    // landing here unmarked would have Bubaly taking credit for it.
    //
    // §7's third symptom — the household's own record of who changed what having
    // holes wherever a person did the work — therefore needs somewhere that says
    // WHICH of the two acted. It is not closed by this change.
    await createCalendarEventAction({ ...concert, submissionId: SAVE_ONE });
    expect(events()).toHaveLength(1);
    expect(db.table('agent_activity')).toHaveLength(0);
  });
});

describe('applying a routine to a week', () => {
  const routine = [
    { title: 'Wake up', startsAt: '2026-09-07T07:00:00.000Z', endsAt: '2026-09-07T07:15:00.000Z' },
    { title: 'Breakfast', startsAt: '2026-09-07T07:15:00.000Z', endsAt: '2026-09-07T07:45:00.000Z' },
    { title: 'School run', startsAt: '2026-09-07T08:00:00.000Z', endsAt: '2026-09-07T08:30:00.000Z' },
  ];

  it('adds the whole week in one write', async () => {
    const result = await applyRoutineToCalendarAction({ events: routine, submissionId: SAVE_ONE });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.ok && result.eventIds).toHaveLength(3);
    expect(events()).toHaveLength(3);
    expect(events().every((r) => r.family_id === FAMILY && r.created_by === 'user-1')).toBe(true);
  });

  it('adds ONE week when the same routine and week are applied twice', async () => {
    // The batch carries a key per row derived from the composition, and a
    // multi-row insert is all-or-nothing — so "any row present" answers "all",
    // and the second Apply returns the first one's events.
    //
    // This asserts the OUTCOME, not which mechanism produced it: the probe
    // short-circuits, and if two taps race past it the unique index refuses the
    // second and the guard hands back the winner's rows. Both are correct and a
    // family cannot tell them apart, which is exactly why the assertion is on
    // the row count and the ids rather than on the path taken.
    const first = await applyRoutineToCalendarAction({ events: routine, submissionId: SAVE_ONE });
    const again = await applyRoutineToCalendarAction({ events: routine, submissionId: SAVE_ONE });

    expect(first.ok && again.ok).toBe(true);
    expect(events()).toHaveLength(3);
    expect(again.ok && again.eventIds.sort()).toEqual(first.ok ? first.eventIds.sort() : []);
  });

  it('adds a second week when a different week is applied', async () => {
    await applyRoutineToCalendarAction({ events: routine, submissionId: SAVE_ONE });
    await applyRoutineToCalendarAction({ events: routine, submissionId: SAVE_TWO });
    expect(events()).toHaveLength(6);
  });

  it('adds nothing at all when one row is invalid', async () => {
    // Atomicity is the point: half a routine on the calendar with nothing to
    // undo it is worse than a refusal.
    const result = await applyRoutineToCalendarAction({
      events: [...routine, { title: '   ', startsAt: '2026-09-07T09:00:00.000Z' }],
      submissionId: SAVE_ONE,
    });
    expect(result.ok).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it('refuses a routine with no active days', async () => {
    const result = await applyRoutineToCalendarAction({ events: [], submissionId: SAVE_ONE });
    expect(result.ok).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it('undoes the whole batch, and only this family’s', async () => {
    const applied = await applyRoutineToCalendarAction({ events: routine, submissionId: SAVE_ONE });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    db.seed('calendar_events', [{ id: 'theirs', family_id: OTHER_FAMILY, title: 'Not ours', starts_at: '2026-09-07T07:00:00.000Z' }]);

    const undone = await undoCalendarEventsAction([...applied.eventIds, 'theirs']);
    expect(undone.ok && undone.removed).toBe(3);
    expect(events()).toHaveLength(0);
    // The client deleted on ids alone; the service filters family_id too.
    expect(db.table('calendar_events').some((r) => r.id === 'theirs')).toBe(true);
  });

  it('undoes nothing for an empty list rather than issuing an unfiltered delete', async () => {
    await applyRoutineToCalendarAction({ events: routine, submissionId: SAVE_ONE });
    const undone = await undoCalendarEventsAction([]);
    expect(undone.ok && undone.removed).toBe(0);
    expect(events()).toHaveLength(3);
  });
});
