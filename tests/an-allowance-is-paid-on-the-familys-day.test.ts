// An allowance is paid on the family's due day, not Greenwich's.
//
// /api/cron/wallet-allowance runs at 07:00 UTC and decided "due today" on the
// UTC day, while `next_run_on` is written on the family's day (wallet/actions.ts)
// and "Run due now" pays on it. At 07:00 UTC a Pacific family in winter is at
// 23:00 the evening before and Honolulu at 21:00, so a rule due on their Tuesday
// was paid on their Monday night and stamped `last_run_on` Tuesday. Each rule is
// now decided, claimed and stamped on its own family's day, from a read that
// takes every rule due anywhere on Earth. Driven through the real route and the
// real ledger write against the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));

const { GET } = await import('@/app/api/cron/wallet-allowance/route');

const FAMILY = '10000000-0000-4000-8000-000000000001';
const PARENT_USER = '20000000-0000-4000-8000-000000000001';
const WALLET = '30000000-0000-4000-8000-000000000001';
const RULE = '70000000-0000-4000-8000-000000000001';
const KINDS = ['spend', 'save', 'give', 'invest'] as const;

let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/wallet-allowance') as never;
const credited = () => db.table('wallet_transactions').reduce((sum, row) => sum + Number(row.amount_cents), 0);
const rule = () => db.table('allowance_rules').find((r) => r.id === RULE)!;

function household(timezone: string, nextRunOn: string) {
  db = createInMemorySupabase();
  h.db = db;
  db.seed('families', [{ id: FAMILY, name: 'Synthetic', timezone, closed_at: null }]);
  db.seed('subscriptions', [{ id: 'sub-1', family_id: FAMILY, plan: 'plus', status: 'active' }]);
  db.seed('family_members', [{ id: 'parent-1', family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true, display_name: 'Parent' }]);
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'child-1' }]);
  db.seed('wallet_buckets', KINDS.map((kind, i) => ({ id: `40000000-0000-4000-8000-00000000000${i + 1}`, family_id: FAMILY, child_wallet_id: WALLET, kind })));
  db.seed('allowance_rules', [{
    id: RULE, family_id: FAMILY, child_wallet_id: WALLET, amount_cents: 1_500, cadence: 'weekly', split: null,
    is_active: true, next_run_on: nextRunOn, last_run_on: null, created_by: PARENT_USER,
  }]);
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('west of UTC-7, the 07:00 UTC run lands on the evening before the due day', () => {
  it.each([
    // [zone, the due day, the run that lands the evening before, the run on the due day]
    ['America/Los_Angeles', '2026-12-15', '2026-12-15T07:00:00.000Z', '2026-12-16T07:00:00.000Z'],
    ['Pacific/Honolulu', '2026-10-20', '2026-10-20T07:00:00.000Z', '2026-10-21T07:00:00.000Z'],
  ])('in %s, a rule due %s is not paid the evening before, and is paid on its day', async (tz, dueOn, eve, onTheDay) => {
    household(tz, dueOn);
    at(eve);
    const early = await GET(req());
    expect(await early.json()).toMatchObject({ ok: true, due: 0, paid: 0 });
    expect(credited(), 'paid on the evening before its due day').toBe(0);
    expect(rule()).toMatchObject({ next_run_on: dueOn, last_run_on: null });

    at(onTheDay);
    const due = await GET(req());
    expect(await due.json()).toMatchObject({ ok: true, due: 1, paid: 1 });
    expect(credited()).toBe(1_500);
    // Stamped on the family's day, and rolled forward from it.
    expect(rule().last_run_on).toBe(dueOn);
    expect(rule().next_run_on).toBe(new Date(Date.parse(`${dueOn}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10));
    expect(db.table('wallet_transactions').every((row) => (row.metadata as { occurrence?: string }).occurrence === `${RULE}:${dueOn}`)).toBe(true);
  });
});

describe('east of UTC, the family\'s day has already begun', () => {
  it('a rule due today in Kiritimati (UTC+14) is paid by a run still on the UTC day before', async () => {
    household('Pacific/Kiritimati', '2026-10-20');
    at('2026-10-19T12:00:00.000Z'); // 02:00 on the 20th there
    expect(await (await GET(req())).json()).toMatchObject({ ok: true, due: 1, paid: 1 });
    expect(rule().last_run_on).toBe('2026-10-20');
  });

  it('Tokyo, and a family with no zone on record, are paid at 07:00 UTC on the due day as before (control)', async () => {
    for (const tz of ['Asia/Tokyo', '']) {
      household(tz, '2026-10-20');
      at('2026-10-20T07:00:00.000Z');
      expect(await (await GET(req())).json(), tz || 'no zone').toMatchObject({ ok: true, due: 1, paid: 1 });
      expect(rule().last_run_on).toBe('2026-10-20');
    }
  });
});
