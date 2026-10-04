import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * An allowance whose amount is edited during a run is paid its new amount.
 *
 * `runDueAllowancesAction` and the nightly cron read the due rules, then claim
 * each one and credit `rule.amount_cents` FROM THAT READ. Once an amount-only
 * edit keeps the rule's date (#916), an edit that commits between the read and
 * the claim no longer makes the claim miss — so the run paid the amount the
 * parent had just changed away from: $15.00 credited for a rule now set to
 * $20.00, and the schedule advanced past it.
 *
 * The claim now also requires the amount it read, in the same statement, as it
 * already requires `is_active` for a pause (a-paused-allowance-is-not-claimed).
 * An edit and the claim cannot both win: a claim that finds the amount changed
 * matches no row and is skipped like one another run claimed. The rule keeps
 * its date, so the next run pays it — at the new amount.
 */

const FAMILY = 'family-1';
const TODAY = '2026-09-28';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
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
vi.mock('@/lib/trust/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/trust/server')>()),
  evaluateTrust: async () => ({ decision: { effect: 'allow', reason: 'Allowed.', basis: 'role_default' } }),
}));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));

const { runDueAllowancesAction } = await import('@/app/(app)/wallet/actions');
const { GET: runAllowanceCron } = await import('@/app/api/cron/wallet-allowance/route');
const KINDS = ['spend', 'save', 'give', 'invest'] as const;

let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('family_members', [{ id: 'member-self', family_id: FAMILY, user_id: 'user-self', role: 'parent', is_active: true }]);
  db.seed('child_wallets', [{ id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' }]);
  db.seed('wallet_buckets', KINDS.map((kind) => ({ id: `wallet-a-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-a', kind })));
  db.seed('allowance_rules', [{
    id: 'rule-1', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_500, cadence: 'weekly', split: null,
    is_active: true, next_run_on: TODAY, last_run_on: '2026-09-21', created_by: 'user-self',
  }]);
});

afterEach(() => { vi.useRealTimers(); });

const rule = () => db.table('allowance_rules')[0] as Row;
const ledger = () => db.table('wallet_transactions');

/** A parent's amount edit (same cadence, date kept) commits after the due read, just before the first claim. */
function editAmountBeforeTheClaim(newCents: number) {
  const from = db.from.bind(db);
  let edited = false;
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === 'allowance_rules') {
      const update = (builder.update as (patch: Row) => unknown).bind(builder);
      builder.update = (patch: Row) => {
        if (!edited && 'last_run_on' in patch) { edited = true; rule().amount_cents = newCents; }
        return update(patch);
      };
    }
    return builder;
  };
}

const runCron = async () => (await runAllowanceCron(new Request('https://bubaly.test/api/cron/wallet-allowance') as never)).json();
const paid = () => ledger().reduce((sum, row) => sum + Number(row.amount_cents), 0);

describe('the manual run (runDueAllowancesAction)', () => {
  it('does not pay the old amount of a rule edited after the due read, and leaves it due', async () => {
    editAmountBeforeTheClaim(2_000);

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(ledger()).toHaveLength(0);
    expect(rule()).toMatchObject({ amount_cents: 2_000, next_run_on: TODAY, last_run_on: '2026-09-21' });
  });

  it('the next run pays it, once, at the new amount', async () => {
    editAmountBeforeTheClaim(2_000);
    await runDueAllowancesAction();

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 1, paidCents: 2_000 });
    expect(paid()).toBe(2_000);
    expect(rule()).toMatchObject({ next_run_on: '2026-10-05', last_run_on: TODAY });
  });

  it('a rule nobody edits is still claimed and paid, once', async () => {
    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 1, paidCents: 1_500 });
    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(paid()).toBe(1_500);
  });
});

describe('the nightly cron', () => {
  it('does not pay the old amount of a rule edited after the due read, and leaves it due', async () => {
    editAmountBeforeTheClaim(2_000);

    expect(await runCron()).toMatchObject({ ok: true, due: 1, paid: 0, failed: 0 });
    expect(ledger()).toHaveLength(0);
    expect(rule()).toMatchObject({ amount_cents: 2_000, next_run_on: TODAY, last_run_on: '2026-09-21' });
  });

  it('the next run pays it, once, at the new amount', async () => {
    editAmountBeforeTheClaim(2_000);
    await runCron();

    expect(await runCron()).toMatchObject({ ok: true, due: 1, paid: 1, failed: 0 });
    expect(paid()).toBe(2_000);
  });

  it('a rule nobody edits is still claimed and paid, once', async () => {
    expect(await runCron()).toMatchObject({ ok: true, due: 1, paid: 1, failed: 0 });
    expect(await runCron()).toMatchObject({ ok: true, due: 0, paid: 0 });
    expect(paid()).toBe(1_500);
  });
});
