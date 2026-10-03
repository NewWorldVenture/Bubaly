import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { admitAiRequest, type AdmitArgs } from './helpers/admit-ai-request';

// F19, the concierge half. Ask Bubaly (`submitRequest` in lib/ai/runs/intake.ts,
// behind POST /api/ai/requests, the concierge form action and the inbox
// action) checked the allowance with `assertAIAccess` and then filed its
// `concierge` row with a plain insert. The count and the insert were two
// statements, so two submissions at 9 of 10 both read 9 and both filed: 11
// rows and two planner calls. On a capped plan the row is now ADMITTED —
// counted and filed as one decision under a per-family lock
// (`admit_ai_request`, 0477) — and the loser gets the gate's own 429
// `allowance_exceeded` with `limit`, before anything is classified or planned.
//
// This drives the REAL intake, the REAL store and the REAL route over one
// in-memory database. The member's client and the ledger (service) client are
// two views of it, so the test can see which one filed the row; the ledger's
// `rpc` serves `admit_ai_request` from the same table
// (tests/helpers/admit-ai-request.ts). Only identity, plan/tier settings, rate
// limits and the model steps (classifier, context, planner, kick) are fixed.

const FAMILY = 'fam-1';
const USER = 'user-1';
const MEMBER = 'member-1';

const state = vi.hoisted(() => ({
  planLevel: 0 as number | 'throws',
  /** 'missing': `admit_ai_request` is not deployed (this code shipped before 0477). */
  rpcFault: null as null | 'missing',
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /** Which client inserted each ai_requests row: the member's own, or the ledger. */
  inserts: [] as Array<'member' | 'ledger'>,
  /** Holds every route request after the gate's count until all have counted: the race, made deterministic. */
  barrier: null as null | { waiting: number; size: number; release: () => void; gate: Promise<void> },
}));

let store: InMemorySupabase;

/** A view of `store` that records which client inserted into ai_requests. */
function view(who: 'member' | 'ledger') {
  return {
    from: (table: string) => {
      const builder = store.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const insert = builder.insert.bind(builder);
      builder.insert = (...a: unknown[]) => {
        if (table === 'ai_requests') state.inserts.push(who);
        return insert(...a);
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      // admit_ai_request is service-role only (0477): a member's client is refused.
      if (who === 'member') return { data: null, error: { code: '42501', message: `permission denied for function ${name}` } };
      if (state.rpcFault === 'missing') {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } };
      }
      // Through the ledger VIEW, so the emulated insert is recorded as the ledger's.
      return admitAiRequest(ledgerDb, args as unknown as AdmitArgs);
    },
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
  };
}
const memberDb = view('member');
const ledgerDb = view('ledger');

const classifyIntent = vi.fn();
const buildContext = vi.fn();
const planRequest = vi.fn();
const kickRun = vi.fn();

const ctx = {
  user: { id: USER, email: 'parent@example.com' },
  memberships: [],
  active: { familyId: FAMILY, role: 'parent', member: { id: MEMBER }, family: { name: 'Fam', timezone: 'UTC' } },
};

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => memberDb, createServiceClient: () => ledgerDb }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: async () => ctx, requireUserContext: async () => ctx }));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: async () => true }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/feature-tiers', () => ({ getResolvedFeatureTiers: async () => ({ 'ai-requests': 'free' }) }));
vi.mock('@/lib/server/plan', () => ({
  resolveFamilyPlanLevel: async () => {
    if (state.planLevel === 'throws') throw new Error('plan read failed');
    return state.planLevel;
  },
}));
vi.mock('@/lib/ai/provider', () => ({
  // Called by the route after the gate's count and before the intake files:
  // the barrier holds every racer here until all of them have counted.
  isAIConfigured: async () => {
    const b = state.barrier;
    if (b) {
      b.waiting += 1;
      if (b.waiting >= b.size) b.release();
      await b.gate;
    }
    return true;
  },
}));
vi.mock('@/lib/ai/context/intents', () => ({
  classifyIntent: (...a: unknown[]) => classifyIntent(...a),
  isIntentKey: (v: unknown) => typeof v === 'string',
}));
vi.mock('@/lib/ai/context/builder', () => ({ buildContext: (...a: unknown[]) => buildContext(...a) }));
vi.mock('@/lib/ai/planner', () => ({ planRequest: (...a: unknown[]) => planRequest(...a) }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: (...a: unknown[]) => kickRun(...a) }));

