import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * Asking to redeem a reward checks the member's token balance first, and that
 * balance is summed from their `currency_transactions` rows. The rows were read
 * with one unpaged select, and PostgREST answers any single response with at
 * most `db-max-rows` (1,000 on a default project), silently. Past 1,000 rows the
 * pre-check summed an arbitrary slice of the ledger:
 *
 *  - a member who could afford the reward was told "Not enough tokens yet";
 *  - a member who could not was queued for a parent's approval.
 *
 * `economy_decide_redemption` re-checks the balance atomically when a parent
 * approves, so the second case is a request that should never have been
 * filed, not an overspend; nothing here claims one.
 *
 * The store below caps every response at 1,000 rows, as PostgREST does.
 */

const FAMILY = 'family-1';
const CAP = 1_000;
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'child', memberId: 'member-child' }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: FAMILY, role: harness.role, member: { id: harness.memberId, family_id: FAMILY } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});

const { requestRedemptionAction } = await import('@/app/(app)/economy/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const NOT_ENOUGH = translate(SOURCE_MESSAGES, 'actions.notEnoughTokensYet');
const { describeActionError } = await import('@/lib/supabase/errors');
const COULD_NOT_CHECK = translate(SOURCE_MESSAGES, 'economy.couldNotCheckTheTokenBalance');
const PAGE_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
/** What the family reads when a page fails: the action's own wording for that error. */
const PAGE_FAILED = describeActionError(PAGE_ERROR, COULD_NOT_CHECK);

let db: InMemorySupabase;
let nextId = 0;

/** `count` ledger rows of `amount` each, oldest first; ids sort in the order written. */
function ledger(count: number, amount: number, direction: 'credit' | 'debit' = 'credit', over: Row = {}) {
  db.seed('currency_transactions', Array.from({ length: count }, () => ({
    id: `txn-${String(nextId++).padStart(7, '0')}`, family_id: FAMILY, currency_id: 'cur-1',
    member_id: 'member-child', direction, amount, ...over,
  })));
}

function reward(cost: number) {
  db.replace('economy_rewards', [{ id: 'reward-1', family_id: FAMILY, currency_id: 'cur-1', title: 'Pizza night', cost, is_active: true, stock: null }]);
}

const ask = (memberId = 'member-child') => requestRedemptionAction({ rewardId: 'reward-1', memberId });
const queued = () => db.table('economy_redemptions');

/** Every `currency_transactions` page from row `first` on answers a database error. */
function failPagesFrom(first: number) {
  const from = db.from.bind(db);
  (db as unknown as { from: (table: string) => unknown }).from = (table: string) => {
    const builder = from(table);
    if (table !== 'currency_transactions') return builder;
    const range = builder.range.bind(builder);
    (builder as unknown as { range: (a: number, b: number) => unknown }).range = (a: number, b: number) => (a >= first
      ? { then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: null, error: PAGE_ERROR,
        count: null, status: 500, statusText: 'Internal Server Error',
      }).then(resolve) }
      : range(a, b));
    return builder;
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: CAP });
  harness.db = db;
  harness.role = 'child';
  harness.memberId = 'member-child';
  nextId = 0;
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, role: 'parent', is_active: true },
    { id: 'member-child', family_id: FAMILY, role: 'child', is_active: true },
    { id: 'member-sibling', family_id: FAMILY, role: 'child', is_active: true },
  ]);
});

