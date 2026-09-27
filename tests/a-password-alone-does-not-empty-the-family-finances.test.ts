// A parent enrols a TOTP authenticator so that a stolen password cannot reach
// the family's money. Someone who has that password — an ex-partner, a teen who
// watched it typed, a phished credential — signs in and holds an `aal1` session:
// authenticated, but no code entered.
//
// Nine money pages send that session to /auth/step-up. The tenth, /dashboard/billing
// — the sidebar's "Finances" entry and the PARENT of those nine — carried no
// guard at all, not even `requireUserContext`. Its ?view=manage tab lists every
// transaction, budget and savings goal with a trash icon beside each, and those
// icons call the seven server actions in app/(app)/dashboard/billing/actions.ts,
// none of which looked at assurance either. `deleteTransaction` is a hard
// `DELETE FROM public.transactions` with no soft-delete column and no undo.
//
// So the control the family opted into was defeated for the money area at
// exactly the screen the money area is named after, and silently: the other
// money pages kept demanding a code, which looks like it working.
//
// What is pinned here is the outcome, not the wiring: with the code not yet
// entered the rows are STILL THERE afterwards, and the family is told where to
// enter it. With the code entered, the same clicks work. A family that never
// enrolled an authenticator is not touched at all — that is what keeps this
// opt-in rather than a surprise lock-out.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STEP_UP = '/auth/step-up?next=%2Fdashboard%2Fbilling';

const mocks = vi.hoisted(() => ({
  getAal: vi.fn(),
  redirect: vi.fn(),
}));

// The session's assurance level, as `readAssurance` sees it.
const NEVER_ENROLLED = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
const ENROLLED_NO_CODE_YET = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
const CODE_ENTERED = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// The REAL en-US catalogue, so a refusal is asserted in the words the family
// reads. A translator that hands the key back would pass on a key that is
// missing from every catalogue — which is exactly how this refusal first
// shipped: as the literal text `actions.moneyNeedsYourCodeAgain`.
vi.mock('@/lib/i18n/server', async () => {
  const { readFileSync } = await import('node:fs');
  const { translate } = await import('@/lib/i18n/translate');
  const messages = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages }),
  };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'p@example.com' },
    memberships: [],
    // A PARENT. The role boundary (`assertFinanceWriter`, `can_manage_family`)
    // is intact and waves this caller through; assurance is the whole question.
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' }, family: { id: 'fam-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: mocks.getAal } } }),
  // /dashboard/billing reads the (non-secret) Stripe service-fee config.
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

// The money tables, as far as this test is concerned. The service functions are
// the only thing that reaches them, so recording what they DID is the same
// question as "is the row still there".
type Row = { id: string };
const tables = { transactions: [] as Row[], budgets: [] as Row[], savings_goals: [] as Row[] };

function remove(table: keyof typeof tables, id: string) {
  const at = tables[table].findIndex((r) => r.id === id);
  if (at < 0) return { ok: false as const, error: 'not found' };
  tables[table].splice(at, 1);
  return { ok: true as const, data: { id } };
}

vi.mock('@/lib/services/finances', () => ({
  deleteTransaction: async (_s: unknown, id: string) => remove('transactions', id),
  deleteBudget: async (_s: unknown, id: string) => remove('budgets', id),
  deleteSavingsGoal: async (_s: unknown, id: string) => remove('savings_goals', id),
  createTransaction: async () => {
    tables.transactions.push({ id: 'tx-new' });
    return { ok: true, data: { id: 'tx-new' } };
  },
  createSavingsGoal: async () => {
    tables.savings_goals.push({ id: 'goal-new' });
    return { ok: true, data: { id: 'goal-new' } };
  },
  updateBudget: async () => {
    tables.budgets.push({ id: 'budget-new' });
    return { ok: true, data: { budget: { id: 'budget-new' } } };
  },
  contributeToSavingsGoal: async (_s: unknown, id: string, delta: number) => {
    contributions.push({ id, delta });
    return { ok: true, data: { id } };
  },
}));

