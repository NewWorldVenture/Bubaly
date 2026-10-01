import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * awardTokensAction and decideRedemptionAction (app/(app)/economy/actions.ts),
 * run as code. No test ran either: `reward-redemption-write-path.test.ts`
 * drives the DASHBOARD's decideRedemptionAction (app/(app)/dashboard/rewards),
 * a different function with the same name, and the economy tests read source
 * text or the ledger helpers. This drives both against the in-memory store and
 * a synthetic `economy_decide_redemption` RPC, through the real
 * `normalizeTokenAmount`, `describeActionError` and message catalogue, and
 * asserts what each reads, writes, sends and answers.
 *
 * Finding: MAIN-F-F07 (money, kids, economy and missions actions with no
 * test). Register B: ACTION-15AC56471580 (awardTokensAction),
 * ACTION-A8F6037143A6 (decideRedemptionAction).
 *
 * The RPC is synthetic. On the real schema it locks the redemption and the
 * reward, re-checks the balance and debits the ledger (0196, 0428); none of
 * that is established here, only what the action sends and how it answers.
 * Non-manager refusals assert that nothing is read and the answer is a
 * refusal, not its wording: each economy refusal currently borrows a wallet
 * key whose text names another feature (see the PR).
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  decide: null as null | ((args: Record<string, unknown>) => unknown),
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
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
    active: { familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY }, family: { id: FAMILY, timezone: 'UTC' } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { awardTokensAction, decideRedemptionAction } = await import('@/app/(app)/economy/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

let db: InMemorySupabase;
let decideCalls: Record<string, unknown>[];

beforeEach(() => {
  // Cleared per test: two cases below assert what is logged, and a call left
  // over from an earlier test would satisfy them on its own.
  vi.spyOn(console, 'error').mockImplementation(() => {}).mockClear();
  decideCalls = [];
  db = createInMemorySupabase({
    rpc: {
      economy_decide_redemption: (args) => { decideCalls.push(args); return harness.decide?.(args); },
    },
  });
  harness.db = db;
  harness.role = 'parent';
  harness.decide = () => ({ ok: true, status: 'fulfilled' });
  harness.revalidatePath.mockClear();
  db.seed('family_currencies', [
    { id: 'cur-stars', family_id: FAMILY, name: 'Stars', emoji: '⭐', is_active: true },
    { id: 'cur-x', family_id: 'family-2', name: 'Coins', emoji: '🪙', is_active: true },
  ]);
  db.seed('family_members', [
    { id: 'member-self', family_id: FAMILY, role: 'parent', is_active: true },
    { id: 'member-kid', family_id: FAMILY, role: 'child', is_active: true },
    { id: 'member-x', family_id: 'family-2', role: 'child', is_active: true },
  ]);
});

/** Make one table's single-row read answer a database error. */
function failRead(table: string) {
  const from = db.from.bind(db);
  (db as unknown as { from: (n: string) => unknown }).from = (n: string) => {
    const builder = from(n) as unknown as Record<string, unknown>;
    if (n === table) builder.maybeSingle = async () => ({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' });
    return builder;
  };
}

/** Make the ledger insert answer a database error. */
function failInsert(table: string) {
  const from = db.from.bind(db);
  (db as unknown as { from: (n: string) => unknown }).from = (n: string) => {
    const builder = from(n) as unknown as Record<string, unknown>;
    if (n === table) {
      builder.insert = () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve) });
    }
    return builder;
  };
}

const ledger = () => db.table('currency_transactions');
const award = (over: Partial<Parameters<typeof awardTokensAction>[0]> = {}) =>
  awardTokensAction({ currencyId: 'cur-stars', memberId: 'member-kid', amount: 5, reason: 'Tidied up', ...over });

