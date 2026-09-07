// The moving service: a move on file (once), the template laid out as dated
// relative tasks with nothing generated twice, one-off tasks keyed so a
// re-plan cannot duplicate them, the reviewed date change through the RPC
// that owns `moves.move_date`, and the live rows a plan personalises from.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { MOVE_TEMPLATE, applicableTemplate } from '@/lib/moving/planner';
import { addMoveDays } from '@/lib/moving/recalculation';
import { addTask, createMove, getMove, listMoveSources, planTasks, setMoveDate } from '@/lib/services/moving';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-05T12:00:00Z');
const FAMILY = randomUUID();
const OTHER_FAMILY = randomUUID();
const MEMBER = randomUUID();
const MOVE = randomUUID();
const MOVE_DATE = '2026-10-03';

type RpcCall = Record<string, unknown>;

/**
 * A faithful stand-in for `move_recalculate_date` (0271): classify every task
 * the way the SQL does, return the preview, and on the second call apply
 * exactly that preview. The service never touches `moves.move_date` itself.
 */
function recalcHandler(calls: RpcCall[]) {
  return (args: Record<string, unknown>, db: InMemorySupabase) => {
    calls.push(args);
    const move = db.table('moves').find((m) => m.id === args.p_move_id && m.family_id === args.p_family_id);
    if (!move) throw new Error('unavailable_move');
    if (move.move_date === args.p_new_date) throw new Error('same_move_date');
    const tasks = db.table('move_tasks').filter((t) => t.move_id === move.id).sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    const shifts: Row[] = [];
    const preview = {
      version: 1, familyId: args.p_family_id, moveId: args.p_move_id, memberId: args.p_member_id, fromDate: move.move_date, toDate: args.p_new_date,
      moveUpdatedAt: move.updated_at, changes: 0,
      tasks: tasks.map((t) => {
        let reason = 'relative';
        let action: 'shift' | 'preserve' = 'shift';
        let next = t.due_date as string | null;
        if (t.completed_at || t.status === 'done') { reason = 'completed'; action = 'preserve'; }
        else if (t.status === 'skipped') { reason = 'skipped'; action = 'preserve'; }
        else if (t.date_mode === 'fixed') { reason = 'fixed'; action = 'preserve'; }
        else if (t.due_date === null) { reason = 'no_date'; action = 'preserve'; }
        else if (!['todo', 'doing'].includes(String(t.status)) || t.due_date !== addMoveDays(String(move.move_date), Number(t.offset_days))) { reason = 'out_of_sync'; action = 'preserve'; }
        else { next = addMoveDays(String(args.p_new_date), Number(t.offset_days)); shifts.push(t); }
        return { id: t.id, title: t.title, status: t.status, mode: t.date_mode, offsetDays: t.offset_days, dueDate: t.due_date, nextDueDate: next, updatedAt: t.updated_at, action, reason };
      }),
    };
    preview.changes = shifts.length;
    if (args.p_expected == null) return { preview, applied: false, requestId: null, appliedAt: null };
    if (JSON.stringify(args.p_expected) !== JSON.stringify(preview)) throw new Error('stale_review');
    for (const t of shifts) t.due_date = addMoveDays(String(args.p_new_date), Number(t.offset_days));
    move.move_date = args.p_new_date;
    return { preview, applied: true, requestId: args.p_request_id, appliedAt: new Date().toISOString() };
  };
}

function makeDb(opts: { rpcCalls?: RpcCall[] } = {}): InMemorySupabase {
  return createInMemorySupabase({
    defaults: {
      moves: { status: 'planning', move_kind: 'local', has_kids: true, has_pets: false, is_renting_out: false, budget_cents: null, spent_cents: 0, mover_quote_cents: null, from_address: null, to_address: null, notes: null, mover_name: null, mover_phone: null },
      move_tasks: { status: 'todo', category: 'admin', offset_days: 0, due_date: null, date_mode: 'fixed', assignee_id: null, completed_at: null, template_key: null, notes: null },
    },
    rpc: { move_recalculate_date: recalcHandler(opts.rpcCalls ?? []) },
  });
}

function seedMove(db: InMemorySupabase, over: Row = {}): void {
  db.seed('moves', [{ id: MOVE, family_id: FAMILY, title: 'Move to Maple St', move_date: MOVE_DATE, has_kids: true, has_pets: false, ...over }]);
}

