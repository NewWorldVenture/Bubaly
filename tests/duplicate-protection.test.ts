// §30 / §45 duplicate protection, end to end through the services.
//
// The promise a family cares about: when Bubaly's step runs twice — a lease
// expired mid-write, a phone re-sent the POST — the household ends up with ONE
// event, ONE reminder, ONE to-do. Since 0256 that is a database fact (a
// partial unique index on `(family_id, idempotency_key)`), and these tests
// walk the three services that carry it: the retry finds its own row and no
// second insert is attempted, the row it wrote carries the key, and a family
// deliberately adding the same thing twice still gets two rows.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import { createEvent } from '@/lib/services/calendar';
import { createReminder } from '@/lib/services/reminders';
import { createTodo } from '@/lib/services/tasks';
import { scopeKey } from '@/lib/services/idempotency';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

/** A PostgREST stand-in with a real store: inserts land in rows, selects filter them. */
function makeDb() {
  const calls: Call[] = [];
  const rows = new Map<string, Record<string, unknown>[]>();
  let seq = 0;

  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };

    const result = (): Reply => {
      if (call.kind === 'insert') {
        const payload = call.payload as Record<string, unknown>;
        const table_rows = rows.get(table) ?? [];
        const key = payload.idempotency_key;
        // The partial unique index: one row per (family, key) when a key is set.
        if (key != null && table_rows.some((r) => r.idempotency_key === key && r.family_id === payload.family_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        const row = { id: `${table}-${(seq += 1)}`, ...payload };
        rows.set(table, [...table_rows, row]);
        return { data: row, error: null };
      }
      const found = (rows.get(table) ?? []).filter((row) => Object.entries(call.filters)
        .every(([column, value]) => column.includes(':') || row[column] === value));
      return { data: found[0] ?? null, error: null };
    };

    Object.assign(b, {
      select: chain, order: chain, limit: chain, ilike: chain, or: chain,
      eq: filter, is: filter, in: filter,
      lt: chain, lte: chain, gte: chain, not: chain,
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(result()),
      maybeSingle: () => Promise.resolve(result()),
      then: (resolve: (value: Reply) => void) => resolve(result()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls, rows };
}

function stepScope(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent',
    actorKind: 'ai', tz: 'America/New_York', runId: 'run-1', stepId: 'step-1',
    now: new Date('2026-09-05T12:00:00Z'), ...extra,
  };
}

describe('a retried write leaves one row', () => {
  it('calendar: the second run of the same step returns the first event', async () => {
    const { db, calls, rows } = makeDb();
    const input = { title: 'Dentist', startsAt: '2026-09-07T14:00:00Z' };

    const first = await createEvent(stepScope(db), input);
    const second = await createEvent(stepScope(db), input);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.id).toBe(first.data.id);
    expect(rows.get('calendar_events')).toHaveLength(1);
    expect(calls.filter((c) => c.table === 'calendar_events' && c.kind === 'insert')).toHaveLength(1);
    // The row carries the key the guard composed, so the index can do its job.
    expect(rows.get('calendar_events')?.[0].idempotency_key)
      .toBe(scopeKey(stepScope(db), 'calendar.createEvent', { title: 'Dentist', startsAt: '2026-09-07T14:00:00.000Z', allDay: false }));
  });

  it('reminders and to-dos: same step, same row', async () => {
    const { db, rows } = makeDb();
    const remindInput = { title: 'Bins', remindAt: '2026-09-06T22:00:00Z' };
    const first = await createReminder(stepScope(db), remindInput);
    const again = await createReminder(stepScope(db), remindInput);
    expect(first.ok && again.ok && first.ok && again.ok && first.data.id === again.data.id).toBe(true);
    expect(rows.get('family_reminders')).toHaveLength(1);

    // todo_items needs its list; the fake answers `ensureTodoList` from this row.
    rows.set('todo_lists', [{ id: 'list-1', family_id: 'fam-1', archived_at: null }]);
    const todoInput = { title: 'Pack the kit', dueDate: '2026-09-15' };
    const todo = await createTodo(stepScope(db), todoInput);
    const todoAgain = await createTodo(stepScope(db), todoInput);
    expect(todo.ok && todoAgain.ok).toBe(true);
    if (!todo.ok || !todoAgain.ok) return;
    expect(todoAgain.data.id).toBe(todo.data.id);
    expect(rows.get('todo_items')).toHaveLength(1);
  });

  it('a different step — a genuinely new ask — writes a second row', async () => {
    const { db, rows } = makeDb();
    const input = { title: 'Dentist', startsAt: '2026-09-07T14:00:00Z' };
    await createEvent(stepScope(db), input);
    await createEvent(stepScope(db, { stepId: 'step-2' }), input);
    expect(rows.get('calendar_events')).toHaveLength(2);
  });

  it('a person adding the same thing twice in the UI is not deduplicated', async () => {
    // No run, step or request on the scope: nothing to deduplicate against,
    // and "add milk" twice on purpose must mean two rows.
    const { db, rows } = makeDb();
    const uiScope = stepScope(db, { actorKind: 'member', runId: null, stepId: null, requestId: null });
    await createEvent(uiScope, { title: 'Dentist', startsAt: '2026-09-07T14:00:00Z' });
    await createEvent(uiScope, { title: 'Dentist', startsAt: '2026-09-07T14:00:00Z' });
    expect(rows.get('calendar_events')).toHaveLength(2);
    expect(rows.get('calendar_events')?.every((r) => r.idempotency_key === null)).toBe(true);
  });
});
