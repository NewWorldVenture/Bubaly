// The seven money writes behind /dashboard/billing, /budgets and /savings,
// called the way the page calls them, by every role a household has.
//
// THE POLICY, from the sources rather than from the action:
// - lib/constants/roles.ts: isManager = parent or adult ("Managers can edit
//   shared data"); the services assert it (lib/services/finances/index.ts,
//   assertFinanceWriter: "Only a parent or another adult can …").
// - The live RLS on transactions, budgets and savings_goals is 0267's
//   can_manage_family insert/update/delete (0267_money_write_boundary.sql:66-91),
//   re-asserted by 0275's sweep; can_manage_family is role in ('parent','adult').
// - lib/auth/guest-scope.ts withholds /dashboard/billing, /budgets and /savings
//   from a guest; a caregiver is not a manager either.
// - Money writes need the step-up code once a manager has enrolled one
//   (lib/auth/require-aal2.ts; 0382's restrictive guards on budgets and
//   savings_goals).
//
// So a parent or an adult writes exactly what each action promises, and a
// teen, a child (a kid login included), a caregiver and a guest are refused
// with the service's own words and write nothing. An id from another household
// answers "not found" and changes nothing anywhere. The in-memory client does
// not run RLS, so every refusal here is the APPLICATION's: each is pinned by
// removing that gate and watching the case fail.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  requireUserContext: vi.fn(),
  getAal: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => mocks.db,
  createServiceClient: () => mocks.db,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages: {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` }); },
}));

const actions = await import('@/app/(app)/dashboard/billing/actions');

const FAMILY_A = '0a000000-0000-4000-8000-00000000000a';
const FAMILY_B = '0b000000-0000-4000-8000-00000000000b';
const MEMBER = (n: number) => `0a000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const USER = (n: number) => `0a000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const B_PARENT_MEMBER = '0b000000-0000-4000-8000-000000000101';

const IDS = {
  aBudget: '0a000000-0000-4000-8000-000000000301',
  bBudget: '0b000000-0000-4000-8000-000000000301',
  aGoal: '0a000000-0000-4000-8000-000000000401',
  bGoal: '0b000000-0000-4000-8000-000000000401',
  aTx: '0a000000-0000-4000-8000-000000000501',
  bTx: '0b000000-0000-4000-8000-000000000501',
  aAccount: '0a000000-0000-4000-8000-000000000601',
  bAccount: '0b000000-0000-4000-8000-000000000601',
};

type Caller = { label: string; role: string; n: number; email: string };
const CALLERS: Record<string, Caller> = {
  parent: { label: 'parent', role: 'parent', n: 1, email: 'parent@example.com' },
  adult: { label: 'adult', role: 'adult', n: 2, email: 'adult@example.com' },
  teen: { label: 'teen', role: 'teen', n: 3, email: 'teen@example.com' },
  child: { label: 'child', role: 'child', n: 4, email: 'child@example.com' },
  kid: { label: 'child on a kid login', role: 'child', n: 5, email: `kid-a@${CHILD_LOGIN_EMAIL_DOMAIN}` },
  caregiver: { label: 'caregiver', role: 'caregiver', n: 6, email: 'caregiver@example.com' },
  guest: { label: 'guest', role: 'guest', n: 7, email: 'guest@example.com' },
};
const MANAGERS = [CALLERS.parent, CALLERS.adult];
const NOT_MANAGERS = [CALLERS.teen, CALLERS.child, CALLERS.kid, CALLERS.caregiver, CALLERS.guest];

const NEVER_ENROLLED = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
const ENROLLED_NO_CODE_YET = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
const STEP_UP = { ok: false, error: 'actions.moneyNeedsYourCodeAgain', stepUp: '/auth/step-up?next=%2Fdashboard%2Fbilling' };

const NOT_BUDGET_WRITER = 'Only a parent or another adult can change the family budget.';
const NOT_BOOKS_WRITER = 'Only a parent or another adult can record a purchase on the household books.';

let db: InMemorySupabase;

function signInAs(caller: Caller) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: USER(caller.n), email: caller.email },
    memberships: [],
    active: {
      familyId: FAMILY_A, role: caller.role,
      member: { id: MEMBER(caller.n), family_id: FAMILY_A, user_id: USER(caller.n), role: caller.role, is_active: true },
      family: { id: FAMILY_A, timezone: 'UTC' },
    },
  });
}

/** Every table a money write could touch, in both households. */
const everything = () => structuredClone({
  budgets: db.table('budgets'),
  savings_goals: db.table('savings_goals'),
  transactions: db.table('transactions'),
  financial_accounts: db.table('financial_accounts'),
  audit_logs: db.table('audit_logs'),
  agent_activity: db.table('agent_activity'),
});
const rowsOf = (table: string, family: string) => structuredClone(db.table(table).filter((r) => r.family_id === family));
const byId = (table: string, id: string) => db.table(table).find((r) => r.id === id);

beforeEach(() => {
  vi.resetAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  Object.assign(db.auth, {
    getSession: async () => ({ data: { session: { access_token: 'synthetic-assurance-token' } }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: mocks.getAal },
  });
  mocks.getAal.mockResolvedValue(NEVER_ENROLLED);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  db.seed('family_members', [
    ...Object.values(CALLERS).map((c) => ({ id: MEMBER(c.n), family_id: FAMILY_A, user_id: USER(c.n), role: c.role, is_active: true })),
    { id: B_PARENT_MEMBER, family_id: FAMILY_B, user_id: '0b000000-0000-4000-8000-000000000201', role: 'parent', is_active: true },
  ]);
  db.seed('financial_accounts', [
    { id: IDS.aAccount, family_id: FAMILY_A, name: 'A checking' },
    { id: IDS.bAccount, family_id: FAMILY_B, name: 'B checking' },
  ]);
  // B's Groceries budget is the OLDER row, so a canonical lookup that forgot
  // the family would find it first.
  db.seed('budgets', [
    { id: IDS.bBudget, family_id: FAMILY_B, category: 'Groceries', amount: 900, period: 'monthly', created_at: '2026-01-01T00:00:00.000Z' },
    { id: IDS.aBudget, family_id: FAMILY_A, category: 'Fuel', amount: 200, period: 'monthly', created_at: '2026-02-01T00:00:00.000Z' },
  ]);
  db.seed('savings_goals', [
    { id: IDS.aGoal, family_id: FAMILY_A, name: 'Summer camp', target_amount: 1000, current_amount: 100 },
    { id: IDS.bGoal, family_id: FAMILY_B, name: 'Summer camp', target_amount: 1000, current_amount: 100 },
  ]);
  db.seed('transactions', [
    { id: IDS.aTx, family_id: FAMILY_A, name: 'Rent', amount: 2400, type: 'expense', date: '2026-11-01' },
    { id: IDS.bTx, family_id: FAMILY_B, name: 'Rent', amount: 1800, type: 'expense', date: '2026-11-01' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const name = (c: Caller) => c.label;

// ── contributeToGoalAction ───────────────────────────────────────────────────
describe('ACTION-A7AC1E2A50BB contributeToGoalAction', () => {
  it.each(MANAGERS.map((c) => [name(c), c] as const))('ACTION-A7AC1E2A50BB a %s adds the delta to their own goal and nothing else moves', async (_l, caller) => {
    signInAs(caller);
    const b = rowsOf('savings_goals', FAMILY_B);
    expect(await actions.contributeToGoalAction(IDS.aGoal, 20)).toEqual({ ok: true, id: IDS.aGoal });
    expect(byId('savings_goals', IDS.aGoal)?.current_amount).toBe(120);
    expect(rowsOf('savings_goals', FAMILY_B)).toEqual(b);
    expect(db.table('audit_logs').map((r) => r.family_id)).toEqual([FAMILY_A]);
  });

  it.each(NOT_MANAGERS.map((c) => [name(c), c] as const))('ACTION-A7AC1E2A50BB a %s is refused and the goal keeps its balance', async (_l, caller) => {
    signInAs(caller);
    const before = everything();
    expect(await actions.contributeToGoalAction(IDS.aGoal, 20)).toEqual({ ok: false, error: NOT_BUDGET_WRITER });
    expect(everything()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ACTION-A7AC1E2A50BB another family's goal id is not found for a parent, and neither household changes", async () => {
    signInAs(CALLERS.parent);
    const before = everything();
    expect(await actions.contributeToGoalAction(IDS.bGoal, 20)).toEqual({ ok: false, error: 'That savings goal could not be found.' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-A7AC1E2A50BB a parent with an authenticator and no code yet is sent to step up, and nothing moves', async () => {
    signInAs(CALLERS.parent);
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    const before = everything();
    expect(await actions.contributeToGoalAction(IDS.aGoal, 20)).toEqual(STEP_UP);
    expect(everything()).toEqual(before);
  });
});

// ── createSavingsGoalAction ──────────────────────────────────────────────────
describe('ACTION-04474DC90357 createSavingsGoalAction', () => {
  const input = { name: 'New bikes', targetAmount: 600, currentAmount: 50, targetDate: '2027-06-01' };

  it.each(MANAGERS.map((c) => [name(c), c] as const))('ACTION-04474DC90357 a %s creates the goal in their own family only', async (_l, caller) => {
    signInAs(caller);
    const b = rowsOf('savings_goals', FAMILY_B);
    const res = await actions.createSavingsGoalAction(input);
    const created = db.table('savings_goals').filter((r) => r.name === 'New bikes');
    expect(created).toHaveLength(1);
    expect(res).toEqual({ ok: true, id: created[0].id });
    expect(created[0]).toMatchObject({ family_id: FAMILY_A, target_amount: 600, current_amount: 50, target_date: '2027-06-01', created_by: USER(caller.n) });
    expect(rowsOf('savings_goals', FAMILY_B)).toEqual(b);
  });

  it.each(NOT_MANAGERS.map((c) => [name(c), c] as const))('ACTION-04474DC90357 a %s is refused and no goal is written', async (_l, caller) => {
    signInAs(caller);
    const before = everything();
    expect(await actions.createSavingsGoalAction(input)).toEqual({ ok: false, error: NOT_BUDGET_WRITER });
    expect(everything()).toEqual(before);
  });

  it("ACTION-04474DC90357 a goal named like another family's lands as a new row in the caller's family and B's is untouched", async () => {
    signInAs(CALLERS.parent);
    const b = rowsOf('savings_goals', FAMILY_B);
    const res = await actions.createSavingsGoalAction({ name: 'Summer camp', targetAmount: 1000 });
    expect(res.ok).toBe(true);
    expect(db.table('savings_goals').filter((r) => r.family_id === FAMILY_A && r.name === 'Summer camp')).toHaveLength(2);
    expect(rowsOf('savings_goals', FAMILY_B)).toEqual(b);
  });

  it('ACTION-04474DC90357 a parent with an authenticator and no code yet is sent to step up, and nothing is written', async () => {
    signInAs(CALLERS.parent);
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    const before = everything();
    expect(await actions.createSavingsGoalAction(input)).toEqual(STEP_UP);
    expect(everything()).toEqual(before);
  });
});

// ── createTransactionAction ──────────────────────────────────────────────────
describe('ACTION-3EB6EC6D3C8F createTransactionAction', () => {
  const input = { name: 'Groceries run', amount: 84.5, type: 'expense' as const, date: '2026-11-10', accountId: IDS.aAccount, memberId: MEMBER(1) };

  it.each(MANAGERS.map((c) => [name(c), c] as const))('ACTION-3EB6EC6D3C8F a %s records the transaction in their own family', async (_l, caller) => {
    signInAs(caller);
    const b = rowsOf('transactions', FAMILY_B);
    const res = await actions.createTransactionAction(input);
    const created = db.table('transactions').filter((r) => r.name === 'Groceries run');
    expect(created).toHaveLength(1);
    expect(res).toEqual({ ok: true, id: created[0].id });
    expect(created[0]).toMatchObject({
      family_id: FAMILY_A, amount: 84.5, type: 'expense', date: '2026-11-10',
      account_id: IDS.aAccount, member_id: MEMBER(1), source: 'manual', created_by: USER(caller.n),
    });
    expect(rowsOf('transactions', FAMILY_B)).toEqual(b);
  });

  it.each(NOT_MANAGERS.map((c) => [name(c), c] as const))('ACTION-3EB6EC6D3C8F a %s is refused and nothing is recorded', async (_l, caller) => {
    signInAs(caller);
    const before = everything();
    expect(await actions.createTransactionAction(input)).toEqual({ ok: false, error: NOT_BOOKS_WRITER });
    expect(everything()).toEqual(before);
  });

  it("ACTION-3EB6EC6D3C8F another family's account id is refused for a parent and nothing is recorded", async () => {
    signInAs(CALLERS.parent);
    const before = everything();
    expect(await actions.createTransactionAction({ ...input, accountId: IDS.bAccount }))
      .toEqual({ ok: false, error: 'That account does not belong to this family.' });
    expect(everything()).toEqual(before);
  });

  it("ACTION-3EB6EC6D3C8F another family's member id is refused for a parent and nothing is recorded", async () => {
    signInAs(CALLERS.parent);
    const before = everything();
    expect(await actions.createTransactionAction({ ...input, memberId: B_PARENT_MEMBER }))
      .toEqual({ ok: false, error: 'That member does not belong to this family.' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-3EB6EC6D3C8F a parent with an authenticator and no code yet is sent to step up, and nothing is recorded', async () => {
    signInAs(CALLERS.parent);
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    const before = everything();
    expect(await actions.createTransactionAction(input)).toEqual(STEP_UP);
    expect(everything()).toEqual(before);
  });
});

// ── deleteBudgetAction ───────────────────────────────────────────────────────
describe('ACTION-31070FC9434F deleteBudgetAction', () => {
  it.each(MANAGERS.map((c) => [name(c), c] as const))("ACTION-31070FC9434F a %s removes their family's budget and only that one", async (_l, caller) => {
    signInAs(caller);
    expect(await actions.deleteBudgetAction(IDS.aBudget)).toEqual({ ok: true, id: IDS.aBudget });
    expect(db.table('budgets').map((r) => r.id)).toEqual([IDS.bBudget]);
  });

  it.each(NOT_MANAGERS.map((c) => [name(c), c] as const))('ACTION-31070FC9434F a %s is refused and the budget stays', async (_l, caller) => {
    signInAs(caller);
    const before = everything();
    expect(await actions.deleteBudgetAction(IDS.aBudget)).toEqual({ ok: false, error: NOT_BUDGET_WRITER });
    expect(everything()).toEqual(before);
  });

  it("ACTION-31070FC9434F another family's budget id is not found for a parent, and both budgets stay", async () => {
    signInAs(CALLERS.parent);
    const before = everything();
    expect(await actions.deleteBudgetAction(IDS.bBudget)).toEqual({ ok: false, error: 'That budget could not be found.' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-31070FC9434F a parent with an authenticator and no code yet is sent to step up, and the budget stays', async () => {
    signInAs(CALLERS.parent);
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    const before = everything();
    expect(await actions.deleteBudgetAction(IDS.aBudget)).toEqual(STEP_UP);
    expect(everything()).toEqual(before);
  });
});

// ── deleteSavingsGoalAction ──────────────────────────────────────────────────
describe('ACTION-9044433F1559 deleteSavingsGoalAction', () => {
  it.each(MANAGERS.map((c) => [name(c), c] as const))("ACTION-9044433F1559 a %s removes their family's goal and only that one", async (_l, caller) => {
    signInAs(caller);
    expect(await actions.deleteSavingsGoalAction(IDS.aGoal)).toEqual({ ok: true, id: IDS.aGoal });
    expect(db.table('savings_goals').map((r) => r.id)).toEqual([IDS.bGoal]);
  });

  it.each(NOT_MANAGERS.map((c) => [name(c), c] as const))('ACTION-9044433F1559 a %s is refused and the goal stays', async (_l, caller) => {
    signInAs(caller);
    const before = everything();
    expect(await actions.deleteSavingsGoalAction(IDS.aGoal)).toEqual({ ok: false, error: NOT_BUDGET_WRITER });
    expect(everything()).toEqual(before);
  });

  it("ACTION-9044433F1559 another family's goal id is not found for a parent, and both goals stay", async () => {
    signInAs(CALLERS.parent);
    const before = everything();
    expect(await actions.deleteSavingsGoalAction(IDS.bGoal)).toEqual({ ok: false, error: 'That savings goal could not be found.' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-9044433F1559 a parent with an authenticator and no code yet is sent to step up, and the goal stays', async () => {
    signInAs(CALLERS.parent);
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    const before = everything();
    expect(await actions.deleteSavingsGoalAction(IDS.aGoal)).toEqual(STEP_UP);
    expect(everything()).toEqual(before);
  });
});

// ── deleteTransactionAction ──────────────────────────────────────────────────
describe('ACTION-8D7121FB9456 deleteTransactionAction', () => {
  it.each(MANAGERS.map((c) => [name(c), c] as const))("ACTION-8D7121FB9456 a %s removes their family's transaction and only that one", async (_l, caller) => {
    signInAs(caller);
    expect(await actions.deleteTransactionAction(IDS.aTx)).toEqual({ ok: true, id: IDS.aTx });
    expect(db.table('transactions').map((r) => r.id)).toEqual([IDS.bTx]);
  });

  it.each(NOT_MANAGERS.map((c) => [name(c), c] as const))('ACTION-8D7121FB9456 a %s is refused and the transaction stays', async (_l, caller) => {
    signInAs(caller);
    const before = everything();
    expect(await actions.deleteTransactionAction(IDS.aTx)).toEqual({ ok: false, error: NOT_BUDGET_WRITER });
    expect(everything()).toEqual(before);
  });

  it("ACTION-8D7121FB9456 another family's transaction id is not found for a parent, and both stay", async () => {
    signInAs(CALLERS.parent);
    const before = everything();
    expect(await actions.deleteTransactionAction(IDS.bTx)).toEqual({ ok: false, error: 'That transaction could not be found.' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-8D7121FB9456 a parent with an authenticator and no code yet is sent to step up, and the transaction stays', async () => {
    signInAs(CALLERS.parent);
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    const before = everything();
    expect(await actions.deleteTransactionAction(IDS.aTx)).toEqual(STEP_UP);
    expect(everything()).toEqual(before);
  });
});

// ── setBudgetAction ──────────────────────────────────────────────────────────
describe('ACTION-25567E8FF47B setBudgetAction', () => {
  it.each(MANAGERS.map((c) => [name(c), c] as const))("ACTION-25567E8FF47B a %s updates their family's budget for that category in place", async (_l, caller) => {
    signInAs(caller);
    expect(await actions.setBudgetAction('fuel', 250, 'weekly')).toEqual({ ok: true, id: IDS.aBudget });
    expect(rowsOf('budgets', FAMILY_A)).toEqual([expect.objectContaining({ id: IDS.aBudget, category: 'Fuel', amount: 250, period: 'weekly' })]);
    expect(byId('budgets', IDS.bBudget)).toMatchObject({ amount: 900, period: 'monthly' });
  });

  it.each(NOT_MANAGERS.map((c) => [name(c), c] as const))('ACTION-25567E8FF47B a %s is refused and no budget is written', async (_l, caller) => {
    signInAs(caller);
    const before = everything();
    expect(await actions.setBudgetAction('Fuel', 250, 'monthly')).toEqual({ ok: false, error: NOT_BUDGET_WRITER });
    expect(everything()).toEqual(before);
  });

  it("ACTION-25567E8FF47B a category only another family budgets is created in the caller's family; B's budget keeps its amount", async () => {
    signInAs(CALLERS.parent);
    const b = rowsOf('budgets', FAMILY_B);
    const res = await actions.setBudgetAction('Groceries', 500, 'monthly');
    const created = rowsOf('budgets', FAMILY_A).filter((r) => r.category === 'Groceries');
    expect(created).toEqual([expect.objectContaining({ family_id: FAMILY_A, amount: 500, period: 'monthly' })]);
    expect(res).toEqual({ ok: true, id: created[0].id });
    expect(rowsOf('budgets', FAMILY_B)).toEqual(b);
  });

  it('ACTION-25567E8FF47B a parent with an authenticator and no code yet is sent to step up, and no budget is written', async () => {
    signInAs(CALLERS.parent);
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    const before = everything();
    expect(await actions.setBudgetAction('Fuel', 250, 'monthly')).toEqual(STEP_UP);
    expect(everything()).toEqual(before);
  });
});

describe('a signed-out caller', () => {
  it('ACTION-25567E8FF47B is sent to sign in before any money table is touched', async () => {
    mocks.requireUserContext.mockImplementation(async () => {
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    });
    const before = everything();
    await expect(actions.setBudgetAction('Fuel', 250, 'monthly')).rejects.toThrow('NEXT_REDIRECT');
    await expect(actions.deleteTransactionAction(IDS.aTx)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});
