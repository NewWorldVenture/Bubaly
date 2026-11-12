// The allowance cron, driven through its real GET and the real CRON_SECRET
// check, over a populated in-memory database: two households it must pay, and
// the rows it must leave alone (a closed family, a family whose trial ended
// unpaid, a paused rule, a rule not yet due, rules written by a removed parent).
//
// What the neighbouring tests already prove, and this file does not repeat:
//   - a-closed-family-is-left-alone-by-the-crons: closed family not paid (with cron-auth mocked)
//   - an-allowance-credit-fits-the-ledgers-uuid-column: one family, one rule, uuid-typed ledger
//   - the-allowance-cron-reads-every-families-managers: manager read chunked/paged, its failure is a 500
//   - a-paused-allowance-is-not-claimed / an-allowance-edited-mid-run-is-paid-its-new-amount: claim races
//   - an-allowance-paid-once-when-the-ledger-answer-is-lost: insert error after the credit landed
//   - an-allowance-is-paid-on-the-familys-day: the family's own day across zones
//   - allowance-cron-isolates-one-bad-rule: one bad rule does not end the run (every collaborator mocked)
//   - allowance-cron-idempotency / allowance-cron-pays-only-manager-written-rules /
//     cron-wallet-allowance-persistence: source-shape checks of the claim, author lock and rollback
// None of them use the real cron-auth check, seed two paying households side by
// side, read per-family balances back, or run the route twice over the same data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const harness = vi.hoisted(() => ({ db: null as unknown, serviceClients: 0 }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { harness.serviceClients++; return harness.db; },
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { GET } = await import('@/app/api/cron/wallet-allowance/route');
const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');
const { allowanceOccurrenceKey } = await import('@/lib/wallet/allowance');

const SECRET = 'test-cron-secret-not-real';
const TODAY = '2026-10-20';
const NEXT_WEEK = '2026-10-27';
const KINDS = ['spend', 'save', 'give', 'invest'] as const;

/** Fixed fake uuids: family N has members, wallet, buckets and rules under its own digit. */
const id = (family: string, slot: string) => `00000000-0000-4000-8000-${family}${slot.padStart(12 - family.length, '0')}`;
const fam = (digit: string) => ({
  id: id(digit, 'f'),
  parentUser: id(digit, '1'),
  parentMember: id(digit, '11'),
  removedUser: id(digit, '2'),
  removedMember: id(digit, '22'),
  childMember: id(digit, '33'),
  wallet: id(digit, '44'),
  bucket: Object.fromEntries(KINDS.map((kind, i) => [kind, id(digit, `5${i}`)])) as Record<(typeof KINDS)[number], string>,
  rule: id(digit, '61'),
  removedAuthorRule: id(digit, '62'),
  pausedRule: id(digit, '63'),
  laterRule: id(digit, '64'),
});
const A = fam('a');       // open, UTC, Basic, default split
const B = fam('b');       // open, Tokyo, Plus (Stripe trialing), its own split
const CLOSED = fam('c');  // closed account, still on a paid row
const LOCKED = fam('d');  // trial ended unpaid, no subscription

let db: InMemorySupabase;

