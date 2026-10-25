// One sync of a provider account at a time.
//
// Nothing claimed an account before syncing it. The scheduled run
// (/api/cron/provider-sync) and a member's "Sync now" (/api/sync/run) — and two
// scheduled runs sharing a batch, since both schedulers fire the route in the
// same minute — each read the account's mappings, found no mapping for a new
// local event, and created it at the provider: two copies in the family's real
// calendar, pulled back as two local events. lib/sync/account-lease.ts now
// takes `sync_status = 'syncing'` as a compare-and-set lease around the engine,
// fenced on the stamp for a stale takeover, and both callers count a held
// account apart from a failure.
//
// Behavioural, against the in-memory database with the engine replaced by a
// recorder that can be held mid-sync: the engine runs ONCE for an account two
// ticks reach together, a press while the cron holds the account is 409, a
// stale lease is taken over, and a fresh one is not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  db: null as unknown,
  runs: [] as string[],
  hold: false,
  release: [] as (() => void)[],
  fail: false,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => ({ provider: 'google', label: 'Google', isConfigured: () => true }) }));
vi.mock('@/lib/sync/engine/generic', () => ({
  runProviderSync: async (_db: unknown, account: { id: string }) => {
    state.runs.push(account.id);
    if (state.hold) await new Promise<void>((resolve) => { state.release.push(resolve); });
    if (state.fail) return { imported: 0, exported: 0, skipped: 0, conflicts: 0, error: 'invalid_grant' };
    return { imported: 1, exported: 0, skipped: 0, conflicts: 0 };
  },
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-a' }, active: { familyId: 'fam' } }) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/sync/audit', () => ({ logSyncAudit: async () => {} }));

const { GET: cron } = await import('@/app/api/cron/provider-sync/route');
const { POST: syncNow } = await import('@/app/api/sync/run/route');
const { ACCOUNT_SYNC_STALE_MS } = await import('@/lib/sync/account-lease');

let db: InMemorySupabase;
const NOW = new Date('2026-10-20T08:15:00.000Z');
const tick = () => cron(new Request('https://bubaly.test/api/cron/provider-sync') as never);
const press = () => syncNow(new Request('https://bubaly.test/api/sync/run', { method: 'POST', body: JSON.stringify({ provider: 'google' }) }));
const account = () => db.table('sync_accounts').find((a) => a.id === 'acct')!;
const releaseAll = () => { for (const r of state.release.splice(0)) r(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.runs = []; state.hold = false; state.release = []; state.fail = false;
  db = createInMemorySupabase();
  state.db = db;
  db.seed('families', [{ id: 'fam', closed_at: null }]);
  db.seed('family_members', [{ id: 'm-a', family_id: 'fam', user_id: 'user-a', is_active: true }]);
  db.seed('sync_accounts', [{
    id: 'acct', user_id: 'user-a', family_id: 'fam', provider: 'google', external_id: 'a@x', sync_direction: 'two_way',
    last_synced_at: null, sync_status: 'synced', updated_at: '2026-10-19T08:00:00.000Z',
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('two scheduled runs that reach one account together', () => {
  it('sync it once: the second finds the account held and counts it busy, not failed', async () => {
    state.hold = true;
    const first = tick();
    await vi.waitFor(() => expect(state.runs).toHaveLength(1));
    const second = await tick();
    expect(state.runs, 'both runs synced the account, and both exported its new events').toEqual(['acct']);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, synced: 0, busy: 1, failed: 0, details: [{ account: 'acct', busy: true }] });

    releaseAll();
    const firstBody = await (await first).json();
    expect(firstBody).toMatchObject({ ok: true, synced: 1, busy: 0, failed: 0 });
    // The holder's finalization released the account.
    expect(account().sync_status).toBe('synced');
  });
});

describe('"Sync now" while the scheduled run holds the account', () => {
  it('is told the sync is already running (409) and does not run the engine a second time', async () => {
    state.hold = true;
    const scheduled = tick();
    await vi.waitFor(() => expect(state.runs).toHaveLength(1));

    const res = await press();
    expect(res.status, 'the press ran a second sync of the held account').toBe(409);
    expect(await res.json()).toMatchObject({ busy: true, error: 'sync.syncAlreadyRunning' });
    expect(state.runs).toEqual(['acct']);

    releaseAll();
    await scheduled;
    // Once released, a press syncs as usual.
    state.hold = false;
    const again = await press();
    expect(again.status).toBe(200);
    expect(state.runs).toEqual(['acct', 'acct']);
  });
});

describe('the lease', () => {
  it('is taken over when its holder died: an account `syncing` since before the stale threshold is synced', async () => {
    account().sync_status = 'syncing';
    account().updated_at = new Date(NOW.getTime() - ACCOUNT_SYNC_STALE_MS - 60_000).toISOString();
    const res = await tick();
    expect(await res.json()).toMatchObject({ synced: 1, busy: 0 });
    expect(state.runs).toEqual(['acct']);
  });

  it('is respected while fresh: an account `syncing` since a minute ago is busy', async () => {
    account().sync_status = 'syncing';
    account().updated_at = new Date(NOW.getTime() - 60_000).toISOString();
    const res = await tick();
    expect(await res.json()).toMatchObject({ synced: 0, busy: 1, failed: 0 });
    expect(state.runs).toEqual([]);
    expect(res.status).toBe(200);
  });

  it('is released as the account\'s error state when the sync failed, so the account is not busy until the stale takeover', async () => {
    state.fail = true;
    const res = await tick();
    expect(await res.json()).toMatchObject({ synced: 0, failed: 1 });
    expect(account().sync_status).toBe('error');
    state.fail = false;
    expect(await (await tick()).json()).toMatchObject({ synced: 1, busy: 0 });
  });
});
