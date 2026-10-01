import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * An allowance paused after the due read is not paid.
 *
 * Both `runDueAllowancesAction` and the nightly cron read the due rules with
 * `.eq('is_active', true)`, then CLAIM each one with an update that checked
 * only its id, family and due date. A parent's pause does not touch the due
 * date. So a pause that committed between the read and the claim was claimed
 * anyway, and the credit went out: measured on main, the manual run answered
 * `{ ok: true, ranCount: 1, paidCents: 1500 }` over a rule that was paused, and
 * advanced its schedule too.
 *
 * The claim now also requires `is_active = true`, in the same statement, so
 * the pause and the claim cannot both win: a claim that finds the rule paused
 * matches no row and is skipped, exactly like a rule another run has already
 * claimed. A pause that lands after a successful claim is a later decision
 * and is not undone here. #697 review 5919136164.
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

/** A parent's pause commits after the due read, just before the first claim. */
function pauseBeforeTheClaim() {
  const from = db.from.bind(db);
  let paused = false;
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === 'allowance_rules') {
      const update = (builder.update as (patch: Row) => unknown).bind(builder);
      builder.update = (patch: Row) => {
        if (!paused) { paused = true; rule().is_active = false; }
        return update(patch);
      };
    }
    return builder;
  };
}

const runCron = async () => (await runAllowanceCron(new Request('https://bubaly.test/api/cron/wallet-allowance') as never)).json();

describe('the manual run (runDueAllowancesAction)', () => {
  it('a rule paused after the due read is not paid, and keeps its schedule', async () => {
    pauseBeforeTheClaim();

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(ledger()).toHaveLength(0);
    expect(rule()).toMatchObject({ is_active: false, next_run_on: TODAY, last_run_on: '2026-09-21' });
  });

  it('an active rule is still claimed and paid, once', async () => {
    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 1, paidCents: 1_500 });
    expect(rule()).toMatchObject({ is_active: true, next_run_on: '2026-10-05', last_run_on: TODAY });

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(ledger().reduce((sum, row) => sum + Number(row.amount_cents), 0)).toBe(1_500);
  });
});

describe('the nightly cron', () => {
  it('a rule paused after the due read is not paid, and keeps its schedule', async () => {
    pauseBeforeTheClaim();

    expect(await runCron()).toMatchObject({ ok: true, due: 1, paid: 0, failed: 0 });
    expect(ledger()).toHaveLength(0);
    expect(rule()).toMatchObject({ is_active: false, next_run_on: TODAY, last_run_on: '2026-09-21' });
  });

  it('an active rule is still claimed and paid, once', async () => {
    expect(await runCron()).toMatchObject({ ok: true, due: 1, paid: 1, failed: 0 });
    expect(rule()).toMatchObject({ next_run_on: '2026-10-05', last_run_on: TODAY });

    expect(await runCron()).toMatchObject({ ok: true, due: 0, paid: 0 });
    expect(ledger().reduce((sum, row) => sum + Number(row.amount_cents), 0)).toBe(1_500);
  });
});
