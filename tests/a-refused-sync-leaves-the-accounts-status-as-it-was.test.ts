// A sync the account's policy refuses leaves the account's status as it was.
//
// The account lease (lib/sync/account-lease.ts) marks `sync_accounts.
// sync_status = 'syncing'` before the engine runs and released it as `error`
// whenever the result carried an error. The engine evaluates the account's
// policy only after that claim, so a sync refused before it started — the
// parent switched it off, an onboarding import is still to be finished, the
// owner left the family — stamped `error` too, and the sync dashboards
// (app/(app)/dashboard/sync/accounts) print that stamp verbatim: "Connected
// error" about a sync nobody wanted to run. Before the lease, a refusal wrote
// nothing to the account. Now the claim remembers the stamp it replaced and a
// refused sync gives it back; a sync that RAN and failed is still the
// account's error state.
//
// Behavioural: the real "Sync now" route and the real scheduled run, the real
// lease and the real engine and policy, against the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, providerCalls: 0 }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-a' }, active: { familyId: 'fam' } }) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/sync/registry', () => ({
  getAdapter: () => ({
    provider: 'microsoft', label: 'Outlook', isConfigured: () => true,
    // Reached only by a sync that runs: a refusal never calls the provider.
    refreshAccessToken: async () => { h.providerCalls += 1; throw new Error('invalid_grant'); },
    listCalendars: async () => { h.providerCalls += 1; return []; },
  }),
}));

const { POST: syncNow } = await import('@/app/api/sync/run/route');
const { GET: scheduled } = await import('@/app/api/cron/provider-sync/route');
const { ACCOUNT_SYNC_STALE_MS } = await import('@/lib/sync/account-lease');

let db: InMemorySupabase;
const NOW = new Date('2026-10-20T08:15:00.000Z');
const press = () => syncNow(new Request('https://bubaly.test/api/sync/run', { method: 'POST', body: JSON.stringify({ provider: 'microsoft' }) }));
const tick = () => scheduled(new Request('https://bubaly.test/api/cron/provider-sync') as never);
const account = () => db.table('sync_accounts').find((a) => a.id === 'acct')!;

function seedAccount(over: Record<string, unknown>) {
  db.seed('sync_accounts', [{
    id: 'acct', user_id: 'user-a', family_id: 'fam', provider: 'microsoft', external_id: 'a@x', display_name: 'Work',
    sync_direction: 'two_way', metadata: {}, last_synced_at: '2026-10-19T08:00:00.000Z',
    sync_status: 'synced', updated_at: '2026-10-19T08:00:00.000Z', ...over,
  }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.providerCalls = 0;
  db = createInMemorySupabase();
  h.db = db;
  db.seed('families', [{ id: 'fam', closed_at: null }]);
  db.seed('family_members', [{ id: 'm-a', family_id: 'fam', user_id: 'user-a', role: 'parent', is_active: true }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a sync the account\'s policy refuses before it starts', () => {
  it('"Sync now" on a sync the parent switched off: refused, and the account still reads as it did', async () => {
    seedAccount({ sync_direction: 'disabled' });
    const res = await press();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'syncPolicy.notEnabled' });
    expect(db.table('sync_jobs'), 'the refusal ran the engine').toEqual([]);
    expect(h.providerCalls).toBe(0);
    expect(account().sync_status, 'a switched-off sync was stamped as the account\'s error').toBe('synced');
  });

  it('the scheduled run on an account whose import is still to be finished: the same', async () => {
    seedAccount({ sync_direction: 'import', sync_status: 'pending', metadata: { onboardingCalendar: { version: 1, state: 'preview' } } });
    const res = await tick();
    expect(await res.json()).toMatchObject({ synced: 0, failed: 1 });
    expect(db.table('sync_jobs')).toEqual([]);
    expect(account().sync_status, 'an unfinished import was stamped as the account\'s error').toBe('pending');
    // And the account is not left claimed: the next press is not "already running".
    expect((await press()).status).not.toBe(409);
  });

  it('a refusal after a stale takeover has no state of its own to give back: it is released, not left `syncing`', async () => {
    seedAccount({
      sync_direction: 'disabled', sync_status: 'syncing',
      updated_at: new Date(NOW.getTime() - ACCOUNT_SYNC_STALE_MS - 60_000).toISOString(),
    });
    await press();
    expect(account().sync_status).toBe('error');
  });
});

describe('a sync that ran and failed (control)', () => {
  it('is still the account\'s error state', async () => {
    seedAccount({});
    const res = await press();
    expect(res.status).toBe(502);
    expect(db.table('sync_jobs'), 'the engine did not run').toHaveLength(1);
    expect(account().sync_status).toBe('error');
  });
});
