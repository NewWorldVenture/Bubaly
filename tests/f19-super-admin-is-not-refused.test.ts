import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { admitAiRequest, type AdmitArgs } from './helpers/admit-ai-request';

// F19. `assertAIAccess` never refuses a super-administrator on the monthly
// allowance (it reads the email off the signed-in context). The atomic
// admission (0477) runs behind `withAiRequest` and the concierge intake, where
// a scope carries no email, so a super-admin acting in a Free family at 10 of
// 10 passed the gate and was then refused by the admission. Only after a
// refusal, the caller is now looked up by user id; a super-admin's row is
// filed as before 0477 (plainly, counted) and the work runs. Everything else
// keeps the refusal, including a lookup that fails.
//
// Drives the REAL `withAiRequest`, `submitRequest`, `assertAIAccess` and
// `isSuperAdminCaller` over one in-memory database; the ledger client's
// `auth.admin.getUserById` answers from `state.emails`.

const FAMILY = 'fam-1';
const ADMIN = 'user-admin';
const PARENT = 'user-parent';
const ADMIN_EMAIL = 'root@bubaly.test';

const state = vi.hoisted(() => ({
  emails: {} as Record<string, string>,
  lookupFails: false,
  lookups: 0,
}));

let store: InMemorySupabase;

function client() {
  return {
    from: (table: string) => store.from(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'admit_ai_request') return { data: null, error: { code: 'PGRST202', message: `unexpected rpc ${name}` } };
      return admitAiRequest(db, args as unknown as AdmitArgs);
    },
    auth: {
      getUser: async () => ({ data: { user: { id: PARENT } }, error: null }),
      admin: {
        getUserById: async (id: string) => {
          state.lookups += 1;
          if (state.lookupFails) return { data: { user: null }, error: { message: 'auth admin unavailable' } };
          return { data: { user: { id, email: state.emails[id] ?? null } }, error: null };
        },
      },
    },
  };
}
const db = { from: (t: string) => client().from(t), rpc: (n: string, a: Record<string, unknown>) => client().rpc(n, a), auth: client().auth };

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 0 }));
vi.mock('@/lib/server/feature-tiers', () => ({ getResolvedFeatureTiers: async () => ({ 'ai-requests': 'free' }) }));
vi.mock('@/lib/ai/context/intents', () => ({
  classifyIntent: async () => ({ intent: 'plan_week', confidence: 0.9, entities: {}, source: 'fast_path' }),
  isIntentKey: (v: unknown) => typeof v === 'string',
}));
vi.mock('@/lib/ai/context/builder', () => ({
  buildContext: async () => ({ ok: true, data: { header: {}, slices: {}, stats: {}, sensitiveOmitted: [], text: 'ctx' } }),
}));
const planRequest = vi.fn(async () => ({ ok: true, data: { kind: 'plan', planId: 'plan-1', runId: 'run-1', stepCount: 1, riskLevel: 'low', requiresApproval: false, summary: 'Planned.' } }));
vi.mock('@/lib/ai/planner', () => ({ planRequest: () => planRequest() }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {} }));

const { withAiRequest, AiRequestOverAllowance } = await import('@/lib/ai/observability');
const { submitRequest } = await import('@/lib/ai/runs/intake');
const { assertAIAccess } = await import('@/lib/server/ai-access');

const scopeOf = (userId: string, actorKind: ServiceScope['actorKind'] = 'member'): ServiceScope => ({
  db: db as unknown as ServiceScope['db'],
  familyId: FAMILY, userId, memberId: `member-${userId}`, role: 'parent', actorKind, tz: 'UTC',
});
const ctxOf = (userId: string, email: string) => ({
  user: { id: userId, email }, memberships: [],
  active: { familyId: FAMILY, role: 'parent', member: { id: `member-${userId}` }, family: { name: 'Fam', timezone: 'UTC' } },
});

const model = vi.fn(async () => 'answer');
const paid = (userId: string, actorKind: ServiceScope['actorKind'] = 'member') =>
  withAiRequest(scopeOf(userId, actorKind), { feature: 'notes.summary', text: 'Summarise a note' }, () => model());
