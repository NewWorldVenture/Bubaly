// The two writers that let a gated approval actually execute.
//
// Before these, `notes` and `goals` were written only by the hand-written chat
// tools, so `executeTool` — which the approval replay goes through — had no
// tool to resolve, and a parent who approved "save a note" read back "Bubaly
// has no tool called add_note".
//
// The headline assertions are the two foreign keys and the two invariants the
// database does not keep:
//   * notes.created_by / goals.created_by reference auth.users (0002), so the
//     AUTH id belongs there — not the family_members id the todo tables want.
//   * `goals.progress` has no CHECK despite its `-- 0..100` comment, and
//     `is_complete` is not derived; both rules live only in the goals module,
//     and three readers filter on `is_complete`.
//
//   * event_rsvps.member_id references family_members (0047), so the MEMBER id
//     belongs there — and it comes from the SCOPE, never from arguments, because
//     0047's policy has no member predicate at all. This tool waited for the
//     approval row to record who asked: replayed under the approver's scope it
//     would have answered for the parent and, on event_rsvps_once, upserted over
//     their own reply.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createNote } from '@/lib/services/notes';
import { createGoal } from '@/lib/services/goals';
import { rsvpToEvent } from '@/lib/services/calendar';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'upsert'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    const index = calls.push(call) - 1;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, limit: chain, is: chain, in: chain,
      order: (column: string, opts?: { ascending?: boolean }) => filter(`order:${column}`, opts?.ascending),
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      eq: filter,
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      upsert: (payload: unknown) => { call.kind = 'upsert'; call.payload = payload; return b; },
      single: () => Promise.resolve(respond(call, index)),
      maybeSingle: () => Promise.resolve(respond(call, index)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call, index)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'ai',
    tz: 'America/New_York',
    now: NOW,
    ...extra,
  };
}

describe('createNote', () => {
  it('writes the AUTH user id into notes.created_by', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'note-1', title: 'Bins', body: 'Tuesday' }, error: null }));
    const res = await createNote(scopeWith(db), { title: 'Bins', body: 'Tuesday' });
    expect(res.ok).toBe(true);
    // notes.created_by → auth.users (0002), the opposite of todo_items.
    expect(calls.find((c) => c.table === 'notes')?.payload).toMatchObject({
      family_id: 'fam-1', title: 'Bins', body: 'Tuesday', created_by: 'auth-user-1',
    });
  });

  it('writes no idempotency_key, because the column does not exist on this table', async () => {
    // 0256 added `idempotency_key` to six tables and `notes` is not one. Writing
    // it would be a PGRST204 against real schema that no unit test would catch,
    // which is the same trap `transactions.idempotency_key` sets.
    const { db, calls } = makeDb(() => ({ data: { id: 'note-1', title: null, body: 'x' }, error: null }));
    await createNote(scopeWith(db), { body: 'x' });
    expect(calls.find((c) => c.table === 'notes')?.payload).not.toHaveProperty('idempotency_key');
  });

  it('never writes the dead checklist column', async () => {
    // The column exists and nothing in the app reads it — the notes module
    // parses checklists out of the body text — so populating it would make a
    // note whose checklist no screen can show.
    const { db, calls } = makeDb(() => ({ data: { id: 'note-1', title: null, body: 'x' }, error: null }));
    await createNote(scopeWith(db), { body: 'x' });
    expect(calls.find((c) => c.table === 'notes')?.payload).not.toHaveProperty('checklist');
  });

  it('refuses an empty note and writes nothing', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await createNote(scopeWith(db), { body: '   ' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  it('refuses a body past the cap the database does not enforce', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await createNote(scopeWith(db), { body: 'x'.repeat(20_001) });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toEqual([]);
  });
});

