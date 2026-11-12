// Call-level role tests for app/(app)/dashboard/money-timeline/actions.ts
// (Register B ACTION-345E2D2E981B setMoneyInsightStatusAction and
// ACTION-78A06636ED27 syncMoneyInsightsAction), every role with VALID input.
//
// THE POLICY, from the sources:
//   - money_timeline_insights' live write policies are 0352's: insert, update
//     and delete `can_manage_family(family_id)` with restrictive manager
//     guards (supabase/migrations/0352_a_child_cannot_clear_the_households_money_warnings.sql).
//   - isManager = parent or adult (lib/constants/roles.ts).
//   - lib/auth/guest-scope.ts withholds /dashboard/money-timeline from a guest.
//   - The action's own header: one row per family per advisory, so a write is a
//     manager's call for the whole household.
// So a parent and an adult write, and a teen, a child (on a kid login too), a
// caregiver and a guest are refused with the action's sentence and write
// nothing. tests/a-child-cannot-clear-the-households-money-warnings.test.ts
// covers the page; this file is the per-role call matrix and the other family.
//
// Neither action takes a family id or a row id: the family is the session's,
// and the row is keyed by (family_id, dedupe_key). The cross-family case is
// another household holding a row under the SAME dedupe key, which must not
// move when this household dismisses or refreshes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { CashflowTimeline, TimelineInsight } from '@/lib/finance/timeline';

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const NOT_YOURS = 'moneyTimeline.onlyAParentOrAnotherAdult';
const KEY = 'low_balance:2026-03-02';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  loadMoneyTimeline: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/finance/timeline-load', () => ({ loadMoneyTimeline: mocks.loadMoneyTimeline }));

const { setMoneyInsightStatusAction, syncMoneyInsightsAction } =
  await import('@/app/(app)/dashboard/money-timeline/actions');

const WARNING: TimelineInsight = {
  kind: 'low_balance',
  title: 'Balance runs thin the week of Mar 2',
  detail: 'At the current pace your balance dips below zero the week of Mar 2.',
  severity: 'urgent',
  weekStart: '2026-03-02',
  amount: -140,
};

function timelineWith(insights: TimelineInsight[]): CashflowTimeline {
  return {
    weeks: [],
    startingBalance: 680,
    totalOutflow: 0,
    monthlyRecurring: 0,
    heaviestWeek: null,
    lowestBalance: -140,
    lowestBalanceWeek: '2026-03-02',
    insights,
    planOutflow: 0,
    scenarioOutflow: 0,
    coverage: {
      coveredCount: 0, coveredAmount: 0, openCount: 0, openAmount: 0,
      paidCount: 0, paidAmount: 0, coveredBills: 0, paidBills: 0, openBills: 0, totalBills: 0,
    },
  };
}

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

let db: InMemorySupabase;
let bAsSeeded: unknown[];