function scopeWith(db: InMemorySupabase, extra?: Partial<ServiceScope>): ServiceScope {
  return { db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'auth-1', memberId: MEMBER, role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('getMove', () => {
  it('answers null for a family with no move, distinct from a failed read', async () => {
    const db = makeDb();
    expect(await getMove(scopeWith(db))).toEqual({ ok: true, data: null });
    const broken = { from: () => { const c: Record<string, unknown> = {}; const self = () => c; Object.assign(c, { select: self, eq: self, in: self, order: self, limit: self, then: (r: (v: unknown) => void) => r({ data: null, error: { code: 'XX000', message: 'boom' } }) }); return c; } } as unknown as SupabaseClient<Database>;
    expect(await getMove(scopeWith(db, { db: broken }))).toMatchObject({ ok: false, code: 'db' });
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).toContain('[service:moving] move read failed');
  });

  it("returns the family's soonest open move with its tasks and burn-down, never another family's", async () => {
    const db = makeDb();
    seedMove(db);
    db.seed('moves', [
      { id: randomUUID(), family_id: FAMILY, title: 'Old move', move_date: '2025-01-01', status: 'done' },
      { id: randomUUID(), family_id: OTHER_FAMILY, title: 'Theirs', move_date: '2026-09-10' },
    ]);
    db.seed('move_tasks', [{ id: randomUUID(), family_id: FAMILY, move_id: MOVE, title: 'Book movers', status: 'done' }]);
    const res = await getMove(scopeWith(db));
    expect(res.ok && res.data?.move.id).toBe(MOVE);
    expect(res.ok && res.data?.tasks).toHaveLength(1);
    expect(res.ok && res.data?.summary).toMatchObject({ daysToMove: 28, total: 1, done: 1 });
  });
});

describe('createMove', () => {
  it('infers kids and pets from the household and refuses to open a second move', async () => {
    const db = makeDb();
    db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, role: 'parent', is_active: true }, { id: randomUUID(), family_id: FAMILY, role: 'child', is_active: true }]);
    db.seed('pets', [{ id: randomUUID(), family_id: FAMILY, name: 'Biscuit', is_active: true }]);
    const first = await createMove(scopeWith(db), { title: 'Move to Maple St', moveDate: MOVE_DATE });
    expect(first.ok && first.data.created).toBe(true);
    expect(first.ok && first.data.move).toMatchObject({ family_id: FAMILY, has_kids: true, has_pets: true, move_kind: 'local', created_by: 'auth-1' });
    const again = await createMove(scopeWith(db), { title: 'Another', moveDate: '2026-12-01' });
    expect(again.ok && again.data.created).toBe(false);
    expect(again.ok && again.data.move.id).toBe(first.ok ? first.data.move.id : '');
    expect(db.table('moves')).toHaveLength(1);
  });

  it('defaults the date 45 days out and rejects a date or kind it cannot use', async () => {
    const db = makeDb();
    db.seed('family_members', []);
    const res = await createMove(scopeWith(db), {});
    expect(res.ok && res.data.move.move_date).toBe('2026-10-20');
    expect(res.ok && res.data.move).toMatchObject({ has_kids: false, has_pets: false, title: 'Our move' });
    expect(await createMove(scopeWith(makeDb()), { moveDate: '2026-02-30' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await createMove(scopeWith(makeDb()), { moveKind: 'teleport' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('planTasks', () => {
  it('inserts only the template keys the move is missing, dated relative to move day', async () => {
    const db = makeDb();
    seedMove(db);
    db.seed('move_tasks', [{ id: randomUUID(), family_id: FAMILY, move_id: MOVE, title: 'Mail forwarding', template_key: 'mail', date_mode: 'relative', offset_days: -14, due_date: '2026-09-19' }]);
    const res = await planTasks(scopeWith(db));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expected = applicableTemplate({ move_kind: 'local', has_kids: true, has_pets: false, is_renting_out: false });
    expect(res.data.inserted).toHaveLength(expected.length - 1);
    expect(res.data.inserted.map((t) => t.template_key)).not.toContain('mail');
    expect(res.data.inserted.map((t) => t.template_key)).not.toContain('vet');
    const essentials = res.data.inserted.find((t) => t.template_key === 'essentials-box')!;
    expect(essentials).toMatchObject({ family_id: FAMILY, move_id: MOVE, due_date: '2026-09-30', offset_days: -3, date_mode: 'relative', category: 'packing', created_by: 'auth-1' });
    // Every relative row satisfies the guard the 0271 trigger enforces: due_date = move_date + offset.
    for (const t of res.data.inserted) expect(t.due_date, String(t.template_key)).toBe(addMoveDays(MOVE_DATE, t.offset_days as number));
    expect(res.data.alreadyPlanned).toBe(1);

    const again = await planTasks(scopeWith(db));
    expect(again.ok && again.data.inserted).toEqual([]);
    expect(again.ok && again.data.alreadyPlanned).toBe(expected.length);
    expect(db.table('move_tasks')).toHaveLength(expected.length);
    expect(MOVE_TEMPLATE.length).toBeGreaterThan(expected.length);
  });

  it('needs a move on file', async () => {
    expect(await planTasks(scopeWith(makeDb()))).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('addTask', () => {
  it('dates a relative task from move day and never adds the same key twice', async () => {
    const db = makeDb();
    seedMove(db);
    const first = await addTask(scopeWith(db), { title: 'Change the address with Netflix', category: 'address', offsetDays: -14, templateKey: 'address-sub-1', assigneeId: MEMBER });
    expect(first.ok && first.data.created).toBe(true);
    expect(first.ok && first.data.task).toMatchObject({ family_id: FAMILY, move_id: MOVE, due_date: '2026-09-19', date_mode: 'relative', offset_days: -14, category: 'address', assignee_id: MEMBER, template_key: 'address-sub-1' });
    const again = await addTask(scopeWith(db), { title: 'Change the address with Netflix (again)', category: 'address', offsetDays: -14, templateKey: 'address-sub-1' });
    expect(again.ok && again.data.created).toBe(false);
    expect(again.ok && again.data.task.id).toBe(first.ok ? first.data.task.id : '');
    expect(db.table('move_tasks')).toHaveLength(1);
  });

  it('keeps a fixed date fixed, and refuses a bad category, offset or date', async () => {
    const db = makeDb();
    seedMove(db);
    const fixed = await addTask(scopeWith(db), { title: 'Lease signing', dueDate: '2026-09-25' });
    expect(fixed.ok && fixed.data.task).toMatchObject({ due_date: '2026-09-25', date_mode: 'fixed', category: 'other' });
    expect(await addTask(scopeWith(db), { title: 'x', category: 'laundry' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await addTask(scopeWith(db), { title: 'x', offsetDays: 400 })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await addTask(scopeWith(db), { title: 'x', dueDate: '2026-13-01' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await addTask(scopeWith(db), { title: '   ' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('setMoveDate', () => {
  function seedTasks(db: InMemorySupabase) {
    db.seed('move_tasks', [
      { id: randomUUID(), family_id: FAMILY, move_id: MOVE, title: 'Relative and open', date_mode: 'relative', offset_days: -14, due_date: '2026-09-19', status: 'todo' },
      { id: randomUUID(), family_id: FAMILY, move_id: MOVE, title: 'Relative but done', date_mode: 'relative', offset_days: -21, due_date: '2026-09-12', status: 'done', completed_at: '2026-09-01T00:00:00Z' },
      { id: randomUUID(), family_id: FAMILY, move_id: MOVE, title: 'Fixed', date_mode: 'fixed', offset_days: 0, due_date: '2026-09-25', status: 'todo' },
      { id: randomUUID(), family_id: FAMILY, move_id: MOVE, title: 'Out of sync', date_mode: 'relative', offset_days: -7, due_date: '2026-09-01', status: 'todo' },
    ]);
  }

  it('previews through the RPC, applies exactly that preview, and reports what shifted', async () => {
    const calls: RpcCall[] = [];
    const db = makeDb({ rpcCalls: calls });
    seedMove(db);
    seedTasks(db);
    const res = await setMoveDate(scopeWith(db), { date: '2026-10-10' });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ fromDate: MOVE_DATE, toDate: '2026-10-10', shifted: 1, preserved: 3 });
    expect(res.data.move.move_date).toBe('2026-10-10');
    expect(db.table('moves').find((m) => m.id === MOVE)?.move_date).toBe('2026-10-10');
    const shifted = db.table('move_tasks').find((t) => t.title === 'Relative and open')!;
    expect(shifted.due_date).toBe('2026-09-26');
    expect(db.table('move_tasks').find((t) => t.title === 'Fixed')?.due_date).toBe('2026-09-25');
    expect(db.table('move_tasks').find((t) => t.title === 'Relative but done')?.due_date).toBe('2026-09-12');
    expect(db.table('move_tasks').find((t) => t.title === 'Out of sync')?.due_date).toBe('2026-09-01');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ p_family_id: FAMILY, p_move_id: MOVE, p_member_id: MEMBER, p_new_date: '2026-10-10', p_expected: null, p_request_id: null });
    expect(calls[1].p_expected).toEqual(res.data.preview);
    expect(String(calls[1].p_request_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.data.result.applied).toBe(true);
  });

  it('never calls the RPC for a caller it cannot vouch for, or for a date it cannot use', async () => {
    const calls: RpcCall[] = [];
    const db = makeDb({ rpcCalls: calls });
    seedMove(db);
    expect(await setMoveDate(scopeWith(db, { memberId: null, userId: null, role: 'system', actorKind: 'system' }), { date: '2026-10-10' })).toMatchObject({ ok: false, code: 'denied' });
    expect(await setMoveDate(scopeWith(db, { role: 'teen' }), { date: '2026-10-10' })).toMatchObject({ ok: false, code: 'denied' });
    expect(await setMoveDate(scopeWith(db), { date: 'next friday' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await setMoveDate(scopeWith(db), { date: MOVE_DATE })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
    expect(db.table('moves').find((m) => m.id === MOVE)?.move_date).toBe(MOVE_DATE);
  });

  it('surfaces the RPC refusing, in words, and leaves the move alone', async () => {
    const db = createInMemorySupabase({ rpc: { move_recalculate_date: () => { throw new Error('stale_review'); } } });
    seedMove(db);
    const res = await setMoveDate(scopeWith(db), { date: '2026-10-10' });
    expect(res).toMatchObject({ ok: false, code: 'db' });
    expect(db.table('moves').find((m) => m.id === MOVE)?.move_date).toBe(MOVE_DATE);
  });
});

describe('listMoveSources', () => {
  it('reads live subscriptions, recurring bills, one school per child and the active pets — names only', async () => {
    const db = makeDb();
    const kid = randomUUID();
    db.seed('subscriptions_tracked', [
      { id: 's1', family_id: FAMILY, name: 'Netflix', cost_cents: 1500, status: 'active' },
      { id: 's2', family_id: FAMILY, name: 'Old gym', cost_cents: 5000, status: 'canceled' },
      { id: 's3', family_id: OTHER_FAMILY, name: 'Theirs', cost_cents: 1, status: 'active' },
    ]);
    db.seed('bills', [
      { id: 'b1', family_id: FAMILY, name: 'Electric Co', amount: 120, due_date: '2026-09-20', is_recurring: true, category: 'utilities' },
      { id: 'b2', family_id: FAMILY, name: 'Plumber', amount: 300, due_date: '2026-09-20', is_recurring: false, category: null },
    ]);
    db.seed('school_classes', [
      { id: randomUUID(), family_id: FAMILY, member_id: kid, subject: 'Math', school_name: null },
      { id: randomUUID(), family_id: FAMILY, member_id: kid, subject: 'Art', school_name: 'Oak Elementary' },
    ]);
    db.seed('pets', [
      { id: 'p1', family_id: FAMILY, name: 'Biscuit', vet_name: 'Dr Paws', vet_phone: '555-0100', is_active: true },
      { id: 'p2', family_id: FAMILY, name: 'Gone', vet_name: null, is_active: false },
    ]);
    const res = await listMoveSources(scopeWith(db));
    expect(res).toEqual({
      ok: true,
      data: {
        subscriptions: [{ id: 's1', name: 'Netflix' }],
        bills: [{ id: 'b1', name: 'Electric Co', category: 'utilities' }],
        schoolClasses: [{ memberId: kid, schoolName: 'Oak Elementary' }],
        pets: [{ id: 'p1', name: 'Biscuit', vetName: 'Dr Paws' }],
      },
    });
  });
});

describe('the "Moving Home" life event launches the Move Planner', () => {
  it('puts a moves row on file and lays out its tasks instead of a parallel checklist', () => {
    const src = readFileSync('app/(app)/dashboard/life-event-actions.ts', 'utf8');
    const branch = src.slice(src.indexOf("template.key === 'moving'"), src.indexOf("from('life_event_plans')"));
    expect(branch).toContain('createMove(scope, { title: template.title, moveDate: anchor })');
    expect(branch).toContain('planTasks(scope, { moveId: move.data.move.id })');
    expect(branch).toContain("href: '/dashboard/moving'");
    expect(branch).toMatch(/if \(!move\.ok\) return \{ ok: false, error: move\.error \}/);
    expect(branch).toMatch(/if \(!tasks\.ok\) return \{ ok: false, error: tasks\.error \}/);
  });
});
