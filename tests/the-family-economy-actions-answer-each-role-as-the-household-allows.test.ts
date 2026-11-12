// Call-level role tests for the seven Family Economy server actions
// (app/(app)/economy/actions.ts), Register B group 6.
//
// Each action is driven as the real exported function, with valid input, as
// every role of household A — parent, adult, teen, child, a child on a kid
// login, caregiver, guest — and as a signed-out caller, and then with ids that
// belong to household B. Every case reads the tables back: an allowed role
// writes exactly what the action promises, a refused one writes nothing.
//
// THE POLICY these pin, from the sources rather than the action:
//   - lib/constants/roles.ts: isManager = parent or adult.
//   - supabase/migrations/0218_economy_ledger_write_lockdown.sql:21-34 —
//     family_currencies, currency_transactions and economy_rewards are written
//     by can_manage_family only.
//   - 0373_a_redemption_spends_your_own_points.sql:59-62 — economy_redemptions
//     insert: a family member, for their own member row, or a manager for anyone.
//   - 0428_a_reward_costs_what_the_parent_set.sql:158-168 — the decision RPC
//     answers not_found / forbidden unless the caller manages the row's family.
//   - components/economy/economy-view.tsx:44,71-72 — a non-manager is offered a
//     request for themselves only; Requests and Manage show to managers.
//   - Family Economy is a free feature (lib/constants/feature-catalog.ts:148,
//     navigation minLevel 0) and /economy is not withheld from a guest
//     (lib/auth/guest-scope.ts), so there is no plan or guest-area gate to pin.
//
// THE ONE SEAM is `economy_decide_redemption`: it is SQL (0428) and the fake has
// no Postgres. The stand-in below answers the way 0428:158-176 does for the
// reject path (not_found, forbidden for a family the caller does not manage,
// already_decided, else the row is marked rejected). What is pinned for that
// action is the action's own role gate, the arguments it sends and how it
// reads the answer; the cross-family refusal is the SQL's, mirrored here.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const FAM_A = '00000000-0000-4000-8000-00000000000a';
const FAM_B = '00000000-0000-4000-8000-00000000000b';

const M = {
  parent: '00000000-0000-4000-8000-0000000000a1',
  adult: '00000000-0000-4000-8000-0000000000a2',
  teen: '00000000-0000-4000-8000-0000000000a3',
  child: '00000000-0000-4000-8000-0000000000a4',
  kid: '00000000-0000-4000-8000-0000000000a5',
  caregiver: '00000000-0000-4000-8000-0000000000a6',
  guest: '00000000-0000-4000-8000-0000000000a7',
  parentB: '00000000-0000-4000-8000-0000000000b1',
  childB: '00000000-0000-4000-8000-0000000000b4',
} as const;
type Who = keyof typeof M;
const userOf = (who: Who) => M[who].replace('-4000-8000-', '-4000-9000-');

const CUR_A = '00000000-0000-4000-8000-0000000000c1';
const CUR_B = '00000000-0000-4000-8000-0000000000c2';
const REW_A = '00000000-0000-4000-8000-0000000000d1';
const REW_B = '00000000-0000-4000-8000-0000000000d2';
const RED_A = '00000000-0000-4000-8000-0000000000e1';
const RED_B = '00000000-0000-4000-8000-0000000000e2';

/** The member row and role each caller signs in as; `kid` is a child on a kid (PIN) login. */
const CALLERS: Record<Exclude<Who, 'parentB' | 'childB'>, { role: string; email: string }> = {
  parent: { role: 'parent', email: 'parent@example.com' },
  adult: { role: 'adult', email: 'adult@example.com' },
  teen: { role: 'teen', email: 'teen@example.com' },
  child: { role: 'child', email: 'child@example.com' },
  kid: { role: 'child', email: `kid-a5@${CHILD_LOGIN_EMAIL_DOMAIN}` },
  caregiver: { role: 'caregiver', email: 'caregiver@example.com' },
  guest: { role: 'guest', email: 'guest@example.com' },
};
type Caller = keyof typeof CALLERS;
const MANAGERS: Caller[] = ['parent', 'adult'];
const NON_MANAGERS: Caller[] = ['teen', 'child', 'kid', 'caregiver', 'guest'];

const harness = vi.hoisted(() => ({
  db: null as unknown,
  caller: 'parent' as string,
  signedOut: false,
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
}));

