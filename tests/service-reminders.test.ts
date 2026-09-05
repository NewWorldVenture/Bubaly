// Behavioural tests for the reminders service. Two things matter most: the
// write lands on `public.family_reminders` (the canonical table per the
// implementation map's decision D4) and never on the legacy
// `public.reminders`; and `created_by`/`assigned_to_id` carry the auth user id
// while `member_id` carries the family_members id, as migration 0014 defines
// them.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { completeReminder, createReminder, listDue, snoozeReminder } from '@/lib/services/reminders';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

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

describe('createReminder', () => {
  it('writes to family_reminders and never to the legacy reminders table', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'rem-1', title: 'Take out bins' }, error: null }));
    const res = await createReminder(scopeWith(db), {
      title: '  Take out bins ',
      remindAt: '2026-09-06T22:00:00Z',
      memberId: 'member-2',
      assignedToUserId: 'auth-user-2',
    });

    expect(res.ok).toBe(true);
    expect(calls.every((c) => c.table !== 'reminders')).toBe(true);
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('family_reminders');
    // created_by / assigned_to_id → auth.users; member_id → family_members (0014).
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1',
      title: 'Take out bins',
      remind_at: '2026-09-06T22:00:00.000Z',
      created_by: 'auth-user-1',
      assigned_to_id: 'auth-user-2',
      member_id: 'member-2',
      status: 'active',
      kind: 'time',
      recurrence: 'none',
      priority: 'medium',
    });
  });

  it('marks a reminder the assistant created as ai_suggested', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'agent_activity'
      ? { data: { id: 'act-1' }, error: null }
      : { data: { id: 'rem-1', title: 'Refill prescription' }, error: null }));
    await createReminder(scopeWith(db, { actorKind: 'ai' }), { title: 'Refill prescription', remindAt: '2026-09-06T22:00:00Z' });
    const insert = calls.find((c) => c.table === 'family_reminders' && c.kind === 'insert');
    expect((insert?.payload as Record<string, unknown>).ai_suggested).toBe(true);
  });

  it('refuses a one-off reminder with no time — it could never fire', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await createReminder(scopeWith(db), { title: 'Something' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a location reminder with no place', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    const res = await createReminder(scopeWith(db), { title: 'Buy stamps', kind: 'location' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('accepts a recurring reminder with no explicit first time', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'rem-1' }, error: null }));
    const res = await createReminder(scopeWith(db), { title: 'Vitamins', recurrence: 'daily' });
    expect(res.ok).toBe(true);
    expect((calls[0].payload as Record<string, unknown>).recurrence).toBe('daily');
  });

  it('surfaces a database failure as ok:false', async () => {
    const { db } = makeDb(() => ({ data: null, error: { code: '23502', message: 'null value in column "title"' } }));
    const res = await createReminder(scopeWith(db), { title: 'Bins', remindAt: '2026-09-06T22:00:00Z' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('db');
  });

  it('returns the existing reminder rather than a duplicate on a retry', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'rem-1', title: 'Bins' }, error: null }));
    const res = await createReminder(scopeWith(db, { idempotencyKey: 'retry-1' }), {
      title: 'Bins', remindAt: '2026-09-06T22:00:00Z',
    });
    expect(res).toMatchObject({ ok: true, data: { id: 'rem-1' } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', title: 'Bins', remind_at: '2026-09-06T22:00:00.000Z' });
  });
});

describe('completeReminder', () => {
  it('rolls a recurring reminder forward instead of cancelling it', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'update'
      ? { data: { id: 'rem-1', status: 'active' }, error: null }
      : { data: { id: 'rem-1', recurrence: 'daily', remind_at: '2026-09-05T13:00:00.000Z' }, error: null }));

    const res = await completeReminder(scopeWith(db), 'rem-1');
    expect(res.ok).toBe(true);
    const update = calls.find((c) => c.kind === 'update');
    // A daily medication reminder ticked off today must still fire tomorrow.
    expect(update?.payload).toMatchObject({ status: 'active', remind_at: '2026-09-06T13:00:00.000Z' });
  });

  it('completes a one-off reminder outright', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'update'
      ? { data: { id: 'rem-1', status: 'completed' }, error: null }
      : { data: { id: 'rem-1', recurrence: 'none', remind_at: '2026-09-05T13:00:00.000Z' }, error: null }));

    const res = await completeReminder(scopeWith(db), 'rem-1');
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.kind === 'update')?.payload).toMatchObject({
      status: 'completed', completed_at: NOW.toISOString(),
    });
  });

  it('reports a reminder from another family as not found', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await completeReminder(scopeWith(db), 'rem-elsewhere');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls[0].filters).toMatchObject({ id: 'rem-elsewhere', family_id: 'fam-1' });
  });
});

describe('snoozeReminder', () => {
  it('pushes the reminder out from now, not from its original time', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'rem-1', status: 'snoozed' }, error: null }));
    const res = await snoozeReminder(scopeWith(db), 'rem-1', 30);
    expect(res.ok).toBe(true);
    expect(calls[0].payload).toMatchObject({ status: 'snoozed', snoozed_until: '2026-09-05T12:30:00.000Z' });
  });

  it('rejects a non-positive snooze', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await snoozeReminder(scopeWith(db), 'rem-1', 0);
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('listDue', () => {
  it('asks for active and snoozed reminders in this family, up to the horizon', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listDue(scopeWith(db), { withinMinutes: 60, memberId: 'member-2' });
    expect(calls[0].table).toBe('family_reminders');
    expect(calls[0].filters).toMatchObject({
      family_id: 'fam-1',
      member_id: 'member-2',
      'lte:remind_at': '2026-09-05T13:00:00.000Z',
    });
    expect(calls[0].filters.status).toEqual(['active', 'snoozed']);
  });

  it('withholds a snoozed reminder until its snooze has elapsed', async () => {
    const rows = [
      { id: 'a', status: 'active', remind_at: '2026-09-05T11:00:00.000Z', snoozed_until: null },
      { id: 'b', status: 'snoozed', remind_at: '2026-09-05T11:00:00.000Z', snoozed_until: '2026-09-05T18:00:00.000Z' },
      { id: 'c', status: 'snoozed', remind_at: '2026-09-05T09:00:00.000Z', snoozed_until: '2026-09-05T11:30:00.000Z' },
    ];
    const { db } = makeDb(() => ({ data: rows, error: null }));
    const res = await listDue(scopeWith(db));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('fails closed on a read error rather than reporting nothing due', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'timeout' } }));
    const res = await listDue(scopeWith(db));
    expect(res.ok).toBe(false);
  });
});