describe('a redemption request checks the whole token ledger', () => {
  it('does not refuse an affordable request when the ledger is longer than one response', async () => {
    // 1,000 one-token awards, then a 500-token award: 1,500 in all.
    ledger(1_000, 1);
    ledger(1, 500);
    reward(1_200);

    const result = await ask();

    expect(result).toEqual({ ok: true });
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ member_id: 'member-child', cost: 1_200, status: 'pending' });
  });

  it('does not queue an unaffordable request when the ledger is longer than one response', async () => {
    // 1,100 one-token awards, then an approved 1,000-token redemption: 100 left.
    ledger(1_100, 1);
    ledger(1, 1_000, 'debit');
    reward(500);

    const result = await ask();

    expect(result).toEqual({ ok: false, error: NOT_ENOUGH });
    expect(queued()).toHaveLength(0);
  });

  it('refuses to guess past the ceiling: more than 5,000 rows fails closed and queues nothing', async () => {
    ledger(5_001, 1);
    reward(10);

    const result = await ask();

    expect(result).toEqual({ ok: false, error: COULD_NOT_CHECK });
    expect(queued()).toHaveLength(0);
  });

  it('reads exactly 5,000 rows as the whole ledger', async () => {
    ledger(5_000, 1);
    reward(5_000);

    expect(await ask()).toEqual({ ok: true });
    expect(queued()).toHaveLength(1);
  });

  it('fails closed when a later page fails, rather than summing the pages that arrived', async () => {
    // The first page alone (1,000) cannot afford 1,200; the whole ledger can.
    ledger(1_500, 1);
    reward(1_200);
    failPagesFrom(CAP);

    const result = await ask();

    expect(result).toEqual({ ok: false, error: PAGE_FAILED });
    expect(PAGE_FAILED).not.toBe(NOT_ENOUGH);
    expect(queued()).toHaveLength(0);
  });

  it('fails closed when a later page fails, even where the first page alone would afford it', async () => {
    ledger(1_500, 1);
    reward(10);
    failPagesFrom(CAP);

    expect(await ask()).toEqual({ ok: false, error: PAGE_FAILED });
    expect(queued()).toHaveLength(0);
  });

  describe('balance boundaries', () => {
    it('a balance equal to the cost affords it; one token short does not', async () => {
      ledger(10, 1);
      reward(10);
      expect(await ask()).toEqual({ ok: true });

      db.replace('economy_redemptions', []);
      reward(11);
      expect(await ask()).toEqual({ ok: false, error: NOT_ENOUGH });
      expect(queued()).toHaveLength(0);
    });

    it('exactly one full response (1,000 rows) is the whole ledger', async () => {
      ledger(1_000, 1);
      reward(1_000);
      expect(await ask()).toEqual({ ok: true });

      db.replace('economy_redemptions', []);
      reward(1_001);
      expect(await ask()).toEqual({ ok: false, error: NOT_ENOUGH });
    });

    it('the 1,001st row counts', async () => {
      ledger(1_001, 1);
      reward(1_001);
      expect(await ask()).toEqual({ ok: true });

      db.replace('economy_redemptions', []);
      reward(1_002);
      expect(await ask()).toEqual({ ok: false, error: NOT_ENOUGH });
    });

    it('a debit on a later page is subtracted', async () => {
      ledger(1_200, 1);
      ledger(1, 300, 'debit');
      reward(901);
      expect(await ask()).toEqual({ ok: false, error: NOT_ENOUGH });

      reward(900);
      expect(await ask()).toEqual({ ok: true });
    });
  });

  describe('whose tokens', () => {
    beforeEach(() => {
      // The child holds 10 in this currency. Everyone else holds far more,
      // across more than one response, and none of it is the child's.
      ledger(10, 1);
      ledger(1_200, 1, 'credit', { member_id: 'member-sibling' });
      ledger(1_200, 1, 'credit', { currency_id: 'cur-2' });
      ledger(1_200, 1, 'credit', { family_id: 'family-2' });
    });

    it('counts only the named member’s tokens in the reward’s currency and family', async () => {
      reward(11);
      expect(await ask()).toEqual({ ok: false, error: NOT_ENOUGH });

      reward(10);
      expect(await ask()).toEqual({ ok: true });
      expect(queued()[0]).toMatchObject({ member_id: 'member-child' });
    });

    it('still refuses a child asking against a sibling’s tokens, and reads no ledger for it', async () => {
      reward(500);
      const reads = db.log.length;

      expect((await ask('member-sibling')).ok).toBe(false);
      expect(queued()).toHaveLength(0);
      expect(db.log.slice(reads).map((entry) => entry.table)).not.toContain('currency_transactions');
    });

    it('lets a parent ask on a child’s behalf, against that child’s whole ledger', async () => {
      harness.role = 'parent';
      harness.memberId = 'member-parent';
      reward(1_200);

      expect(await ask('member-sibling')).toEqual({ ok: true });
      expect(queued()[0]).toMatchObject({ member_id: 'member-sibling', status: 'pending' });

      db.replace('economy_redemptions', []);
      reward(1_201);
      expect(await ask('member-sibling')).toEqual({ ok: false, error: NOT_ENOUGH });
    });
  });
});