const cron = (authorization?: string) => GET(new Request('https://app.example.com/api/cron/wallet-allowance', {
  headers: authorization === undefined ? {} : { authorization },
}) as never);
const run = async (authorization: string = `Bearer ${SECRET}`) => {
  const res = await cron(authorization);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const ledger = (familyId: string) => db.table('wallet_transactions').filter((row) => row.family_id === familyId);
const balance = (bucketId: string) => db.table('wallet_transactions')
  .filter((row) => row.bucket_id === bucketId && row.status === 'completed')
  .reduce((sum, row) => sum + (row.direction === 'credit' ? 1 : -1) * Number(row.amount_cents), 0);
const balances = (f: ReturnType<typeof fam>) => Object.fromEntries(KINDS.map((kind) => [kind, balance(f.bucket[kind])]));
const rule = (ruleId: string) => db.table('allowance_rules').find((row) => row.id === ruleId) as Row;

function seedFamily(f: ReturnType<typeof fam>, family: Row, opts: { amount: number; split: Row | null; plan?: { plan: string; status: string }; removedRole?: string }) {
  db.seed('families', [{ id: f.id, trial_ends_at: null, closed_at: null, timezone: 'UTC', ...family }]);
  if (opts.plan) db.seed('subscriptions', [{ family_id: f.id, ...opts.plan }]);
  db.seed('family_members', [
    { id: f.parentMember, family_id: f.id, user_id: f.parentUser, role: 'parent', is_active: true },
    // Removed the way every removal path writes it (REMOVED_MEMBER_PATCH), or, in
    // B, a parent removed before that patch kept their role: inactive either way.
    { id: f.removedMember, family_id: f.id, user_id: f.removedUser, role: opts.removedRole ?? 'guest', is_active: false },
    { id: f.childMember, family_id: f.id, user_id: null, role: 'child', is_active: true },
  ]);
  db.seed('child_wallets', [{ id: f.wallet, family_id: f.id, member_id: f.childMember, is_active: true }]);
  db.seed('wallet_buckets', KINDS.map((kind) => ({ id: f.bucket[kind], family_id: f.id, child_wallet_id: f.wallet, kind })));
  const base = { family_id: f.id, child_wallet_id: f.wallet, amount_cents: opts.amount, cadence: 'weekly', split: opts.split, is_active: true, next_run_on: TODAY, last_run_on: '2026-10-13', created_by: f.parentUser };
  db.seed('allowance_rules', [
    { ...base, id: f.rule },
    { ...base, id: f.removedAuthorRule, amount_cents: 999, created_by: f.removedUser },
    { ...base, id: f.pausedRule, amount_cents: 777, is_active: false },
    { ...base, id: f.laterRule, amount_cents: 555, next_run_on: NEXT_WEEK },
  ]);
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.serviceClients = 0;
  db = createInMemorySupabase({
    // The wallet tables' uuid columns, as 0088 declares them.
    uuidColumns: {
      wallet_transactions: ['id', 'family_id', 'child_wallet_id', 'bucket_id', 'related_id', 'reverses_id', 'created_by', 'approved_by'],
      allowance_rules: ['id', 'family_id', 'child_wallet_id', 'created_by'],
      wallet_buckets: ['id', 'family_id', 'child_wallet_id'],
      child_wallets: ['id', 'family_id'],
    },
  });
  harness.db = db;
  seedFamily(A, {}, { amount: 1_500, split: null, plan: { plan: 'basic', status: 'active' } });
  seedFamily(B, { timezone: 'Asia/Tokyo' }, { amount: 2_000, split: { spend: 50, save: 50, give: 0, invest: 0 }, plan: { plan: 'plus', status: 'trialing' }, removedRole: 'parent' });
  seedFamily(CLOSED, { closed_at: '2026-10-01T00:00:00.000Z' }, { amount: 3_000, split: null, plan: { plan: 'plus', status: 'active' } });
  seedFamily(LOCKED, { trial_ends_at: '2026-10-10T00:00:00.000Z' }, { amount: 4_000, split: null });
  db.log.length = 0;
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authorization, with the real CRON_SECRET check', () => {
  it('API-DCEC08074039 JOB-4065F88A93D9: no Authorization header is a 401 before any database read', async () => {
    const res = await cron();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: SOURCE_MESSAGES['walletAllowance.unauthorized'] });
    expect(harness.serviceClients).toBe(0);
    expect(db.log).toEqual([]);
    expect(db.table('wallet_transactions')).toEqual([]);
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: a wrong Bearer secret is a 401 before any database read', async () => {
    const { status } = await run('Bearer not-the-cron-secret');
    expect(status).toBe(401);
    expect(harness.serviceClients).toBe(0);
    expect(db.log).toEqual([]);
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: an unset CRON_SECRET does not admit "Bearer undefined"', async () => {
    vi.stubEnv('CRON_SECRET', undefined as unknown as string);
    const { status } = await run('Bearer undefined');
    expect(status).toBe(401);
    expect(db.log).toEqual([]);
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: the right secret runs the job', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(harness.serviceClients).toBe(1);
  });
});

