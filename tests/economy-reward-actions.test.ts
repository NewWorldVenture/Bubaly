import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * createRewardAction and setRewardActiveAction (app/(app)/economy/actions.ts),
 * run as code. No test ran either. This drives both against the in-memory
 * store, through the real `normalizeTokenAmount`, `normalizeEmoji`,
 * `describeActionError` and message catalogue, and asserts what each writes,
 * leaves alone, refuses and answers.
 *
 * Finding: MAIN-F-F07 (money, kids, economy and missions actions with no
 * test). Register B: ACTION-0DF41D871E0C (createRewardAction),
 * ACTION-8A0C9AFBCF11 (setRewardActiveAction).
 *
 * An archived reward matters more than an archived currency:
 * `requestRedemptionAction` gates on `reward.is_active`, so a reward reported
 * as archived but left active keeps charging tokens. Non-manager refusals
 * assert that nothing is touched, not their wording (reported in #717).
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
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

const { createRewardAction, setRewardActiveAction, requestRedemptionAction } = await import('@/app/(app)/economy/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const SEEDED = ['rew-movie', 'rew-park', 'rew-x'];

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  db.seed('family_currencies', [
    { id: 'cur-stars', family_id: FAMILY, name: 'Stars', emoji: '⭐', is_active: true },
    { id: 'cur-x', family_id: 'family-2', name: 'Coins', emoji: '🪙', is_active: true },
  ]);
  db.seed('family_members', [
    { id: 'member-self', family_id: FAMILY, role: 'parent', is_active: true },
    { id: 'member-kid', family_id: FAMILY, role: 'child', is_active: true },
  ]);
  db.seed('economy_rewards', [
    { id: 'rew-movie', family_id: FAMILY, currency_id: 'cur-stars', title: 'Movie night', emoji: '🎬', cost: 20, stock: null, is_active: true, sort_order: 1, created_by: 'user-other' },
    { id: 'rew-park', family_id: FAMILY, currency_id: 'cur-stars', title: 'Park trip', emoji: '🌳', cost: 10, stock: 3, is_active: true, sort_order: 2, created_by: 'user-other' },
    { id: 'rew-x', family_id: 'family-2', currency_id: 'cur-x', title: 'Their reward', emoji: '🎁', cost: 5, stock: null, is_active: true, sort_order: 1, created_by: 'user-x' },
  ]);
});

/** Replace one table's builder method so its call answers `reply`. */
function override(table: string, method: 'insert' | 'update' | 'maybeSingle', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (n: string) => unknown }).from = (n: string) => {
    const builder = from(n) as unknown as Record<string, unknown>;
    if (n === table) {
      const answer = { data: null, error: null, count: null, status: 200, statusText: 'OK', ...reply };
      if (method === 'maybeSingle') {
        builder.maybeSingle = async () => answer;
      } else {
        const settled: Record<string, unknown> = {
          eq: () => settled,
          select: () => settled,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve),
        };
        builder[method] = () => settled;
      }
    }
    return builder;
  };
}

const rewards = () => db.table('economy_rewards');
const reward = (id: string) => rewards().find((row) => row.id === id) as Row;
const newRows = () => rewards().filter((row) => !SEEDED.includes(String(row.id)));
const create = (over: Partial<Parameters<typeof createRewardAction>[0]> = {}) =>
  createRewardAction({ currencyId: 'cur-stars', title: 'Ice cream', emoji: '🍦', cost: 15, ...over });