function signedInAs(role: Role, opts: { kidLogin?: boolean } = {}) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}`, email: opts.kidLogin ? `kid-${role}@kids.bubaly.app` : `${role}@example.com` },
    memberships: [],
    active: {
      familyId: FAMILY_A,
      family: { id: FAMILY_A, timezone: 'America/New_York' },
      role,
      member: { id: `member-${role}` },
    },
  });
}

const rowsOf = (family: string) => db.table('money_timeline_insights').filter((r) => r.family_id === family);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: { money_timeline_insights: [['family_id', 'dedupe_key']] },
    defaults: { money_timeline_insights: { status: 'active' } },
  });
  db.seed('money_timeline_insights', [{
    id: '00000000-0000-4000-8000-0000000000b1',
    family_id: FAMILY_B,
    kind: 'low_balance',
    title: "Family B's own warning",
    detail: "Family B's own detail",
    severity: 'urgent',
    week_start: '2026-03-02',
    amount: -900,
    status: 'active',
    dedupe_key: KEY,
  }]);
  bAsSeeded = structuredClone(rowsOf(FAMILY_B));
  mocks.createServer.mockResolvedValue(db);
  mocks.loadMoneyTimeline.mockResolvedValue(timelineWith([WARNING]));
});

describe('ACTION-345E2D2E981B setMoneyInsightStatusAction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-345E2D2E981B a %s dismisses the warning for their own household', async (role) => {
    signedInAs(role);
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' })).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_A).map(({ family_id, kind, severity, week_start, amount, status, dedupe_key }) =>
      ({ family_id, kind, severity, week_start, amount, status, dedupe_key }))).toEqual([{
      family_id: FAMILY_A, kind: 'low_balance', severity: 'urgent', week_start: '2026-03-02', amount: -140,
      status: 'dismissed', dedupe_key: KEY,
    }]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/money-timeline');
  });

  it('ACTION-345E2D2E981B an adult acknowledges, and the same row moves rather than a second one appearing', async () => {
    signedInAs('adult');
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'acknowledged' })).resolves.toEqual({ ok: true });
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' })).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_A).map((r) => r.status)).toEqual(['dismissed']);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-345E2D2E981B a %s is refused and nothing is written', async (role) => {
    signedInAs(role);
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' }))
      .resolves.toEqual({ ok: false, error: NOT_YOURS });
    expect(rowsOf(FAMILY_A)).toEqual([]);
    expect(rowsOf(FAMILY_B)).toEqual(bAsSeeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-345E2D2E981B a child on a kid login is refused and nothing is written', async () => {
    signedInAs('child', { kidLogin: true });
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' }))
      .resolves.toEqual({ ok: false, error: NOT_YOURS });
    expect(rowsOf(FAMILY_A)).toEqual([]);
  });

  it("ACTION-345E2D2E981B another household's row under the same key is left exactly as it was", async () => {
    signedInAs('parent');
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' })).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_B)).toEqual(bAsSeeded);
    expect(rowsOf(FAMILY_A).map((r) => r.status)).toEqual(['dismissed']);
  });

  it('ACTION-345E2D2E981B a signed-out caller is sent away and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' })).rejects.toThrow('NEXT_REDIRECT');
    expect(rowsOf(FAMILY_A)).toEqual([]);
    expect(rowsOf(FAMILY_B)).toEqual(bAsSeeded);
  });
});

describe('ACTION-78A06636ED27 syncMoneyInsightsAction', () => {
  it.each(['parent', 'adult'] as const)("ACTION-78A06636ED27 a %s refreshes their own household's insights", async (role) => {
    signedInAs(role);
    await expect(syncMoneyInsightsAction()).resolves.toEqual({ ok: true });
    expect(mocks.loadMoneyTimeline).toHaveBeenCalledTimes(1);
    expect(mocks.loadMoneyTimeline.mock.calls[0][1]).toBe(FAMILY_A);
    expect(rowsOf(FAMILY_A).map(({ family_id, kind, status, dedupe_key, title }) => ({ family_id, kind, status, dedupe_key, title })))
      .toEqual([{ family_id: FAMILY_A, kind: 'low_balance', status: 'active', dedupe_key: KEY, title: 'Balance runs thin the week of Mar 2' }]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/money-timeline');
  });

  it('ACTION-78A06636ED27 a refresh keeps a status the household already chose', async () => {
    signedInAs('parent');
    await expect(setMoneyInsightStatusAction({ insight: WARNING, status: 'dismissed' })).resolves.toEqual({ ok: true });
    await expect(syncMoneyInsightsAction()).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_A).map((r) => r.status)).toEqual(['dismissed']);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)(
    'ACTION-78A06636ED27 a %s is refused before the forecast is read, and nothing is written',
    async (role) => {
      signedInAs(role);
      await expect(syncMoneyInsightsAction()).resolves.toEqual({ ok: false, error: NOT_YOURS });
      expect(mocks.loadMoneyTimeline).not.toHaveBeenCalled();
      expect(rowsOf(FAMILY_A)).toEqual([]);
      expect(rowsOf(FAMILY_B)).toEqual(bAsSeeded);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('ACTION-78A06636ED27 a child on a kid login is refused and nothing is written', async () => {
    signedInAs('child', { kidLogin: true });
    await expect(syncMoneyInsightsAction()).resolves.toEqual({ ok: false, error: NOT_YOURS });
    expect(rowsOf(FAMILY_A)).toEqual([]);
  });

  it("ACTION-78A06636ED27 another household's row under the same key is left exactly as it was", async () => {
    signedInAs('parent');
    await expect(syncMoneyInsightsAction()).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_B)).toEqual(bAsSeeded);
    expect(rowsOf(FAMILY_A)).toHaveLength(1);
  });

  it('ACTION-78A06636ED27 a signed-out caller is sent away and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
    await expect(syncMoneyInsightsAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.loadMoneyTimeline).not.toHaveBeenCalled();
    expect(rowsOf(FAMILY_A)).toEqual([]);
  });
});