describe('a populated run pays the two open households, each its own, and skips the rest', () => {
  it('API-DCEC08074039 JOB-4065F88A93D9: answers the counts of what it decided', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    // Due: A and B's payable rules, and the removed-author rules of A, B and the locked
    // family (authorship is checked before the plan), and the locked family's own rule.
    // The closed family's and the paused rules are not read; next week's rules are not due.
    expect(body).toEqual({ ok: true, due: 6, paid: 2, skippedFree: 1, skippedUnauthored: 3, failed: 0 });
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: credits A and B their own amounts, split into their own buckets', async () => {
    await run();
    expect(balances(A)).toEqual({ spend: 600, save: 600, give: 150, invest: 150 });
    expect(balances(B)).toEqual({ spend: 1_000, save: 1_000, give: 0, invest: 0 });
    for (const [f, amount] of [[A, 1_500], [B, 2_000]] as const) {
      const rows = ledger(f.id);
      expect(rows.reduce((sum, row) => sum + Number(row.amount_cents), 0)).toBe(amount);
      for (const row of rows) {
        expect(row).toMatchObject({
          family_id: f.id, child_wallet_id: f.wallet, type: 'allowance', status: 'completed', direction: 'credit',
          related_type: 'allowance_rules', related_id: f.rule, created_by: null,
          metadata: { occurrence: allowanceOccurrenceKey(f.rule, TODAY) },
        });
      }
    }
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: nothing of household A reaches household B, or the reverse', async () => {
    await run();
    const bucketsOf = (f: ReturnType<typeof fam>) => new Set(Object.values(f.bucket));
    for (const [own, other] of [[A, B], [B, A]] as const) {
      for (const row of ledger(own.id)) {
        expect(bucketsOf(own).has(row.bucket_id as string)).toBe(true);
        expect([row.child_wallet_id, row.related_id]).not.toContain(other.wallet);
        expect(row.related_id).not.toBe(other.rule);
      }
    }
    expect(new Set(db.table('wallet_transactions').map((row) => row.family_id))).toEqual(new Set([A.id, B.id]));
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: leaves the closed family, the locked family, paused, later and removed-author rules untouched', async () => {
    await run();
    expect(ledger(CLOSED.id)).toEqual([]);
    expect(ledger(LOCKED.id)).toEqual([]);
    expect(balances(CLOSED)).toEqual({ spend: 0, save: 0, give: 0, invest: 0 });
    expect(balances(LOCKED)).toEqual({ spend: 0, save: 0, give: 0, invest: 0 });
    for (const f of [A, B, CLOSED, LOCKED]) {
      for (const untouched of [f.removedAuthorRule, f.pausedRule]) {
        expect(rule(untouched)).toMatchObject({ next_run_on: TODAY, last_run_on: '2026-10-13' });
      }
      expect(rule(f.laterRule)).toMatchObject({ next_run_on: NEXT_WEEK, last_run_on: '2026-10-13' });
    }
    for (const f of [CLOSED, LOCKED]) expect(rule(f.rule)).toMatchObject({ next_run_on: TODAY, last_run_on: '2026-10-13' });
    const paidRules = new Set(db.table('wallet_transactions').map((row) => row.related_id));
    expect(paidRules).toEqual(new Set([A.rule, B.rule]));
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: advances each paid rule on its own family\'s day', async () => {
    await run();
    expect(rule(A.rule)).toMatchObject({ next_run_on: NEXT_WEEK, last_run_on: TODAY });
    expect(rule(B.rule)).toMatchObject({ next_run_on: NEXT_WEEK, last_run_on: TODAY });
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: a rule written into one family against the other family\'s wallet pays neither child', async () => {
    // The cross-family rule 0311 closes in the database: the cron's own door.
    const crossRule = id('b', '65');
    db.seed('allowance_rules', [{
      id: crossRule, family_id: B.id, child_wallet_id: A.wallet, amount_cents: 5_000, cadence: 'weekly', split: null,
      is_active: true, next_run_on: TODAY, last_run_on: '2026-10-13', created_by: B.parentUser,
    }]);
    const { status, body } = await run();
    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, paid: 2, failed: 1 });
    expect(balances(A)).toEqual({ spend: 600, save: 600, give: 150, invest: 150 });
    expect(db.table('wallet_transactions').some((row) => row.related_id === crossRule)).toBe(false);
    expect(rule(crossRule)).toMatchObject({ next_run_on: TODAY, last_run_on: '2026-10-13' });
  });
});