describe('createGoal', () => {
  it('writes the AUTH user id and derives is_complete from progress', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'goal-1', title: 'Save £2000', target_date: '2026-12-01', progress: 0 }, error: null }));
    const res = await createGoal(scopeWith(db), { title: 'Save £2000', targetDate: '2026-12-01' });
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.table === 'goals')?.payload).toMatchObject({
      family_id: 'fam-1', title: 'Save £2000', target_date: '2026-12-01',
      progress: 0, is_complete: false, created_by: 'auth-user-1',
    });
  });

  it('keeps is_complete in step at 100, because the database does not', async () => {
    // The rule lives only in goals-module.tsx, and three readers filter on
    // is_complete. A row with progress 100 and is_complete false is invisible
    // to the completed list and stuck in the active one for ever.
    const { db, calls } = makeDb(() => ({ data: { id: 'goal-1', title: 'Done', target_date: null, progress: 100 }, error: null }));
    await createGoal(scopeWith(db), { title: 'Done', progress: 100 });
    expect(calls.find((c) => c.table === 'goals')?.payload).toMatchObject({ progress: 100, is_complete: true });
  });

  it.each([-1, 101, 5000, Number.NaN])('refuses progress of %s rather than clamping it', async (progress) => {
    // `progress` has no CHECK constraint despite the `-- 0..100` comment, so a
    // value straight from model output would render every bar off the end.
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await createGoal(scopeWith(db), { title: 'Goal', progress });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  it.each(['2026-02-31', '2026-13-01', 'next Tuesday', '2026-12-01T00:00:00Z'])(
    'refuses %s as a target date', async (targetDate) => {
      // Date.parse alone rolls 2026-02-31 into March, storing a day the family
      // never chose — the trap lib/services/memory hit with expiry dates.
      const { db, calls } = makeDb(() => ({ data: null, error: null }));
      const res = await createGoal(scopeWith(db), { title: 'Goal', targetDate });
      expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(calls).toEqual([]);
    },
  );
});