vi.mock('next/cache', async () => {
  const { vi: v } = await import('vitest');
  harness.revalidatePath = v.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    // The real one redirects a signed-out caller to /login, which throws.
    if (harness.signedOut) throw new Error('NEXT_REDIRECT;/login');
    const who = harness.caller as Caller;
    const memberId = M[who];
    const active = {
      familyId: FAM_A, role: CALLERS[who].role,
      member: { id: memberId, family_id: FAM_A },
      family: { id: FAM_A, name: 'Household A', timezone: 'UTC' },
    };
    return { user: { id: userOf(who), email: CALLERS[who].email }, memberships: [active], active };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const {
  createCurrencyAction, setCurrencyActiveAction, awardTokensAction, createRewardAction,
  setRewardActiveAction, requestRedemptionAction, decideRedemptionAction,
} = await import('@/app/(app)/economy/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const TABLES = ['family_currencies', 'economy_rewards', 'currency_transactions', 'economy_redemptions', 'family_members'];
let db: InMemorySupabase;
let rpcCalls: Record<string, unknown>[];

/** Every economy table, as a deep copy, for "nothing changed" assertions. */
const snapshot = () => Object.fromEntries(TABLES.map((name) => [name, structuredClone(db.table(name))]));
const rowsOf = (table: string, family: string) => db.table(table).filter((row) => row.family_id === family);
const byId = (table: string, id: string) => db.table(table).find((row) => row.id === id) as Row;

function as(who: Caller) { harness.caller = who; harness.signedOut = false; }

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rpcCalls = [];
  db = createInMemorySupabase({
    rpc: {
      // Stand-in for 0428's economy_decide_redemption, reject path (see header).
      economy_decide_redemption: (args) => {
        rpcCalls.push(args);
        const row = db.table('economy_redemptions').find((r) => r.id === args.p_redemption_id);
        if (!row) return { ok: false, reason: 'not_found' };
        const caller = db.table('family_members').find((m) => m.user_id === userOf(harness.caller as Who) && m.family_id === row.family_id);
        if (!caller || (caller.role !== 'parent' && caller.role !== 'adult')) return { ok: false, reason: 'forbidden' };
        if (row.status !== 'pending') return { ok: false, reason: 'already_decided' };
        if (args.p_approve) throw new Error('approve path is not modelled');
        Object.assign(row, { status: 'rejected', decided_by: userOf(harness.caller as Who), note: args.p_note });
        return { ok: true, status: 'rejected' };
      },
    },
  });
  harness.db = db;
  harness.revalidatePath.mockClear();
  as('parent');

  db.seed('family_members', [
    ...(Object.keys(CALLERS) as Caller[]).map((who) => ({
      id: M[who], family_id: FAM_A, user_id: userOf(who), role: CALLERS[who].role, is_active: true,
    })),
    { id: M.parentB, family_id: FAM_B, user_id: userOf('parentB'), role: 'parent', is_active: true },
    { id: M.childB, family_id: FAM_B, user_id: userOf('childB'), role: 'child', is_active: true },
  ]);
  db.seed('family_currencies', [
    { id: CUR_A, family_id: FAM_A, name: 'Stars', emoji: '⭐', unit_label: null, is_active: true },
    { id: CUR_B, family_id: FAM_B, name: 'Coins', emoji: '🪙', unit_label: null, is_active: true },
  ]);
  db.seed('economy_rewards', [
    { id: REW_A, family_id: FAM_A, currency_id: CUR_A, title: 'Movie night', emoji: '🎬', cost: 5, stock: null, is_active: true },
    { id: REW_B, family_id: FAM_B, currency_id: CUR_B, title: 'Ice cream', emoji: '🍦', cost: 5, stock: null, is_active: true },
  ]);
  db.seed('currency_transactions', [
    ...(Object.keys(CALLERS) as Caller[]).map((who) => ({
      family_id: FAM_A, currency_id: CUR_A, member_id: M[who], direction: 'credit', amount: 10, reason: 'Seed', related_type: 'manual',
    })),
    { family_id: FAM_B, currency_id: CUR_B, member_id: M.childB, direction: 'credit', amount: 10, reason: 'Seed', related_type: 'manual' },
  ]);
  db.seed('economy_redemptions', [
    { id: RED_A, family_id: FAM_A, reward_id: REW_A, currency_id: CUR_A, member_id: M.child, title: 'Movie night', cost: 5, status: 'pending', note: null, decided_by: null },
    { id: RED_B, family_id: FAM_B, reward_id: REW_B, currency_id: CUR_B, member_id: M.childB, title: 'Ice cream', cost: 5, status: 'pending', note: null, decided_by: null },
  ]);
});

/** A refused call: the answer is the refusal, nothing was written and nothing refreshed. */
async function expectRefused(call: () => Promise<unknown>, answer: unknown) {
  const before = snapshot();
  expect(await call()).toEqual(answer);
  expect(snapshot()).toEqual(before);
  expect(harness.revalidatePath).not.toHaveBeenCalled();
}

/** A signed-out caller is redirected (the real requireUserContext throws) before any table is touched. */
async function expectSignedOutRedirect(call: () => Promise<unknown>) {
  harness.signedOut = true;
  const before = snapshot();
  await expect(call()).rejects.toThrow('NEXT_REDIRECT');
  expect(db.log).toHaveLength(0);
  expect(snapshot()).toEqual(before);
}

describe('createCurrencyAction', () => {
  const create = () => createCurrencyAction({ name: '  Gems ', emoji: '💎', unitLabel: ' gem ' });

  it.each(MANAGERS)('ACTION-406DD2DE86E3 a %s creates one currency in their own household', async (who) => {
    as(who);
    expect(await create()).toEqual({ ok: true });
    expect(rowsOf('family_currencies', FAM_A)).toHaveLength(2);
    expect(rowsOf('family_currencies', FAM_A).find((r) => r.name === 'Gems')).toMatchObject({
      family_id: FAM_A, name: 'Gems', emoji: '💎', unit_label: 'gem', created_by: userOf(who),
    });
    expect(rowsOf('family_currencies', FAM_B)).toHaveLength(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
  });

  it.each(NON_MANAGERS)('ACTION-406DD2DE86E3 a %s is refused and nothing is written', async (who) => {
    as(who);
    await expectRefused(create, { ok: false, error: t('actions.onlyAParentGuardianCan') });
  });

  it('ACTION-406DD2DE86E3 a signed-out caller is redirected before anything is read or written', async () => {
    await expectSignedOutRedirect(create);
  });
});

describe('setCurrencyActiveAction', () => {
  it.each(MANAGERS)('ACTION-0DBCDF276549 a %s archives their own household’s currency', async (who) => {
    as(who);
    expect(await setCurrencyActiveAction({ currencyId: CUR_A, isActive: false })).toEqual({ ok: true });
    expect(byId('family_currencies', CUR_A).is_active).toBe(false);
    expect(byId('family_currencies', CUR_B).is_active).toBe(true);
  });

  it.each(NON_MANAGERS)('ACTION-0DBCDF276549 a %s is refused and the currency stays active', async (who) => {
    as(who);
    await expectRefused(() => setCurrencyActiveAction({ currencyId: CUR_A, isActive: false }),
      { ok: false, error: t('actions.onlyAParentGuardianCan2') });
  });

  it.each(MANAGERS)('ACTION-0DBCDF276549 a %s cannot archive another household’s currency', async (who) => {
    as(who);
    await expectRefused(() => setCurrencyActiveAction({ currencyId: CUR_B, isActive: false }),
      { ok: false, error: t('economy.couldNotUpdateTheCurrency') });
  });

  it('ACTION-0DBCDF276549 a signed-out caller is redirected before anything is read or written', async () => {
    await expectSignedOutRedirect(() => setCurrencyActiveAction({ currencyId: CUR_A, isActive: false }));
  });
});

describe('awardTokensAction', () => {
  const award = (over: Partial<Parameters<typeof awardTokensAction>[0]> = {}) =>
    awardTokensAction({ currencyId: CUR_A, memberId: M.child, amount: 4, reason: 'Tidied up', ...over });
  const ledgerA = () => rowsOf('currency_transactions', FAM_A);

  it.each(MANAGERS)('ACTION-15AC56471580 a %s credits one ledger row to a child of their household', async (who) => {
    as(who);
    const before = ledgerA().length;
    expect(await award()).toEqual({ ok: true });
    expect(ledgerA()).toHaveLength(before + 1);
    expect(ledgerA().at(-1)).toMatchObject({
      family_id: FAM_A, currency_id: CUR_A, member_id: M.child, direction: 'credit', amount: 4,
      reason: 'Tidied up', related_type: 'manual', created_by: userOf(who),
    });
    expect(rowsOf('currency_transactions', FAM_B)).toHaveLength(1);
  });

  it.each(NON_MANAGERS)('ACTION-15AC56471580 a %s is refused and the ledger is untouched', async (who) => {
    as(who);
    // A non-manager awarding themselves is the case a refusal exists for.
    await expectRefused(() => award({ memberId: M[who] }), { ok: false, error: t('actions.onlyAParentGuardianCan3') });
  });

  it.each(MANAGERS)('ACTION-15AC56471580 a %s cannot credit another household’s currency', async (who) => {
    as(who);
    await expectRefused(() => award({ currencyId: CUR_B }), { ok: false, error: t('actions.currencyNotFound') });
  });

  it.each(MANAGERS)('ACTION-15AC56471580 a %s cannot credit another household’s member', async (who) => {
    as(who);
    await expectRefused(() => award({ memberId: M.childB }), { ok: false, error: t('actions.familyMemberNotFound') });
  });

  it('ACTION-15AC56471580 a signed-out caller is redirected before anything is read or written', async () => {
    await expectSignedOutRedirect(() => award());
  });
});

describe('createRewardAction', () => {
  const create = (over: Partial<Parameters<typeof createRewardAction>[0]> = {}) =>
    createRewardAction({ currencyId: CUR_A, title: ' Late bedtime ', emoji: '🌙', cost: 8, stock: 2, ...over });

  it.each(MANAGERS)('ACTION-0DF41D871E0C a %s adds one reward priced in their household’s currency', async (who) => {
    as(who);
    expect(await create()).toEqual({ ok: true });
    expect(rowsOf('economy_rewards', FAM_A)).toHaveLength(2);
    expect(rowsOf('economy_rewards', FAM_A).find((r) => r.title === 'Late bedtime')).toMatchObject({
      family_id: FAM_A, currency_id: CUR_A, title: 'Late bedtime', emoji: '🌙', cost: 8, stock: 2, created_by: userOf(who),
    });
    expect(rowsOf('economy_rewards', FAM_B)).toHaveLength(1);
  });

  it.each(NON_MANAGERS)('ACTION-0DF41D871E0C a %s is refused and no reward is added', async (who) => {
    as(who);
    await expectRefused(() => create(), { ok: false, error: t('actions.onlyAParentGuardianCan4') });
  });

  it.each(MANAGERS)('ACTION-0DF41D871E0C a %s cannot price a reward in another household’s currency', async (who) => {
    as(who);
    await expectRefused(() => create({ currencyId: CUR_B }), { ok: false, error: t('actions.currencyNotFound') });
  });

  it('ACTION-0DF41D871E0C a signed-out caller is redirected before anything is read or written', async () => {
    await expectSignedOutRedirect(() => create());
  });
});

describe('setRewardActiveAction', () => {
  it.each(MANAGERS)('ACTION-8A0C9AFBCF11 a %s archives their own household’s reward', async (who) => {
    as(who);
    expect(await setRewardActiveAction({ rewardId: REW_A, isActive: false })).toEqual({ ok: true });
    expect(byId('economy_rewards', REW_A).is_active).toBe(false);
    expect(byId('economy_rewards', REW_B).is_active).toBe(true);
  });

  it.each(NON_MANAGERS)('ACTION-8A0C9AFBCF11 a %s is refused and the reward stays redeemable', async (who) => {
    as(who);
    await expectRefused(() => setRewardActiveAction({ rewardId: REW_A, isActive: false }),
      { ok: false, error: t('actions.onlyAParentGuardianCan2') });
  });

  it.each(MANAGERS)('ACTION-8A0C9AFBCF11 a %s cannot archive another household’s reward', async (who) => {
    as(who);
    await expectRefused(() => setRewardActiveAction({ rewardId: REW_B, isActive: false }),
      { ok: false, error: t('economy.couldNotUpdateTheReward') });
  });

  it('ACTION-8A0C9AFBCF11 a signed-out caller is redirected before anything is read or written', async () => {
    await expectSignedOutRedirect(() => setRewardActiveAction({ rewardId: REW_A, isActive: false }));
  });
});

describe('requestRedemptionAction', () => {
  const pendingA = () => rowsOf('economy_redemptions', FAM_A);

  it.each([...MANAGERS, ...NON_MANAGERS])('ACTION-82980A9A8005 a %s requests a reward against their own tokens', async (who) => {
    as(who);
    expect(await requestRedemptionAction({ rewardId: REW_A, memberId: M[who] })).toEqual({ ok: true });
    expect(pendingA()).toHaveLength(2);
    expect(pendingA().at(-1)).toMatchObject({
      family_id: FAM_A, reward_id: REW_A, currency_id: CUR_A, member_id: M[who],
      title: 'Movie night', cost: 5, status: 'pending', requested_by: userOf(who),
    });
    // A request debits nothing; the decision does.
    expect(rowsOf('currency_transactions', FAM_A).every((r) => r.direction === 'credit')).toBe(true);
    expect(rowsOf('economy_redemptions', FAM_B)).toHaveLength(1);
  });

  it.each(MANAGERS)('ACTION-82980A9A8005 a %s may request on a child’s behalf', async (who) => {
    as(who);
    expect(await requestRedemptionAction({ rewardId: REW_A, memberId: M.teen })).toEqual({ ok: true });
    expect(pendingA().at(-1)).toMatchObject({ member_id: M.teen, requested_by: userOf(who), status: 'pending' });
  });

  it.each(NON_MANAGERS)('ACTION-82980A9A8005 a %s cannot spend a sibling’s tokens, and is refused before any read', async (who) => {
    as(who);
    const sibling = who === 'child' ? M.teen : M.child;
    await expectRefused(() => requestRedemptionAction({ rewardId: REW_A, memberId: sibling }),
      { ok: false, error: t('actions.familyMemberNotFound') });
    expect(db.log).toHaveLength(0);
  });

  it.each([...MANAGERS, ...NON_MANAGERS])('ACTION-82980A9A8005 a %s cannot redeem another household’s reward', async (who) => {
    as(who);
    await expectRefused(() => requestRedemptionAction({ rewardId: REW_B, memberId: M[who] }),
      { ok: false, error: t('actions.thatRewardIsNotAvailable') });
  });

  it.each(MANAGERS)('ACTION-82980A9A8005 a %s cannot charge another household’s member', async (who) => {
    as(who);
    await expectRefused(() => requestRedemptionAction({ rewardId: REW_A, memberId: M.childB }),
      { ok: false, error: t('actions.familyMemberNotFound') });
  });

  it('ACTION-82980A9A8005 a signed-out caller is redirected before anything is read or written', async () => {
    await expectSignedOutRedirect(() => requestRedemptionAction({ rewardId: REW_A, memberId: M.child }));
  });
});

describe('decideRedemptionAction', () => {
  it.each(MANAGERS)('ACTION-A8F6037143A6 a %s decides their household’s request through the RPC', async (who) => {
    as(who);
    expect(await decideRedemptionAction({ redemptionId: RED_A, approve: false, note: '  Not this week ' })).toEqual({ ok: true });
    expect(rpcCalls).toEqual([{ p_redemption_id: RED_A, p_approve: false, p_note: 'Not this week' }]);
    expect(byId('economy_redemptions', RED_A)).toMatchObject({ status: 'rejected', decided_by: userOf(who) });
    expect(byId('economy_redemptions', RED_B)).toMatchObject({ status: 'pending', decided_by: null });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
  });

  it.each(NON_MANAGERS)('ACTION-A8F6037143A6 a %s is refused before the RPC is called', async (who) => {
    as(who);
    await expectRefused(() => decideRedemptionAction({ redemptionId: RED_A, approve: true }),
      { ok: false, error: t('actions.onlyAParentGuardianCan5') });
    expect(rpcCalls).toEqual([]);
  });

  it.each(MANAGERS)('ACTION-A8F6037143A6 a %s deciding another household’s request is refused as the database answers', async (who) => {
    as(who);
    await expectRefused(() => decideRedemptionAction({ redemptionId: RED_B, approve: false }),
      { ok: false, error: 'Only a parent or guardian can decide redemptions.' });
    expect(rpcCalls).toEqual([{ p_redemption_id: RED_B, p_approve: false, p_note: null }]);
  });

  it('ACTION-A8F6037143A6 a signed-out caller is redirected before anything is read or written', async () => {
    await expectSignedOutRedirect(() => decideRedemptionAction({ redemptionId: RED_A, approve: false }));
    expect(rpcCalls).toEqual([]);
  });
});
