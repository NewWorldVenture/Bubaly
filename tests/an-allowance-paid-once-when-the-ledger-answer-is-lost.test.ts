// An allowance is paid once when the ledger's answer is lost.
//
// /api/cron/wallet-allowance claims the rule (a correct compare-and-set), then
// credits the wallet, and on ANY credit error restored the schedule so the next
// run would retry. The one error that rule is wrong for is the insert whose
// answer was lost — the server committed, the connection dropped — which looks
// exactly like a refused write: the schedule was rolled back, the next run (or
// the mirrored 07:00 run still in flight) claimed the rule again and credited a
// second time, and no ledger key could refuse it, because every allowance
// credit carried `related_id = rule.id` and the only unique index on the ledger
// is chore-scoped.
//
// Each payment is now keyed per occurrence (`<rule>:<day>`,
// lib/wallet/allowance.ts), and on an insert error the run asks the ledger for
// that key before deciding: landed is paid, absent is rolled back, unreadable
// leaves the claim in place.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));

const { GET } = await import('@/app/api/cron/wallet-allowance/route');

const FAMILY = 'fam-1';
const TODAY = '2026-10-20';
const RULE = '70000000-0000-4000-8000-000000000001';
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/wallet-allowance') as never;
const ledger = () => db.table('wallet_transactions');
const credited = () => ledger().reduce((sum, row) => sum + Number(row.amount_cents), 0);
const rule = () => db.table('allowance_rules').find((r) => r.id === RULE)!;

/**
 * The same database, with the first ledger INSERT committed and then answered
 * with a transport error — the dropped connection after the server committed.
 */
function losingTheFirstLedgerAnswer(base: InMemorySupabase): InMemorySupabase {
  let lost = false;
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
                if (table === 'wallet_transactions' && inserting && !lost) {
                  lost = true;
                  return resolve({ data: null, error: { code: 'XX000', message: 'TypeError: fetch failed', details: null, hint: null }, count: null, status: 0, statusText: '' });
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
  vi.setSystemTime(new Date(`${TODAY}T07:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase();
  h.db = db;
  db.seed('families', [{ id: FAMILY, name: 'Synthetic', timezone: 'UTC', closed_at: null }]);
  db.seed('subscriptions', [{ id: 'sub-1', family_id: FAMILY, plan: 'plus', status: 'active' }]);
  db.seed('family_members', [{ id: 'parent-1', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true, display_name: 'Parent' }]);
  db.seed('child_wallets', [{ id: 'wallet-1', family_id: FAMILY, member_id: 'child-1' }]);
  db.seed('wallet_buckets', (['spend', 'save', 'give', 'invest'] as const).map((kind) => ({ id: `bucket-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-1', kind })));
  db.seed('allowance_rules', [{
    id: RULE, family_id: FAMILY, child_wallet_id: 'wallet-1', amount_cents: 1_500, cadence: 'weekly', split: null,
    is_active: true, next_run_on: TODAY, last_run_on: '2026-10-13', created_by: 'user-1',
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a credit whose insert committed but answered an error', () => {
  it('is counted paid, keeps its claim, and is not paid again next run', async () => {
    h.db = losingTheFirstLedgerAnswer(db);
    const first = await GET(req());
    expect(await first.json()).toMatchObject({ ok: true, due: 1, paid: 1, failed: 0 });
    expect(first.status).toBe(200);
    expect(credited(), 'the first run credited the wallet').toBe(1_500);
    expect(rule().next_run_on, 'the schedule was rolled back on a credit that landed').toBe('2026-10-27');

    h.db = db;
    const second = await GET(req());
    expect(await second.json()).toMatchObject({ due: 0, paid: 0 });
    expect(credited(), 'the child was paid twice').toBe(1_500);
  });

  it('keys every ledger row by the occurrence, so a key can refuse the repeat', async () => {
    await GET(req());
    expect(ledger().length).toBeGreaterThan(0);
    for (const row of ledger()) expect(row).toMatchObject({ related_type: 'allowance_rules', related_id: `${RULE}:${TODAY}` });
  });
});

describe('a credit the ledger already holds (the owner\'s unique key, once it lands)', () => {
  it('is paid, not failed, and the schedule stays advanced', async () => {
    db = createInMemorySupabase({ uniques: { wallet_transactions: [['family_id', 'related_type', 'related_id', 'bucket_id']] } });
    h.db = db;
    db.seed('families', [{ id: FAMILY, name: 'Synthetic', timezone: 'UTC', closed_at: null }]);
    db.seed('subscriptions', [{ id: 'sub-1', family_id: FAMILY, plan: 'plus', status: 'active' }]);
    db.seed('family_members', [{ id: 'parent-1', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true, display_name: 'Parent' }]);
    db.seed('child_wallets', [{ id: 'wallet-1', family_id: FAMILY, member_id: 'child-1' }]);
    db.seed('wallet_buckets', (['spend', 'save', 'give', 'invest'] as const).map((kind) => ({ id: `bucket-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-1', kind })));
    db.seed('allowance_rules', [{
      id: RULE, family_id: FAMILY, child_wallet_id: 'wallet-1', amount_cents: 1_500, cadence: 'weekly', split: null,
      is_active: true, next_run_on: TODAY, last_run_on: '2026-10-13', created_by: 'user-1',
    }]);
    // The mirrored run already paid this occurrence into every bucket a split can reach.
    db.seed('wallet_transactions', (['spend', 'save', 'give', 'invest'] as const).map((kind) => ({
      family_id: FAMILY, child_wallet_id: 'wallet-1', bucket_id: `bucket-${kind}`, type: 'allowance', status: 'completed', direction: 'credit',
      amount_cents: kind === 'spend' ? 1_500 : 0, related_type: 'allowance_rules', related_id: `${RULE}:${TODAY}`,
    })));
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, paid: 1, failed: 0 });
    expect(rule().next_run_on).toBe('2026-10-27');
    expect(credited()).toBe(1_500);
  });
});

describe('a credit the wallet refused before any write (control)', () => {
  it('is rolled back and retried, as before', async () => {
    db.replace('wallet_buckets', []); // not provisioned: refused before the insert
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, paid: 0, failed: 1 });
    expect(rule().next_run_on).toBe(TODAY);
    expect(ledger()).toEqual([]);
  });
});