describe('rsvpToEvent', () => {
  const EVENT = { id: 'evt-1', title: 'Swim lesson', starts_at: '2026-09-08T16:00:00Z', family_id: 'fam-1' };

  it('answers for the ACTING member, never for anyone named in the arguments', async () => {
    const { db, calls } = makeDb((call) => call.table === 'calendar_events'
      ? { data: EVENT, error: null }
      : { data: { id: 'rsvp-1', event_id: 'evt-1', status: 'accepted', member_id: 'member-1' }, error: null });

    const res = await rsvpToEvent(
      scopeWith(db, { memberId: 'member-teen' }),
      // A member_id in the arguments must be ignored: 0047's policy is FOR ALL
      // on is_family_member alone, so the app is the ONLY thing stopping a teen
      // recording a reply in a parent's name.
      { eventId: 'evt-1', status: 'accepted', ...({ memberId: 'member-parent' } as object) },
    );
    expect(res.ok).toBe(true);
    const upsert = calls.find((c) => c.table === 'event_rsvps');
    expect(upsert?.kind).toBe('upsert');
    // event_rsvps.member_id → family_members (0047), NOT auth.users.
    expect(upsert?.payload).toMatchObject({ event_id: 'evt-1', member_id: 'member-teen', status: 'accepted' });
    expect(upsert?.payload).not.toMatchObject({ member_id: 'member-parent' });
  });

  it('takes family_id from the event, not from the caller', async () => {
    // Nothing constrains event_rsvps.family_id to match the event's.
    const { db, calls } = makeDb((call) => call.table === 'calendar_events'
      ? { data: EVENT, error: null }
      : { data: { id: 'rsvp-1', event_id: 'evt-1', status: 'maybe' }, error: null });
    await rsvpToEvent(scopeWith(db), { eventId: 'evt-1', status: 'maybe' });
    expect(calls.find((c) => c.table === 'event_rsvps')?.payload).toMatchObject({ family_id: 'fam-1' });
  });

  it('refuses when the scope cannot say whose reply it is', async () => {
    // Better to answer for nobody than for whoever sorts first in the roster,
    // which is what this code did before.
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await rsvpToEvent(scopeWith(db, { memberId: null }), { eventId: 'evt-1', status: 'accepted' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toEqual([]);
  });

  it('resolves a title to the NEXT occurrence, not the furthest-out one', async () => {
    // The lookup this replaces ordered DESCENDING with limit 1, so a weekly
    // swim lesson resolved to the last one of the term — months away — and
    // reported success against the right title.
    const { db, calls } = makeDb((call) => call.table === 'calendar_events'
      ? { data: [EVENT, { ...EVENT, id: 'evt-9', starts_at: '2026-11-24T16:00:00Z' }], error: null }
      : { data: { id: 'rsvp-1', event_id: 'evt-1', status: 'accepted' }, error: null });

    const res = await rsvpToEvent(scopeWith(db), { eventTitle: 'swim', status: 'accepted' });
    expect(res.ok).toBe(true);
    const lookup = calls.find((c) => c.table === 'calendar_events');
    expect(lookup?.filters['order:starts_at'], 'must be ascending').toBe(true);
    expect(lookup?.filters['gte:starts_at'], 'must exclude events that already happened').toBe(NOW.toISOString());
    expect(calls.find((c) => c.table === 'event_rsvps')?.payload).toMatchObject({ event_id: 'evt-1' });
  });

  it('refuses a title that matches two different events instead of guessing', async () => {
    const { db, calls } = makeDb((call) => call.table === 'calendar_events'
      ? { data: [{ ...EVENT, id: 'a', title: 'Board game night' }, { ...EVENT, id: 'b', title: 'Away game vs Fairview' }], error: null }
      : { data: null, error: null });

    const res = await rsvpToEvent(scopeWith(db), { eventTitle: 'game', status: 'accepted' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    if (!res.ok) expect(res.error).toMatch(/more than one/i);
    expect(calls.some((c) => c.table === 'event_rsvps')).toBe(false);
  });

  it('accepts several occurrences of ONE event as unambiguous', async () => {
    // A weekly lesson is not a question. Refusing here would make the tool
    // useless for exactly the case it is most often asked about.
    const { db } = makeDb((call) => call.table === 'calendar_events'
      ? { data: [EVENT, { ...EVENT, id: 'evt-2', starts_at: '2026-09-15T16:00:00Z' }], error: null }
      : { data: { id: 'rsvp-1', event_id: 'evt-1', status: 'accepted' }, error: null });
    expect((await rsvpToEvent(scopeWith(db), { eventTitle: 'Swim lesson', status: 'accepted' })).ok).toBe(true);
  });

  it('says so when nothing upcoming matches, rather than answering for the past', async () => {
    const { db, calls } = makeDb((call) => call.table === 'calendar_events' ? { data: [], error: null } : { data: null, error: null });
    const res = await rsvpToEvent(scopeWith(db), { eventTitle: 'sports day', status: 'declined' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    if (!res.ok) expect(res.error).toMatch(/already happened/i);
    expect(calls.some((c) => c.table === 'event_rsvps')).toBe(false);
  });

  it.each([
    [{ status: 'accepted' }, /which event/i],
    [{ eventId: 'evt-1', eventTitle: 'swim', status: 'accepted' }, /not both/i],
    [{ eventId: 'evt-1', status: 'going' }, /accepted, maybe or declined/i],
  ])('refuses a malformed request (%#)', async (input, message) => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await rsvpToEvent(scopeWith(db), input as Parameters<typeof rsvpToEvent>[1]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(message);
    expect(calls).toEqual([]);
  });

  it('will not reach an event in another family', async () => {
    const { db, calls } = makeDb((call) => call.table === 'calendar_events' ? { data: null, error: null } : { data: null, error: null });
    const res = await rsvpToEvent(scopeWith(db), { eventId: 'evt-other', status: 'accepted' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.find((c) => c.table === 'calendar_events')?.filters).toMatchObject({ family_id: 'fam-1' });
  });
});