const contributions: { id: string; delta: number }[] = [];

// Rendering the real modules is not the question here, and pulling the client
// tree into a node test would answer a different one.
vi.mock('@/components/modules/billing-module', () => ({ BillingModule: () => null }));
vi.mock('@/components/modules/finances-module', () => ({ FinancesModule: () => null }));
vi.mock('@/components/app/close-account-card', () => ({ CloseAccountCard: () => null }));

const actions = await import('@/app/(app)/dashboard/billing/actions');
const { default: BillingPage } = await import('@/app/(app)/dashboard/billing/page');
const { reportRefusal } = await import('@/lib/auth/step-up-client');
const { returnPathWith } = await import('@/lib/auth/mfa');

// `actions.moneyNeedsYourCodeAgain` is queued for the catalogues in
// scratchpad/i18n-asks/m10+m11.json; the assertions on it are RED until that
// merge lands, and are meant to be.
const NEEDS_CODE = "Enter your two-step code before changing the family's money.";

beforeEach(() => {
  mocks.redirect.mockReset();
  mocks.getAal.mockReset();
  tables.transactions = [{ id: 'tx-1' }];
  tables.budgets = [{ id: 'budget-1' }];
  tables.savings_goals = [{ id: 'goal-1' }];
  contributions.length = 0;
});

describe('the money area, reached with the password alone', () => {
  it('leaves the transaction, the budget and the savings goal exactly where they were', async () => {
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);

    const tx = await actions.deleteTransactionAction('tx-1');
    const budget = await actions.deleteBudgetAction('budget-1');
    const goal = await actions.deleteSavingsGoalAction('goal-1');

    expect(tables.transactions).toEqual([{ id: 'tx-1' }]);
    expect(tables.budgets).toEqual([{ id: 'budget-1' }]);
    expect(tables.savings_goals).toEqual([{ id: 'goal-1' }]);

    // And the family is told, in words, that the code is what is missing — and
    // the answer carries where it goes (reportRefusal, below, acts on it).
    for (const res of [tx, budget, goal]) {
      expect(res).toEqual({ ok: false, error: NEEDS_CODE, stepUp: STEP_UP });
    }
  });

  it('records nothing new either — the write half of the area is closed, not just the delete half', async () => {
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);

    const added = await actions.createTransactionAction({ name: 'Rent', amount: 2400 } as never);
    const saved = await actions.setBudgetAction('Groceries', 600, 'monthly');
    const created = await actions.createSavingsGoalAction({ name: 'Summer camp' } as never);
    const paid = await actions.contributeToGoalAction('goal-1', 20);

    expect(tables.transactions).toEqual([{ id: 'tx-1' }]);
    expect(tables.budgets).toEqual([{ id: 'budget-1' }]);
    expect(tables.savings_goals).toEqual([{ id: 'goal-1' }]);
    expect(contributions).toEqual([]);
    for (const res of [added, saved, created, paid]) expect(res).toEqual({ ok: false, error: NEEDS_CODE, stepUp: STEP_UP });
  });

  it('does not show the Finances page the icons live on', async () => {
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);

    // ?view=manage is the tab with the trash icons; the default view lists every
    // account balance and transaction. Neither renders.
    await expect(BillingPage({ searchParams: Promise.resolve({ view: 'manage' }) })).rejects.toThrow('NEXT_REDIRECT');
    await expect(BillingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect.mock.calls).toEqual([
      [`/auth/step-up?next=${encodeURIComponent('/dashboard/billing?view=manage')}`],
      [STEP_UP],
    ]);
  });

  it('comes back to what the family was SENT there for once the code is entered', async () => {
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);

    // The plan gate (lib/supabase/auth.ts requireFeature) sends families here
    // as ?upgrade=1&need=…; the bare path would drop the upgrade prompt.
    await expect(BillingPage({ searchParams: Promise.resolve({ upgrade: '1', need: '2' }) })).rejects.toThrow('NEXT_REDIRECT');
    await expect(BillingPage({ searchParams: Promise.resolve({ view: 'manage' }) })).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect.mock.calls).toEqual([
      [`/auth/step-up?next=${encodeURIComponent('/dashboard/billing?upgrade=1&need=2')}`],
      [`/auth/step-up?next=${encodeURIComponent('/dashboard/billing?view=manage')}`],
    ]);
  });
});

