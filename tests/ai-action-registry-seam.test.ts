// `runAction` is the one name that both Magic Import and the trust queue's
// auto-execute hold on to, and since the tool registry landed it is a front
// door rather than an implementation. These tests are about the seam itself —
// the three things that would break a caller if the delegation got them wrong:
//
//   • WHICH names delegate. A name the registry resolves must go to
//     `executeTool`; one it does not must still run the hand-written branch, or
//     meal planning silently stops working.
//   • WHO checked trust. The approval-replay path MUST suppress the registry's
//     gate: re-evaluating a decision a parent already made opens a second
//     approval for the same work and the approved action never runs. Every
//     other caller must NOT suppress it.
//   • WHAT `ok` means. `ok: true` is "the change happened". A denial or a
//     pending approval is not a change, so neither may come back as `ok`, or
//     Magic Import counts it as created and the trust queue stamps it executed.
//
// `executeTool` is mocked at the module boundary because its own behaviour is
// covered by tests/tool-execute.test.ts; what is under test here is the
// translation on either side of it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { ToolOutcome } from '@/lib/ai/tools/types';

const executeTool = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/tools/execute', () => ({ executeTool }));

const { runAction } = await import('@/lib/ai/actions');
const { getTool } = await import('@/lib/ai/tools/registry');

type Call = { table: string; kind: 'select' | 'insert'; filters: Record<string, unknown>; payload?: unknown };

/** Chainable PostgREST fake, thenable so both terminal styles resolve. */
function makeDb(respond: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, order: chain, limit: chain, is: chain,
      eq: (column: string, value: unknown) => { call.filters[column] = value; return b; },
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: { data: unknown; error: unknown }) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const MEMBER = { id: 'member-1', role: 'parent' };
const FAMILY = { timezone: 'America/New_York' };

function ctxWith(overrides: Partial<Record<string, { data: unknown; error: unknown }>> = {}) {
  const { db, calls } = makeDb((call) => {
    const override = overrides[call.table];
    if (override) return override;
    if (call.table === 'family_members') return { data: MEMBER, error: null };
    if (call.table === 'families') return { data: FAMILY, error: null };
    if (call.kind === 'insert') return { data: { id: `${call.table}-row` }, error: null };
    return { data: null, error: null };
  });
  return { ctx: { supabase: db, familyId: 'fam-1', userId: 'user-1' }, calls };
}

const okOutcome: ToolOutcome = { status: 'ok', data: { id: 'evt-1' }, summary: 'Added soccer.', toolCallId: 'call-1' };

