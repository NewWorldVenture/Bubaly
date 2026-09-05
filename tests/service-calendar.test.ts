// Behavioural tests for the calendar service against a hand-written Supabase
// fake. What matters here is not "does Supabase work" but: the right columns
// carry the right ids, every query is family-scoped, a database error becomes
// an honest ok:false instead of a throw, and slot search resolves working
// hours in the family's timezone rather than the server's.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  busyEvenings,
  createEvent,
  deleteEvent,
  findConflicts,
  findFreeSlots,
  rescheduleAfter,
  searchEvents,
  updateEvent,
} from '@/lib/services/calendar';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

/**
 * Chainable PostgREST fake. Every builder is thenable so both terminal styles
 * used by the services resolve — `await q` for a list and `await q.single()`
 * for a row — and each call records the filters it was given so a test can
 * assert that `family_id` was actually applied.
 */
function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, ilike: chain, or: chain,
      eq: filter, is: filter, in: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
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
    actorKind: 'member',
    tz: 'America/New_York',
    now: NOW,
    ...extra,
  };
}

const EVENT_ROW = {
  id: 'event-1', family_id: 'fam-1', title: 'Dentist', description: null, location: null,
  category: 'appointment', starts_at: '2026-09-07T14:00:00.000Z', ends_at: '2026-09-07T15:00:00.000Z',
  all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: 'member-2',
  feed_id: null, external_uid: null, created_by: 'auth-user-1', onboarding_key: null,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

describe('createEvent', () => {
  it('writes the auth user id into created_by and the member id into assignee_id', async () => {
    const { db, calls } = makeDb(() => ({ data: EVENT_ROW, error: null }));
    const res = await createEvent(scopeWith(db), {
      title: '  Dentist  ',
      startsAt: '2026-09-07T14:00:00Z',
      endsAt: '2026-09-07T15:00:00Z',
      category: 'appointment',
      assigneeId: 'member-2',
    });

    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('calendar_events');
    // calendar_events.created_by references auth.users (0002) — unlike the todo
    // tables, which reference family_members.
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1',
      title: 'Dentist',
      category: 'appointment',
      starts_at: '2026-09-07T14:00:00.000Z',
      ends_at: '2026-09-07T15:00:00.000Z',
      assignee_id: 'member-2',
      created_by: 'auth-user-1',
      all_day: false,
      recurrence: 'none',
    });
  });

  it('rejects a missing title before touching the database', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await createEvent(scopeWith(db), { title: '   ', startsAt: '2026-09-07T14:00:00Z' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an unparseable start time', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await createEvent(scopeWith(db), { title: 'Dentist', startsAt: 'next tuesdayish' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an end before the start', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    const res = await createEvent(scopeWith(db), {
      title: 'Dentist', startsAt: '2026-09-07T14:00:00Z', endsAt: '2026-09-07T10:00:00Z',
    });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('surfaces a database failure as ok:false with a readable message', async () => {
    const { db } = makeDb(() => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }));
    const res = await createEvent(scopeWith(db), { title: 'Dentist', startsAt: '2026-09-07T14:00:00Z' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('db');
      expect(res.error).toContain("don't have permission");
      expect(res.error).not.toContain('row-level security policy');
    }
  });

  it('returns the existing row instead of a duplicate when an idempotency key repeats', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'select' ? { data: EVENT_ROW, error: null } : { data: EVENT_ROW, error: null }));
    const res = await createEvent(scopeWith(db, { idempotencyKey: 'retry-1' }), {
      title: 'Dentist', startsAt: '2026-09-07T14:00:00Z',
    });
    expect(res).toMatchObject({ ok: true, data: { id: 'event-1' } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    // The probe is family-scoped like every other query.
    expect(calls[0].filters.family_id).toBe('fam-1');
  });

  it('records agent activity for an AI actor but not for a person in the UI', async () => {
    const aiDb = makeDb(() => ({ data: EVENT_ROW, error: null }));
    await createEvent(scopeWith(aiDb.db, { actorKind: 'ai' }), { title: 'Dentist', startsAt: '2026-09-07T14:00:00Z' });
    expect(aiDb.calls.some((c) => c.table === 'agent_activity' && c.kind === 'insert')).toBe(true);

    const uiDb = makeDb(() => ({ data: EVENT_ROW, error: null }));
    await createEvent(scopeWith(uiDb.db), { title: 'Dentist', startsAt: '2026-09-07T14:00:00Z' });
    expect(uiDb.calls.some((c) => c.table === 'agent_activity')).toBe(false);
  });
});

describe('updateEvent / deleteEvent', () => {
  it('scopes the update to the family and reports a foreign id as not found', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await updateEvent(scopeWith(db), 'event-from-another-family', { title: 'Moved' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls[0].filters).toMatchObject({ id: 'event-from-another-family', family_id: 'fam-1' });
  });

  it('refuses an empty patch instead of issuing a no-op write', async () => {
    const { db, calls } = makeDb(() => ({ data: EVENT_ROW, error: null }));
    const res = await updateEvent(scopeWith(db), 'event-1', {});
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('deletes within the family scope', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'event-1', title: 'Dentist' }, error: null }));
    const res = await deleteEvent(scopeWith(db), 'event-1');
    expect(res).toMatchObject({ ok: true, data: { id: 'event-1', title: 'Dentist' } });
    expect(calls[0].kind).toBe('delete');
    expect(calls[0].filters.family_id).toBe('fam-1');
  });
});

