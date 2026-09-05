// The routines service: what a family may set up, and who may set it up.
//
// A routine is a standing permission to ask on a cadence, so the two things
// worth pinning are that a child cannot create one and that an unreadable
// schedule is refused rather than guessed — a routine that fires at an hour
// nobody chose is how a family stops trusting the whole feature.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import { createRoutine, listRoutines, nextRelativeFire, scheduleOf, setRoutineEnabled } from '@/lib/services/routines';
import { anchorByKey } from '@/lib/services/routines/anchors';
import type { RelativeSchedule } from '@/lib/services/routines/schedule';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: string; filters: Record<string, unknown>; payload?: unknown };

function makeDb(reply: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, order: chain, limit: chain,
      eq: (c: string, v: unknown) => { call.filters[c] = v; return b; },
      not: (c: string, op: string, v: unknown) => { call.filters[`not:${c}`] = v; return b; },
      gte: (c: string, v: unknown) => { call.filters[`gte:${c}`] = v; return b; },
      insert: (p: unknown) => { call.kind = 'insert'; call.payload = p; return b; },
      update: (p: unknown) => { call.kind = 'update'; call.payload = p; return b; },
      single: () => Promise.resolve(reply(call)),
      maybeSingle: () => Promise.resolve(reply(call)),
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(reply(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T15:00:00Z');

function scope(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra,
  };
}

const ROW = {
  id: 'rule-1', family_id: 'fam-1', name: 'Plan our meals', action_config: { prompt: 'Plan our meals for next week' },
  is_enabled: true, said: 'every Sunday at 5pm', schedule_kind: 'cron' as const, schedule_expr: '0 17 * * 0' as string | null,
  anchor_key: null as string | null, offset_days: null as number | null, at_hour: null as number | null,
  next_run_at: '2026-09-06T21:00:00.000Z',
};

describe('createRoutine', () => {
  it('parses the schedule and stores the family’s own words with it', async () => {
    const { db, calls } = makeDb(() => ({ data: ROW, error: null }));
    const res = await createRoutine(scope(db), { said: 'every Sunday at 5pm', prompt: 'Plan our meals for next week' });
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1', schedule_kind: 'cron', schedule_expr: '0 17 * * 0',
      said: 'every Sunday at 5pm', trigger_type: 'schedule', action_type: 'ai_request',
      action_config: { prompt: 'Plan our meals for next week' },
      // The first fire is computed in the family's zone: Sunday 17:00 New York.
      next_run_at: '2026-09-06T21:00:00.000Z',
    });
  });

  it('stores an anchor by key, never a table name from the sentence', async () => {
    const { db, calls } = makeDb(() => ({ data: { ...ROW, schedule_kind: 'relative', anchor_key: 'trip', offset_days: -2, at_hour: 9, schedule_expr: null }, error: null }));
    await createRoutine(scope(db), { said: 'two days before every trip', prompt: 'Make sure we are ready' });
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.payload).toMatchObject({ schedule_kind: 'relative', anchor_key: 'trip', offset_days: -2, at_hour: 9 });
    // A relative routine's first fire depends on the trip, so the worker sets it.
    expect((insert?.payload as { next_run_at: unknown }).next_run_at).toBeNull();
  });

  it('refuses a schedule it cannot read instead of choosing an hour', async () => {
    const { db, calls } = makeDb(() => ({ data: ROW, error: null }));
    const res = await createRoutine(scope(db), { said: 'when things get busy', prompt: 'Help out' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(res.ok === false && res.error).toMatch(/every Sunday at 5pm/);
    expect(calls).toHaveLength(0);
  });

  it('is manager-only, checked before any write', async () => {
    const { db, calls } = makeDb(() => ({ data: ROW, error: null }));
    const res = await createRoutine(scope(db, { role: 'child' }), { said: 'every Sunday at 5pm', prompt: 'Plan our meals' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('needs something to do, not just a time', async () => {
    const { db } = makeDb(() => ({ data: ROW, error: null }));
    expect(await createRoutine(scope(db), { said: 'every Sunday', prompt: '  ' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('listRoutines', () => {
  it('reads only this family’s scheduled rules, active ones by default', async () => {
    const { db, calls } = makeDb(() => ({ data: [ROW], error: null }));
    const res = await listRoutines(scope(db));
    expect(res.ok && res.data[0]).toMatchObject({ id: 'rule-1', prompt: 'Plan our meals for next week', enabled: true });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', is_enabled: true, 'not:schedule_kind': null });
  });

  it('includes paused ones when asked', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listRoutines(scope(db), { includeDisabled: true });
    expect(calls[0].filters.is_enabled).toBeUndefined();
  });
});

describe('setRoutineEnabled', () => {
  it('pauses a routine for a manager, under the family', async () => {
    const { db, calls } = makeDb(() => ({ data: { ...ROW, is_enabled: false }, error: null }));
    const res = await setRoutineEnabled(scope(db), 'rule-1', false);
    expect(res.ok && res.data.enabled).toBe(false);
    expect(calls[0].filters).toMatchObject({ id: 'rule-1', family_id: 'fam-1' });
  });

  it('refuses a child', async () => {
    const { db, calls } = makeDb(() => ({ data: ROW, error: null }));
    expect(await setRoutineEnabled(scope(db, { role: 'teen' }), 'rule-1', false)).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });
});

describe('scheduleOf', () => {
  it('rebuilds a schedule from the row, and refuses an anchor key that is not on the list', () => {
    expect(scheduleOf(ROW)).toMatchObject({ kind: 'cron', expr: '0 17 * * 0' });
    expect(scheduleOf({ ...ROW, schedule_kind: 'relative' as const, schedule_expr: null, anchor_key: 'trip', offset_days: -2, at_hour: 9 }))
      .toMatchObject({ kind: 'relative', offsetDays: -2, atHour: 9 });
    expect(scheduleOf({ ...ROW, schedule_kind: 'relative' as const, schedule_expr: null, anchor_key: 'audit_logs', offset_days: -2, at_hour: 9 })).toBeNull();
    expect(scheduleOf({ ...ROW, schedule_expr: null })).toBeNull();
  });
});

describe('nextRelativeFire', () => {
  const schedule: RelativeSchedule = {
    kind: 'relative', anchor: anchorByKey('trip')!, offsetDays: -2, atHour: 9, said: 'two days before every trip',
  };

  it('takes the soonest anchor whose moment has not passed, family-scoped', async () => {
    const { db, calls } = makeDb(() => ({ data: [{ start_date: '2026-09-06' }, { start_date: '2026-10-24' }, { start_date: '2026-12-01' }], error: null }));
    const fires = await nextRelativeFire(db, 'fam-1', schedule, NOW, 'America/New_York');
    // The 6th is already too close for a "two days before"; the 24th is next.
    expect(fires?.toISOString()).toBe('2026-10-22T13:00:00.000Z');
    expect(calls[0].table).toBe('vacations');
    expect(calls[0].filters.family_id).toBe('fam-1');
  });

  it('answers null when there is nothing to anchor to', async () => {
    const { db } = makeDb(() => ({ data: [], error: null }));
    expect(await nextRelativeFire(db, 'fam-1', schedule, NOW, 'America/New_York')).toBeNull();
  });
});