const { submitRequest } = await import('@/lib/ai/runs/intake');
const { POST } = await import('@/app/api/ai/requests/route');

const scope = (): ServiceScope => ({
  db: memberDb as unknown as ServiceScope['db'],
  familyId: FAMILY, userId: USER, memberId: MEMBER, role: 'parent', actorKind: 'member', tz: 'UTC',
});

function seed(n: number, extra: Row = {}) {
  store.seed('ai_requests', Array.from({ length: n }, (_, i) => ({
    family_id: FAMILY, kind: 'feature', status: 'completed', request_text: `earlier ${i}`, client_request_id: null, ...extra,
  })));
}
const rows = () => store.table('ai_requests').filter((r) => r.family_id === FAMILY);

function post(body: unknown) {
  return new NextRequest('http://localhost/api/ai/requests', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function race(size: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  state.barrier = { waiting: 0, size, release, gate };
}

beforeEach(() => {
  store = createInMemorySupabase({ userId: USER, uniques: { ai_requests: [['family_id', 'client_request_id']] } });
  state.planLevel = 0;
  state.rpcFault = null;
  state.rpcCalls = [];
  state.inserts = [];
  state.barrier = null;
  let n = 0;
  classifyIntent.mockResolvedValue({ intent: 'plan_week', confidence: 0.9, entities: {}, source: 'fast_path' });
  buildContext.mockResolvedValue({ ok: true, data: { header: {}, slices: {}, stats: {}, sensitiveOmitted: [], text: 'ctx' } });
  planRequest.mockImplementation(async () => {
    n += 1;
    return { ok: true, data: { kind: 'plan', planId: `plan-${n}`, runId: `run-${n}`, stepCount: 2, riskLevel: 'low', requiresApproval: false, summary: 'Planned the week.' } };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('F19: the concierge intake admits its request atomically', () => {
  it('two submissions racing at 9 of 10 file and plan exactly one; the other is refused with the allowance shape', async () => {
    seed(9);
    const kick = vi.fn();
    const results = await Promise.all([
      submitRequest(scope(), { text: 'Plan our week' }, { kick }),
      submitRequest(scope(), { text: 'Plan our weekend' }, { kick }),
    ]);

    expect(rows()).toHaveLength(10);
    expect(planRequest).toHaveBeenCalledTimes(1);
    expect(classifyIntent).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(refused).toMatchObject({ ok: false, status: 429, code: 'allowance_exceeded', limit: 10 });
    // The admitted row went through the ledger's admission, not the member's insert.
    expect(state.inserts).toEqual(['ledger']);
  });

  it('two POSTs racing past the gate at 9 of 10: one 202, one localized 429 allowance_exceeded with limit, planner once', async () => {
    seed(9);
    race(2);
    const responses = await Promise.all([POST(post({ text: 'Plan our week' })), POST(post({ text: 'Plan our weekend' }))]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([202, 429]);
    const refusal = await responses.find((r) => r.status === 429)!.json();
    expect(refusal).toEqual({
      error: 'Your family has used its 10 AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.',
      code: 'allowance_exceeded', limit: 10,
    });
    expect(rows()).toHaveLength(10);
    expect(planRequest).toHaveBeenCalledTimes(1);
    expect(kickRun).toHaveBeenCalledTimes(1);
  });

  it('eight POSTs racing at 9 of 10 file exactly one row', async () => {
    seed(9);
    race(8);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => POST(post({ text: `Plan item ${i}` }))));
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(7);
    expect(rows()).toHaveLength(10);
    expect(planRequest).toHaveBeenCalledTimes(1);
  });

  it('a keyed retry at 10 of 10 replays the request it already filed: no refusal, no new row, no planning', async () => {
    seed(9);
    const first = await submitRequest(scope(), { text: 'Plan our week', clientRequestId: 'retry-key-0001' }, { kick: vi.fn() });
    expect(first.ok).toBe(true);
    expect(rows()).toHaveLength(10);
    // The first submission's run, as the planner left it.
    const requestId = first.ok ? first.data.requestId : '';
    store.seed('family_automation_runs', [{ family_id: FAMILY, request_id: requestId, plan_id: 'plan-1', state: 'ready', summary: 'Planned the week.' }]);
    planRequest.mockClear();

    const retry = await submitRequest(scope(), { text: 'Plan our week', clientRequestId: 'retry-key-0001' }, { kick: vi.fn() });
    expect(retry).toMatchObject({ ok: true, data: { requestId, outcome: 'plan', planId: 'plan-1', replayed: true } });
    expect(rows()).toHaveLength(10);
    expect(planRequest).not.toHaveBeenCalled();
    expect(state.rpcCalls.at(-1)?.args).toMatchObject({ p_client_request_id: 'retry-key-0001' });

    // Through the route, the gate (`assertAIAccess`) counts 10 of 10 and
    // answers 429 BEFORE the intake is reached. That ordering predates this fix
    // and is outside the intake; pinned here so a change to it is deliberate.
    const res = await POST(post({ text: 'Plan our week', clientRequestId: 'retry-key-0001' }));
    expect(res.status).toBe(429);
    expect(state.rpcCalls).toHaveLength(2);
    expect(rows()).toHaveLength(10);
  });

  it('an unlimited plan files plainly on the member client and is never refused', async () => {
    state.planLevel = 1;
    seed(25);
    const kick = vi.fn();
    const results = await Promise.all([
      submitRequest(scope(), { text: 'Plan our week' }, { kick }),
      submitRequest(scope(), { text: 'Plan our weekend' }, { kick }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(rows()).toHaveLength(27);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.inserts).toEqual(['member', 'member']);
    expect(planRequest).toHaveBeenCalledTimes(2);
  });

  it('a capped plan whose admission function is missing (deployed before 0477) is refused: nothing filed or planned', async () => {
    state.rpcFault = 'missing';
    seed(3);
    const result = await submitRequest(scope(), { text: 'Plan our week' }, { kick: vi.fn() });
    expect(result.ok).toBe(false);
    expect(rows()).toHaveLength(3);
    expect(state.inserts).toEqual([]);
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('a plan that cannot be read files plainly (withAiRequest\'s rule), and a failed filing plans nothing', async () => {
    state.planLevel = 'throws';
    seed(3);
    const filed = await submitRequest(scope(), { text: 'Plan our week' }, { kick: vi.fn() });
    expect(filed.ok).toBe(true);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.inserts).toEqual(['member']);
  });

  it('the admitted row carries the requester from the verified scope, and the intake\'s columns', async () => {
    seed(2);
    store.seed('ai_conversations', [{ id: '11111111-1111-4111-8111-111111111111', family_id: FAMILY, user_id: USER }]);
    const result = await submitRequest(
      scope(),
      { text: '  Plan our week  ', conversationId: '11111111-1111-4111-8111-111111111111', clientRequestId: 'key-scope-0001' },
      { kick: vi.fn() },
    );
    expect(result.ok).toBe(true);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      name: 'admit_ai_request',
      args: {
        p_family_id: FAMILY, p_allowance: 10, p_kind: 'concierge', p_request_text: 'Plan our week',
        p_requested_by: USER, p_requested_by_member_id: MEMBER,
        p_conversation_id: '11111111-1111-4111-8111-111111111111', p_feature: null, p_client_request_id: 'key-scope-0001',
      },
    });
    const row = rows().find((r) => r.client_request_id === 'key-scope-0001');
    expect(row).toMatchObject({ kind: 'concierge', requested_by: USER, requested_by_member_id: MEMBER, feature: null });
  });
});