describe('searchEvents', () => {
  it('filters by family and defaults the window to now onwards', async () => {
    const { db, calls } = makeDb(() => ({ data: [EVENT_ROW], error: null }));
    const res = await searchEvents(scopeWith(db), { to: '2026-09-12T00:00:00Z', assigneeId: 'member-2' });
    expect(res).toMatchObject({ ok: true });
    expect(calls[0].filters).toMatchObject({
      family_id: 'fam-1',
      'gte:starts_at': NOW.toISOString(),
      'lte:starts_at': '2026-09-12T00:00:00.000Z',
      assignee_id: 'member-2',
    });
  });

  it('fails closed when the read errors', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'connection reset' } }));
    const res = await searchEvents(scopeWith(db));
    expect(res.ok).toBe(false);
  });
});

describe('findConflicts', () => {
  it('reports one person double-booked and returns the events involved', async () => {
    const overlapping = [
      { ...EVENT_ROW, id: 'a', title: 'Dentist', starts_at: '2026-09-07T14:00:00.000Z', ends_at: '2026-09-07T15:00:00.000Z' },
      { ...EVENT_ROW, id: 'b', title: 'Soccer', starts_at: '2026-09-07T14:30:00.000Z', ends_at: '2026-09-07T15:30:00.000Z' },
      { ...EVENT_ROW, id: 'c', title: 'Later', assignee_id: 'member-3', starts_at: '2026-09-07T18:00:00.000Z', ends_at: '2026-09-07T19:00:00.000Z' },
    ];
    const { db } = makeDb(() => ({ data: overlapping, error: null }));
    const res = await findConflicts(scopeWith(db), { to: '2026-09-12T00:00:00Z' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.conflicts).toHaveLength(1);
      expect(res.data.conflicts[0].eventIds.sort()).toEqual(['a', 'b']);
      expect(res.data.events.a.title).toBe('Dentist');
    }
  });
});

describe('findFreeSlots', () => {
  it('clips to working hours in the family timezone, not the server one', async () => {
    // No commitments at all: the first slot of a New York family's day must be
    // 08:00 local = 12:00Z, never 08:00Z.
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    const res = await findFreeSlots(scopeWith(db), {
      durationMin: 60,
      from: '2026-09-07T04:00:00Z',
      to: '2026-09-08T04:00:00Z',
      limit: 1,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].startsAt).toBe('2026-09-07T12:00:00.000Z');
      expect(res.data[0].dayKey).toBe('2026-09-07');
    }
    // Every source is read and every source is family-scoped.
    expect(calls.map((c) => c.table).sort()).toEqual(['calendar_events', 'school_events', 'sports_events']);
    expect(calls.every((c) => c.filters.family_id === 'fam-1')).toBe(true);
  });

  it('treats school and sports commitments as busy', async () => {
    const { db } = makeDb((call) => {
      if (call.table === 'sports_events') {
        return { data: [{ starts_at: '2026-09-07T12:00:00.000Z', ends_at: '2026-09-07T14:00:00.000Z', member_id: 'member-2' }], error: null };
      }
      return { data: [], error: null };
    });
    const res = await findFreeSlots(scopeWith(db), {
      durationMin: 60, from: '2026-09-07T04:00:00Z', to: '2026-09-08T04:00:00Z', limit: 1,
    });
    expect(res.ok).toBe(true);
    // Practice runs 08:00–10:00 local, so the first free hour starts at 10:00 local.
    if (res.ok) expect(res.data[0].startsAt).toBe('2026-09-07T14:00:00.000Z');
  });

  it('fails rather than proposing a time when a source cannot be read', async () => {
    const { db } = makeDb((call) => (call.table === 'school_events'
      ? { data: null, error: { message: 'timeout' } }
      : { data: [], error: null }));
    const res = await findFreeSlots(scopeWith(db), { durationMin: 30, from: '2026-09-07T00:00:00Z', to: '2026-09-08T00:00:00Z' });
    expect(res.ok).toBe(false);
  });
});

describe('busyEvenings', () => {
  it('counts an event after 17:00 local, and ignores an earlier one', async () => {
    const { db } = makeDb((call) => {
      if (call.table === 'calendar_events') {
        return {
          data: [
            // 23:00Z on the 7th = 19:00 local on the 7th → a busy evening.
            { starts_at: '2026-09-07T23:00:00.000Z', all_day: false },
            // 15:00Z on the 8th = 11:00 local → not an evening.
            { starts_at: '2026-09-08T15:00:00.000Z', all_day: false },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const res = await busyEvenings(scopeWith(db), { from: '2026-09-07T00:00:00Z', to: '2026-09-12T00:00:00Z' });
    expect(res).toEqual({ ok: true, data: ['2026-09-07'] });
  });
});

describe('rescheduleAfter', () => {
  it('keeps the original duration when moving an event', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'update'
      ? { data: { ...EVENT_ROW, starts_at: '2026-09-08T16:00:00.000Z' }, error: null }
      : { data: { id: 'event-1', title: 'Dentist', starts_at: '2026-09-07T14:00:00.000Z', ends_at: '2026-09-07T15:30:00.000Z' }, error: null }));

    const res = await rescheduleAfter(scopeWith(db), 'event-1', { startsAt: '2026-09-08T16:00:00Z' });
    expect(res.ok).toBe(true);
    const update = calls.find((c) => c.kind === 'update');
    expect(update?.payload).toMatchObject({
      starts_at: '2026-09-08T16:00:00.000Z',
      ends_at: '2026-09-08T17:30:00.000Z',
    });
  });

  it('reports a missing event rather than creating one', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    const res = await rescheduleAfter(scopeWith(db), 'nope', { startsAt: '2026-09-08T16:00:00Z' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });
});