describe('createRewardAction (ACTION-0DF41D871E0C)', () => {
  describe('creating', () => {
    it('writes one reward in this family’s currency, priced and stocked as given, and refreshes /economy once', async () => {
      expect(await create({ stock: 4 })).toEqual({ ok: true });

      expect(newRows()).toEqual([expect.objectContaining({
        family_id: FAMILY, currency_id: 'cur-stars', title: 'Ice cream', emoji: '🍦', cost: 15, stock: 4, created_by: 'user-self',
      })]);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
    });

    it('an adult may create one too', async () => {
      harness.role = 'adult';
      expect(await create()).toEqual({ ok: true });
      expect(newRows()).toHaveLength(1);
    });

    it('no stock given is unlimited', async () => {
      await create();
      await create({ title: 'Ice lolly', stock: null });
      expect(newRows().map((row) => row.stock)).toEqual([null, null]);
    });

    it('costs whole tokens: 2.7 is 2', async () => {
      await create({ cost: 2.7 });
      expect(newRows()[0]).toMatchObject({ cost: 2 });
    });

    it('trims the title; a blank icon is a gift box', async () => {
      await create({ title: '  Late bedtime  ', emoji: '   ' });
      expect(newRows()[0]).toMatchObject({ title: 'Late bedtime', emoji: '🎁' });
    });

    it('leaves every other reward alone', async () => {
      const before = structuredClone(rewards());
      await create();
      expect(rewards().slice(0, 3)).toEqual(before);
    });
  });

  describe('refused, with nothing written and nothing refreshed', () => {
    it.each(NON_MANAGERS)('a %s, before anything is touched', async (role) => {
      harness.role = role;

      const result = await create();

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(db.log).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it.each(['', '   '])('a title of %j, before anything is touched', async (title) => {
      expect(await create({ title })).toEqual({ ok: false, error: t('actions.giveTheRewardATitle') });
      expect(db.log).toHaveLength(0);
    });

    it.each([0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('a cost of %s, before anything is touched', async (cost) => {
      expect(await create({ cost })).toEqual({ ok: false, error: t('actions.setACostGreaterThan') });
      expect(db.log).toHaveLength(0);
    });

    it.each([
      ['another family’s currency', 'cur-x'],
      ['a currency that does not exist', 'cur-missing'],
    ])('%s', async (_label, currencyId) => {
      expect(await create({ currencyId })).toEqual({ ok: false, error: t('actions.currencyNotFound') });
      expect(newRows()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a currency that cannot be read is a failure in words', async () => {
      override('family_currencies', 'maybeSingle', { error: PG_ERROR, status: 500 });

      expect(await create()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotVerifyTheCurrency')) });
      expect(newRows()).toHaveLength(0);
    });

    it('a refused insert is a failure in words', async () => {
      override('economy_rewards', 'insert', { error: PG_ERROR, status: 500 });

      expect(await create()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotCreateTheReward')) });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });
});

describe('setRewardActiveAction (ACTION-8A0C9AFBCF11)', () => {
  const set = (rewardId: string, isActive: boolean) => setRewardActiveAction({ rewardId, isActive });

  describe('archiving and restoring', () => {
    it('archives exactly that reward: only its active flag changes, and /economy is refreshed once', async () => {
      const before = structuredClone(rewards());

      expect(await set('rew-movie', false)).toEqual({ ok: true });

      expect(reward('rew-movie')).toEqual({ ...before[0], is_active: false });
      expect(rewards().slice(1)).toEqual(before.slice(1));
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
    });

    it('an archived reward can no longer be asked for', async () => {
      await set('rew-movie', false);
      harness.role = 'child';
      const asked = await requestRedemptionAction({ rewardId: 'rew-movie', memberId: 'member-self' });
      expect(asked).toEqual({ ok: false, error: t('actions.thatRewardIsNotAvailable') });
    });

    it('restores an archived reward', async () => {
      reward('rew-park').is_active = false;
      expect(await set('rew-park', true)).toEqual({ ok: true });
      expect(reward('rew-park').is_active).toBe(true);
    });

    it('an adult may do it too', async () => {
      harness.role = 'adult';
      expect(await set('rew-movie', false)).toEqual({ ok: true });
      expect(reward('rew-movie').is_active).toBe(false);
    });
  });

  describe('refused, with nothing changed and nothing refreshed', () => {
    it.each(NON_MANAGERS)('a %s, before anything is touched', async (role) => {
      harness.role = role;

      const result = await set('rew-movie', false);

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(db.log).toHaveLength(0);
      expect(reward('rew-movie').is_active).toBe(true);
    });

    it.each([
      ['another family’s reward', 'rew-x'],
      ['a reward that does not exist', 'rew-missing'],
    ])('%s is not reported as archived', async (_label, id) => {
      const before = structuredClone(rewards());

      expect(await set(id, false)).toEqual({ ok: false, error: t('economy.couldNotUpdateTheReward') });
      expect(rewards()).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('an update that matches no row (as row-level security would leave it) is not reported as archived', async () => {
      override('economy_rewards', 'update', { data: [] });

      expect(await set('rew-movie', false)).toEqual({ ok: false, error: t('economy.couldNotUpdateTheReward') });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a failed update is a failure in words, and the reward stays redeemable', async () => {
      override('economy_rewards', 'update', { error: PG_ERROR, status: 500 });

      expect(await set('rew-movie', false)).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotUpdateTheReward')) });
      expect(reward('rew-movie').is_active).toBe(true);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });
});
