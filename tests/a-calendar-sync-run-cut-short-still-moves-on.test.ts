import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A calendar sync run that is cut short, or handed fewer rows than it asked
 * for, still moves on (review of #1036, comment 6133937237).
 *
 * The provider-sync cron walks enabled accounts in id order from a cursor in
 * app_settings (tests/a-failing-calendar-account-does-not-starve-the-rest.test.ts).
 * Two cases that suite does not reach:
 *
 *  - Interrupted batch. The cursor was saved once, as the LAST account of the
 *    batch, before the first sync. With exactly 25 accounts, a run that dies
 *    on the first one (a provider call that hangs past maxDuration) leaves the
 *    cursor on the 25th, so the next run wraps to the same first account and
 *    the other 24 are never tried. The cursor now moves to each account just
 *    before it is tried, and a run stops taking new accounts once its time
 *    budget is spent, so the next run starts after the last one tried.
 *  - A capped response. Any page shorter than the batch was read as the end of
 *    the list and wrapped. PostgREST's db-max-rows returns fewer rows without
 *    saying so: with 30 accounts and a cap of 10, runs read 1-10, then 11-20
 *    plus 1-10, saving 10 again, and 21-30 were never tried. A short page now
 *    counts as the end only when nothing follows its last row.
 *
 * In-memory tables and a mocked engine; ids synthetic; nothing leaves the process.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  ran: [] as string[],
  hangOn: null as string | null,
  clock: 0,
  step: 0,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
// Microsoft has no keys on this deployment: its accounts are skipped every run.
vi.mock('@/lib/sync/registry', () => ({
  getAdapter: (provider: string) => ({ provider, isConfigured: () => provider !== 'microsoft' }),
}));
vi.mock('@/lib/sync/engine/generic', () => ({
  runProviderSync: async (_admin: unknown, account: { id: string }) => {
    state.ran.push(account.id);
    // A provider call that never comes back: the platform ends the run here.
    if (account.id === state.hangOn) return new Promise(() => {});
    state.clock += state.step;
    return { imported: 1, exported: 0, skipped: 0, conflicts: 0 };
  },
}));

const { GET } = await import('@/app/api/cron/provider-sync/route');

const pad = (n: number) => String(n).padStart(2, '0');
const ids = (count: number) => Array.from({ length: count }, (_, i) => `acct-${pad(i + 1)}`);
const run = () => GET(new NextRequest('https://www.bubaly.com/api/cron/provider-sync'));

function seed(accountIds: string[], options: { maxRows?: number; provider?: (id: string) => string } = {}): InMemorySupabase {
  const db = createInMemorySupabase({ maxRows: options.maxRows });
  db.seed('families', [{ id: 'fam', closed_at: null }]);
  db.seed('sync_accounts', accountIds.map((id) => ({
    id, user_id: `user-${id}`, family_id: 'fam', provider: options.provider?.(id) ?? 'google', external_id: `${id}@x`, sync_direction: 'two_way', last_synced_at: null,
  })));
  db.seed('family_members', accountIds.map((id) => ({
    id: `member-${id}`, family_id: 'fam', user_id: `user-${id}`, role: 'parent', is_active: true,
  })));
  state.db = db;
  return db;
}

const cursorOf = (db: InMemorySupabase) =>
  (db.table('app_settings').find((r) => r.key === 'provider_sync_cursor:v1')?.value as { id?: string } | undefined)?.id;

beforeEach(() => {
  state.ran = [];
  state.hangOn = null;
  state.clock = 0;
  state.step = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockImplementation(() => state.clock);
});

describe('a run that dies on its first account', () => {
  it('leaves the cursor on that account, and the next run goes on from the one after it', async () => {
    const db = seed(ids(25));
    state.hangOn = 'acct-01';
    void run();
    await vi.waitFor(() => expect(state.ran).toEqual(['acct-01']));
    // What the platform leaves behind when it ends the hung run.
    expect(cursorOf(db)).toBe('acct-01');

    state.hangOn = null;
    state.ran = [];
    const res = await run();
    expect(res.status).toBe(200);
    expect(state.ran[0]).toBe('acct-02');
    expect(state.ran).toContain('acct-25');
  });
});

describe('a run that has spent its time budget', () => {
  it('stops taking new accounts, and the next run starts at the first one it left', async () => {
    const db = seed(ids(25));
    // Each sync takes longer than the whole of maxDuration.
    state.step = 1_000_000;
    const first = await run();
    expect(first.status).toBe(200);
    // At least one account is tried, so every run makes progress.
    expect(state.ran).toEqual(['acct-01']);
    expect(cursorOf(db)).toBe('acct-01');

    state.step = 0;
    state.ran = [];
    await run();
    expect(state.ran[0]).toBe('acct-02');
  });

  it('still tries one account when reading the batch alone took the budget', async () => {
    const db = seed(ids(25));
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'sync_accounts') state.clock = 1_000_000;
      return from(table);
    }) as typeof db.from);
    await run();
    expect(state.ran).toEqual(['acct-01']);
  });
});

describe('a batch the run could only skip', () => {
  it('is passed, so the next run reaches the accounts behind it', async () => {
    // The first 25 accounts have no provider keys on this deployment.
    const db = seed(ids(30), { provider: (id) => (id <= 'acct-25' ? 'microsoft' : 'google') });
    const first = await (await run()).json();
    expect(first.skipped).toBe(25);
    expect(state.ran).toEqual([]);
    expect(cursorOf(db)).toBe('acct-25');
    await run();
    expect(state.ran).toEqual(['acct-26', 'acct-27', 'acct-28', 'acct-29', 'acct-30']);
  });
});

describe('a response the server capped below the batch', () => {
  it('is not taken for the end of the list: every account is reached', async () => {
    seed(ids(30), { maxRows: 10 });
    const perRun: string[][] = [];
    for (let i = 0; i < 3; i++) {
      state.ran = [];
      await run();
      perRun.push([...state.ran]);
    }
    for (const id of ids(30)) expect(perRun.flat(), id).toContain(id);
    for (const attempted of perRun) expect(new Set(attempted).size).toBe(attempted.length);
  });

  it('still wraps when the list really has ended', async () => {
    const db = seed(ids(30), { maxRows: 10 });
    db.seed('app_settings', [{ key: 'provider_sync_cursor:v1', value: { id: 'acct-25' } }]);
    await run();
    expect(state.ran).toEqual(['acct-26', 'acct-27', 'acct-28', 'acct-29', 'acct-30', ...ids(10)]);
  });

  it('refuses to guess when it cannot tell whether more accounts follow', async () => {
    const db = seed(ids(30), { maxRows: 10 });
    db.seed('app_settings', [{ key: 'provider_sync_cursor:v1', value: { id: 'acct-05' } }]);
    const from = db.from.bind(db);
    let reads = 0;
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = from(table) as unknown as Record<string, unknown>;
      if (table === 'sync_accounts' && ++reads === 2) {
        const refused = { data: null, error: { code: '57014', message: 'timeout', details: null, hint: null } };
        builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(refused).then(resolve);
      }
      return builder;
    }) as unknown as typeof db.from);
    const res = await run();
    expect(res.status).toBe(500);
    expect(state.ran).toEqual([]);
  });
});
