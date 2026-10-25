// The Google page's "Sync now" takes the account's lease too.
//
// lib/sync/account-lease.ts makes one sync of a provider account at a time:
// the scheduled run (/api/cron/provider-sync) and the generic "Sync now"
// (/api/sync/run) claim `sync_accounts.sync_status = 'syncing'` around the
// engine and count an account another sync holds as busy. The Google account
// page renders its own control (components/sync/google-controls.tsx), which
// posts /api/sync/google/sync, and that route ran the Google engine with no
// claim at all. A press while the scheduled run held the account started a
// second sync of it, which is the duplicate-create race the lease closes
// (both sync the same new local event and both create it at Google). Its
// success path also stamped the account `synced` while the scheduled sync was
// still running, which released that sync's lease and let the next tick start
// a third.
//
// Behavioural: the real Google route, the real scheduled run, the real lease,
// engines and policy, against the in-memory database. Only the provider's
// network calls are replaced, and the Google press's token read can be held
// mid-sync.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  calls: [] as string[],
  hold: false,
  release: [] as (() => void)[],
  fail: false,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-a' }, active: { familyId: 'fam' } }) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
// The Google engine's token read: the first sync to reach the provider.
vi.mock('@/lib/sync/accounts', async (orig) => ({
  ...(await orig<typeof import('@/lib/sync/accounts')>()),
  getValidAccessToken: async () => {
    h.calls.push('google-engine');
    if (h.fail) throw new Error('invalid_grant');
    if (h.hold) await new Promise<void>((resolve) => { h.release.push(resolve); });
    return 'tok';
  },
}));
// The generic engine's (the scheduled run's) token read.
vi.mock('@/lib/sync/access-token', () => ({
  getProviderAccessToken: async () => { h.calls.push('generic-engine'); return 'tok'; },
}));
vi.mock('@/lib/sync/providers/google', async (orig) => ({
  ...(await orig<typeof import('@/lib/sync/providers/google')>()),
  listCalendars: async () => [],
  listTasks: async () => [],
}));
vi.mock('@/lib/sync/registry', async (orig) => {
  const real = await orig<typeof import('@/lib/sync/registry')>();
  return { ...real, getAdapter: (p: string) => { const a = real.getAdapter(p as never); return a ? { ...a, isConfigured: () => true } : a; } };
});

const { POST: googleSyncNow } = await import('@/app/api/sync/google/sync/route');
const { GET: scheduled } = await import('@/app/api/cron/provider-sync/route');

let db: InMemorySupabase;
const NOW = new Date('2026-10-20T08:15:00.000Z');
const press = () => googleSyncNow();
const tick = () => scheduled(new Request('https://bubaly.test/api/cron/provider-sync') as never);
const account = () => db.table('sync_accounts').find((a) => a.id === 'acct')!;
const releaseAll = () => { for (const r of h.release.splice(0)) r(); };

function seedAccount(over: Record<string, unknown> = {}) {
  db.seed('sync_accounts', [{
    id: 'acct', user_id: 'user-a', family_id: 'fam', provider: 'google', external_id: 'a@x', display_name: 'Me',
    sync_direction: 'two_way', metadata: {}, last_synced_at: '2026-10-19T08:00:00.000Z',
    sync_status: 'synced', updated_at: '2026-10-19T08:00:00.000Z', ...over,
  }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.calls = []; h.hold = false; h.release = []; h.fail = false;
  db = createInMemorySupabase({
    rpc: { ensure_sync_pull_container: (args) => ({ id: `container-${String(args.p_kind)}`, sync_token: null }) },
  });
  h.db = db;
  db.seed('families', [{ id: 'fam', closed_at: null }]);
  db.seed('family_members', [{ id: 'm-a', family_id: 'fam', user_id: 'user-a', role: 'parent', is_active: true }]);
  db.seed('sync_connections', [{ account_id: 'acct', family_id: 'fam', health: 'healthy', sync_status: 'synced' }]);
});
afterEach(() => { releaseAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Google "Sync now" while another sync holds the account', () => {
  it('is told the sync is already running (409), runs no job, and leaves the holder\'s lease in place', async () => {
    const claimedAt = new Date(NOW.getTime() - 60_000).toISOString();
    seedAccount({ sync_status: 'syncing', updated_at: claimedAt });

    const res = await press();
    expect(res.status, 'the press ran a second sync of the held account').toBe(409);
    expect(await res.json()).toMatchObject({ busy: true, error: 'sync.syncAlreadyRunning', imported: 0, exported: 0 });
    expect(db.table('sync_jobs'), 'the press started a sync job beside the held one').toEqual([]);
    expect(h.calls, 'the press reached the provider').toEqual([]);
    expect(account().sync_status, 'the press released the holder\'s lease').toBe('syncing');
    expect(account().updated_at).toBe(claimedAt);
  });
});

describe('the Google "Sync now" holds the account while it runs', () => {
  it('so the scheduled run reaching it then is busy, a second press is busy, and the account is released when it finishes', async () => {
    seedAccount();
    h.hold = true;
    const pressing = press();
    await vi.waitFor(() => expect(h.calls).toEqual(['google-engine']));
    expect(account().sync_status, 'the press syncs the account without holding it').toBe('syncing');

    const run = await tick();
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ synced: 0, busy: 1, failed: 0 });
    const again = await press();
    expect(again.status).toBe(409);
    expect(h.calls, 'a second sync of the account ran beside the press').toEqual(['google-engine']);
    expect(db.table('sync_jobs')).toHaveLength(1);

    releaseAll();
    const res = await pressing;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 0, exported: 0 });
    expect(db.table('sync_jobs')).toMatchObject([{ status: 'succeeded' }]);
    expect(account().sync_status).toBe('synced');

    // Released: the next scheduled run syncs it as usual.
    expect(await (await tick()).json()).toMatchObject({ synced: 1, busy: 0 });
    expect(h.calls).toEqual(['google-engine', 'generic-engine']);
  });

  it('a press that ran and failed is the account\'s error state, not a lease left held', async () => {
    seedAccount();
    h.fail = true;
    const res = await press();
    expect(res.status).toBe(502);
    expect(db.table('sync_jobs')).toMatchObject([{ status: 'failed' }]);
    expect(account().sync_status, 'the failed press left the account held, or unmarked').toBe('error');
    h.fail = false;
    expect((await press()).status).toBe(200);
  });
});

describe('a Google press the account\'s policy refuses (control)', () => {
  it('gives the account back as it found it: the lease does not stamp a switched-off sync as an error', async () => {
    seedAccount({ sync_direction: 'disabled' });
    const res = await press();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'syncPolicy.notEnabled' });
    expect(db.table('sync_jobs')).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(account().sync_status).toBe('synced');
  });
});
