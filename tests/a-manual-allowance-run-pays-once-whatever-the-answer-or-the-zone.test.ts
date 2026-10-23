// "Run due now" pays an allowance once, whatever the ledger answered and
// whatever the family's zone.
//
// The nightly cron (app/api/cron/wallet-allowance) was taught, in N10, that a
// credit whose insert answered an error may have landed anyway (the server
// committed, the connection dropped): it asks the ledger under the payment's
// occurrence key before rolling its claim back, and a credit the ledger
// already holds (23505 once the owner's index lands) is paid, not failed. The
// sibling path, the parent's "Run due now" (runDueAllowancesAction), was not:
// it rolled the schedule back on EVERY failed credit. A lost answer made the
// rule due again with the money already in the wallet, and the next click (or
// the cron) paid the child a second time; with the index, the repeat was
// refused, rolled back again and answered as an error, every click.
//
// And the key named the RUN's day, not the payment's: the cron's day is UTC,
// the manual run's is the family's, so one payment had two identities west or
// east of UTC and no index over the key could refuse the second credit. The
// key is now the day being paid (the claimed `next_run_on`), the same on both
// paths and on every retry.
//
// Behavioural: the real action and the real cron route against the in-memory
// database with the ledger's uuid columns declared, under the same
// lost-first-answer proxy as tests/an-allowance-paid-once-when-the-ledger-
// answer-is-lost.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemoryOptions, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const FAMILY = '10000000-0000-4000-8000-000000000001';
const PARENT_USER = '20000000-0000-4000-8000-000000000001';
const PARENT_MEMBER = '20000000-0000-4000-8000-000000000011';
const WALLET = '30000000-0000-4000-8000-000000000001';
const KINDS = ['spend', 'save', 'give', 'invest'] as const;
const BUCKET: Record<(typeof KINDS)[number], string> = {
  spend: '40000000-0000-4000-8000-000000000001',
  save: '40000000-0000-4000-8000-000000000002',
  give: '40000000-0000-4000-8000-000000000003',
  invest: '40000000-0000-4000-8000-000000000004',
};
const RULE = '70000000-0000-4000-8000-000000000001';
const DUE = '2026-10-20';
const NEXT = '2026-10-27';
const OCCURRENCE = `${RULE}:${DUE}`;

const h = vi.hoisted(() => ({ db: null as unknown, tz: 'UTC' }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: '20000000-0000-4000-8000-000000000001' },
    memberships: [],
    active: {
      familyId: '10000000-0000-4000-8000-000000000001', role: 'parent',
      member: { id: '20000000-0000-4000-8000-000000000011', family_id: '10000000-0000-4000-8000-000000000001' },
      family: { id: '10000000-0000-4000-8000-000000000001', timezone: h.tz },
    },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
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

/** The ledger's uuid columns (0088), and the owner's index over the occurrence when asked for. */
const LEDGER_UUIDS: InMemoryOptions['uuidColumns'] = {
  wallet_transactions: ['id', 'family_id', 'child_wallet_id', 'bucket_id', 'related_id', 'reverses_id', 'created_by', 'approved_by'],
  allowance_rules: ['id', 'family_id', 'child_wallet_id', 'created_by'],
};
const OWNERS_INDEX: InMemoryOptions['uniques'] = {
  // (family_id, related_id, (metadata->>'occurrence'), bucket_id) where
  // related_type = 'allowance_rules'; related_type stands in for the WHERE.
  wallet_transactions: [['family_id', 'related_type', 'related_id', 'metadata->>occurrence', 'bucket_id']],
};

let db: InMemorySupabase;
const ledger = () => db.table('wallet_transactions');
const credited = () => ledger().reduce((sum, row) => sum + Number(row.amount_cents), 0);
const rule = () => db.table('allowance_rules').find((r) => r.id === RULE) as Row;
const keys = () => [...new Set(ledger().map((row) => (row.metadata as { occurrence?: string }).occurrence))];
const cron = () => runAllowanceCron(new Request('https://bubaly.test/api/cron/wallet-allowance') as never);

function household(opts: { index?: boolean; tz?: string; nextRunOn?: string } = {}): InMemorySupabase {
  const next = createInMemorySupabase({ uuidColumns: LEDGER_UUIDS, ...(opts.index ? { uniques: OWNERS_INDEX } : {}) });
  next.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null, timezone: opts.tz ?? 'UTC' }]);
  next.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  next.seed('family_members', [{ id: PARENT_MEMBER, family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true }]);
  next.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'child-1' }]);
  next.seed('wallet_buckets', KINDS.map((kind) => ({ id: BUCKET[kind], family_id: FAMILY, child_wallet_id: WALLET, kind })));
  next.seed('allowance_rules', [{
    id: RULE, family_id: FAMILY, child_wallet_id: WALLET, amount_cents: 1_500, cadence: 'weekly', split: null,
    is_active: true, next_run_on: opts.nextRunOn ?? DUE, last_run_on: '2026-10-13', created_by: PARENT_USER,
  }]);
  return next;
}

