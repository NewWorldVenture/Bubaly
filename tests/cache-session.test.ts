import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheSessionIdentity, getCacheSessionSnapshot, getServerCacheSessionSnapshot, refreshCacheSession, subscribeCacheAuthEvents, subscribeCacheSession } from '@/lib/auth/cache-session';
import { getCacheGeneration } from '@/lib/offline/cache';
import { notifySessionStorageChanged } from '@/lib/auth/session-change';
import { isAuthenticatedCacheScopeCurrent, type AuthenticatedCacheScope } from '@/lib/offline/cache-scope';

type Reply = { data: { session: Session | null }; error: Error | null };
const mocks = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<Reply>>(), unsubscribe: vi.fn(),
  cookieSnapshot: vi.fn(), setRealtimeAuth: vi.fn(),
  callbacks: [] as Array<(event: AuthChangeEvent, session: Session | null) => void>,
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: {
  getSession: mocks.getSession,
  onAuthStateChange: (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
    mocks.callbacks.push(callback); return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
  },
}, realtime: { setAuth: mocks.setRealtimeAuth } }) }));
vi.mock('@/lib/auth/browser-session-storage', () => ({ captureBrowserSessionSnapshot: mocks.cookieSnapshot }));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';
const C = '55555555-5555-4555-8555-555555555555';
const S3 = '66666666-6666-4666-8666-666666666666';
const S2 = '44444444-4444-4444-8444-444444444444';
function session(userId = A, sessionId: unknown = S1, sub: unknown = userId): Session {
  return { access_token: `fixture.${Buffer.from(JSON.stringify({ sub, session_id: sessionId })).toString('base64url')}.signature`,
    refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: userId, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
}
const reply = (value: Session | null, error: Error | null = null): Reply => ({ data: { session: value }, error });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
const disposers: Array<() => void> = [];
function connect() { const stop = subscribeCacheSession(() => {}); disposers.push(stop); return stop; }
function saveCookies(value: Session | null) { mocks.cookieSnapshot.mockReturnValue(value ? { accessToken: value.access_token } : null); }
function emit(event: AuthChangeEvent, value: Session | null) { mocks.callbacks.at(-1)!(event, value); }

beforeEach(() => {
  vi.clearAllMocks(); mocks.callbacks = [];
  mocks.getSession.mockReset().mockResolvedValue(reply(session()));
  mocks.cookieSnapshot.mockReset(); saveCookies(session());
  mocks.setRealtimeAuth.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon');
  vi.stubGlobal('window', new EventTarget()); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
});

describe('bounded reconciliation never authorizes an unverified session', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  const scope = (): AuthenticatedCacheScope => {
    const current = getCacheSessionSnapshot();
    return { status: 'ready', key: 'synthetic', partition: { userId: current.identity!.userId, sessionId: current.identity!.sessionId, accessIdentity: 'synthetic' },
      familyId: 'synthetic', sessionRevision: current.revision, error: null, familyMismatchError: '' };
  };

  it.each(['absent', 'different user', 'new session', 'malformed', 'unreadable'] as const)(
    'a storage-only change to %s cookies withholds the old scope before the SDK read settles', async kind => {
      connect(); await settle();
      const oldScope = scope(), generation = getCacheGeneration();
      const held = deferred<Reply>(); mocks.getSession.mockReturnValueOnce(held.promise);
      if (kind === 'unreadable') mocks.cookieSnapshot.mockImplementation(() => { throw new Error('synthetic denied cookie read'); });
      else saveCookies(kind === 'absent' ? null : kind === 'different user' ? session(B, S2)
        : kind === 'new session' ? session(A, S2) : { ...session(), access_token: 'malformed' });
      const events = vi.fn(); disposers.push(subscribeCacheAuthEvents(events));
      mocks.setRealtimeAuth.mockClear();
      notifySessionStorageChanged({ broadcast: false });
      expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(false);
      await settle(); await vi.advanceTimersByTimeAsync(350);
      expect(mocks.getSession).toHaveBeenCalledTimes(2);
      expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A, sessionId: S1 } });
      expect(getCacheGeneration()).toBe(generation);
      expect(events).not.toHaveBeenCalled(); expect(mocks.setRealtimeAuth).not.toHaveBeenCalled();
      // A newer agreeing SDK login fences the old read, even if it returns null.
      saveCookies(session(B, S2)); emit('SIGNED_IN', session(B, S2));
      const newer = getCacheSessionSnapshot();
      held.resolve(reply(null)); await settle();
      expect(getCacheSessionSnapshot()).toBe(newer);
      expect(newer).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 } });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['unchanged', 'rotated token', 'delayed old notification'] as const)(
    'a storage-only notification preserves %s scope while the SDK read is held', async kind => {
      connect(); await settle();
      const current = kind === 'delayed old notification' ? session(B, S2) : session();
      if (kind === 'delayed old notification') { saveCookies(current); emit('SIGNED_IN', current); }
      const oldScope = scope(), before = getCacheSessionSnapshot(), generation = getCacheGeneration();
      const receipt = kind === 'rotated token' ? { ...current, access_token: current.access_token + '-rotated' } : current;
      saveCookies(receipt);
      const held = deferred<Reply>(); mocks.getSession.mockReturnValueOnce(held.promise);
      notifySessionStorageChanged({ broadcast: false });
      expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(true);
      await settle(); await vi.advanceTimersByTimeAsync(350);
      expect(mocks.getSession).toHaveBeenCalledTimes(2);
      expect(getCacheSessionSnapshot()).toBe(before); expect(getCacheGeneration()).toBe(generation);
      held.resolve(reply(receipt)); await settle();
      expect(getCacheSessionSnapshot()).toBe(before); expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('withholds a previously refuted peer claim during a held lifecycle read', async () => {
    connect(); await settle();
    emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(1_000);
    expect(getCacheSessionSnapshot().status).toBe('ready');
    const oldScope = scope(); const held = deferred<Reply>();
    mocks.getSession.mockImplementation(() => held.promise);
    const lifecycle = refreshCacheSession({ force: true }); await settle();
    emit('SIGNED_IN', session(B, S2)); await settle();
    const immediatelyCurrent = isAuthenticatedCacheScopeCurrent(oldScope);
    await vi.advanceTimersByTimeAsync(20); saveCookies(session(B, S2));
    await vi.advanceTimersByTimeAsync(1_000);
    const stillCurrent = isAuthenticatedCacheScopeCurrent(oldScope);
    held.resolve(reply(session(B, S2))); await lifecycle; await settle();
    expect(immediatelyCurrent).toBe(false); expect(stillCurrent).toBe(false);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 } });
  });

  it('withholds the old cache partition for the same user with a new session', async () => {
    connect(); await settle(); const oldScope = scope(); const generation = getCacheGeneration();
    const held = deferred<Reply>(); mocks.getSession.mockImplementation(() => held.promise);
    const lifecycle = refreshCacheSession({ force: true }); await settle();
    emit('SIGNED_IN', session(A, S2)); await settle();
    const immediatelyCurrent = isAuthenticatedCacheScopeCurrent(oldScope);
    expect(getCacheGeneration()).toBe(generation);
    await vi.advanceTimersByTimeAsync(20); saveCookies(session(A, S2));
    await vi.advanceTimersByTimeAsync(1_000);
    const stillCurrent = isAuthenticatedCacheScopeCurrent(oldScope);
    held.resolve(reply(session(A, S2))); await lifecycle; await settle();
    expect(immediatelyCurrent).toBe(false); expect(stillCurrent).toBe(false);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A, sessionId: S2 } });
  });

  it('a rotated cookie token for the unchanged session preserves its scope after a failed read', async () => {
    connect(); await settle(); const oldScope = scope();
    saveCookies({ ...session(), access_token: session().access_token + '-rotated' });
    mocks.getSession.mockRejectedValue(new Error('synthetic outage'));
    await refreshCacheSession({ force: true });
    expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(true);
  });

  it.each(['same token', 'rotating token', 'rotating user'] as const)('delayed %s echoes exhaust a finite SDK-call budget, then permit explicit recovery', async kind => {
    connect(); await settle(); const base = mocks.getSession.mock.calls.length; let sequence = 0;
    mocks.getSession.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      sequence += 1;
      const claim = kind === 'rotating user' ? session(`77777777-7777-4777-8777-${String(sequence).padStart(12, '0')}`, S2)
        : kind === 'rotating token' ? { ...session(B, S2), access_token: session(B, S2).access_token + '-' + sequence } : session(B, S2);
      emit('TOKEN_REFRESHED', claim);
      return reply(session());
    });
    emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(mocks.getSession.mock.calls.length - base).toBeLessThanOrEqual(16);
    expect(vi.getTimerCount()).toBe(0);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    const calls = mocks.getSession.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(mocks.getSession).toHaveBeenCalledTimes(calls);
    mocks.getSession.mockResolvedValue(reply(session()));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    emit('SIGNED_IN', session(C, S3));
    saveCookies(session(C, S3)); mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
    expect(mocks.getSession).toHaveBeenCalledTimes(calls + 2);
  });

  it('counts stale-receipt retries in the same autonomous budget', async () => {
    connect(); await settle(); const base = mocks.getSession.mock.calls.length;
    mocks.getSession.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      emit('TOKEN_REFRESHED', session(B, S2)); return reply(session(B, S2));
    });
    emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(mocks.getSession.mock.calls.length - base).toBeLessThanOrEqual(16);
    expect(vi.getTimerCount()).toBe(0);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
  });

  it('a fresh claim during explicit recovery from exhaustion cannot revive the held owner', async () => {
    connect(); await settle();
    mocks.getSession.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      emit('TOKEN_REFRESHED', session(B, S2)); return reply(session());
    });
    emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(12 * 60_000);
    const held = deferred<Reply>(); mocks.getSession.mockImplementation(() => held.promise);
    const lifecycle = refreshCacheSession({ force: true }); await settle();
    emit('SIGNED_IN', session(C, S3)); await settle();
    held.resolve(reply(session())); await lifecycle; await settle();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
    saveCookies(session(C, S3)); mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
  });

  async function exhaustWithDelayedEchoes() {
    connect(); await settle();
    mocks.getSession.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      emit('TOKEN_REFRESHED', session(B, S2)); return reply(session());
    });
    emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
  }

  it.each(['lifecycle', 'storage'] as const)('a %s read started after a fresh exhausted claim cannot revive the old cookie owner', async trigger => {
    await exhaustWithDelayedEchoes();
    // Establish the claimed B session after exhaustion without replenishing
    // autonomous work, then deliver a genuinely newer C claim before its jar.
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 } });
    emit('SIGNED_IN', session(C, S3));
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    if (trigger === 'storage') notifySessionStorageChanged({ broadcast: false });
    await refreshCacheSession({ force: true }); await settle();
    // No event arrived DURING this read, but the earlier C claim is still
    // unverified. A newly rendered READY/B scope would expose the old partition.
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(20); saveCookies(session(C, S3));
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
    mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
    expect(isAuthenticatedCacheScopeCurrent(scope())).toBe(true);
  });

  it('the newest owner can complete the same lifecycle read after autonomous exhaustion', async () => {
    await exhaustWithDelayedEchoes();
    const held = deferred<Reply>(); mocks.getSession.mockImplementation(() => held.promise);
    const lifecycle = refreshCacheSession({ force: true }); await settle();
    emit('SIGNED_IN', session(C, S3)); saveCookies(session(C, S3));
    held.resolve(reply(session(C, S3))); await lifecycle;
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an older cookie-bound read or SDK event cannot erase a newer unverified claim', async () => {
    connect(); await settle();
    emit('SIGNED_IN', session(B, S2)); emit('SIGNED_IN', session(C, S3));
    // Both claims precede the queued read, but only the latest claim C can
    // authorize adoption before the settling episode has refuted it.
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await settle();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    emit('SIGNED_IN', session(B, S2));
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    saveCookies(session(C, S3)); mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    emit('SIGNED_IN', session(C, S3));
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
  });

  it('the newest cookie-bound SDK event recovers after autonomous exhaustion', async () => {
    await exhaustWithDelayedEchoes();
    emit('SIGNED_IN', session(C, S3));
    saveCookies(session(C, S3)); emit('SIGNED_IN', session(C, S3));
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the last budgeted read keeps a verified new owner without scheduling more calls', async () => {
    connect(); await settle(); const base = mocks.getSession.mock.calls.length; let calls = 0;
    mocks.getSession.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (++calls === 16) { saveCookies(session(B, S2)); return reply(session(B, S2)); }
      emit('TOKEN_REFRESHED', session(B, S2)); return reply(session());
    });
    emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(mocks.getSession.mock.calls.length - base).toBe(16);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 } });
    expect(vi.getTimerCount()).toBe(0);
    // Exhaustion must still remember a later claim after adoption cleared the
    // earlier hold; an old cookie-bound callback cannot revive B behind C.
    const scopeB = scope();
    emit('SIGNED_IN', session(C, S3)); emit('TOKEN_REFRESHED', session(B, S2));
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(isAuthenticatedCacheScopeCurrent(scopeB)).toBe(false);
    expect(mocks.getSession.mock.calls.length - base).toBe(16);
    expect(vi.getTimerCount()).toBe(0);
    saveCookies(session(C, S3)); emit('SIGNED_IN', session(C, S3));
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
  });

  it('exhaustion cannot let a stale event retain B after current cookies become C', async () => {
    await exhaustWithDelayedEchoes();
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 } });
    const oldScope = scope(); const calls = mocks.getSession.mock.calls.length;
    saveCookies(session(C, S3)); emit('SIGNED_IN', session(B, S2)); await settle();
    expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(false);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(mocks.getSession).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an unverified sign-out withholds A even while its confirming read hangs', async () => {
    connect(); await settle(); const oldScope = scope(); const generation = getCacheGeneration();
    const held = deferred<Reply>(); mocks.getSession.mockImplementation(() => held.promise);
    const lifecycle = refreshCacheSession({ force: true }); await settle();
    emit('SIGNED_OUT', null); await settle();
    const immediatelyCurrent = isAuthenticatedCacheScopeCurrent(oldScope);
    expect(getCacheGeneration()).toBe(generation);
    await vi.advanceTimersByTimeAsync(20); saveCookies(null);
    await vi.advanceTimersByTimeAsync(1_000);
    const stillCurrent = isAuthenticatedCacheScopeCurrent(oldScope);
    held.resolve(reply(null)); await lifecycle; await settle();
    expect(immediatelyCurrent).toBe(false); expect(stillCurrent).toBe(false);
    expect(getCacheSessionSnapshot().status).toBe('signed-out');
  });

  it('a claim after the final read started is not refuted in the same clock millisecond', async () => {
    connect(); await settle(); const generation = getCacheGeneration();
    emit('SIGNED_IN', session(B, S2)); await settle();
    await vi.advanceTimersByTimeAsync(50);
    const held = deferred<Reply>(); mocks.getSession.mockImplementationOnce(() => held.promise);
    await vi.advanceTimersByTimeAsync(450);
    emit('SIGNED_IN', session(C, S3));
    held.resolve(reply(session())); await settle();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(getCacheGeneration()).toBe(generation);
    await vi.advanceTimersByTimeAsync(20); saveCookies(session(C, S3));
    mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    await vi.advanceTimersByTimeAsync(40);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
  });
});
afterEach(() => { disposers.splice(0).forEach(stop => stop()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('cache session identity', () => {
  it('extracts only stable user/session UUIDs, without persisting rotating credentials', () => {
    expect(cacheSessionIdentity(session())).toEqual({ userId: A, sessionId: S1 });
    expect(cacheSessionIdentity({ ...session(), refresh_token: 'rotated', expires_in: 1 } as Session)).toEqual({ userId: A, sessionId: S1 });
  });
  it.each([undefined, null, '', 'not-a-uuid', { id: S1 }])('rejects malformed session_id %j', id => {
    const value = session();
    value.access_token = `fixture.${Buffer.from(JSON.stringify({ sub: A, session_id: id })).toString('base64url')}.signature`;
    expect(cacheSessionIdentity(value)).toBeNull();
  });
  it('rejects mismatched/malformed subjects and malformed SDK session shapes without throwing', () => {
    expect(cacheSessionIdentity(session(A, S1, B))).toBeNull();
    expect(cacheSessionIdentity(session('bad-user', S1))).toBeNull();
    expect(cacheSessionIdentity({ ...session(), user: null } as unknown as Session)).toBeNull();
    expect(cacheSessionIdentity({ ...session(), access_token: 'invalid' })).toBeNull();
  });
});

describe('shared session observer', () => {
  it('shares one subscription and one bootstrap read, and resets the bootstrap boundary after final disposal', async () => {
    const first = connect(), second = connect();
    await Promise.all([refreshCacheSession(), refreshCacheSession()]);
    expect(mocks.callbacks).toHaveLength(1); expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A, sessionId: S1 } });
    first(); expect(mocks.unsubscribe).not.toHaveBeenCalled(); second();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'restoring', identity: null });
  });
  it('server reads and subscriptions never expose or establish browser singleton identity', async () => {
    connect(); await settle();
    expect(getServerCacheSessionSnapshot()).toMatchObject({ status: 'restoring', identity: null });
    vi.stubGlobal('window', undefined);
    expect(getCacheSessionSnapshot()).toBe(getServerCacheSessionSnapshot());
    const stop = subscribeCacheSession(() => {}); stop(); await refreshCacheSession();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
  });
  it('unchanged session token refresh keeps the identity revision and does not purge cache', async () => {
    connect(); await settle(); const before = getCacheSessionSnapshot(); const generation = getCacheGeneration();
    const rotated = { ...session(), access_token: session().access_token.replace('.signature', '.rotated-signature'), refresh_token: 'new-token', expires_in: 60 };
    saveCookies(rotated); emit('TOKEN_REFRESHED', rotated);
    expect(getCacheSessionSnapshot()).toBe(before); expect(getCacheGeneration()).toBe(generation);
  });
  it('a changed login session retires the old generation even for the same user', async () => {
    connect(); await settle(); const generation = getCacheGeneration();
    saveCookies(session(A, S2)); emit('SIGNED_IN', session(A, S2));
    expect(getCacheSessionSnapshot().identity).toEqual({ userId: A, sessionId: S2 });
    expect(getCacheGeneration()).toBe(generation + 1);
  });
  it('INITIAL_SESSION null cannot hide a failed bootstrap or manufacture sign-out', async () => {
    mocks.getSession.mockResolvedValue(reply(null, new Error('storage unavailable')));
    connect(); emit('INITIAL_SESSION', null); await settle();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: null, error: expect.any(String) });
  });
  it('a successful no-session bootstrap is definitive and retires cache', async () => {
    saveCookies(null); mocks.getSession.mockResolvedValue(reply(null)); connect(); await settle();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'signed-out', identity: null, error: null });
  });
  it('transient failures preserve established identity and recover without changing its revision', async () => {
    connect(); await settle(); const before = getCacheSessionSnapshot(); const generation = getCacheGeneration();
    mocks.getSession.mockRejectedValueOnce(new Error('offline'));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: before.identity, revision: before.revision, error: expect.any(String) });
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toEqual(before); expect(getCacheGeneration()).toBe(generation);
  });
  it.each([[B, S1], [A, S2]])('late SDK INITIAL_SESSION cannot replace newer SIGNED_IN %s/%s', async (userId, sid) => {
    connect(); await settle();
    const events: string[] = []; disposers.push(subscribeCacheAuthEvents(event => events.push(event)));
    saveCookies(session(userId, sid)); emit('SIGNED_IN', session(userId, sid)); const before = getCacheSessionSnapshot();
    emit('INITIAL_SESSION', session());
    expect(getCacheSessionSnapshot()).toBe(before); expect(events).toEqual(['SIGNED_IN']);
  });
  it('late SDK INITIAL_SESSION cannot replace a newer explicit read or its error', async () => {
    connect(); await settle();
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2))); await refreshCacheSession();
    emit('INITIAL_SESSION', session()); expect(getCacheSessionSnapshot().identity?.userId).toBe(B);
    mocks.getSession.mockRejectedValue(new Error('offline')); await refreshCacheSession();
    const before = getCacheSessionSnapshot(); emit('INITIAL_SESSION', session());
    expect(getCacheSessionSnapshot()).toBe(before);
  });
  it('late explicit bootstrap cannot undo sign-out or a later sign-in', async () => {
    const held = deferred<Reply>(); mocks.getSession.mockReturnValue(held.promise);
    connect(); saveCookies(null); emit('SIGNED_OUT', null); saveCookies(session(B, S2)); emit('SIGNED_IN', session(B, S2));
    held.resolve(reply(session())); await settle();
    expect(getCacheSessionSnapshot().identity).toEqual({ userId: B, sessionId: S2 });
  });
  it('a newer lifecycle read supersedes a read still pending after thirty seconds', async () => {
    const old = deferred<Reply>(); mocks.getSession.mockReturnValueOnce(old.promise).mockResolvedValue(reply(session(B, S2)));
    connect(); await settle(); saveCookies(session(B, S2)); vi.setSystemTime(30_000); await refreshCacheSession();
    old.resolve(reply(session())); await settle();
    expect(getCacheSessionSnapshot().identity).toEqual({ userId: B, sessionId: S2 });
  });
  it('an explicit storage change supersedes a just-started read and its stale initial event', async () => {
    const old = deferred<Reply>();
    mocks.getSession.mockReturnValueOnce(old.promise).mockResolvedValue(reply(null));
    connect(); await settle();
    saveCookies(null); notifySessionStorageChanged();
    emit('INITIAL_SESSION', session());
    await refreshCacheSession();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'signed-out', identity: null });
    old.resolve(reply(session())); await settle();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'signed-out', identity: null });
  });
  it('a delayed signal rereads a newer login without purging it or emitting an auth event', async () => {
    connect(); await settle(); saveCookies(session(B, S2)); emit('SIGNED_IN', session(B, S2));
    mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    const before = getCacheSessionSnapshot(), generation = getCacheGeneration();
    const events = vi.fn(); disposers.push(subscribeCacheAuthEvents(events));
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toBe(before);
    expect(getCacheGeneration()).toBe(generation);
    expect(events).not.toHaveBeenCalled();
  });
  it('a later SDK login supersedes an explicit-change read that returns empty', async () => {
    connect(); await settle(); const held = deferred<Reply>();
    mocks.getSession.mockReturnValueOnce(held.promise);
    notifySessionStorageChanged(); await settle();
    saveCookies(session(B, S2)); emit('SIGNED_IN', session(B, S2)); const generation = getCacheGeneration();
    held.resolve(reply(null)); await settle();
    expect(getCacheSessionSnapshot().identity).toEqual({ userId: B, sessionId: S2 });
    expect(getCacheGeneration()).toBe(generation);
  });
  it('a forced read bypasses coalescing even without a cross-tab message', async () => {
    const held = deferred<Reply>();
    mocks.getSession.mockReturnValueOnce(held.promise).mockResolvedValue(reply(session(B, S2)));
    connect(); await settle(); saveCookies(session(B, S2)); await refreshCacheSession({ force: true });
    held.resolve(reply(session())); await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot().identity).toEqual({ userId: B, sessionId: S2 });
  });
  it('an unavailable reread after a change notification does not manufacture sign-out', async () => {
    connect(); await settle(); const generation = getCacheGeneration();
    mocks.getSession.mockRejectedValueOnce(new Error('storage unavailable'));
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A }, error: expect.any(String) });
    expect(getCacheGeneration()).toBe(generation);
  });
  it('a confirmed empty reread downgrades realtime using the explicit public key', async () => {
    connect(); await settle(); mocks.setRealtimeAuth.mockClear(); saveCookies(null); mocks.getSession.mockResolvedValue(reply(null));
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(mocks.setRealtimeAuth).toHaveBeenCalledExactlyOnceWith('synthetic-public-anon');
  });
  it('a new cookie session appearing after an empty read prevents stale realtime downgrade', async () => {
    connect(); await settle(); mocks.setRealtimeAuth.mockClear(); saveCookies(null); mocks.getSession.mockResolvedValue(reply(null));
    const generation = getCacheGeneration();
    mocks.cookieSnapshot.mockReturnValue({ accessToken: session(B, S2).access_token });
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(mocks.setRealtimeAuth).not.toHaveBeenCalled();
    expect(getCacheGeneration()).toBe(generation);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A }, error: expect.any(String) });
    expect(mocks.getSession).toHaveBeenCalledTimes(3); // Bootstrap plus at most two conflicting reads.
  });
  it('one bounded reread observes B after an empty receipt without purging B cache', async () => {
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    connect(); await settle(); mocks.setRealtimeAuth.mockClear(); const generation = getCacheGeneration();
    mocks.getSession.mockResolvedValueOnce(reply(null)).mockResolvedValue(reply(session(B, S2)));
    mocks.cookieSnapshot.mockReturnValue({ accessToken: session(B, S2).access_token });
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B }, error: null });
    expect(mocks.getSession).toHaveBeenCalledTimes(3);
    expect(getCacheGeneration()).toBe(generation);
    expect(mocks.setRealtimeAuth).toHaveBeenCalledExactlyOnceWith(session(B, S2).access_token);
  });
  it('malformed present cookies do not turn a null receipt into confirmed sign-out', async () => {
    connect(); await settle(); mocks.setRealtimeAuth.mockClear(); const generation = getCacheGeneration();
    mocks.getSession.mockResolvedValue(reply(null));
    mocks.cookieSnapshot.mockReturnValue({ accessToken: null, userId: null, sessionId: null });
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A }, error: expect.any(String) });
    expect(getCacheGeneration()).toBe(generation);
    expect(mocks.setRealtimeAuth).not.toHaveBeenCalled();
    mocks.getSession.mockRejectedValue(new Error('network unavailable'));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
  });
  it('an agreeing B receipt updates peer realtime using the exact currently stored token', async () => {
    const value = session(B, S2);
    mocks.getSession.mockResolvedValue(reply(value));
    mocks.cookieSnapshot.mockReturnValue({ accessToken: value.access_token });
    connect(); await settle();
    expect(mocks.setRealtimeAuth).toHaveBeenCalledExactlyOnceWith(value.access_token);
  });
  it('a nonempty receipt cannot authorize cache or overwrite realtime when current cookie token disagrees', async () => {
    mocks.cookieSnapshot.mockReturnValue({ accessToken: session(B, S2).access_token });
    connect(); await settle();
    expect(mocks.setRealtimeAuth).not.toHaveBeenCalled();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot()).toMatchObject({status:'unavailable',identity:null,error:expect.any(String)});
  });
  it('a stale SIGNED_OUT event with B cookies cannot purge B or reach auth listeners', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const value = session(B, S2);
    mocks.getSession.mockResolvedValue(reply(value));
    mocks.cookieSnapshot.mockReturnValue({ accessToken: value.access_token });
    connect(); await settle(); const generation = getCacheGeneration();
    const events = vi.fn(); disposers.push(subscribeCacheAuthEvents(events));
    emit('SIGNED_OUT', null);
    expect(mocks.getSession).toHaveBeenCalledTimes(1); // Never acquire the SDK lock inside its callback.
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: B } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
    expect(getCacheGeneration()).toBe(generation);
    expect(events).not.toHaveBeenCalled();
  });
  it('a repeated stale event from the queued read does not recursively schedule SDK reads', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const value = session(B, S2);
    mocks.getSession.mockResolvedValue(reply(value));
    mocks.cookieSnapshot.mockReturnValue({ accessToken: value.access_token });
    connect(); await settle(); const generation = getCacheGeneration();
    mocks.getSession.mockImplementation(async () => { emit('SIGNED_OUT', null); return reply(null); });
    emit('SIGNED_OUT', null); await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: B } });
    // A contradictory empty receipt cannot keep B authorized. Once a read
    // actually agrees with B's cookies, the stale sign-out can be refuted.
    mocks.getSession.mockResolvedValue(reply(value));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
    expect(getCacheGeneration()).toBe(generation);
  });
  it('a denied cookie read cannot downgrade realtime', async () => {
    connect(); await settle(); mocks.setRealtimeAuth.mockClear(); saveCookies(null); mocks.getSession.mockResolvedValue(reply(null));
    mocks.cookieSnapshot.mockImplementation(() => { throw new Error('cookies denied'); });
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(mocks.setRealtimeAuth).not.toHaveBeenCalled();
  });
  it('a realtime transport failure does not undo confirmed local sign-out', async () => {
    connect(); await settle(); mocks.setRealtimeAuth.mockClear(); saveCookies(null); mocks.getSession.mockResolvedValue(reply(null));
    mocks.setRealtimeAuth.mockRejectedValue(new Error('socket closed'));
    notifySessionStorageChanged(); await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'signed-out', identity: null });
  });
  it('malformed new credentials retire established identity but retain the observed user for server agreement', async () => {
    connect(); await settle(); saveCookies(session(B, 'invalid')); emit('SIGNED_IN', session(B, 'invalid'));
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: null, observedUserId: B, error: expect.any(String) });
  });
  it('a later failed refresh cannot forget a confirmed different user with a malformed session discriminator', async () => {
    connect(); await settle(); saveCookies(session(B, 'invalid')); emit('SIGNED_IN', session(B, 'invalid'));
    mocks.getSession.mockRejectedValue(new Error('provider unavailable'));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: null, observedUserId: B });
  });
});