describe('what the family SEES when a money action is refused for the code', () => {
  it('reads the reason and is taken to the code page, and back to the page they were on', () => {
    const shown: string[] = [];
    const went: string[] = [];
    reportRefusal({ error: NEEDS_CODE, stepUp: STEP_UP }, (m) => shown.push(m), (to) => went.push(to), () => '/dashboard/savings');

    expect(shown).toEqual([NEEDS_CODE]);
    // Back to /dashboard/savings, where the click happened — not to the
    // /dashboard/billing the shared action names.
    expect(went).toEqual([`/auth/step-up?next=${encodeURIComponent('/dashboard/savings')}`]);
  });

  it('an ordinary refusal is only a message — nobody is sent anywhere', () => {
    const went: string[] = [];
    reportRefusal({ error: 'That budget could not be found.' }, () => {}, (to) => went.push(to), () => '/dashboard/budgets');
    expect(went).toEqual([]);
  });

  it('every call site of the seven money actions hands its refusal to reportRefusal', () => {
    const CALLERS = [
      'components/modules/billing-module.tsx',
      'components/finance/savings-view.tsx',
      'components/finance/budgets-view.tsx',
      'components/modules/finances-module.tsx',
    ];
    for (const file of CALLERS) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain("from '@/lib/auth/step-up-client'");
      // The old shape: the message shown and `stepUp` dropped on the floor.
      expect(src, file).not.toMatch(/(toastError|onError)\(res\.error\)/);
    }
  });

  it('keeps the query a page was reached with, and nothing else', () => {
    expect(returnPathWith('/dashboard/billing', {})).toBe('/dashboard/billing');
    expect(returnPathWith('/dashboard/billing', { view: 'manage', missing: undefined })).toBe('/dashboard/billing?view=manage');
    expect(returnPathWith('/dashboard/billing', { tag: ['a', 'b'] })).toBe('/dashboard/billing?tag=a&tag=b');
  });
});

describe('once the code is entered', () => {
  beforeEach(() => mocks.getAal.mockResolvedValue(CODE_ENTERED));

  it('the same two clicks remove the transaction, as they always did', async () => {
    const res = await actions.deleteTransactionAction('tx-1');
    expect(res).toEqual({ ok: true, id: 'tx-1' });
    expect(tables.transactions).toEqual([]);
  });

  it('and the Finances page renders', async () => {
    await expect(BillingPage({ searchParams: Promise.resolve({ view: 'manage' }) })).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('a family that never set up an authenticator', () => {
  beforeEach(() => mocks.getAal.mockResolvedValue(NEVER_ENROLLED));

  it('is not asked for a code it does not have — nothing changes for them', async () => {
    const res = await actions.deleteBudgetAction('budget-1');
    expect(res).toEqual({ ok: true, id: 'budget-1' });
    expect(tables.budgets).toEqual([]);

    await expect(BillingPage({ searchParams: Promise.resolve({ view: 'manage' }) })).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('when the assurance level cannot be read at all', () => {
  it('the money stays where it is — an unreadable level is not a cleared one', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getAal.mockResolvedValue({ data: null, error: { message: 'session missing' } });

    const res = await actions.deleteTransactionAction('tx-1');
    expect(res.ok).toBe(false);
    expect(tables.transactions).toEqual([{ id: 'tx-1' }]);
    errorSpy.mockRestore();
  });
});