describe('awardTokensAction (ACTION-15AC56471580)', () => {
  describe('awarding', () => {
    it('credits one ledger row for this family’s member in this family’s currency, and refreshes /economy once', async () => {
      expect(await award()).toEqual({ ok: true });

      expect(ledger()).toEqual([expect.objectContaining({
        family_id: FAMILY, currency_id: 'cur-stars', member_id: 'member-kid',
        direction: 'credit', amount: 5, reason: 'Tidied up', related_type: 'manual', created_by: 'user-self',
      })]);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
    });

    it('an adult may award too', async () => {
      harness.role = 'adult';
      expect(await award()).toEqual({ ok: true });
      expect(ledger()).toHaveLength(1);
    });

    it('awards whole tokens: 3.9 is 3', async () => {
      expect(await award({ amount: 3.9 })).toEqual({ ok: true });
      expect(ledger()[0]).toMatchObject({ amount: 3 });
    });

    it('trims the reason, and a blank one is recorded as "Awarded"', async () => {
      await award({ reason: '  Fed the cat  ' });
      await award({ reason: '   ' });
      await award({ reason: undefined });
      expect(ledger().map((row) => row.reason)).toEqual(['Fed the cat', 'Awarded', 'Awarded']);
    });

    it('never debits: an award is always a credit, however it is asked for', async () => {
      await award({ amount: 7 });
      expect(ledger().every((row) => row.direction === 'credit')).toBe(true);
    });
  });

  describe('refused, with nothing written and nothing refreshed', () => {
    it.each(NON_MANAGERS)('a %s, before anything is read', async (role) => {
      harness.role = role;

      const result = await award();

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(db.log).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it.each([0, -3, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('an amount of %s, before anything is read', async (amount) => {
      expect(await award({ amount })).toEqual({ ok: false, error: t('actions.enterAWholeNumberGreater') });
      expect(db.log).toHaveLength(0);
    });

    it.each([
      ['another family’s currency', { currencyId: 'cur-x' }, 'actions.currencyNotFound'],
      ['a currency that does not exist', { currencyId: 'cur-missing' }, 'actions.currencyNotFound'],
      ['another family’s member', { memberId: 'member-x' }, 'actions.familyMemberNotFound'],
      ['a member who does not exist', { memberId: 'member-missing' }, 'actions.familyMemberNotFound'],
    ])('%s', async (_label, over, key) => {
      expect(await award(over)).toEqual({ ok: false, error: t(key) });
      expect(ledger()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('failures, in words', () => {
    it('the currency cannot be read', async () => {
      failRead('family_currencies');
      expect(await award()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotVerifyTheCurrency')) });
      expect(ledger()).toHaveLength(0);
    });

    it('the member cannot be read', async () => {
      failRead('family_members');
      expect(await award()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotVerifyTheFamilyMember')) });
      expect(ledger()).toHaveLength(0);
    });

    it('the ledger refuses the credit: nothing is refreshed', async () => {
      failInsert('currency_transactions');
      expect(await award()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotAwardTokens')) });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });
});

describe('decideRedemptionAction (ACTION-A8F6037143A6)', () => {
  const COULD_NOT = () => t('economy.couldNotDecideTheRedemption');
  const decide = (over: Partial<Parameters<typeof decideRedemptionAction>[0]> = {}) =>
    decideRedemptionAction({ redemptionId: 'red-1', approve: true, ...over });

  describe('deciding', () => {
    it('an approval is one RPC call, as sent, and refreshes /economy once', async () => {
      expect(await decide()).toEqual({ ok: true });

      expect(decideCalls).toEqual([{ p_redemption_id: 'red-1', p_approve: true, p_note: null }]);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
    });

    it('a rejection carries its trimmed note; a blank note is sent as none', async () => {
      harness.decide = () => ({ ok: true, status: 'rejected' });
      await decide({ approve: false, note: '  Not this week  ' });
      await decide({ approve: false, note: '   ' });

      expect(decideCalls).toEqual([
        { p_redemption_id: 'red-1', p_approve: false, p_note: 'Not this week' },
        { p_redemption_id: 'red-1', p_approve: false, p_note: null },
      ]);
    });

    it('an adult may decide too', async () => {
      harness.role = 'adult';
      expect(await decide()).toEqual({ ok: true });
      expect(decideCalls).toHaveLength(1);
    });
  });

  describe('refused before the RPC', () => {
    it.each(NON_MANAGERS)('a %s', async (role) => {
      harness.role = role;

      const result = await decide();

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(decideCalls).toHaveLength(0);
      expect(db.log).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('when the RPC says no, or answers nothing usable: nothing is refreshed', () => {
    it('out of stock is said in the reader’s language', async () => {
      harness.decide = () => ({ ok: false, reason: 'out_of_stock' });
      expect(await decide()).toEqual({ ok: false, error: t('actions.thatRewardIsOutOf') });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it.each(['unauthenticated', 'forbidden', 'not_found', 'already_decided', 'insufficient_tokens'])(
      '"%s" is a refusal with its own explanation, not the generic one and not the code',
      async (reason) => {
        harness.decide = () => ({ ok: false, reason });

        const result = await decide();

        expect(result.ok).toBe(false);
        expect(result.error).toEqual(expect.any(String));
        expect(result.error).not.toBe(COULD_NOT());
        expect(result.error).not.toContain(reason);
        expect(harness.revalidatePath).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['an unknown reason', { ok: false, reason: 'something_new' }],
      ['no reason at all', { ok: false }],
      ['an "ok" that is not literally true', { ok: 'true' }],
    ])('%s is the generic failure', async (_label, reply) => {
      harness.decide = () => reply;
      expect(await decide()).toEqual({ ok: false, error: COULD_NOT() });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      ['nothing', null],
      ['a list', [{ ok: true }]],
      ['a bare string', 'ok'],
    ])('a reply of %s is not taken as a decision, and is logged as an invalid one', async (_label, reply) => {
      harness.decide = () => reply;
      expect(await decide()).toEqual({
        ok: false,
        error: describeActionError(new Error(t('actions.invalidDecisionResponse')), COULD_NOT()),
      });
      // The answer a parent reads is the generic one either way; what tells an
      // operator the RPC answered something malformed is this log line.
      expect(console.error).toHaveBeenCalledWith('[economy-action] decide the redemption failed',
        expect.objectContaining({ message: t('actions.invalidDecisionResponse') }));
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a failed RPC call is a failure in words, and the database’s text is not passed on', async () => {
      harness.decide = () => { throw new Error('deadlock detected'); };

      const result = await decide();

      expect(result).toEqual({
        ok: false,
        error: describeActionError({ code: 'P0001', message: 'deadlock detected', details: null, hint: null }, COULD_NOT()),
      });
      expect(result.error).not.toContain('deadlock');
      // The database's own error is what the server log keeps, not a stand-in.
      expect(console.error).toHaveBeenCalledWith('[economy-action] decide the redemption failed',
        expect.objectContaining({ code: 'P0001', message: 'deadlock detected' }));
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });
});
