import { afterEach, describe, it, expect, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';

type Captured = { op: string; payload?: Record<string, unknown> }[];
type DbArg = Parameters<typeof buildAssistantTools>[0];

// Minimal chainable Supabase stub: select-chains resolve to `selectRows` (a
// ranged one to those rows of it, as PostgREST answers); update resolves with
// its matched row, insert with { error: null }; both record their payloads.
function fakeDb(selectRows: Record<string, unknown>[], captured: Captured, updateRows: unknown[] = [{ id: 'row' }]): DbArg {
  const make = (table: string) => {
    let op: 'select' | 'update' | 'insert' = 'select';
    const tableRows = table === 'family_reminders' ? selectRows : [];
    let rows = tableRows;
    let columns: string | undefined;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select(value?: string) { columns = value; return b; }, eq: chain, ilike: chain, order: chain, limit: chain, not: chain,
      range(from: number, to: number) { rows = tableRows.slice(from, to + 1); return b; },
      update(p: Record<string, unknown>) { op = 'update'; captured.push({ op, payload: p }); return b; },
      insert(p: Record<string, unknown>) { op = 'insert'; captured.push({ op, payload: p }); return b; },
      then(resolve: (v: unknown) => void) {
        // A matched update answers `.select()` with its row (C1-S9-69); an
        // update with no `data` is a shape the client cannot give once asked.
        const projected = columns && columns !== '*'
          ? rows.map(row => Object.fromEntries(columns!.split(',').map(column => column.trim()).map(column => [column, row[column]])))
          : rows;
        resolve(op === 'select' ? { data: projected, error: null } : op === 'update' ? { data: updateRows, error: null } : { error: null });
      },
    });
    return b;
  };
  return { from: (table: string) => make(table) } as unknown as DbArg;
}

const ctx: AssistantCtx = { familyId: 'fam-1', userId: 'user-1', role: 'parent', memberId: 'mem-self', members: [], tz: 'America/New_York' };

function tool(name: string, selectRows: Record<string, unknown>[], captured: Captured, updateRows?: unknown[]) {
  const t = buildAssistantTools(fakeDb(selectRows, captured, updateRows), ctx).find((x) => x.name === name);
  if (!t) throw new Error(`${name} tool missing`);
  return t;
}

describe('assistant complete_reminder tool', () => {
  it('completes a one-off reminder (no recurrence spawn)', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [
      { id: 'r1', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Pay rent', recurrence: 'none', remind_at: '2026-07-01T09:00:00.000Z', kind: 'bill', priority: 'high', notes: null, member_id: null, location_name: null },
    ], captured).execute({ title: 'rent' }) as { ok: boolean; summary: string };

    expect(res.ok).toBe(true);
    expect(res.summary).toContain('Completed');
    expect(res.summary).not.toContain('next one');
    expect(captured.filter((c) => c.op === 'update')).toHaveLength(1);
    expect(captured.find((c) => c.op === 'update')!.payload).toMatchObject({ status: 'completed' });
    expect(captured.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('completes a recurring reminder and schedules the next occurrence', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [
      { id: 'r2', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Water plants', recurrence: 'monthly', remind_at: '2026-07-01T09:00:00.000Z', kind: 'recurring', priority: 'medium', notes: null, member_id: null, location_name: null },
    ], captured).execute({ title: 'plants' }) as { ok: boolean; summary: string };

    expect(res.ok).toBe(true);
    expect(res.summary).toContain('next one scheduled');
    const insert = captured.find((c) => c.op === 'insert');
    expect(insert).toBeTruthy();
    expect(insert!.payload).toMatchObject({ recurrence: 'monthly', remind_at: '2026-08-01T09:00:00.000Z', status: 'active' });
  });

  it('reports when no active reminder matches', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [], captured).execute({ title: 'nope' });
    expect(res).toMatchObject({ ok: false });
    expect(res).toEqual({ ok: false, error: 'No active reminder matching “nope”.' });
    expect(captured).toHaveLength(0);
  });

  // C1-S9-69. The assistant speaks this answer, and the next occurrence of a
  // recurring reminder is inserted after the completion — so a completion that
  // matched nothing (a concurrent one already won) must fail AND schedule nothing.
  it('does not claim a completion that matched nothing, and schedules no second occurrence', async () => {
    const captured: Captured = [];
    const res = await tool('complete_reminder', [
      { id: 'r3', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Water plants', recurrence: 'monthly', remind_at: '2026-07-01T09:00:00.000Z', kind: 'recurring', priority: 'medium', notes: null, member_id: null, location_name: null },
    ], captured, []).execute({ title: 'plants' }) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(res).toEqual({ ok: false, error: 'Could not complete the reminder.' });
    expect(captured.filter((c) => c.op === 'update')).toHaveLength(1);
    expect(captured.find((c) => c.op === 'update')!.payload).toMatchObject({ status: 'completed' });
    expect(captured.filter((c) => c.op === 'insert'), 'a second future reminder').toHaveLength(0);
  });

  it('does not claim a reschedule that matched nothing', async () => {
    const captured: Captured = [];
    const res = await tool('snooze_reminder', [{ id: 'r4', family_id: 'fam-1', autopilot_origin: false, autopilot_card_id: null, title: 'Dentist' }], captured, [])
      .execute({ title: 'dentist', remind_at: '2026-08-01T09:00:00.000Z' }) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(res).toEqual({ ok: false, error: 'Could not reschedule the reminder.' });
    expect(captured.filter((c) => c.op === 'update')).toHaveLength(1);
    expect(captured.find((c) => c.op === 'update')!.payload).toEqual({ remind_at: '2026-08-01T09:00:00.000Z' });
  });
});


