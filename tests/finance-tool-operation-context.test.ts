import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

const mocks = vi.hoisted(() => ({
  getTool: vi.fn(),
  createServiceClient: vi.fn(),
  evaluateTrust: vi.fn(),
}));

vi.mock('@/lib/ai/tools/registry', () => ({ getTool: mocks.getTool }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/trust/server', () => ({
  evaluateTrust: mocks.evaluateTrust,
  roleOf: (role: string) => role,
}));
vi.mock('@/lib/services/ai-settings', () => ({ getAISettings: async () => ({ enabled: true }) }));
vi.mock('@/lib/ai/family-settings', () => ({
  effectiveRisk: () => 'low',
  behaviorForDomain: () => 'recommend',
}));

const { executeTool } = await import('@/lib/ai/tools/execute');

type Call = { table: string; kind: 'select' | 'insert' | 'update'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

// Same thenable PostgREST recorder pattern as tool-execute.test.ts.
function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      eq: (column: string, value: unknown) => { call.filters[column] = value; return builder; },
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return builder; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return builder; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return builder;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function setup(existingState?: 'succeeded' | 'failed' | 'reserved') {
  const caller = makeDb(() => ({ data: null, error: null }));
  const supplied = makeDb(() => ({ data: null, error: null }));
  const ledger = makeDb((call) => {
    if (call.kind === 'insert' && existingState) {
      return { data: null, error: { code: '23505' } };
    }
    if (call.kind === 'select') {
      return { data: {
        id: 'reserved-operation', state: existingState, attempt: 1,
        locked_at: new Date().toISOString(), outputs: { result: { id: 'recorded-transaction' } },
      }, error: null };
    }
    return { data: { id: 'reserved-operation' }, error: null };
  });
  mocks.createServiceClient.mockReturnValue(ledger.db);
  const scope: ServiceScope = {
    db: caller.db, familyId: 'family-1', userId: 'user-1', memberId: 'member-1',
    role: 'parent', actorKind: 'ai', tz: 'America/New_York',
    toolOperation: { id: 'caller-supplied-operation', db: supplied.db },
  };
  const execute = vi.fn(async (_scope: ServiceScope, _input: { amount: number }) => ({
    ok: true as const, data: { id: 'created-transaction' },
  }));
  const tool = {
    name: 'finances.createTransaction', description: 'Record a purchase.',
    domain: 'finances', capability: 'create', risk: 'low', readOnly: false,
    input: z.object({ amount: z.number().positive() }),
    output: z.object({ id: z.string() }),
    execute, summarize: () => 'Recorded purchase', activityFrom: 'service',
  };
  mocks.getTool.mockReturnValue(tool);
  return { scope, caller, supplied, ledger, execute, tool };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluateTrust.mockResolvedValue({
    decision: { effect: 'allow', basis: 'policy', policyScope: 'specific', reason: 'Allowed by policy' },
  });
});

describe('finance executor operation-context handoff', () => {
  it('overwrites supplied identity and client with the reserved operation without replacing caller db', async () => {
    const { scope, caller, supplied, ledger, execute } = setup();
    const originalOperation = scope.toolOperation;
    const outcome = await executeTool(scope, 'finances.createTransaction', { amount: 12 }, { idempotencyKey: 'purchase-1' });

    expect(outcome).toMatchObject({ status: 'ok', toolCallId: 'reserved-operation' });
    expect(execute).toHaveBeenCalledTimes(1);
    const received = execute.mock.calls[0][0];
    expect(received).not.toBe(scope);
    expect(received.db).toBe(caller.db);
    expect(received.toolOperation?.id).toBe('reserved-operation');
    expect(received.toolOperation?.db).toBe(ledger.db);
    expect(received.toolOperation?.db).not.toBe(supplied.db);
    expect(received).toMatchObject({ familyId: scope.familyId, userId: scope.userId, memberId: scope.memberId, idempotencyKey: 'purchase-1' });
    expect(scope.toolOperation).toBe(originalOperation);
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateTrust.mock.calls[0][0]).toBe(caller.db);
    expect(ledger.calls[0]).toMatchObject({ table: 'ai_tool_calls', kind: 'insert' });
    expect(caller.calls).toHaveLength(0);
    expect(supplied.calls).toHaveLength(0);
  });

  it('hands a reclaimed reservation its existing identity rather than caller input', async () => {
    const { scope, ledger, execute } = setup('failed');
    const outcome = await executeTool(scope, 'finances.createTransaction', { amount: 12 });
    expect(outcome).toMatchObject({ status: 'ok', toolCallId: 'reserved-operation' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].toolOperation).toEqual({ id: 'reserved-operation', db: ledger.db });
    expect(ledger.calls).toContainEqual(expect.objectContaining({
      kind: 'update', filters: { id: 'reserved-operation', state: 'failed' },
    }));
  });

  it('replays a succeeded duplicate without executing the service', async () => {
    const { scope, execute } = setup('succeeded');
    const outcome = await executeTool(scope, 'finances.createTransaction', { amount: 12 });
    expect(outcome).toMatchObject({ status: 'ok', toolCallId: 'reserved-operation', data: { id: 'recorded-transaction' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute while an existing reservation is still held', async () => {
    const { scope, execute } = setup('reserved');
    const outcome = await executeTool(scope, 'finances.createTransaction', { amount: 12 });
    expect(outcome).toMatchObject({ status: 'error', retryable: true, toolCallId: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['deny', 'require_approval'] as const)('does not execute or reserve when trust returns %s', async (effect) => {
    const { scope, ledger, execute } = setup();
    mocks.evaluateTrust.mockResolvedValue({
      decision: { effect, basis: 'policy', policyScope: 'specific', reason: 'Policy boundary' },
      approvalId: effect === 'require_approval' ? 'approval-1' : null,
    });
    const outcome = await executeTool(scope, 'finances.createTransaction', { amount: 12 });
    expect(outcome.status).toBe(effect === 'deny' ? 'denied' : 'pending_approval');
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(ledger.calls).toHaveLength(0);
  });

  it.each([false, true])('leaves read-only scope behavior unchanged (supplied context: %s)', async (hasContext) => {
    const { scope, caller, ledger, execute, tool } = setup();
    tool.readOnly = true;
    if (!hasContext) delete scope.toolOperation;
    const outcome = await executeTool(scope, 'finances.createTransaction', { amount: 12 });
    expect(outcome).toMatchObject({ status: 'ok', toolCallId: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].db).toBe(caller.db);
    expect(execute.mock.calls[0][0].toolOperation).toBe(scope.toolOperation);
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(ledger.calls).toHaveLength(0);
  });
});