describe('positive session receipt ownership', () => {
  it('rejects stale positive SDK events before notifying listeners and rereads current B outside the callback', async () => {
    connect(); await settle();
    const events = vi.fn(); disposers.push(subscribeCacheAuthEvents(events));
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    emit('SIGNED_IN', session());
    expect(events).not.toHaveBeenCalled();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot()).toMatchObject({status:'ready',identity:{userId:B},error:null});
    expect(mocks.setRealtimeAuth).toHaveBeenLastCalledWith(session(B, S2).access_token);
  });
  it('bounds repeated stale positive event reconciliation without recursive SDK reads', async () => {
    connect(); await settle();
    saveCookies(session(B, S2));
    mocks.getSession.mockImplementation(async () => { emit('SIGNED_IN', session()); return reply(session(B, S2)); });
    emit('SIGNED_IN', session()); await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot()).toMatchObject({status:'ready',identity:{userId:B},error:null});
  });
});

// A peer tab's SDK broadcast reached this tab a few milliseconds before its
// cookie write was visible here (reproduced in Chromium 141 and 149, React 18
// and 19). The immediate reread saw consistent, stale A and nothing read again.
describe('a peer event that outruns its cookie write', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(0); });
  const reads = () => mocks.getSession.mock.calls.length;

  it('rereads after the cookie jar settles and retires A for B', async () => {
    connect(); await settle();
    const generation = getCacheGeneration();
    // The event names B while this tab's cookies still read A: A is withheld at
    // once, B is not adopted from the event, and nothing is purged yet.
    emit('SIGNED_IN', session(B, S2)); await settle();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
    expect(getCacheGeneration()).toBe(generation);
    // The peer's write becomes visible here.
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await vi.advanceTimersByTimeAsync(50);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 }, error: null });
    expect(getCacheGeneration()).toBeGreaterThan(generation);
  });

  it('rereads a sign-out whose cookie removal was not yet visible', async () => {
    connect(); await settle();
    emit('SIGNED_OUT', null); await settle();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
    saveCookies(null); mocks.getSession.mockResolvedValue(reply(null));
    await vi.advanceTimersByTimeAsync(50);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'signed-out', identity: null });
  });

  it('never adopts the event itself, and one quiet episode is three reads', async () => {
    connect(); await settle(); const base = reads();
    emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(60_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A } });
    expect(reads() - base).toBe(3); // now, +50 ms, +500 ms; then nothing
  });

  it('a sustained stream of stale events does not multiply reads, and a real switch is still seen', async () => {
    connect(); await settle(); const base = reads();
    // 1,000 stale events, one every 10 ms, while cookies stay A.
    for (let i = 0; i < 1000; i++) { emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(10); }
    const duringStorm = reads() - base;
    expect(duringStorm).toBeLessThanOrEqual(12); // was 1,000 before the fix, one per event
    // The last still-unverified B claim must withhold A, even if an earlier
    // identical claim was refuted. Read scheduling remains bounded below.
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
    // The peer's write finally lands; the pending episode sees it.
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
    expect(reads() - base).toBeLessThanOrEqual(duringStorm + 3);
  });

  it('a read that itself provokes a stale event stops at the autonomous budget', async () => {
    connect(); await settle(); const base = reads(); const oldScope = scopeOf();
    mocks.getSession.mockImplementation(async () => { emit('TOKEN_REFRESHED', session(B, S2)); return reply(session()); });
    emit('SIGNED_IN', session(B, S2));
    await vi.advanceTimersByTimeAsync(60_000);
    const inFirstMinute = reads() - base;
    expect(inFirstMinute).toBe(16);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads() - base).toBe(inFirstMinute);
    expect(vi.getTimerCount()).toBe(0);
    // Each callback might be a genuine peer change. A later read of the old
    // cookie does not refute it; only a receipt for the latest claim recovers.
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
    expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(false);
    mocks.getSession.mockResolvedValue(reply(session()));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(reads() - base).toBe(17);
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 } });
    expect(reads() - base).toBe(18);
  });

  it('rapid owner changes settle on whoever the cookies finally name', async () => {
    connect(); await settle(); const base = reads();
    for (let i = 0; i < 20; i++) { emit('SIGNED_IN', i % 2 ? session() : session(B, S2)); await vi.advanceTimersByTimeAsync(5); }
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
    expect(reads() - base).toBeLessThanOrEqual(6);
  });

  // Integration review of f6c512aa: every reread echoes a stale event while the
  // observer stays subscribed. Work must stop even if each callback is newer
  // than its read; recovery still requires a successful cookie-bound receipt.
  it('a stale event echoed by every reread exhausts into no further reads and no pending timers', async () => {
    connect(); await settle(); const base = reads(); const oldScope = scopeOf();
    saveCookies(session(B, S2));
    mocks.getSession.mockImplementation(async () => { emit('SIGNED_IN', session()); return reply(session(B, S2)); });
    emit('SIGNED_IN', session()); await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = reads();
    expect(settled - base).toBe(16);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(settled);
    expect(vi.getTimerCount()).toBe(0);
    mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(reads()).toBe(settled + 1);
    emit('SIGNED_IN', session(C, S3));
    saveCookies(session(C, S3)); mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
    expect(reads()).toBe(settled + 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Integration review of 6bf38f3b: after reads have been echoing stale B for a
  // while, a genuine sign-in by a third owner must still recover through a
  // lifecycle read after the autonomous budget has been spent.
  it('a genuine new owner after a saturated stale stream is adopted by a cookie-bound lifecycle read', async () => {
    connect(); await settle(); const base = reads(); const oldScope = scopeOf();
    let echo = true;
    mocks.getSession.mockImplementation(async () => { if (echo) emit('TOKEN_REFRESHED', session(B, S2)); return reply(session()); });
    emit('TOKEN_REFRESHED', session(B, S2));
    await vi.advanceTimersByTimeAsync(33_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
    expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(false);
    expect(reads() - base).toBe(16);
    expect(vi.getTimerCount()).toBe(0);
    echo = false;
    const generation = getCacheGeneration();
    // C signs in elsewhere; this tab's cookies still read A for 20 ms.
    emit('SIGNED_IN', session(C, S3));
    expect(getCacheSessionSnapshot().status).not.toBe('ready'); // A's cached UI is no longer authorized
    expect(getCacheGeneration()).toBe(generation);             // nothing purged on an unbound event
    await vi.advanceTimersByTimeAsync(20);
    expect(getCacheSessionSnapshot().status).not.toBe('ready');
    saveCookies(session(C, S3)); mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    await vi.advanceTimersByTimeAsync(40);
    expect(reads() - base).toBe(16);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
    expect(getCacheGeneration()).toBeGreaterThan(generation);
    expect(reads() - base).toBe(17);
  });

  it('a stale event naming another owner withholds only until cookies confirm the current one', async () => {
    connect(); await settle();
    const generation = getCacheGeneration();
    emit('SIGNED_IN', session(C, S3)); // stale: cookies stay A throughout
    expect(getCacheSessionSnapshot().status).not.toBe('ready');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A }, error: null });
    expect(getCacheGeneration()).toBe(generation);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposal while a claimed new owner is withheld stops every read and timer', async () => {
    const stop = connect(); await settle();
    emit('SIGNED_IN', session(C, S3)); await settle();
    expect(getCacheSessionSnapshot().status).not.toBe('ready');
    const calls = reads();
    stop(); await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops rereading once the observer is disposed, including a pending backoff', async () => {
    const stop = connect(); await settle();
    for (let i = 0; i < 100; i++) { emit('SIGNED_IN', session(B, S2)); await vi.advanceTimersByTimeAsync(10); }
    const calls = reads();
    stop(); await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(calls);
  });

  // Integration review of c3abcc86: once cookies change from A to B, a receipt
  // held from before the change must not authorize A again, whether the
  // episode's later reads fail or keep returning stale A.
  it.each([
    ['fail', () => reply(null, new Error('synthetic read failure'))],
    ['return stale A', () => reply(session())],
  ])('when rereads after the cookie change %s, A is never restored', async (_, later) => {
    connect(); await settle(); const base = reads();
    const generation = getCacheGeneration();
    emit('SIGNED_IN', session(B, S2)); await settle(); // the 0 ms read still returns cookie-bound A
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
    await vi.advanceTimersByTimeAsync(20);
    saveCookies(session(B, S2)); mocks.getSession.mockImplementation(async () => later());
    await vi.advanceTimersByTimeAsync(1_000); // the +50 ms and +500 ms reads, then the episode ends
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(getCacheGeneration()).toBe(generation);
    // Recovery is bounded: a few spaced reads, then quiet until a lifecycle read.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(reads() - base).toBeLessThanOrEqual(1 + 2 * 2 + 2 * 5); // episode, then five spaced reads
    expect(vi.getTimerCount()).toBe(0);
    const calls = reads();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads()).toBe(calls);
    // A later read that current cookies bind to B recovers.
    mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 }, error: null });
    expect(getCacheGeneration()).toBeGreaterThan(generation);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers on its own once a spaced reread verifies the owner that cookies name', async () => {
    connect(); await settle();
    emit('SIGNED_IN', session(B, S2)); await settle();
    await vi.advanceTimersByTimeAsync(20);
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(null, new Error('synthetic read failure')));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    const base = reads();
    mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 }, error: null });
    expect(reads() - base).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads() - base).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposal while recovering from a failed verification stops every read and timer', async () => {
    const stop = connect(); await settle();
    emit('SIGNED_IN', session(B, S2)); await settle();
    await vi.advanceTimersByTimeAsync(20);
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(null, new Error('synthetic read failure')));
    await vi.advanceTimersByTimeAsync(1_000);
    const calls = reads();
    stop(); await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads()).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Integration review of f9c1fecb (comments 5918650810, 5918816296): a failed
  // read keeps authorizing A only while current cookies still carry A, and a
  // peer owner event is withheld even while another SDK read is outstanding.
  function scopeOf(snapshot = getCacheSessionSnapshot()): AuthenticatedCacheScope {
    return { status: 'ready', key: 'synthetic', partition: { userId: snapshot.identity!.userId, sessionId: snapshot.identity!.sessionId, accessIdentity: 'synthetic' },
      familyId: 'synthetic', sessionRevision: snapshot.revision, error: null, familyMismatchError: '' };
  }
  const failures = [
    ['resolved', () => mocks.getSession.mockResolvedValue(reply(null, new Error('synthetic failure')))],
    ['thrown', () => mocks.getSession.mockRejectedValue(new Error('synthetic failure'))],
  ] as const;

  it.each(failures)('a peer owner event during a pending SDK read withholds A when reads fail (%s)', async (_, fail) => {
    connect(); await settle();
    const scopeA = scopeOf(); const generation = getCacheGeneration();
    expect(isAuthenticatedCacheScopeCurrent(scopeA)).toBe(true);
    const pendingRead = deferred<Reply>();
    mocks.getSession.mockImplementationOnce(() => pendingRead.promise);
    const lifecycle = refreshCacheSession({ force: true }); await settle();
    fail();
    // External peer event while that read is outstanding; cookies still read A.
    emit('SIGNED_IN', session(B, S2)); await settle();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(isAuthenticatedCacheScopeCurrent(scopeA)).toBe(false);
    expect(getCacheGeneration()).toBe(generation); // nothing purged on an unbound event
    await vi.advanceTimersByTimeAsync(20);
    saveCookies(session(B, S2));
    pendingRead.resolve(reply(null, new Error('synthetic old-read failure')));
    await lifecycle.catch(() => {}); await settle();
    for (const at of [1_000, 120_000]) {
      await vi.advanceTimersByTimeAsync(at);
      expect(getCacheSessionSnapshot().status).toBe('unavailable');
      expect(isAuthenticatedCacheScopeCurrent(scopeA)).toBe(false);
    }
    expect(reads()).toBeLessThanOrEqual(1 + 1 + 3 + 5); // bootstrap, the lifecycle read, one episode, recovery
    expect(vi.getTimerCount()).toBe(0);
    // A later read bound to B's cookie adopts B.
    mocks.getSession.mockReset().mockResolvedValue(reply(session(B, S2)));
    await refreshCacheSession({ force: true });
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 }, error: null });
    expect(getCacheGeneration()).toBeGreaterThan(generation);
  });

  it('a peer owner event during a pending read converges on B when the reread agrees', async () => {
    connect(); await settle();
    const pendingRead = deferred<Reply>();
    mocks.getSession.mockImplementationOnce(() => pendingRead.promise);
    const lifecycle = refreshCacheSession({ force: true }); await settle();
    emit('SIGNED_IN', session(B, S2)); await settle();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(20);
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    pendingRead.resolve(reply(session()));
    await lifecycle; await vi.advanceTimersByTimeAsync(40);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B, sessionId: S2 }, error: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(failures)('a failed reread after the cookies changed withholds A without any SDK event (%s)', async (_, fail) => {
    connect(); await settle();
    const scopeA = scopeOf();
    saveCookies(session(B, S2)); fail();
    notifySessionStorageChanged({ broadcast: false });
    await refreshCacheSession().catch(() => {}); await settle();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(isAuthenticatedCacheScopeCurrent(scopeA)).toBe(false);
  });

  it.each(failures)('a transient failure with A still in the cookies keeps A (%s)', async (_, fail) => {
    connect(); await settle();
    const scopeA = scopeOf();
    fail();
    notifySessionStorageChanged({ broadcast: false });
    await refreshCacheSession().catch(() => {}); await settle();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A, sessionId: S1 } });
    expect(isAuthenticatedCacheScopeCurrent(scopeOf())).toBe(true);
    expect(getCacheSessionSnapshot().identity).toEqual(scopeA.partition && { userId: scopeA.partition.userId, sessionId: scopeA.partition.sessionId });
  });

  // A read-time callback cannot be distinguished from a genuine later peer
  // change. It remains unverified, but cannot replenish the autonomous budget.
  it.each([
    ['a new token', (i: number) => session(B, `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`)],
    ['a new user', (i: number) => session(`77777777-7777-4777-8777-${String(i).padStart(12, '0')}`, `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`)],
  ] as const)('reads that each provoke a claim for %s stop, and only the claimed owner can recover', async (_, claim) => {
    connect(); await settle(); const base = reads(); const oldScope = scopeOf(); let i = 0;
    mocks.getSession.mockImplementation(async () => { emit('TOKEN_REFRESHED', claim(++i)); return reply(session()); });
    emit('SIGNED_IN', session(B, S2));
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(reads() - base).toBe(16);
    expect(vi.getTimerCount()).toBe(0);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'unavailable', identity: { userId: A } });
    expect(isAuthenticatedCacheScopeCurrent(oldScope)).toBe(false);
    mocks.getSession.mockResolvedValue(reply(session()));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot().status).toBe('unavailable');
    expect(reads() - base).toBe(17);
    emit('SIGNED_IN', session(C, S3));
    saveCookies(session(C, S3)); mocks.getSession.mockResolvedValue(reply(session(C, S3)));
    await refreshCacheSession();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 }, error: null });
    expect(reads() - base).toBe(18);
  });
});

