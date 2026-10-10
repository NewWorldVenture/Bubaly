import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A new allowance or savings goal is set up only for a child wallet in the
 * family the parent is acting in.
 *
 * THE DEFECT. `saveAllowanceRuleAction` (when it inserts) and
 * `createGoalAction` (app/(app)/wallet/actions.ts) wrote the caller's
 * `childWalletId` straight into a row stamped with the ACTIVE family, without
 * reading the wallet back inside that family. Every sibling action that takes a
 * wallet id does (addFundsAction, createGiftLinkAction, saveWalletRuleAction,
 * claimPayHandleAction, requestSpendAction).
 *
 * How a family meets it: a parent in two households (separated parents, a
 * grandparent's home) opens the allowance page in household A, switches the
 * active household to B in another tab, and saves from the first tab. The rule
 * is written into B pointing at A's child. It shows on neither family's
 * allowance page (each lists rules by its own wallets), it never pays (the
 * credit finds no buckets for that wallet in B, and a manual "Run now" stops at
 * it), the nightly cron counts it as failed every night, and the child the
 * parent meant to pay gets nothing while the parent was told it was saved. A
 * goal the same way is listed in B with no child and can never be funded
 * (`wallet_fund_goal` answers wallet_not_found).
 *
 * The database does not stop it in production: 0311's same-family reference
 * guard on `allowance_rules` is recorded as missing there, and `wallet_goals`
 * is not on 0311's list at all.
 *
 * WHAT IS ASSERTED: another household's wallet is refused in words and nothing
 * is written; a wallet read that fails is a failure, not a save; a wallet in
 * the active family, a family-wide goal and an edit of an existing rule still
 * save.
 */

const HOUSEHOLD_A = 'family-a';
const HOUSEHOLD_B = 'family-b';
const harness = vi.hoisted(() => ({ db: null as unknown, familyId: 'family-b' }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-parent' },
    memberships: [],
    active: {
      familyId: harness.familyId, role: 'parent',
      member: { id: `member-parent-${harness.familyId}`, family_id: harness.familyId },
      family: { id: harness.familyId, timezone: 'UTC' },
    },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { saveAllowanceRuleAction, createGoalAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

// Ava is household A's child; Ben is household B's.
const AVA_WALLET = 'wallet-ava';
const BEN_WALLET = 'wallet-ben';
const READ_FAILED = { code: 'XX000', message: 'private database detail', details: null, hint: null };
// What a parent reads when the wallet could not be read: the action's own
// sentence, never the database's.
const COULD_NOT_READ = () => describeActionError(READ_FAILED, t('actions.couldNotLoadThatChild'));

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.familyId = HOUSEHOLD_B;
  db.seed('families', [
    { id: HOUSEHOLD_A, trial_ends_at: null, closed_at: null },
    { id: HOUSEHOLD_B, trial_ends_at: null, closed_at: null },
  ]);
  db.seed('subscriptions', [
    { family_id: HOUSEHOLD_A, plan: 'basic', status: 'active' },
    { family_id: HOUSEHOLD_B, plan: 'basic', status: 'active' },
  ]);
  db.seed('child_wallets', [
    { id: AVA_WALLET, family_id: HOUSEHOLD_A, member_id: 'member-ava', is_active: true },
    { id: BEN_WALLET, family_id: HOUSEHOLD_B, member_id: 'member-ben', is_active: true },
  ]);
  db.seed('allowance_rules', [
    { id: 'rule-ben', family_id: HOUSEHOLD_B, child_wallet_id: BEN_WALLET, amount_cents: 500, cadence: 'weekly', is_active: true, next_run_on: '2099-01-05', created_by: 'user-parent' },
  ]);
});

/** Every read of `child_wallets` fails; everything else is the real store. */
function walletReadsFail() {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name);
    if (name === 'child_wallets') {
      (builder as unknown as { maybeSingle: () => unknown }).maybeSingle = async () => ({ data: null, error: READ_FAILED, count: null, status: 500, statusText: 'Error' });
    }
    return builder;
  };
}

