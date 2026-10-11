import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A calendar account that keeps failing does not starve everyone else's sync.
 *
 * The scheduled provider sync took the 25 accounts with the OLDEST
 * `last_synced_at` (never-synced first) — and only a SUCCESSFUL sync advances
 * that column. An account that is refused or fails every time (a revoked
 * Google grant, a provider whose keys are not configured on this deployment,
 * a connection the policy refuses) therefore keeps its place at the head of
 * the queue forever. Once 25 such accounts exist anywhere in the product, the
 * daily run is spent on them every day and no healthy family's calendar is
 * synced in the background again.
 *
 * The cron now walks every enabled account in a stable order from a cursor it
 * keeps in app_settings, the way push dispatch already does, wrapping at the
 * end: every account gets its turn whatever the last one's outcome was.
 */

const state = vi.hoisted(() => ({ db: null as unknown, ran: [] as string[] }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
// Microsoft has no keys on this deployment: its accounts are skipped every run.
vi.mock('@/lib/sync/registry', () => ({
  getAdapter: (provider: string) => ({ provider, isConfigured: () => provider !== 'microsoft' }),
}));
// What the engine does to the one column the old order read: only a success
// stamps last_synced_at. A revoked grant fails every time and stamps nothing.
vi.mock('@/lib/sync/engine/generic', () => ({
  runProviderSync: async (admin: InMemorySupabase, account: { id: string }) => {
    state.ran.push(account.id);
    if (account.id.startsWith('revoked')) return { imported: 0, exported: 0, skipped: 0, conflicts: 0, error: 'invalid_grant' };
    const row = admin.table('sync_accounts').find((a) => a.id === account.id)!;
    row.last_synced_at = new Date().toISOString();
    return { imported: 1, exported: 0, skipped: 0, conflicts: 0 };
  },
}));

const { GET } = await import('@/app/api/cron/provider-sync/route');

let db: InMemorySupabase;
const pad = (n: number) => String(n).padStart(2, '0');
const unconfigured = Array.from({ length: 15 }, (_, i) => `microsoft-${pad(i)}`);
const revoked = Array.from({ length: 10 }, (_, i) => `revoked-${pad(i)}`);
const healthy = Array.from({ length: 5 }, (_, i) => `healthy-${pad(i)}`);
const run = async () => (await GET(new NextRequest('https://www.bubaly.com/api/cron/provider-sync'))).json();

beforeEach(() => {
  state.ran = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  state.db = db;
  db.seed('families', [{ id: 'fam', closed_at: null }]);
  const account = (id: string, provider: string, lastSynced: string | null) => ({
    id, user_id: `user-${id}`, family_id: 'fam', provider, external_id: `${id}@x`, sync_direction: 'two_way', last_synced_at: lastSynced,
  });
  db.seed('sync_accounts', [
    ...unconfigured.map((id) => account(id, 'microsoft', null)),
    ...revoked.map((id) => account(id, 'google', null)),
    // Synced fine yesterday, so they sort after every never-synced account.
    ...healthy.map((id) => account(id, 'google', '2026-10-10T08:15:00.000Z')),
  ]);
  db.seed('family_members', [...unconfigured, ...revoked, ...healthy].map((id) => ({
    id: `member-${id}`, family_id: 'fam', user_id: `user-${id}`, role: 'parent', is_active: true,
  })));
});

describe('the scheduled provider sync with 25 accounts that never succeed', () => {
  it('still reaches every healthy account within two runs', async () => {
    await run();
    await run();
    for (const id of healthy) expect(state.ran, id).toContain(id);
  });

  it('reaches every account it can sync within two runs', async () => {
    await run();
    await run();
    for (const id of [...revoked, ...healthy]) expect(state.ran, id).toContain(id);
  });

  it('continues where the last run stopped instead of starting over', async () => {
    const first = await run();
    const reached = new Set(state.ran);
    state.ran = [];
    await run();
    expect(first.scanned).toBe(25);
    // The next run's first attempt is an account the previous run never reached.
    expect(reached.has(state.ran[0])).toBe(false);
  });
});

describe('going round', () => {
  it('wraps to the start once the list is done, rather than stopping', async () => {
    await run(); await run();
    state.ran = [];
    expect((await run()).scanned).toBe(25);
    expect(state.ran.length).toBeGreaterThan(0);
  });

  it('takes each account at most once in a run, even when the list is shorter than a batch', async () => {
    db.replace('sync_accounts', db.table('sync_accounts').filter((a) => ['revoked-00', 'revoked-01', 'revoked-02'].includes(String(a.id))));
    db.seed('app_settings', [{ key: 'provider_sync_cursor:v1', value: { id: 'revoked-01' } }]);
    await run();
    expect(state.ran).toEqual(['revoked-02', 'revoked-00', 'revoked-01']);
  });
});

describe('the cursor', () => {
  it('refuses to run a partial batch when the wrap-round read fails', async () => {
    db.replace('sync_accounts', db.table('sync_accounts').filter((a) => ['revoked-00', 'revoked-01', 'revoked-02'].includes(String(a.id))));
    db.seed('app_settings', [{ key: 'provider_sync_cursor:v1', value: { id: 'revoked-01' } }]);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = from(table) as unknown as Record<string, unknown>;
      if (table === 'sync_accounts') {
        const refused = { data: null, error: { code: '57014', message: 'timeout', details: null, hint: null } };
        builder.lte = () => ({ then: (resolve: (value: unknown) => unknown) => Promise.resolve(refused).then(resolve) });
      }
      return builder;
    }) as unknown as typeof db.from);
    const res = await GET(new NextRequest('https://www.bubaly.com/api/cron/provider-sync'));
    expect(res.status).toBe(500);
    expect(state.ran).toEqual([]);
  });

  it('refuses to run when it cannot record where this run got to', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== 'app_settings') return from(table);
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ data: null, error: { code: '42501', message: 'refused', details: null, hint: null } }),
      };
      return chain;
    }) as typeof db.from);
    const res = await GET(new NextRequest('https://www.bubaly.com/api/cron/provider-sync'));
    expect(res.status).toBe(500);
    expect(state.ran).toEqual([]);
  });

  it('refuses to run, rather than loop on the same batch, when it cannot be read', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== 'app_settings') return from(table);
      const refused = { data: null, error: { code: '08006', message: 'offline', details: null, hint: null } };
      const chain: Record<string, unknown> = { select: () => chain, eq: () => chain, maybeSingle: async () => refused };
      return chain;
    }) as typeof db.from);
    const res = await GET(new NextRequest('https://www.bubaly.com/api/cron/provider-sync'));
    expect(res.status).toBe(500);
    expect(state.ran).toEqual([]);
  });
});
