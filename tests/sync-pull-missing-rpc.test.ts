import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMissingSyncPullRpc, resetSyncPullMigrationWarnings } from '@/lib/sync/persistence';
import { runGoogleSync } from '@/lib/sync/engine/google';
import { syncSdkFixture, missingRpc, ACCOUNT } from './helpers/sync-sdk-fixture';

vi.mock('@/lib/sync/accounts', async original => ({
  ...await original<typeof import('@/lib/sync/accounts')>(), getValidAccessToken: async () => 'synthetic-access-token',
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
beforeEach(() => resetSyncPullMigrationWarnings());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

// Without held 0494 the pull falls back to the previous production writes, but
// only on PostgREST's exact answer that the named RPC does not exist.
describe('0494 missing-RPC recognition', () => {
  it.each(['ensure_sync_pull_container', 'create_sync_pull_item'])('recognises the exact missing answer for %s', name => {
    expect(isMissingSyncPullRpc(missingRpc(name), name)).toBe(true);
    expect(isMissingSyncPullRpc({ code: '42883', message: `function public.${name}(uuid, uuid) does not exist` }, name)).toBe(true);
  });

  it('rejects other errors and other objects', () => {
    const name = 'create_sync_pull_item';
    expect(isMissingSyncPullRpc(missingRpc('ensure_sync_pull_container'), name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: 'PGRST202', message: 'Could not find the function' }, name)).toBe(false);
    // Only the message names the absent function; details/hint alone (a hint
    // can suggest another, existing function) never count.
    expect(isMissingSyncPullRpc({ code: 'PGRST202', message: 'Could not find the function', details: `Searched for public.${name}` }, name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: 'PGRST202', message: 'Could not find the function public.other_rpc(p_account) in the schema cache',
      hint: `Perhaps you meant to call the function public.${name}` }, name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: '42883', message: `operator does not exist: public.${name}(uuid) = text` }, name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: '42501', message: `permission denied for function ${name}` }, name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: '55P03', message: `could not obtain lock in ${name}` }, name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: '42883', message: 'function sync_pull_private.admit_account(uuid) does not exist' }, name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: '42883', message: `function sync_pull_private.${name}(uuid) does not exist` }, name)).toBe(false);
    expect(isMissingSyncPullRpc({ code: 'PGRST202', message: `Could not find the function public.${name}_v2()` }, name)).toBe(false);
    expect(isMissingSyncPullRpc(new TypeError('fetch failed'), name)).toBe(false);
    expect(isMissingSyncPullRpc(null, name)).toBe(false);
  });

  it('warns once per process for each missing RPC, naming the migration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetSyncPullMigrationWarnings();
    for (let i = 0; i < 2; i++) {
      const { db, rows } = syncSdkFixture([{ id: `remote-${i}`, summary: 'Synthetic', start: { dateTime: '2026-06-21T09:00:00Z' } }],
        { rpcFailure: 'missing' });
      expect((await runGoogleSync(db, ACCOUNT)).error).toBeUndefined();
      expect(rows.sync_calendar_events.some(row => row.external_id === `remote-${i}`)).toBe(true);
      vi.unstubAllGlobals();
    }
    const lines = warn.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines.filter(line => line.includes('ensure_sync_pull_container'))).toHaveLength(1);
    expect(lines.filter(line => line.includes('create_sync_pull_item'))).toHaveLength(1);
    expect(lines.every(line => line.includes('0494_sync_atomic_pull.sql'))).toBe(true);
  });

  it('does not ask a known-absent RPC again until the retry window passes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    const rpcCalls = (calls: { url: URL }[]) => calls.filter(call => call.url.pathname.startsWith('/rest/v1/rpc/')).length;
    const events = (i: number) => [`a-${i}`, `b-${i}`].map(id => ({ id, summary: 'Synthetic', start: { dateTime: '2026-06-21T09:00:00Z' } }));
    const first = syncSdkFixture(events(1), { rpcFailure: 'missing' });
    expect((await runGoogleSync(first.db, ACCOUNT)).error).toBeUndefined();
    // One failed answer per RPC; the second new item goes straight to the direct writes.
    expect(rpcCalls(first.calls)).toBe(2);
    expect(first.rows.sync_calendar_events.filter(row => String(row.external_id).endsWith('-1'))).toHaveLength(2);
    vi.unstubAllGlobals();
    const cached = syncSdkFixture(events(2), { rpcFailure: 'missing' });
    expect((await runGoogleSync(cached.db, ACCOUNT)).error).toBeUndefined();
    expect(rpcCalls(cached.calls)).toBe(0);
    expect(cached.rows.sync_calendar_events.filter(row => String(row.external_id).endsWith('-2'))).toHaveLength(2);
    vi.unstubAllGlobals();
    // After the window the RPC is asked again, so an applied 0494 takes over.
    vi.setSystemTime(Date.now() + 61_000);
    const applied = syncSdkFixture(events(3));
    applied.rows.sync_external_mappings.length = 0;
    applied.rows.sync_calendar_events.length = 0;
    expect((await runGoogleSync(applied.db, ACCOUNT)).error).toBeUndefined();
    expect(applied.calls.some(call => call.url.pathname === '/rest/v1/rpc/ensure_sync_pull_container')).toBe(true);
    expect(applied.calls.some(call => call.url.pathname === '/rest/v1/rpc/create_sync_pull_item')).toBe(true);
    expect(applied.calls.some(call => call.method === 'POST' && call.url.pathname === '/rest/v1/sync_calendar_events')).toBe(false);
  });

  it('a non-missing RPC failure is not remembered and keeps failing visibly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 2; i++) {
      const { db, rows, calls } = syncSdkFixture([{ id: `denied-${i}`, summary: 'Synthetic', start: { dateTime: '2026-06-21T09:00:00Z' } }],
        { rpcFailure: 'container-denied' });
      expect((await runGoogleSync(db, ACCOUNT)).error).toContain('container admission');
      expect(calls.some(call => call.url.pathname === '/rest/v1/rpc/ensure_sync_pull_container')).toBe(true);
      expect(rows.sync_calendar_events.some(row => row.external_id === `denied-${i}`)).toBe(false);
      vi.unstubAllGlobals();
    }
  });
});