describe('claimed session rotation after conflict exhaustion', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  const rotated = (value: Session) => ({ ...value, access_token: value.access_token + '-rotation' });
  async function exhausted() {
    connect(); await settle(); const base=mocks.getSession.mock.calls.length;
    mocks.getSession.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve,1));
      emit('TOKEN_REFRESHED',session(B,S2)); return reply(session());
    });
    emit('SIGNED_IN',session(B,S2)); await vi.advanceTimersByTimeAsync(12*60_000);
    expect(mocks.getSession.mock.calls.length-base).toBe(16);
    expect(vi.getTimerCount()).toBe(0); expect(getCacheSessionSnapshot().status).toBe('unavailable');
  }
  it.each(['SDK event','lifecycle receipt'] as const)('accepts a cookie-bound rotated token for the latest claimed user/session through %s',async mode => {
    await exhausted(); const next=rotated(session(B,S2)); saveCookies(next); mocks.getSession.mockResolvedValue(reply(next));
    if(mode==='SDK event')emit('TOKEN_REFRESHED',next);else await refreshCacheSession({force:true});
    expect(getCacheSessionSnapshot()).toMatchObject({status:'ready',identity:{userId:B,sessionId:S2}});
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['old owner','different claimed session','newer owner','malformed claim','claim subject mismatch','sign-out claim'] as const)('does not revive cookies after exhaustion behind %s',async kind => {
    await exhausted();
    let next=rotated(session(B,S2));
    if(kind==='old owner')next=rotated(session());
    if(kind==='different claimed session')next=rotated(session(B,S3));
    if(kind==='newer owner')emit('SIGNED_IN',session(C,S3));
    if(kind==='malformed claim')emit('SIGNED_IN',{...session(B,S2),access_token:'unparseable'});
    if(kind==='claim subject mismatch') { emit('SIGNED_IN',rotated(session(B,S1,A))); next=session(); }
    if(kind==='sign-out claim')emit('SIGNED_OUT',null);
    saveCookies(next); mocks.getSession.mockResolvedValue(reply(next));
    await refreshCacheSession({force:true}); emit('TOKEN_REFRESHED',next);
    expect(getCacheSessionSnapshot().status).toBe('unavailable');expect(vi.getTimerCount()).toBe(0);
  });
  it('a late rotated receipt may adopt only the latest owner, never an earlier claim',async () => {
    await exhausted(); const held=deferred<Reply>();mocks.getSession.mockImplementation(()=>held.promise);
    const work=refreshCacheSession({force:true});await settle();emit('SIGNED_IN',session(C,S3));
    const next=rotated(session(C,S3));saveCookies(next);held.resolve(reply(next));await work;
    expect(getCacheSessionSnapshot()).toMatchObject({status:'ready',identity:{userId:C,sessionId:S3}});expect(vi.getTimerCount()).toBe(0);
  });
});
