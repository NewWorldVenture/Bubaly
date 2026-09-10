import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '@supabase/supabase-js';
import { createDeviceSignOut, sessionStorageKey } from '@/mobile/src/lib/sign-out';
import { createChunkedStore, SessionStorageUnavailableError, type KeyValueStore } from '@/mobile/src/lib/chunked-storage';
import { createSessionRefreshFetch } from '@/shared/auth/refresh-fetch';

const origin = 'https://device-session.supabase.co';
const key = sessionStorageKey(origin);
const transient = { name: 'AuthRetryableFetchError', status: 503 };
const noConcurrentWrites = { writeRevision: () => 0, blockWrites: () => () => {} };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function storeFixture() {
  const values = new Map<string, string>();
  const backing: KeyValueStore = {
    getItem: vi.fn(async name => values.get(name) ?? null),
    setItem: vi.fn(async (name, value) => { values.set(name, value); }),
    removeItem: vi.fn(async name => { values.delete(name); }),
  };
  return { values, backing, store: createChunkedStore(backing) };
}
const session = (expired: boolean) => ({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600), user: { id: 'saved-user' } });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('explicit device sign-out', () => {
  async function actualAuth(status = 204) {
    const f = storeFixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => status === 204 ? new Response(null, { status }) : Response.json({ message: 'Temporary failure' }, { status }));
    const auth = new AuthClient({ url: `${origin}/auth/v1`, storage: f.store, storageKey: key, autoRefreshToken: false,
      persistSession: true, detectSessionInUrl: false, fetch: createSessionRefreshFetch(origin, fetcher) });
    await auth.initialize();
    const events: string[] = []; const observers = new Set<(event: string) => void>();
    // Establish the SDK event bridge before damaging storage; the separate SDK
    // regression covers cold subscriptions while native storage is unavailable.
    const { data } = auth.onAuthStateChange(event => { events.push(event); observers.forEach(listener => listener(event)); });
    await new Promise(resolve => setTimeout(resolve, 0));
    const signOut = vi.fn(() => auth.signOut({ scope: 'local' }));
    const removeSession = vi.fn((guard: () => boolean) => f.store.removeItemIf(key, guard));
    const run = createDeviceSignOut({ signOut, removeSession, writeRevision: () => f.store.writeRevision(key), blockWrites: () => f.store.blockWrites(key),
      subscribe: listener => { observers.add(listener); return () => observers.delete(listener); } });
    return { ...f, auth, events, fetcher, signOut, removeSession, run, close: async () => { data.subscription.unsubscribe(); await auth.stopAutoRefresh(); } };
  }
  it('keeps the existing SDK storage key for hosted, local and custom-domain projects', () => {
    expect(sessionStorageKey(origin)).toBe('sb-device-session-auth-token');
    expect(sessionStorageKey('http://127.0.0.1:54321')).toBe('sb-127-auth-token');
    expect(sessionStorageKey('https://auth.bubaly.example')).toBe('sb-auth-auth-token');
  });
  it('uses ordinary local SDK sign-out when a saved session can be read', async () => {
    const f = await actualAuth();
    try {
      await f.store.setItem(key, JSON.stringify(session(false))); await f.run();
      expect(f.signOut).toHaveBeenCalledTimes(1); expect(f.removeSession).not.toHaveBeenCalled();
      expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${origin}/auth/v1/logout?scope=local`]);
      expect(await f.store.getItem(key)).toBeNull(); expect(f.events).toContain('SIGNED_OUT');
    } finally { await f.close(); }
  });
  it.each(['chunks:0', 'chunks:2'])('clears corrupt committed storage %s and emits the normal SDK sign-out event', async header => {
    const f = await actualAuth();
    try {
      f.values.set(key, header); f.values.set(`${key}.0`, 'torn session');
      await f.run();
      expect(f.signOut).toHaveBeenCalledTimes(2); expect(f.removeSession).toHaveBeenCalledTimes(1);
      expect(await f.store.getItem(key)).toBeNull(); expect(f.events).toContain('SIGNED_OUT'); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('preserves state and rejects when committed storage cannot be deleted', async () => {
    const f = await actualAuth();
    try {
      f.values.set(key, 'chunks:0'); vi.mocked(f.backing.removeItem).mockRejectedValue(new Error('device locked'));
      await expect(f.run()).rejects.toMatchObject({ code: 'session_storage_unavailable' });
      expect(f.values.get(key)).toBe('chunks:0'); expect(f.events).not.toContain('SIGNED_OUT'); expect(f.signOut).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it('allows explicit device sign-out when the logout endpoint is temporarily unreachable', async () => {
    const f = await actualAuth(503);
    try {
      await f.store.setItem(key, JSON.stringify(session(false))); await f.run();
      expect(f.signOut).toHaveBeenCalledTimes(2); expect(f.events).toContain('SIGNED_OUT'); expect(await f.store.getItem(key)).toBeNull();
    } finally { await f.close(); }
  });
  it('allows explicit sign-out after a temporary expired-token refresh failure', async () => {
    const f = await actualAuth(429);
    try {
      vi.useFakeTimers(); await f.store.setItem(key, JSON.stringify(session(true)));
      const ending = f.run(); await vi.advanceTimersByTimeAsync(35_000); await ending;
      expect(f.signOut).toHaveBeenCalledTimes(2); expect(f.events).toContain('SIGNED_OUT'); expect(await f.store.getItem(key)).toBeNull();
      expect(f.fetcher.mock.calls.every(([url]) => String(url).includes('/token?grant_type=refresh_token'))).toBe(true);
    } finally { await f.close(); }
  });
  it('does not use storage recovery for a permanent SDK rejection', async () => {
    const error = { status: 400, code: 'bad_request' }; const removeSession = vi.fn();
    const run = createDeviceSignOut({ ...noConcurrentWrites, signOut: async () => ({ error }), removeSession, subscribe: () => vi.fn() });
    await expect(run()).rejects.toBe(error); expect(removeSession).not.toHaveBeenCalled();
  });
  it('coalesces repeated explicit clicks and releases the guard after a failed clear', async () => {
    const release = deferred(); const clear = vi.fn(async () => { await release.promise; throw transient; });
    const signOut = vi.fn(async () => ({ error: transient }));
    const run = createDeviceSignOut({ ...noConcurrentWrites, signOut, removeSession: clear, subscribe: () => vi.fn() });
    const first = run(); const second = run(); expect(first).toBe(second);
    release.resolve(); await expect(first).rejects.toBe(transient);
    await expect(run()).rejects.toBe(transient); expect(signOut).toHaveBeenCalledTimes(2);
  });
  it('preserves a newer session committed while fallback deletion waits in the storage queue', async () => {
    const f = storeFixture(); await f.store.setItem(key, 'old session');
    let event!: (event: string) => void;
    const entered = deferred(); const release = deferred();
    vi.mocked(f.backing.setItem).mockImplementation(async (name, value) => {
      entered.resolve(); await release.promise; f.values.set(name, value); event('SIGNED_IN');
    });
    const signOut = vi.fn(async () => ({ error: transient }));
    const run = createDeviceSignOut({ signOut, writeRevision: () => f.store.writeRevision(key), blockWrites: () => f.store.blockWrites(key), subscribe: listener => { event = listener; return vi.fn(); },
      removeSession: guard => f.store.removeItemIf(key, guard) });
    const writing = f.store.setItem(key, 'new account session'); await entered.promise;
    const ending = run(); await Promise.resolve(); await Promise.resolve();
    release.resolve(); await writing;
    await expect(ending).rejects.toMatchObject({ name: 'DeviceSignOutChangedError' });
    expect(await f.store.getItem(key)).toBe('new account session'); expect(signOut).toHaveBeenCalledTimes(1);
  });
  it('does not call SDK sign-out again after a newer auth event during removal', async () => {
    let event!: (event: string) => void;
    const signOut = vi.fn(async () => ({ error: transient }));
    const run = createDeviceSignOut({ ...noConcurrentWrites, signOut, subscribe: listener => { event = listener; return vi.fn(); },
      removeSession: async () => { event('TOKEN_REFRESHED'); return true; } });
    await expect(run()).rejects.toMatchObject({ name: 'DeviceSignOutChangedError' }); expect(signOut).toHaveBeenCalledTimes(1);
  });
  it.each(['removal', 'second SDK read'])('returns a retryable failure for an overlapping password save during %s and then permits a fresh login', async phase => {
    const f = await actualAuth();
    try {
      f.values.set(key, 'chunks:0');
      const entered = deferred(); const release = deferred(); const queued = deferred();
      const save = f.store.setItem;
      vi.spyOn(f.store, 'setItem').mockImplementation((name, value) => {
        const pending = save(name, value); if (name === key) queued.resolve(); return pending;
      });
      f.fetcher.mockImplementation(async input => {
        if (String(input).includes('grant_type=password')) return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh',
          expires_in: 3600, token_type: 'bearer', user: { id: 'new-user' } });
        throw new Error('New account must never be sent to logout');
      });
      if (phase === 'removal') {
        let first = true;
        vi.mocked(f.backing.removeItem).mockImplementation(async name => {
          if (name === key && first) { first = false; entered.resolve(); await release.promise; }
          f.values.delete(name);
        });
      } else {
        let calls = 0;
        f.signOut.mockImplementation(async () => {
          if (++calls === 2) { entered.resolve(); await release.promise; }
          return f.auth.signOut({ scope: 'local' });
        });
      }
      const ending = f.run(); await entered.promise;
      const signingIn = f.auth.signInWithPassword({ email: 'fixture@example.test', password: 'synthetic-password' });
      await queued.promise; release.resolve(); await ending;
      expect((await signingIn).error?.code).toBe('session_write_blocked');
      expect(await f.store.getItem(key)).toBeNull(); expect(f.events).not.toContain('SIGNED_IN');
      expect((await f.auth.signInWithPassword({ email: 'fixture@example.test', password: 'synthetic-password' })).error).toBeNull();
      expect((await f.auth.getSession()).data.session?.user.id).toBe('new-user');
      expect(f.events.indexOf('SIGNED_OUT')).toBeLessThan(f.events.indexOf('SIGNED_IN'));
      expect(f.fetcher.mock.calls.every(([url]) => String(url).includes('grant_type=password'))).toBe(true);
    } finally { await f.close(); }
  });
  it('allows a fresh session write after a failed native deletion releases the block', async () => {
    const f = await actualAuth();
    try {
      f.values.set(key, 'chunks:0');
      const entered = deferred(); const release = deferred();
      vi.mocked(f.backing.removeItem).mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error('native deletion failed'); });
      const ending = f.run(); await entered.promise;
      const next = JSON.stringify({ ...session(false), user: { id: 'new-user' } });
      const writing = f.store.setItem(key, next);
      await expect(writing).rejects.toMatchObject({ code: 'session_write_blocked' });
      release.resolve(); await expect(ending).rejects.toMatchObject({ code: 'session_storage_unavailable' });
      await f.store.setItem(key, next); expect(await f.store.getItem(key)).toBe(next);
    } finally { await f.close(); }
  });
  it('rejects an old in-flight refresh and an overlapping login without restoring either after explicit sign-out', async () => {
    const f = await actualAuth();
    try {
      await f.store.setItem(key, JSON.stringify(session(false)));
      const snapshot = deferred(); const releaseSnapshot = deferred(); const removal = deferred(); const releaseRemoval = deferred();
      const loginWrite = deferred(); const refreshWrite = deferred();
      const read = f.store.getItem; const save = f.store.setItem;
      let reads = 0; let failNext = false;
      vi.spyOn(f.store, 'getItem').mockImplementation(async name => {
        if (name === key && failNext) { failNext = false; throw new SessionStorageUnavailableError(); }
        const value = await read(name);
        // Hold the SDK's refresh commit snapshot after its required read.
        if (name === key && ++reads === 3) { snapshot.resolve(); await releaseSnapshot.promise; }
        return value;
      });
      vi.spyOn(f.store, 'setItem').mockImplementation((name, value) => {
        const writing = save(name, value);
        if (name === key) {
          const token = JSON.parse(value).access_token;
          if (token === 'new-login') loginWrite.resolve();
          if (token === 'old-refresh') refreshWrite.resolve();
        }
        return writing;
      });
      f.fetcher.mockImplementation(async input => {
        if (String(input).includes('grant_type=password')) return Response.json({ ...session(false), expires_in: 3600, access_token: 'new-login', user: { id: 'new-user' } });
        if (String(input).includes('grant_type=refresh_token')) return Response.json({ ...session(false), expires_in: 3600, access_token: 'old-refresh' });
        throw new Error('No logout request expected after failed session read');
      });
      const refreshing = f.auth.refreshSession(); await snapshot.promise;
      failNext = true; let holdRemoval = true;
      vi.mocked(f.backing.removeItem).mockImplementation(async name => {
        if (name === key && holdRemoval) { holdRemoval = false; removal.resolve(); await releaseRemoval.promise; }
        f.values.delete(name);
      });
      const ending = f.run(); await removal.promise;
      const signingIn = f.auth.signInWithPassword({ email: 'fixture@example.test', password: 'synthetic-password' });
      await loginWrite.promise; releaseSnapshot.resolve(); await refreshWrite.promise;
      releaseRemoval.resolve(); await ending;
      expect((await signingIn).error?.code).toBe('session_write_blocked');
      expect((await refreshing).error?.code).toBe('session_write_blocked');
      expect(await f.store.getItem(key)).toBeNull();
      expect(f.events).toContain('SIGNED_OUT'); expect(f.events).not.toContain('SIGNED_IN'); expect(f.events).not.toContain('TOKEN_REFRESHED');
      expect((await f.auth.signInWithPassword({ email: 'fixture@example.test', password: 'synthetic-password' })).error).toBeNull();
      expect((await f.auth.getSession()).data.session?.user.id).toBe('new-user');
    } finally { await f.close(); }
  });
});
