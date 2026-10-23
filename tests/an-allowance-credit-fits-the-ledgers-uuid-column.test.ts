// An allowance credit fits the ledger's uuid column: the child is paid.
//
// The N10 fix (27e4b2648) keyed every allowance payment per occurrence,
// `<rule id>:<YYYY-MM-DD>`, and wrote that key into
// `wallet_transactions.related_id`. That column is `uuid`
// (supabase/migrations/0088_family_wallet.sql:86; nothing later retypes it), so
// Postgres refused every allowance credit with 22P02 — the nightly cron's and
// the parent's "Run due now" alike. Worse than before: the cron had already
// CLAIMED the rule (next_run_on moved on), its insertFailed re-read used the
// same key as a filter and failed the same way, so the run left the schedule
// advanced and the occurrence was never paid; the route answered 502 every
// night. The manual run failed on every rule and rolled its schedule back.
//
// The in-memory database stored the text and every test passed. Here the
// ledger's uuid columns are declared (`uuidColumns`), so the fake refuses
// what the server refuses; on 27e4b2648 the first case answers
// `{ ok: false, paid: 0, failed: 1 }` with the schedule advanced and the ledger
// empty — the lost allowance — and the manual run answers
// `{ ok: false, error: ... }`.
//
// Now `related_id` carries the rule's uuid, as every other ledger reference
// does, and the occurrence rides in `metadata.occurrence` (jsonb), read back
// with `.eq('metadata->>occurrence', key)`: the expression the owner's partial
// unique index is built over.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

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
const TODAY = '2026-10-20';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: '20000000-0000-4000-8000-000000000001' },
    memberships: [],
    active: {
      familyId: '10000000-0000-4000-8000-000000000001', role: 'parent',
      member: { id: '20000000-0000-4000-8000-000000000011', family_id: '10000000-0000-4000-8000-000000000001' },
      family: { id: '10000000-0000-4000-8000-000000000001', timezone: 'UTC' },
    },
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
const { allowanceOccurrenceKey } = await import('@/lib/wallet/allowance');

let db: InMemorySupabase;
const cronRequest = () => new Request('https://bubaly.test/api/cron/wallet-allowance') as never;
const rule = () => db.table('allowance_rules').find((row) => row.id === RULE) as Row;
const ledger = () => db.table('wallet_transactions');
const credited = () => ledger().reduce((sum, row) => sum + Number(row.amount_cents), 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null, timezone: 'UTC' }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('family_members', [{ id: PARENT_MEMBER, family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true }]);
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'child-1' }]);
  db.seed('wallet_buckets', KINDS.map((kind) => ({ id: BUCKET[kind], family_id: FAMILY, child_wallet_id: WALLET, kind })));
  db.seed('allowance_rules', [{
    id: RULE, family_id: FAMILY, child_wallet_id: WALLET, amount_cents: 1_500, cadence: 'weekly', split: null,
    is_active: true, next_run_on: TODAY, last_run_on: '2026-10-13', created_by: PARENT_USER,
  }]);
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Every row of the payment: the rule's uuid where the ledger expects one, the day in metadata. */
function expectKeyedByOccurrence(rows: Row[]) {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toMatchObject({
      family_id: FAMILY, child_wallet_id: WALLET, type: 'allowance', status: 'completed', direction: 'credit',
      related_type: 'allowance_rules', related_id: RULE,
      metadata: { occurrence: allowanceOccurrenceKey(RULE, TODAY) },
    });
    expect((row.metadata as Row).split, 'the split still rides in metadata').toBeTruthy();
  }
}

describe('the nightly cron (RV1-N10-uuid)', () => {
  it('credits the child: the ledger accepts the row, the run is ok, the schedule is advanced', async () => {
    const res = await runAllowanceCron(cronRequest());
    expect(await res.json()).toEqual({ ok: true, due: 1, paid: 1, skippedFree: 0, skippedUnauthored: 0, failed: 0 });
    expect(res.status).toBe(200);
    expect(credited()).toBe(1_500);
    expectKeyedByOccurrence(ledger());
    expect(rule()).toMatchObject({ next_run_on: '2026-10-27', last_run_on: TODAY });
  });

  it('does not leave a claimed schedule behind an unpaid occurrence (the shape of the defect)', async () => {
    await runAllowanceCron(cronRequest());
    // Either the schedule moved on AND the ledger holds the payment, or
    // neither: a rule that is no longer due must have been paid.
    const advanced = rule().next_run_on !== TODAY;
    expect(advanced).toBe(credited() === 1_500);
    expect(advanced).toBe(true);
  });
});

describe('the parent\'s "Run due now" (RV1-N10-uuid)', () => {
  it('credits the child the same way, under the same identity the cron writes', async () => {
    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 1, paidCents: 1_500 });
    expect(credited()).toBe(1_500);
    expectKeyedByOccurrence(ledger());
    for (const row of ledger()) expect(row).toMatchObject({ created_by: PARENT_USER });
    expect(rule()).toMatchObject({ next_run_on: '2026-10-27', last_run_on: TODAY });
  });

  it('after the cron has paid the day, finds nothing due and pays nothing more', async () => {
    await runAllowanceCron(cronRequest());
    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(credited()).toBe(1_500);
  });
});

describe('the occurrence is findable under the ledger\'s typing', () => {
  it('a read by the rule\'s uuid and the occurrence text answers the payment, not 22P02', async () => {
    await runAllowanceCron(cronRequest());
    const { data, error } = await db.from('wallet_transactions').select('id')
      .eq('family_id', FAMILY).eq('related_type', 'allowance_rules')
      .eq('related_id', RULE).eq('metadata->>occurrence', allowanceOccurrenceKey(RULE, TODAY)).limit(1);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
