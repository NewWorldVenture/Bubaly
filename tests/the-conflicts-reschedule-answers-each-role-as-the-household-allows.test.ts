// Call-level role tests for the Conflicts screen's one write,
// `rescheduleEventAction` (app/(app)/dashboard/conflicts/actions.ts),
// Register B ACTION-4EE6E1BA998B.
//
// THE POLICY, from the sources rather than from the action:
//  - calendar_events' live RLS is 01050's: insert/update/delete for any
//    `is_family_member(family_id)` (supabase/migrations/01050_calendar_events_rls_repair.sql:23).
//  - 0464 adds a BEFORE trigger that refuses, with 42501, any write by a caller
//    whose role in the row's family is `guest`
//    (supabase/migrations/0464_a_guest_views_the_household.sql:66-69).
//  - The action itself has no role check. It reads the row family-scoped
//    (`.eq('family_id', ctx.active.familyId)`) and writes through the calendar
//    service, whose update is family-scoped again and reports a write that
//    matched no row as "not found".
//
// So a parent and an adult move the event (pinned), and a guest's move is
// refused by the database and must be reported as refused, never as a move
// (pinned against a client that answers a guest's write the way the 0464
// trigger does). Teen, child, caregiver and a kid login are NOT pinned here:
// RLS lets them move any family event, while the permission matrix the
// /family/permissions page shows (supabase/seed.sql:17-27) gives calendar_events
// update to parent and adult only. That disagreement is an owner decision.
//
// Cross-family: an id from household B is "not found", and nothing in B or A
// moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { rescheduleEventAction } = await import('@/app/(app)/dashboard/conflicts/actions');

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const NOT_FOUND = MESSAGES['actions.thatEventCouldNotBe'];

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const A_PIANO = 'a1111111-1111-4111-8111-111111111111';
const B_SWIM = 'b2222222-2222-4222-8222-222222222222';
const B_WEEKLY = 'b3333333-3333-4333-8333-333333333333';

const PIANO_STARTS = '2026-03-03T17:30:00.000Z';
const PIANO_ENDS = '2026-03-03T18:30:00.000Z';
const MOVED_STARTS = '2026-03-03T18:00:00.000Z';
const MOVED_ENDS = '2026-03-03T19:00:00.000Z';
const SWIM_STARTS = '2026-03-04T16:00:00.000Z';
const SWIM_ENDS = '2026-03-04T17:00:00.000Z';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

let db: InMemorySupabase;
let client: unknown;

function signedInAs(role: Role) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}`, email: `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'America/New_York' }, role, member: { id: `member-${role}` } },
  });
}

/**
 * The 0464 trigger as PostgREST reports it: a guest's UPDATE on calendar_events
 * answers 42501 and changes nothing. Reads go through untouched. Every builder
 * method after `update` keeps the chain; the terminal call resolves the refusal.
 */
function refusingAGuestsWrite(): unknown {
  const refusal = { data: null, error: { code: '42501', message: 'A guest can see the household but not change it', details: null, hint: null } };
  const refused: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(refusal);
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(refusal);
      return () => refused;
    },
  });
  return {
    from(name: string) {
      const builder = db.from(name);
      if (name !== 'calendar_events') return builder;
      return Object.assign(builder, { update: () => refused, delete: () => refused, insert: () => refused });
    },
    rpc: db.rpc?.bind(db),
    auth: db.auth,
  };
}

const row = (id: string) => db.table('calendar_events').find((r) => r.id === id);
const snapshot = () => structuredClone(db.table('calendar_events'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  client = db;
  mocks.createServer.mockImplementation(async () => client);
  db.seed('calendar_events', [
    { id: A_PIANO, family_id: FAMILY_A, title: 'Piano lesson', starts_at: PIANO_STARTS, ends_at: PIANO_ENDS, all_day: false, recurrence: 'none', recurrence_until: null, feed_id: null, external_uid: null, assignee_id: null },
    { id: B_SWIM, family_id: FAMILY_B, title: 'Swim', starts_at: SWIM_STARTS, ends_at: SWIM_ENDS, all_day: false, recurrence: 'none', recurrence_until: null, feed_id: null, external_uid: null, assignee_id: null },
    { id: B_WEEKLY, family_id: FAMILY_B, title: 'Weekly club', starts_at: SWIM_STARTS, ends_at: SWIM_ENDS, all_day: false, recurrence: 'weekly', recurrence_until: null, feed_id: null, external_uid: null, assignee_id: null },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const rendered = { startsAt: PIANO_STARTS, endsAt: PIANO_ENDS, allDay: false };

describe('rescheduleEventAction answers each role as the household allows', () => {
  it.each(['parent', 'adult'] as const)('ACTION-4EE6E1BA998B a %s moves their own family\'s event, and only that row changes', async (role) => {
    signedInAs(role);
    const others = snapshot().filter((r) => r.id !== A_PIANO);

    await expect(rescheduleEventAction(A_PIANO, MOVED_STARTS, MOVED_ENDS, rendered)).resolves.toEqual({ ok: true });

    expect(row(A_PIANO)).toMatchObject({ starts_at: MOVED_STARTS, ends_at: MOVED_ENDS, family_id: FAMILY_A });
    expect(db.table('calendar_events').filter((r) => r.id !== A_PIANO), 'household B is untouched').toEqual(others);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/conflicts');
  });

  it('ACTION-4EE6E1BA998B a guest\'s move is refused by the database and reported as refused, with nothing moved', async () => {
    signedInAs('guest');
    client = refusingAGuestsWrite();
    const before = snapshot();

    const result = await rescheduleEventAction(A_PIANO, MOVED_STARTS, MOVED_ENDS, rendered);

    expect(result.ok, 'a refused write is not a resolved conflict').toBe(false);
    expect(result.error, 'and the reader is told something').toEqual(expect.any(String));
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('rescheduleEventAction refuses an event of another family', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const)(
    'ACTION-4EE6E1BA998B a %s naming household B\'s one-off event gets "not found", and neither household changes',
    async (role) => {
      signedInAs(role);
      const before = snapshot();
      await expect(rescheduleEventAction(B_SWIM, MOVED_STARTS, MOVED_ENDS, { startsAt: SWIM_STARTS, endsAt: SWIM_ENDS, allDay: false }))
        .resolves.toEqual({ ok: false, error: NOT_FOUND });
      expect(snapshot()).toEqual(before);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('ACTION-4EE6E1BA998B household B\'s series is "not found" too: the read itself is family-scoped, not only the write', async () => {
    // Were the action's own read to reach B's row, a series answers "this one
    // repeats" instead — which also confirms the id exists in another family.
    signedInAs('parent');
    const before = snapshot();
    await expect(rescheduleEventAction(B_WEEKLY, MOVED_STARTS, MOVED_ENDS)).resolves.toEqual({ ok: false, error: NOT_FOUND });
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