const rows = () => store.table('ai_requests').filter((r: Row) => r.family_id === FAMILY);
function seedPaid(n: number) {
  store.seed('ai_requests', Array.from({ length: n }, (_, i) => ({ family_id: FAMILY, kind: 'feature', feature: 'notes.summary', status: 'completed', request_text: `paid ${i}` })));
}

const previousEnv = process.env.SUPER_ADMIN_EMAILS;
beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ADMIN_EMAIL;
  store = createInMemorySupabase({ userId: PARENT, uniques: { ai_requests: [['family_id', 'client_request_id']] } });
  state.emails = { [ADMIN]: ADMIN_EMAIL, [PARENT]: 'parent@example.com' };
  state.lookupFails = false;
  state.lookups = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = previousEnv;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('a super-administrator is not refused by the admission, as the gate promised', () => {
  it('the gate passes a super-admin at 10 of 10, and so does the admission: the work runs and its row is filed, counted', async () => {
    seedPaid(10);
    const gate = await assertAIAccess(ctxOf(ADMIN, ADMIN_EMAIL) as never, { db: db as never });
    expect(gate.ok).toBe(true);

    await expect(paid(ADMIN)).resolves.toBe('answer');
    expect(model).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(11);
    expect(rows().at(-1)).toMatchObject({ requested_by: ADMIN, metered: true });
    expect(state.lookups).toBe(1);
  });

  it('the assistant\'s own scope (actorKind ai) for a super-admin is not refused either', async () => {
    seedPaid(10);
    await expect(paid(ADMIN, 'ai')).resolves.toBe('answer');
    expect(rows()).toHaveLength(11);
  });

  it('a super-admin\'s concierge request at 10 of 10 is filed and planned', async () => {
    seedPaid(10);
    const result = await submitRequest(scopeOf(ADMIN), { text: 'Plan our week' }, { kick: vi.fn() });
    expect(result.ok).toBe(true);
    expect(planRequest).toHaveBeenCalledTimes(1);
    expect(rows().at(-1)).toMatchObject({ kind: 'concierge', requested_by: ADMIN, metered: true });
  });

  it('negative control: an ordinary member at 10 of 10 is still refused, nothing run or filed', async () => {
    seedPaid(10);
    const gate = await assertAIAccess(ctxOf(PARENT, 'parent@example.com') as never, { db: db as never });
    expect(gate).toMatchObject({ ok: false, code: 'allowance_exceeded' });
    await expect(paid(PARENT)).rejects.toBeInstanceOf(AiRequestOverAllowance);
    expect(await submitRequest(scopeOf(PARENT), { text: 'Plan our week' }, { kick: vi.fn() }))
      .toMatchObject({ ok: false, code: 'allowance_exceeded', limit: 10 });
    expect(model).not.toHaveBeenCalled();
    expect(planRequest).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(10);
  });

  it('a lookup that fails keeps the refusal (fail closed)', async () => {
    seedPaid(10);
    state.lookupFails = true;
    await expect(paid(ADMIN)).rejects.toBeInstanceOf(AiRequestOverAllowance);
    expect(model).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(10);
  });

  it('the ordinary path makes no lookup: under the cap, a super-admin is simply admitted', async () => {
    seedPaid(3);
    await paid(ADMIN);
    await paid(PARENT);
    expect(state.lookups).toBe(0);
    expect(rows()).toHaveLength(5);
  });

  it('racing at 9 of 10: the member\'s request and the super-admin\'s both run; a second member\'s is refused', async () => {
    seedPaid(9);
    const results = await Promise.allSettled([paid(PARENT), paid(ADMIN), paid(PARENT)]);
    const ran = results.filter((r) => r.status === 'fulfilled').length;
    // One member request is admitted at 9; the super-admin runs whether admitted
    // or not; the remaining member request is refused.
    expect(ran).toBe(2);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof AiRequestOverAllowance)).toHaveLength(1);
    expect(rows().filter((r: Row) => r.requested_by === ADMIN)).toHaveLength(1);
  });
});