describe('idempotence: the same period is never credited twice', () => {
  it('API-DCEC08074039 JOB-4065F88A93D9: a second run the same day writes nothing new', async () => {
    await run();
    const after = structuredClone(db.table('wallet_transactions'));
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, due: 4, paid: 0, skippedFree: 1, skippedUnauthored: 3, failed: 0 });
    expect(db.table('wallet_transactions')).toEqual(after);
    expect(balances(A)).toEqual({ spend: 600, save: 600, give: 150, invest: 150 });
    expect(balances(B)).toEqual({ spend: 1_000, save: 1_000, give: 0, invest: 0 });
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: a run late the same UTC day, already tomorrow in Tokyo, pays nobody again', async () => {
    await run();
    vi.setSystemTime(new Date(`${TODAY}T23:30:00.000Z`));
    const { body } = await run();
    expect(body).toMatchObject({ ok: true, paid: 0 });
    expect(ledger(A.id)).toHaveLength(4);
    expect(ledger(B.id)).toHaveLength(2);
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: next week pays each family exactly one more period, its own', async () => {
    await run();
    vi.setSystemTime(new Date(`${NEXT_WEEK}T12:00:00.000Z`));
    const { status, body } = await run();
    expect(status).toBe(200);
    // Next week's 555 rules fall due too, so each family is paid two rules.
    expect(body).toMatchObject({ ok: true, paid: 4, failed: 0 });
    for (const f of [A, B]) {
      const occurrences = ledger(f.id).filter((row) => row.related_id === f.rule).map((row) => (row.metadata as Row).occurrence);
      expect(new Set(occurrences)).toEqual(new Set([allowanceOccurrenceKey(f.rule, TODAY), allowanceOccurrenceKey(f.rule, NEXT_WEEK)]));
      expect(rule(f.rule)).toMatchObject({ next_run_on: '2026-11-03', last_run_on: NEXT_WEEK });
    }
    // 555 at 40/40/10/10 is 222/222/55/55 plus one cent, which goes to save first.
    expect(balances(A)).toEqual({ spend: 1_422, save: 1_423, give: 355, invest: 355 });
    expect(balances(B)).toEqual({ spend: 2_277, save: 2_278, give: 0, invest: 0 });
    expect(ledger(CLOSED.id)).toEqual([]);
    expect(ledger(LOCKED.id)).toEqual([]);
  });
});

describe('a failure is reported as one', () => {
  it('API-DCEC08074039 JOB-4065F88A93D9: a ledger write refused for A is a 502, B is still paid, A stays due and is paid once on retry', async () => {
    harness.db = withFaults(db, (table, calls) => (
      table === 'wallet_transactions' && calls.some((call) => call.method === 'insert'
        && (call.args[0] as Row[]).some((row) => row.family_id === A.id))
        ? { code: '08006', message: 'Fixture write refused' } : null
    ));
    const first = await run();
    expect(first.status).toBe(502);
    expect(first.body).toEqual({ ok: false, due: 6, paid: 1, skippedFree: 1, skippedUnauthored: 3, failed: 1 });
    expect(ledger(A.id)).toEqual([]);
    expect(balances(B)).toEqual({ spend: 1_000, save: 1_000, give: 0, invest: 0 });
    expect(rule(A.rule)).toMatchObject({ next_run_on: TODAY, last_run_on: '2026-10-13' });
    expect(rule(B.rule)).toMatchObject({ next_run_on: NEXT_WEEK, last_run_on: TODAY });

    harness.db = db;
    const retry = await run();
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, paid: 1, failed: 0 });
    expect(balances(A)).toEqual({ spend: 600, save: 600, give: 150, invest: 150 });
    expect(balances(B)).toEqual({ spend: 1_000, save: 1_000, give: 0, invest: 0 });
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: a plan read that fails is a 500 that pays nobody, not a run of "free" families', async () => {
    harness.db = withFaults(db, (table) => (table === 'subscriptions' ? { message: 'Fixture read refused' } : null));
    const { status, body } = await run();
    expect(status).toBe(500);
    expect(body).toEqual({ error: SOURCE_MESSAGES['walletAllowance.allowanceRunFailed'] });
    expect(db.table('wallet_transactions')).toEqual([]);
    for (const f of [A, B]) expect(rule(f.rule)).toMatchObject({ next_run_on: TODAY, last_run_on: '2026-10-13' });
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: a rules read that fails is a 500, not an empty clean run', async () => {
    harness.db = withFaults(db, (table) => (table === 'allowance_rules' ? { code: '57014', message: 'Fixture statement timeout' } : null));
    const { status, body } = await run();
    expect(status).toBe(500);
    expect(body).toEqual({ error: SOURCE_MESSAGES['walletAllowance.allowanceRunFailed'] });
    expect(db.table('wallet_transactions')).toEqual([]);
  });

  it('API-DCEC08074039 JOB-4065F88A93D9: only a missing wallet table is the clean "not deployed" no-op', async () => {
    harness.db = withFaults(db, (table) => (table === 'allowance_rules' ? { code: '42P01', message: 'relation "public.allowance_rules" does not exist' } : null));
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, skipped: 'wallet_not_deployed' });
    expect(db.table('wallet_transactions')).toEqual([]);
  });
});
