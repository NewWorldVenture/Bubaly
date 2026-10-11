import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A LOCKED FAMILY GETS NO AI ALLOWANCE ANYWHERE (F19).
 *
 * Main's `assertAIAccess` refuses a locked entitlement outright: "a trial that
 * ended unpaid is level 0 like Free, but it is not Free: it gets no allowance
 * at all". The allowance every OTHER AI route checks — `assertAIAllowance`
 * (briefings, chat, voice, flyer…) and `assertFamilyAIAllowance` (the public
 * gift page) — read the plan level alone, so a trial-expired or closed family
 * was a Free family there and spent ten requests a month on every route but
 * the concierge.
 */
const state = vi.hoisted(() => ({
  entitlement: { effectiveLevel: 0, locked: false, closed: false, inTrial: false, trialEndsAt: null as string | null },
  used: 0,
  rpcCalls: 0,
}));

vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyEntitlement: async () => state.entitlement,
  resolveFamilyPlanLevel: async () => state.entitlement.effectiveLevel,
}));

const db = {
  rpc: async (name: string) => {
    state.rpcCalls += 1;
    return name === 'count_family_ai_requests_month' ? { data: state.used, error: null } : { data: null, error: { message: `no fake for ${name}` } };
  },
  from: () => { throw new Error('the allowance reads only the count RPC here'); },
} as never;

const ctx = {
  user: { id: 'user-1', email: 'parent@example.test' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
} as never;

beforeEach(() => {
  state.entitlement = { effectiveLevel: 0, locked: false, closed: false, inTrial: false, trialEndsAt: null };
  state.used = 0;
  state.rpcCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the allowance answers a locked entitlement the way assertAIAccess does', () => {
  it.each([
    ['a trial that ended unpaid', { locked: true, closed: false }, 'trial_expired'],
    ['a closed account', { locked: true, closed: true }, 'account_closed'],
  ])('%s is refused by assertAIAllowance, withinAIAllowance and assertFamilyAIAllowance, before any count', async (_label, lock, code) => {
    state.entitlement = { ...state.entitlement, ...lock };
    const { assertAIAllowance, withinAIAllowance, assertFamilyAIAllowance } = await import('@/lib/server/ai-access');
    expect(await assertAIAllowance(ctx, { db })).toMatchObject({ ok: false, status: 403, code });
    expect(await withinAIAllowance(ctx, db)).toBe(false);
    expect(await assertFamilyAIAllowance(db, 'fam-1')).toMatchObject({ ok: false, status: 403, code });
    expect(state.rpcCalls).toBe(0);
  });

  it('control: an unlocked Free family under its allowance is allowed', async () => {
    state.used = 3;
    const { assertAIAllowance, assertFamilyAIAllowance } = await import('@/lib/server/ai-access');
    expect(await assertAIAllowance(ctx, { db })).toMatchObject({ ok: true, monthlyUsed: 3 });
    expect(await assertFamilyAIAllowance(db, 'fam-1')).toMatchObject({ ok: true, monthlyUsed: 3 });
  });

  it('control: a paying family is unlimited and costs no count', async () => {
    state.entitlement = { ...state.entitlement, effectiveLevel: 1 };
    const { assertAIAllowance } = await import('@/lib/server/ai-access');
    expect(await assertAIAllowance(ctx, { db })).toMatchObject({ ok: true, monthlyAllowance: null });
    expect(state.rpcCalls).toBe(0);
  });
});