/**
 * The same database, with the first ledger INSERT committed and then answered
 * with a transport error; with `rereadFails`, the ledger read that follows
 * fails too (the connection is still down).
 */
function losingTheFirstLedgerAnswer(base: InMemorySupabase, opts: { rereadFails?: boolean } = {}): InMemorySupabase {
  let lost = false;
  let rereadRefused = false;
  const failure = (message: string) => ({ data: null, error: { code: 'XX000', message, details: null, hint: null }, count: null, status: 0, statusText: '' });
  return new Proxy(base, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (table: string) => {
        const builder = target.from(table) as unknown as Record<string | symbol, unknown> & PromiseLike<unknown>;
        let inserting = false;
        const proxy: object = new Proxy(builder, {
          get(object, k) {
            if (k === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => object.then((reply) => {
                if (table === 'wallet_transactions' && inserting && !lost) { lost = true; return resolve(failure('TypeError: fetch failed')); }
                if (table === 'wallet_transactions' && !inserting && lost && opts.rereadFails && !rereadRefused) {
                  rereadRefused = true;
                  return resolve(failure('TypeError: fetch failed'));
                }
                return resolve(reply);
              }, reject);
            }
            const value = Reflect.get(object, k);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (k === 'insert') inserting = true;
              const result = Reflect.apply(value, object, args);
              return result === object ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  }) as InMemorySupabase;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${DUE}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.tz = 'UTC';
  db = household();
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('"Run due now" whose credit committed but answered an error', () => {
  it('is counted paid and keeps its claim, so the next click pays nothing (no index: production today)', async () => {
    h.db = losingTheFirstLedgerAnswer(db);
    const first = await runDueAllowancesAction();
    expect(first, 'the parent was told the credit failed for an allowance the child has').toEqual({ ok: true, ranCount: 1, paidCents: 1_500 });
    expect(credited()).toBe(1_500);
    expect(rule().next_run_on, 'the claim was rolled back on a credit that landed').toBe(NEXT);

    h.db = db;
    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(await (await cron()).json()).toMatchObject({ due: 0, paid: 0 });
    expect(credited(), 'the child was paid twice').toBe(1_500);
  });

  it('leaves the claim in place when the ledger cannot be read either: unknown is never paid twice', async () => {
    h.db = losingTheFirstLedgerAnswer(db, { rereadFails: true });
    const first = await runDueAllowancesAction();
    expect(first).toMatchObject({ ok: false, ranCount: 0, paidCents: 0 });
    expect((first as { error: string }).error).not.toContain('fetch failed');
    expect(rule().next_run_on, 'an unknown outcome was rolled back and made due again').toBe(NEXT);

    h.db = db;
    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(credited()).toBe(1_500);
  });

  it('a payment the ledger already holds (the owner\'s index) is paid, and the rule is not left due', async () => {
    db = household({ index: true });
    h.db = db;
    // Another run already paid this occurrence into every bucket a split can reach.
    db.seed('wallet_transactions', KINDS.map((kind) => ({
      family_id: FAMILY, child_wallet_id: WALLET, bucket_id: BUCKET[kind], type: 'allowance', status: 'completed', direction: 'credit',
      amount_cents: kind === 'spend' ? 1_500 : 0, related_type: 'allowance_rules', related_id: RULE,
      metadata: { split: { spend: 100, save: 0, give: 0, invest: 0 }, occurrence: OCCURRENCE },
    })));
    const res = await runDueAllowancesAction();
    expect(res, 'a refused repeat was answered as an error and rolled back').toMatchObject({ ok: true, ranCount: 1 });
    expect(rule().next_run_on).toBe(NEXT);
    expect(credited()).toBe(1_500);
  });

  it('a credit refused before any write is still rolled back and retried (control)', async () => {
    db.replace('wallet_buckets', []);
    expect(await runDueAllowancesAction()).toMatchObject({ ok: false, ranCount: 0, paidCents: 0 });
    expect(rule().next_run_on).toBe(DUE);
    expect(ledger()).toEqual([]);
  });
});

// A family's day that is not the UTC day: the manual run counts in the
// family's zone, the cron in UTC.
const ZONES = [
  // 20:00 on the 20th in Los Angeles is 03:00Z on the 21st; the cron's 07:00Z run that day is still the 20th there.
  { tz: 'America/Los_Angeles', manualAt: '2026-10-21T03:00:00.000Z', cronAt: '2026-10-21T07:00:00.000Z', due: DUE },
  // 01:00 on the 21st in Tokyo is 16:00Z on the 20th; the cron ran at 07:00Z on the 20th.
  { tz: 'Asia/Tokyo', manualAt: '2026-10-20T16:00:00.000Z', cronAt: '2026-10-20T07:00:00.000Z', due: DUE },
];

describe.each(ZONES)('one payment, one key: a family in $tz', ({ tz, manualAt, cronAt, due }) => {
  beforeEach(() => { h.tz = tz; });

  it('the manual run and the cron key the same payment by the day it is due', async () => {
    db = household({ tz, nextRunOn: due });
    h.db = db;
    vi.setSystemTime(new Date(manualAt));
    expect(await runDueAllowancesAction()).toMatchObject({ ok: true, ranCount: 1 });
    const manualKeys = keys();

    db = household({ tz, nextRunOn: due });
    h.db = db;
    vi.setSystemTime(new Date(cronAt));
    expect(await (await cron()).json()).toMatchObject({ ok: true, paid: 1 });
    const cronKeys = keys();

    expect(manualKeys).toEqual([`${RULE}:${due}`]);
    expect(cronKeys, 'the two paths named one payment twice').toEqual(manualKeys);
  });

  it('with the owner\'s index, a payment one path made is refused on the other after a rollback', async () => {
    db = household({ tz, index: true, nextRunOn: due });
    h.db = db;
    const [firstAt, secondAt] = tz === 'Asia/Tokyo' ? [cronAt, manualAt] : [manualAt, cronAt];
    const run = async (at: string) => {
      vi.setSystemTime(new Date(at));
      return at === manualAt ? runDueAllowancesAction() : (await cron()).json();
    };

    expect(await run(firstAt)).toMatchObject({ ok: true });
    expect(credited()).toBe(1_500);
    // The schedule put back over a payment that landed: what a run deployed
    // before the lost-answer handling did, and what the index is there for.
    Object.assign(rule(), { next_run_on: due, last_run_on: '2026-10-13' });

    expect(await run(secondAt)).toMatchObject({ ok: true });
    expect(credited(), 'the second path wrote a new key and paid the child again').toBe(1_500);
    expect(rule().next_run_on).toBe(NEXT);
  });

  it('a lost answer on one path is not paid again by the other', async () => {
    db = household({ tz, index: true, nextRunOn: due });
    const [firstAt, secondAt] = tz === 'Asia/Tokyo' ? [cronAt, manualAt] : [manualAt, cronAt];
    const run = async (at: string) => {
      vi.setSystemTime(new Date(at));
      return at === manualAt ? runDueAllowancesAction() : (await cron()).json();
    };

    h.db = losingTheFirstLedgerAnswer(db);
    await run(firstAt);
    h.db = db;
    await run(secondAt);
    expect(credited(), 'the child was paid twice').toBe(1_500);
    expect(rule().next_run_on).toBe(NEXT);
  });
});