// Actual legacy tool + strict 0487 model. Only the response boundary is faulted:
// commit-loss cases execute the real writer before replacing/rejecting its reply.
// These controls do not claim native PostgreSQL locks/RLS or provider retry proof.
const OUTCOME_FAMILY = 'outcome-family';
const OUTCOME_USER = 'outcome-user';
const OUTCOME_PARENT = 'outcome-parent';
const OUTCOME_CARD = 'outcome-card';
const OUTCOME_NOW = '2026-10-14T12:00:00.000Z';
const OUTCOME_DUE = '2026-10-14T14:30:00.000Z';
const OUTCOME_NEXT = '2026-10-15T14:30:00.000Z';
const PARTIAL_COMPLETION = 'Reminder completed, but we could not confirm the next occurrence. Check your reminders before completing this again or adding another.';
type Memory = ReturnType<typeof createInMemorySupabase>;
type Reply = Awaited<ReturnType<Memory['rpc']>>;
type SuccessorFault =
  | { kind: 'none' | 'refused' | 'throw-before-commit' | 'returned-after-commit' | 'throw-after-commit' }
  | { kind: 'receipt'; transform: (receipt: Record<string, unknown>) => unknown };

function completionScenario(generated: boolean, fault: SuccessorFault, options: { parent?: 'refused' | 'zero'; recurrence?: string } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(OUTCOME_NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createInMemorySupabase({
    userId: OUTCOME_USER, rpcRole: 'authenticated',
    uniques: { family_reminders: [['family_id', 'idempotency_key']] },
  });
  db.seed('families', [{ id: OUTCOME_FAMILY }]);
  db.seed('family_members', [{ id: 'outcome-member', family_id: OUTCOME_FAMILY, user_id: OUTCOME_USER, role: 'parent', is_active: true }]);
  db.seed('family_reminders', [{
    id: OUTCOME_PARENT, family_id: OUTCOME_FAMILY, created_by: OUTCOME_USER,
    title: 'Synthetic recurring task', notes: null, kind: 'time', priority: 'medium',
    recurrence: options.recurrence ?? 'daily', remind_at: OUTCOME_DUE, status: 'active', completed_at: null,
    member_id: null, location_name: null, tags: [], autopilot_origin: generated,
    autopilot_card_id: generated ? OUTCOME_CARD : null,
  }]);
  if (generated) db.seed('autopilot_suggestions', [{
    id: OUTCOME_CARD, family_id: OUTCOME_FAMILY, member_id: null, kind: 'renewal', action_type: 'create_reminder',
    title: 'Synthetic source card', status: 'executed', payload: {}, expires_at: null,
  }]);
  let attempts = 0;
  const writes: { operation: string; payload: unknown }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
  const refused = (code: string, message: string): Reply => ({
    data: null, error: { code, message, details: null, hint: null }, count: null, status: 400, statusText: 'Bad Request',
  });
  async function successor(proceed: () => PromiseLike<Reply>): Promise<Reply> {
    attempts++;
    const current = attempts === 1 ? fault : { kind: 'none' } as const;
    if (current.kind === 'refused') return refused('42501', 'Synthetic definite refusal');
    if (current.kind === 'throw-before-commit') throw new Error('Synthetic transport failure before commit');
    const result = await proceed();
    expect(result.error, 'real ordinary/trusted writer must commit before response is lost').toBeNull();
    expect(db.table('family_reminders').filter(row => row.id !== OUTCOME_PARENT)).toHaveLength(attempts);
    if (current.kind === 'returned-after-commit') return refused('', 'Synthetic transport response lost after commit');
    if (current.kind === 'throw-after-commit') throw new Error('Synthetic transport response lost after commit');
    if (current.kind === 'receipt') return { ...result, data: current.transform(result.data as Record<string, unknown>) };
    return result;
  }
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(table => {
    const object = from(table);
    let operation = 'read';
    let once: Promise<Reply> | undefined;
    const proxy: typeof object = new Proxy(object, {
      get(target, property) {
        if (property === 'then') return (resolve: (reply: Reply) => unknown, reject: (reason: unknown) => unknown) => {
          once ??= table === 'family_reminders' && operation === 'insert'
            ? successor(() => target)
            : table === 'family_reminders' && operation === 'update' && options.parent
              ? Promise.resolve(options.parent === 'refused'
                ? refused('42501', 'Synthetic completion refusal')
                : { data: [], error: null, count: null, status: 200, statusText: 'OK' })
              : Promise.resolve(target);
          return once.then(resolve, reject);
        };
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['insert', 'update', 'delete', 'upsert'].includes(String(property))) {
            operation = String(property);
            writes.push({ operation, payload: args[0] });
          }
          const result = Reflect.apply(value, target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  });
  const rpc = db.rpc.bind(db);
  vi.spyOn(db, 'rpc').mockImplementation((name, args) => {
    rpcCalls.push({ name, args });
    if (name !== 'repeat_card_family_reminder') return rpc(name, args);
    const request = successor(() => rpc(name, args).maybeSingle());
    return Object.assign(request, { maybeSingle: () => request, single: () => request });
  });
  const complete = buildAssistantTools(db as unknown as DbArg, {
    familyId: OUTCOME_FAMILY, userId: OUTCOME_USER, memberId: 'outcome-member', role: 'parent', members: [], tz: 'UTC',
  }).find(candidate => candidate.name === 'complete_reminder')!;
  return { db, writes, rpcCalls, attempts: () => attempts, execute: () => complete.execute({ title: 'Synthetic recurring task' }) };
}

function assertDurableCompletion(scenario: ReturnType<typeof completionScenario>, generated: boolean, children: number) {
  expect(scenario.db.table('family_reminders').find(row => row.id === OUTCOME_PARENT)).toMatchObject({ status: 'completed', completed_at: OUTCOME_NOW });
  expect(scenario.writes.filter(write => write.operation === 'update')).toEqual([
    { operation: 'update', payload: { status: 'completed', completed_at: OUTCOME_NOW } },
  ]);
  expect(scenario.writes.some(write => ['delete', 'upsert'].includes(write.operation))).toBe(false);
  expect(scenario.attempts()).toBe(1);
  expect(scenario.rpcCalls).toEqual(generated ? [{ name: 'repeat_card_family_reminder', args: { p_parent_id: OUTCOME_PARENT, p_at: OUTCOME_NEXT } }] : []);
  expect(scenario.writes.filter(write => write.operation === 'insert')).toHaveLength(generated ? 0 : 1);
  const saved = scenario.db.table('family_reminders').filter(row => row.id !== OUTCOME_PARENT);
  expect(saved).toHaveLength(children);
  for (const row of saved) expect(row).toMatchObject({
    family_id: OUTCOME_FAMILY, remind_at: OUTCOME_NEXT, status: 'active',
    autopilot_origin: generated, autopilot_card_id: generated ? OUTCOME_CARD : null,
  });
}

describe('assistant recurrence outcome after a confirmed completion', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([false, true])('keeps the healthy generated=%s recurrence path', async generated => {
    const scenario = completionScenario(generated, { kind: 'none' });
    expect(await scenario.execute()).toEqual({ ok: true, summary: 'Completed “Synthetic recurring task” — next one scheduled.' });
    assertDurableCompletion(scenario, generated, 1);
  });

  it.each([false, true].flatMap(generated => [
    { kind: 'refused', children: 0 }, { kind: 'throw-before-commit', children: 0 },
    { kind: 'returned-after-commit', children: 1 }, { kind: 'throw-after-commit', children: 1 },
  ].map(fault => ({ generated, ...fault }))))('reports partial completion for $kind generated=$generated without restoring or retrying', async ({ generated, kind, children }) => {
    const scenario = completionScenario(generated, { kind: kind as Exclude<SuccessorFault['kind'], 'receipt'> });
    const result = await scenario.execute().catch(error => ({ escapedException: String(error) }));
    expect.soft(result).toEqual({ ok: false, error: PARTIAL_COMPLETION });
    assertDurableCompletion(scenario, generated, children);
  });

  const receipts: { name: string; transform: (receipt: Record<string, unknown>) => unknown }[] = [
    { name: 'missing receipt', transform: () => null },
    { name: 'missing id', transform: receipt => { const copy = { ...receipt }; delete copy.id; return copy; } },
    { name: 'empty id', transform: receipt => ({ ...receipt, id: '' }) },
    { name: 'whitespace id', transform: receipt => ({ ...receipt, id: '  ' }) },
    { name: 'numeric id', transform: receipt => ({ ...receipt, id: 17 }) },
    { name: 'foreign family', transform: receipt => ({ ...receipt, family_id: 'foreign-family' }) },
    { name: 'changed origin', transform: receipt => ({ ...receipt, autopilot_origin: false }) },
    { name: 'wrong source card', transform: receipt => ({ ...receipt, autopilot_card_id: 'other-card' }) },
  ];
  it.each(receipts)('does not claim a verified successor for $name after its actual commit', async ({ transform }) => {
    const scenario = completionScenario(true, { kind: 'receipt', transform });
    expect.soft(await scenario.execute()).toEqual({ ok: false, error: PARTIAL_COMPLETION });
    assertDurableCompletion(scenario, true, 1);
  });

  it.each([false, true].flatMap(generated => (['refused', 'zero'] as const).map(parent => ({ generated, parent }))))('keeps the $parent parent boundary generated=$generated without scheduling', async ({ generated, parent }) => {
    const scenario = completionScenario(generated, { kind: 'none' }, { parent });
    expect(await scenario.execute()).toEqual({ ok: false, error: 'Could not complete the reminder.' });
    expect(scenario.attempts()).toBe(0);
    expect(scenario.rpcCalls).toEqual([]);
    expect(scenario.writes).toEqual([{ operation: 'update', payload: { status: 'completed', completed_at: OUTCOME_NOW } }]);
    expect(scenario.db.table('family_reminders')).toHaveLength(1);
    expect(scenario.db.table('family_reminders')[0]).toMatchObject({ status: 'active', completed_at: null });
  });

  it.each([false, true])('completes one-off generated=%s without trying a successor', async generated => {
    const scenario = completionScenario(generated, { kind: 'none' }, { recurrence: 'none' });
    expect(await scenario.execute()).toEqual({ ok: true, summary: 'Completed “Synthetic recurring task”.' });
    expect(scenario.attempts()).toBe(0);
    expect(scenario.rpcCalls).toEqual([]);
    expect(scenario.writes).toEqual([{ operation: 'update', payload: { status: 'completed', completed_at: OUTCOME_NOW } }]);
    expect(scenario.db.table('family_reminders')).toHaveLength(1);
    expect(scenario.db.table('family_reminders')[0]).toMatchObject({ status: 'completed', completed_at: OUTCOME_NOW });
  });

  it('cannot materialize two manual children for the original due date after a lost reply and a later title completion', async () => {
    const scenario = completionScenario(false, { kind: 'returned-after-commit' });
    await scenario.execute();
    await scenario.execute();
    // The second explicit call can complete the NEXT active occurrence. This
    // asserts no duplicate of the original occurrence, not general retry safety.
    expect(scenario.db.table('family_reminders').filter(row => row.remind_at === OUTCOME_NEXT)).toHaveLength(1);
    expect(scenario.attempts()).toBe(2);
  });
});