beforeEach(() => {
  executeTool.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runAction → tool registry', () => {
  it('delegates a registry-covered name with the acting member, role and family zone', async () => {
    executeTool.mockResolvedValueOnce(okOutcome);
    const { ctx } = ctxWith();

    const result = await runAction(ctx, { name: 'create_calendar_event', args: { title: 'Soccer', starts_at: '2026-09-12T09:00:00Z' } });

    expect(result).toEqual({ ok: true, data: { id: 'evt-1' }, summary: 'Added soccer.' });
    expect(executeTool).toHaveBeenCalledTimes(1);
    const [scope, name, args, opts] = executeTool.mock.calls[0] as [ServiceScope, string, unknown, { skipTrust: boolean }];
    // The legacy flat name is passed through untranslated — the registry
    // resolves it as an alias, which is what keeps a stored payload executing.
    expect(name).toBe('create_calendar_event');
    expect(args).toEqual({ title: 'Soccer', starts_at: '2026-09-12T09:00:00Z' });
    // `memberId` is the family_members row, not the auth user id: that is the
    // value the household tables' `created_by` columns actually reference.
    expect(scope).toMatchObject({
      familyId: 'fam-1', userId: 'user-1', memberId: 'member-1', role: 'parent',
      actorKind: 'ai', tz: 'America/New_York',
    });
    expect(scope.db).toBe(ctx.supabase);
    expect(opts.skipTrust).toBe(false);
  });

  it('suppresses the registry gate only when the caller says it already authorized the call', async () => {
    executeTool.mockResolvedValue(okOutcome);
    const { ctx } = ctxWith();

    await runAction(ctx, { name: 'add_todo', args: { task: 'Dishes' } });
    await runAction(ctx, { name: 'add_todo', args: { task: 'Dishes' } }, { alreadyAuthorized: true });

    expect(executeTool.mock.calls[0][3]).toEqual({ skipTrust: false });
    // This is the approval-replay contract: the approval WAS the gate.
    expect(executeTool.mock.calls[1][3]).toEqual({ skipTrust: true });
  });

  it('never reports a denial or a pending approval as a completed change', async () => {
    const { ctx } = ctxWith();

    executeTool.mockResolvedValueOnce({ status: 'denied', reason: 'Household policy says no.', toolCallId: null });
    expect(await runAction(ctx, { name: 'add_chore', args: { title: 'Bins' } }))
      .toEqual({ ok: false, error: 'Household policy says no.' });

    executeTool.mockResolvedValueOnce({ status: 'pending_approval', approvalId: 'appr-1', summary: 'Waiting on a parent.', toolCallId: null });
    expect(await runAction(ctx, { name: 'add_chore', args: { title: 'Bins' } }))
      .toEqual({ ok: false, error: 'Waiting on a parent.' });

    executeTool.mockResolvedValueOnce({ status: 'error', error: 'The calendar is unavailable.', retryable: true, toolCallId: null });
    expect(await runAction(ctx, { name: 'add_chore', args: { title: 'Bins' } }))
      .toEqual({ ok: false, error: 'The calendar is unavailable.' });
  });

  it('fails closed, without executing, when the acting member cannot be resolved', async () => {
    const { ctx } = ctxWith({ family_members: { data: null, error: { message: 'permission denied' } } });

    const result = await runAction(ctx, { name: 'create_calendar_event', args: { title: 'Soccer', starts_at: '2026-09-12T09:00:00Z' } });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // A write that cannot be attributed must not happen at all.
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('resolves the member and zone once per client, not once per action', async () => {
    executeTool.mockResolvedValue(okOutcome);
    const { ctx, calls } = ctxWith();

    // Magic Import confirms up to 50 items through one client in a single
    // Promise.all; re-reading these two rows per item would be 100 round trips.
    await Promise.all([
      runAction(ctx, { name: 'add_grocery_item', args: { name: 'Milk' } }),
      runAction(ctx, { name: 'add_grocery_item', args: { name: 'Eggs' } }),
      runAction(ctx, { name: 'add_grocery_item', args: { name: 'Bread' } }),
    ]);

    expect(executeTool).toHaveBeenCalledTimes(3);
    // Those three raced, so each may have missed the cache; what matters is that
    // the identity is cached by the time they finish.
    const readsAfterBurst = calls.filter((c) => c.table === 'families').length;
    expect(readsAfterBurst).toBeLessThanOrEqual(3);

    // A fresh ctx object over the SAME client adds no read — the cache is keyed
    // on the client, which is what survives across a request's calls.
    await runAction({ ...ctx }, { name: 'add_grocery_item', args: { name: 'Butter' } });
    expect(calls.filter((c) => c.table === 'families').length).toBe(readsAfterBurst);
    expect(calls.filter((c) => c.table === 'family_members').length).toBe(readsAfterBurst);
    expect(executeTool).toHaveBeenCalledTimes(4);
  });

  it('still runs the hand-written branch for a name the registry does not cover', async () => {
    const { ctx, calls } = ctxWith();

    const result = await runAction(ctx, { name: 'create_meal_plan_entry', args: { meal_name: 'Tacos', plan_date: '2026-09-06' } });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Planned "Tacos" for 2026-09-06.');
    expect(executeTool).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.kind === 'insert').map((c) => c.table)).toEqual(['meals', 'meal_plans']);
  });

  it('refuses an unknown name rather than delegating it', async () => {
    const { ctx } = ctxWith();
    expect(await runAction(ctx, { name: 'finances_transferMoney', args: {} }))
      .toEqual({ ok: false, error: 'That action is not available.' });
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe('legacy payload shapes still parse', () => {
  // `AI_TOOLS` declares `add_grocery_item` with the item under `name`, so that
  // is what the model emits and what Magic Import stores. Resolving the alias
  // but then dropping the item would be silent data loss — worse than a refusal
  // — so the tool accepts both single-item spellings.
  it.each([
    ['name', { name: 'Milk', quantity: '2%' }],
    ['item', { item: 'Milk', quantity: '2%' }],
  ])('accepts the single-item form spelled `%s`', (_spelling, args) => {
    const tool = getTool('add_grocery_item');
    expect(tool?.name).toBe('groceries.addItems');
    const parsed = tool!.input.safeParse(args);
    expect(parsed.success).toBe(true);
  });

  it('resolves every name lib/ai/actions.ts still declares to the model', () => {
    // AI_TOOLS is what Magic Import sends the model, so each of its names must
    // either resolve in the registry or have a branch in the switch. This pins
    // the split so a tool added to one side is not silently unroutable.
    const registryCovered = ['create_calendar_event', 'create_chore', 'create_reminder', 'add_grocery_item'];
    for (const name of registryCovered) expect(getTool(name), name).toBeTruthy();
    expect(getTool('create_meal_plan_entry')).toBeNull();
  });
});