const newRules = () => db.table('allowance_rules').filter((row) => row.id !== 'rule-ben');
const goals = () => db.table('wallet_goals');
const allowance = (childWalletId: string) => saveAllowanceRuleAction({ childWalletId, amountCents: 1_000, cadence: 'weekly' });
const goal = (childWalletId?: string | null) => createGoalAction({ title: 'Bike', targetCents: 20_000, childWalletId });

describe("a wallet from the other household (a stale tab after switching)", () => {
  it('is refused for a new allowance, and no rule is written into either family', async () => {
    expect(await allowance(AVA_WALLET)).toEqual({ ok: false, error: t('actions.childWalletNotFound') });
    expect(newRules()).toEqual([]);
  });

  it('is refused for a new goal, and no goal is written', async () => {
    expect(await goal(AVA_WALLET)).toEqual({ ok: false, error: t('actions.childWalletNotFound') });
    expect(goals()).toEqual([]);
  });

  it('is refused when the wallet id names no wallet at all', async () => {
    expect(await allowance('wallet-nobody')).toEqual({ ok: false, error: t('actions.childWalletNotFound') });
    expect(await goal('wallet-nobody')).toEqual({ ok: false, error: t('actions.childWalletNotFound') });
    expect(newRules()).toEqual([]);
    expect(goals()).toEqual([]);
  });
});

describe('a wallet read that fails', () => {
  it('is a failure in words for an allowance, not a save', async () => {
    expect(COULD_NOT_READ()).toBe('Could not load that child wallet.');
    walletReadsFail();
    expect(await allowance(BEN_WALLET)).toEqual({ ok: false, error: COULD_NOT_READ() });
    expect(newRules()).toEqual([]);
  });

  it('is a failure in words for a goal, not a save', async () => {
    walletReadsFail();
    expect(await goal(BEN_WALLET)).toEqual({ ok: false, error: COULD_NOT_READ() });
    expect(goals()).toEqual([]);
  });
});

describe('what still saves', () => {
  it("a new allowance for the active household's own child", async () => {
    expect(await allowance(BEN_WALLET)).toEqual({ ok: true });
    expect(newRules()).toEqual([expect.objectContaining({ family_id: HOUSEHOLD_B, child_wallet_id: BEN_WALLET, amount_cents: 1_000 })]);
  });

  it("the same child's allowance once the parent is back in their household", async () => {
    harness.familyId = HOUSEHOLD_A;
    expect(await allowance(AVA_WALLET)).toEqual({ ok: true });
    expect(newRules()).toEqual([expect.objectContaining({ family_id: HOUSEHOLD_A, child_wallet_id: AVA_WALLET })]);
  });

  it("a new goal for the active household's own child", async () => {
    expect(await goal(BEN_WALLET)).toEqual({ ok: true });
    expect(goals()).toEqual([expect.objectContaining({ family_id: HOUSEHOLD_B, child_wallet_id: BEN_WALLET })]);
  });

  it.each([undefined, null])('a family-wide goal (childWalletId %s), without reading any wallet', async (childWalletId) => {
    expect(await goal(childWalletId)).toEqual({ ok: true });
    expect(goals()).toEqual([expect.objectContaining({ family_id: HOUSEHOLD_B, child_wallet_id: null })]);
    expect(db.log.map((entry) => entry.table)).not.toContain('child_wallets');
  });

  it("an edit of an existing rule, which never changes the rule's wallet and reads none", async () => {
    const edited = await saveAllowanceRuleAction({ id: 'rule-ben', childWalletId: AVA_WALLET, amountCents: 750, cadence: 'weekly' });
    expect(edited).toEqual({ ok: true });
    expect(db.table('allowance_rules')).toEqual([expect.objectContaining({ id: 'rule-ben', child_wallet_id: BEN_WALLET, amount_cents: 750 })]);
    expect(db.log.map((entry) => entry.table)).not.toContain('child_wallets');
  });
});
