import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheSessionIdentity, getCacheSessionSnapshot, getServerCacheSessionSnapshot, refreshCacheSession, subscribeCacheAuthEvents, subscribeCacheSession } from '@/lib/auth/cache-session';
import { getCacheGeneration } from '@/lib/offline/cache';
import { notifySessionStorageChanged } from '@/lib/auth/session-change';

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
    const value = session(B, S2);
    mocks.getSession.mockResolvedValue(reply(value));
    mocks.cookieSnapshot.mockReturnValue({ accessToken: value.access_token });
    connect(); await settle(); const generation = getCacheGeneration();
    const events = vi.fn(); disposers.push(subscribeCacheAuthEvents(events));
    emit('SIGNED_OUT', null);
    expect(mocks.getSession).toHaveBeenCalledTimes(1); // Never acquire the SDK lock inside its callback.
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
    expect(getCacheGeneration()).toBe(generation);
    expect(events).not.toHaveBeenCalled();
  });
  it('a repeated stale event from the queued read does not recursively schedule SDK reads', async () => {
    const value = session(B, S2);
    mocks.getSession.mockResolvedValue(reply(value));
    mocks.cookieSnapshot.mockReturnValue({ accessToken: value.access_token });
    connect(); await settle(); const generation = getCacheGeneration();
    mocks.getSession.mockImplementation(async () => { emit('SIGNED_OUT', null); return reply(null); });
    emit('SIGNED_OUT', null); await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
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
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A } });
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
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A } });
    // The peer's write finally lands; the pending episode sees it.
    saveCookies(session(B, S2)); mocks.getSession.mockResolvedValue(reply(session(B, S2)));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
    expect(reads() - base).toBeLessThanOrEqual(duringStorm + 3);
  });

  it('a read that itself provokes a stale event backs off instead of looping', async () => {
    connect(); await settle(); const base = reads();
    mocks.getSession.mockImplementation(async () => { emit('TOKEN_REFRESHED', session(B, S2)); return reply(session()); });
    emit('SIGNED_IN', session(B, S2));
    await vi.advanceTimersByTimeAsync(60_000);
    const inFirstMinute = reads() - base;
    expect(inFirstMinute).toBeLessThanOrEqual(18); // 2,401 with fixed re-armed timers
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads() - base - inFirstMinute).toBeLessThanOrEqual(6); // at the 30 s ceiling: one episode per ~30 s
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A } });
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
  // observer stays subscribed. Work must stop once cookie-bound state settles.
  it('a stale event echoed by every reread settles into no further reads and no pending timers', async () => {
    connect(); await settle();
    saveCookies(session(B, S2));
    mocks.getSession.mockImplementation(async () => { emit('SIGNED_IN', session()); return reply(session(B, S2)); });
    emit('SIGNED_IN', session()); await settle();
    for (const at of [50, 50, 400, 500]) await vi.advanceTimersByTimeAsync(at);
    const settled = reads();
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(settled);
    expect(vi.getTimerCount()).toBe(0);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
  });

  // Integration review of 6bf38f3b: after reads have been echoing stale B for a
  // while, a genuine sign-in by a third owner must not inherit that cooldown.
  it('a genuine new owner after a saturated stale stream is withheld at once and adopted from cookies', async () => {
    connect(); await settle();
    let echo = true;
    mocks.getSession.mockImplementation(async () => { if (echo) emit('TOKEN_REFRESHED', session(B, S2)); return reply(session()); });
    emit('TOKEN_REFRESHED', session(B, S2));
    await vi.advanceTimersByTimeAsync(33_000);
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: A } });
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
    expect(getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: C, sessionId: S3 } });
    expect(getCacheGeneration()).toBeGreaterThan(generation);
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
});
