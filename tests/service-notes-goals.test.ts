// The two writers that let a gated approval actually execute.
//
// Before these, `notes` and `goals` were written only by the hand-written chat
// tools, so `executeTool` — which the approval replay goes through — had no
// tool to resolve, and a parent who approved "save a note" read back "Bubaly
// has no tool called add_note".
//
// The headline assertions are the foreign key and the two invariants the
// database does not keep:
//   * notes.created_by / goals.created_by reference auth.users (0002), so the
//     AUTH id belongs there — not the family_members id the todo tables want.
//   * `goals.progress` has no CHECK despite its `-- 0..100` comment, and
//     `is_complete` is not derived; both rules live only in the goals module,
//     and three readers filter on `is_complete`.
//
// `rsvp_to_event` is deliberately NOT here. See lib/assistant/trust-wrapper.ts
// APPROVAL_CANNOT_REPLAY: the approval replay runs as the APPROVER and the row
// does not record who asked, so a registry RSVP tool would answer for the wrong
// person and its upsert would overwrite that person's own reply.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createNote } from '@/lib/services/notes';
import { createGoal } from '@/lib/services/goals';
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
