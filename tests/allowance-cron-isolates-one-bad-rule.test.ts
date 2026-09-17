// One unpayable allowance rule must not stop the platform's allowance run.
//
// The credit failure path used to `throw`, which the route's outer catch turned
// into a 500. Because the rollback restores `next_run_on`, the same rule was due
// again the next night and threw at the same point — and since the rules are
// read `.order('id')`, every rule ordered after it was never reached. A SINGLE
// bad row stopped allowances for every family after it, permanently, with
// nothing in the response naming the cause.
//
// Reaching that state is ordinary, not exotic: `creditChildWallet` resolves
// buckets by (family_id, child_wallet_id) and reports "not fully provisioned"
// for any wallet missing a bucket — and for a rule whose `child_wallet_id`
// belongs to another family, which RLS permits because the foreign key names
// `child_wallets(id)` alone while the insert policy only checks the row's own
// `family_id`.
//
// This asserts the behaviour, not the source text: the SECOND rule is paid.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rules: [] as Row[],
  updates: [] as { patch: Row; filters: Row }[],
  credited: [] as { familyId: string; childWalletId: string; amountCents: number }[],
  // Which wallet ids the ledger refuses, the way an unprovisioned or
  // foreign-family wallet is refused.
  unpayable: new Set<string>(),
  // Which rule ids fail to CLAIM the schedule, the way a transient or
  // recurring write error on that one row does.
  claimFails: new Set<string>(),
  // Active managers, for the author gate this branch added ahead of the credit.
  // Empty is the right default HERE: these fixtures carry no `created_by`, and
  // a rule with no author is deliberately still payable (the seed and
  // service-role path). The gate is exercised in
  // tests/allowance-cron-pays-only-manager-written-rules.test.ts.
  managers: [] as Row[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/wallet/tiers', () => ({
  walletTierForPlanLevel: () => 'paid',
  walletFeatureEnabled: () => true,
}));
vi.mock('@/lib/supabase/read-all', () => ({
  readAll: async () => ({ rows: state.rules, error: null }),
}));
vi.mock('@/lib/supabase/chunked-in', () => ({
  readInChunks: async () => ({ data: [], error: null }),
}));
vi.mock('@/lib/wallet/server', () => ({
  creditChildWallet: async (_db: unknown, p: { familyId: string; childWalletId: string; amountCents: number }) => {
    if (state.unpayable.has(p.childWalletId)) {
      return { ok: false, error: 'The wallet is not fully provisioned.', credited: 0 };
    }
    state.credited.push({ familyId: p.familyId, childWalletId: p.childWalletId, amountCents: p.amountCents });
    return { ok: true, credited: p.amountCents };
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      // The author gate reads family_members with .in(), which the write
      // builder below does not implement — an unmocked method threw into the
      // route's outer catch and turned every case here into a 500. It is a
      // READ, so it must not be recorded in state.updates either, or it would
      // count as one of the schedule writes these tests assert over.
      if (table === 'family_members') {
        const read: Record<string, unknown> = {
          select() { return read; },
          in() { return read; },
          eq() { return read; },
          then(res: (v: unknown) => unknown) {
            return Promise.resolve({ data: state.managers, error: null }).then(res);
          },
        };
        return read;
      }
      const filters: Row = {};
      let patch: Row = {};
      const builder: Record<string, unknown> = {
        update(p: Row) { patch = p; return builder; },
        eq(c: string, v: unknown) { filters[c] = v; return builder; },
        lte(c: string, v: unknown) { filters[`lte:${c}`] = v; return builder; },
        select() { return builder; },
        // The claim: records the write and reports one matched row.
        maybeSingle() {
          state.updates.push({ patch, filters: { ...filters } });
          if (state.claimFails.has(String(filters.id))) {
            return Promise.resolve({ data: null, error: { message: 'claim write failed' } });
          }
          return Promise.resolve({ data: { id: filters.id }, error: null });
        },
        // The rollback is awaited directly.
        then(res: (v: unknown) => unknown) {
          state.updates.push({ patch, filters: { ...filters } });
          return Promise.resolve({ data: null, error: null }).then(res);
        },
      };
      return builder;
    },
  }),
}));

async function run() {
  const { GET } = await import('@/app/api/cron/wallet-allowance/route');
  return GET(new Request('https://x/api/cron/wallet-allowance') as never);
}

beforeEach(() => {
  state.rules = [];
  state.updates = [];
  state.credited = [];
  state.unpayable = new Set();
  state.claimFails = new Set();
  vi.resetModules();
});
afterEach(() => { vi.clearAllMocks(); });

describe('one unpayable allowance rule does not end the run', () => {
  const yesterday = '2000-01-01';

  beforeEach(() => {
    // Ordered by id, exactly as the route reads them: the bad one comes FIRST.
    state.rules = [
      { id: 'rule-a', family_id: 'fam-a', child_wallet_id: 'wallet-foreign',
        amount_cents: 500, cadence: 'weekly', split: null, next_run_on: yesterday, last_run_on: null },
      { id: 'rule-b', family_id: 'fam-b', child_wallet_id: 'wallet-ok',
        amount_cents: 700, cadence: 'weekly', split: null, next_run_on: yesterday, last_run_on: null },
    ];
    state.unpayable.add('wallet-foreign');
  });

  it('pays the rule ordered AFTER the one that failed', async () => {
    const res = await run();
    const body = await res.json();

    // The assertion that fails against the throwing version: rule-b is paid.
    expect(state.credited.map((c) => c.childWalletId)).toEqual(['wallet-ok']);
    expect(body.paid).toBe(1);
    expect(body.failed).toBe(1);
  });

  it('reports the run as degraded rather than succeeding or 500ing', async () => {
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.due).toBe(2);
  });

  it('leaves the failed rule retryable by restoring its schedule', async () => {
    await run();
    const restored = state.updates.filter(
      (u) => u.filters.id === 'rule-a' && u.patch.next_run_on === yesterday,
    );
    expect(restored).toHaveLength(1);
  });

  it('pays the next rule when an earlier rule fails to CLAIM its schedule', async () => {
    // The other half of the same defect. Nothing is written when the claim
    // fails, so the rule stays due and retries on its own — but it must not
    // take the rest of the platform's run down with it.
    state.unpayable = new Set();
    state.claimFails.add('rule-a');

    const res = await run();
    const body = await res.json();

    expect(state.credited.map((c) => c.childWalletId)).toEqual(['wallet-ok']);
    expect(body.paid).toBe(1);
    expect(body.failed).toBe(1);
    expect(res.status).toBe(502);
  });

  it('still returns 200 when every rule pays', async () => {
    state.unpayable = new Set();
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.failed).toBe(0);
    expect(body.paid).toBe(2);
  });
});
