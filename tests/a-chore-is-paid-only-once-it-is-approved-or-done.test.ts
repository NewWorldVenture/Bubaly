import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A chore is paid only once it is approved, or done without needing approval.
 *
 * `payChoreRewardAction` read the assignment's id, member, family and award,
 * and never its status. A parent's Pay (or a stale board, or a direct call)
 * credited a chore that was still `todo`, `in_progress`, waiting in
 * `submitted`, or that a parent had `rejected`: measured on main, all four
 * credited 15.00.
 *
 * The chore lifecycle this follows:
 * - `completeChoreAssignment` settles on `done` only when the chore's
 *   `requires_approval` is false, and on `submitted` otherwise;
 * - only a manager moves an assignment to `approved` or `rejected` (0223);
 * - the board offers Pay only on `approved`/`done` (`isCompleted`).
 *
 * So the action now pays `approved`, or `done` on a chore that needs no
 * approval. A `done` on a chore that DOES need approval is not a parent's
 * decision (0223 lets any member write `done`), and is refused. Anything
 * refused is refused before Trust, the ledger or the wallet are touched.
 *
 * This is the server-boundary check. It does not make the status read and the
 * credit one step: see the PR for the coordinated database follow-up.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
  evaluateTrust: null as unknown as Mock<(...args: unknown[]) => unknown>,
}));

vi.mock('next/cache', async () => {
  const { vi: v } = await import('vitest');
  harness.revalidatePath = v.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: { familyId: FAMILY, role: 'parent', member: { id: 'member-self', family_id: FAMILY }, family: { id: FAMILY, timezone: 'UTC' } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/trust/server', async (importOriginal) => {
  const { vi: v } = await import('vitest');
  harness.evaluateTrust = v.fn(async () => ({ decision: { effect: 'allow', reason: 'Allowed.', basis: 'role_default' } }));
  return { ...(await importOriginal<typeof import('@/lib/trust/server')>()), evaluateTrust: (...args: unknown[]) => harness.evaluateTrust(...args) };
});

const { payChoreRewardAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);
const NOT_PAYABLE = t('actions.thatChoreIsNoLonger');
const KINDS = ['spend', 'save', 'give', 'invest'] as const;

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('child_wallets', [{ id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' }]);
  db.seed('wallet_buckets', KINDS.map((kind) => ({ id: `wallet-a-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-a', kind })));
  db.seed('chores', [
    { id: 'chore-reviewed', family_id: FAMILY, title: 'Mow the lawn', cash_cents: 1_500, requires_approval: true },
    { id: 'chore-trusted', family_id: FAMILY, title: 'Feed the cat', cash_cents: 1_500, requires_approval: false },
  ]);
});

/** One assignment of `choreId` in `status`, for member-a, paid from the chore's listed cash. */
function assign(status: string, choreId = 'chore-reviewed', over: Row = {}) {
  db.seed('chore_assignments', [{ id: 'asg-1', family_id: FAMILY, member_id: 'member-a', chore_id: choreId, cash_awarded_cents: null, status, ...over }]);
}
const pay = () => payChoreRewardAction({ choreAssignmentId: 'asg-1' });
const ledger = () => db.table('wallet_transactions');
const total = () => ledger().reduce((sum, row) => sum + Number(row.amount_cents), 0);

function expectNothingPaid() {
  expect(ledger()).toHaveLength(0);
  expect(harness.evaluateTrust).not.toHaveBeenCalled();
  expect(harness.revalidatePath).not.toHaveBeenCalled();
}

describe('a chore that is not finished, or not approved, is not paid', () => {
  describe.each(['chore-reviewed', 'chore-trusted'])('whether or not it needs approval (%s)', (choreId) => {
    it.each(['todo', 'in_progress', 'submitted', 'rejected'])('%s', async (status) => {
      assign(status, choreId);

      expect(await pay()).toEqual({ ok: false, error: NOT_PAYABLE });
      expectNothingPaid();
    });
  });

  it('done, on a chore that needs a parent’s approval it has not had', async () => {
    assign('done', 'chore-reviewed');

    expect(await pay()).toEqual({ ok: false, error: NOT_PAYABLE });
    expectNothingPaid();
  });

  it('done, when its chore cannot be read with it, so whether it needed approval is unknown', async () => {
    assign('done', 'chore-missing', { cash_awarded_cents: 1_500 });

    expect(await pay()).toEqual({ ok: false, error: NOT_PAYABLE });
    expectNothingPaid();
  });

  it('refused on the assignment read alone, before any payout or wallet is looked up', async () => {
    assign('submitted');
    await pay();

    expect(db.log.map((entry) => entry.table)).toEqual(['chore_assignments']);
  });
});

describe('a finished chore is still paid, once', () => {
  it('approved, on a chore that needs approval', async () => {
    assign('approved', 'chore-reviewed');

    expect(await pay()).toEqual({ ok: true });
    expect(total()).toBe(1_500);
    expect(ledger()[0]).toMatchObject({ related_type: 'chore_assignments', related_id: 'asg-1', type: 'chore_reward', status: 'completed' });
  });

  it('approved, on a chore that did not need it', async () => {
    assign('approved', 'chore-trusted');

    expect(await pay()).toEqual({ ok: true });
    expect(total()).toBe(1_500);
  });

  it('done, on a chore that needs no approval', async () => {
    assign('done', 'chore-trusted');

    expect(await pay()).toEqual({ ok: true });
    expect(total()).toBe(1_500);
  });

  it('the amount awarded at approval still wins over the listed cash', async () => {
    assign('approved', 'chore-reviewed', { cash_awarded_cents: 2_200 });

    expect(await pay()).toEqual({ ok: true });
    expect(total()).toBe(2_200);
  });

  it('a second Pay on the same approved chore is still “already paid”', async () => {
    assign('approved');
    expect(await pay()).toEqual({ ok: true });
    const paid = ledger().length;

    expect(await pay()).toEqual({ ok: false, error: t('actions.thisChoreWasAlreadyPaid') });
    expect(ledger()).toHaveLength(paid);
  });
});
