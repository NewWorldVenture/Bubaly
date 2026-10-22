// M19 — the allowance cron reads every due family's managers, however many
// families are due.
//
// The cron checks that each rule's author is an active manager of its family,
// and read those managers in ONE `.in('family_id', families)` over every family
// with a due rule, with no chunking and no paging. Two ways that broke:
//
//   - PostgREST filters travel in the URL, ~40 bytes per id
//     (lib/supabase/chunked-in.ts): past roughly 200 families the request line
//     outgrew the gateway, the read failed, and the run answered 500 before
//     paying anyone — every night, for every family.
//   - Below that, the response stops at db-max-rows (1,000). Families whose
//     managers did not come back had every rule skipped as "unauthored", and
//     the run still reported ok: true at 200.
//
// The route is driven for real against an in-memory database capped at 1,000
// rows, with a gateway that refuses an `.in()` carrying more than 200 ids.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const TODAY = '2026-09-28';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));

const { GET: runAllowanceCron } = await import('@/app/api/cron/wallet-allowance/route');
const KINDS = ['spend', 'save', 'give', 'invest'] as const;
/** ~40 bytes per id against a common 8 KB request-line limit. */
const URL_ID_LIMIT = 200;

let db: InMemorySupabase;

/** `count` families, each with a due weekly rule written by its parent, and `managers` active managers. */
function families(count: number, managers: number) {
  const ids = Array.from({ length: count }, (_, i) => `family-${String(i).padStart(4, '0')}`);
  db.seed('families', ids.map((id) => ({ id, trial_ends_at: null, closed_at: null })));
  db.seed('subscriptions', ids.map((id) => ({ family_id: id, plan: 'basic', status: 'active' })));
  db.seed('family_members', ids.flatMap((id) => Array.from({ length: managers }, (_, m) => ({
    id: `${id}-m${m}`, family_id: id, user_id: `${id}-user-${m}`, role: m % 2 ? 'adult' : 'parent', is_active: true,
  }))));
  db.seed('child_wallets', ids.map((id) => ({ id: `${id}-wallet`, family_id: id, member_id: `${id}-kid`, is_active: true })));
  db.seed('wallet_buckets', ids.flatMap((id) => KINDS.map((kind) => ({ id: `${id}-${kind}`, family_id: id, child_wallet_id: `${id}-wallet`, kind }))));
  // Written by the LAST manager, so a manager read that came back short misses them.
  db.seed('allowance_rules', ids.map((id) => ({
    id: `${id}-rule`, family_id: id, child_wallet_id: `${id}-wallet`, amount_cents: 1000, cadence: 'weekly', split: null,
    is_active: true, next_run_on: TODAY, last_run_on: '2026-09-21', created_by: `${id}-user-${managers - 1}`,
  })));
  return ids;
}

const run = async () => {
  const res = await runAllowanceCron(new Request('https://app.example.test/api/cron/wallet-allowance') as never);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const paidFamilies = () => new Set(db.table('wallet_transactions').filter((r) => r.type === 'allowance').map((r) => r.family_id)).size;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  // The gateway: an `.in()` past the request-line limit is refused.
  harness.db = withFaults(db, (_table, calls) => (
    calls.some((call) => call.method === 'in' && Array.isArray(call.args[1]) && (call.args[1] as unknown[]).length > URL_ID_LIMIT)
      ? { code: '414', message: 'URI Too Long' } : null
  ));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the allowance cron reads every due family\'s managers', () => {
  it('250 families due on the same night are all paid, not a 500 that pays nobody', async () => {
    families(250, 2);
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, due: 250, paid: 250, skippedUnauthored: 0, failed: 0 });
    expect(paidFamilies()).toBe(250);
  });

  it('past 1,000 manager rows, no family\'s rules are skipped as unauthored', async () => {
    families(150, 8); // 1,200 manager rows, inside the URL limit
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, due: 150, paid: 150, skippedUnauthored: 0 });
    expect(paidFamilies()).toBe(150);
  });

  it('a rule whose author is not an active manager is still not paid (the second lock holds)', async () => {
    const [first] = families(3, 2);
    db.table('allowance_rules').find((r) => r.family_id === first)!.created_by = 'someone-else';
    const { body } = await run();
    expect(body).toMatchObject({ paid: 2, skippedUnauthored: 1 });
  });

  it('a manager read that fails fails the run, and pays nobody on a guess', async () => {
    families(3, 2);
    harness.db = withFaults(db, (table) => (table === 'family_members' ? { message: 'Fixture read refused' } : null));
    const { status } = await run();
    expect(status).toBe(500);
    expect(paidFamilies()).toBe(0);
  });
});
