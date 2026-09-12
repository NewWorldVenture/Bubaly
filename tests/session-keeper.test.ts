import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionKeeper } from '@/components/auth/session-keeper';

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type SessionResult = { data: { session: Session | null }; error: Error | null };
type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
const mocks = vi.hoisted(() => ({
  effect: undefined as Effect | undefined,
  pendingEffects: [] as (() => void)[],
  router: { refresh: vi.fn() },
  getSession: vi.fn<() => Promise<SessionResult>>(),
  authCallback: undefined as AuthCallback | undefined,
  unsubscribe: vi.fn(),
  isNative: vi.fn(),
  addListener: vi.fn(),
  removeResume: vi.fn(),
}));

// Run the component's real effect and callbacks with a small effect scheduler;
// the browser event targets, auth SDK and native plugin are the boundaries.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const previous = mocks.effect;
    if (previous?.deps && deps && previous.deps.length === deps.length
      && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
    mocks.pendingEffects.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      mocks.effect = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    });
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: (callback: AuthCallback) => {
        mocks.authCallback = callback;
        return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
      },
    },
  }),
}));
vi.mock('@/lib/native/capacitor', () => ({ isNative: mocks.isNative }));
vi.mock('@capacitor/app', () => ({ App: { addListener: mocks.addListener } }));

function session(userId: string): Session {
  const id = userId === 'user-a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
  const claims = Buffer.from(JSON.stringify({ sub: id, session_id: '33333333-3333-4333-8333-333333333333' })).toString('base64url');
  return {
    access_token: `fixture.${claims}.signature`, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3_600,
    user: { id, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-09T00:00:00Z' },
  };
}
function result(userId: string | null, error: Error | null = null): SessionResult {
  return { data: { session: userId === null ? null : session(userId) }, error };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function render(userId = 'user-a') {
  expect(SessionKeeper({ userId: session(userId).user.id })).toBeNull();
  mocks.pendingEffects.splice(0).forEach((effect) => effect());
}
function unmount() {
  mocks.effect?.cleanup?.();
  mocks.effect = undefined;
}
function emit(event: AuthChangeEvent, userId: string | null = 'user-a') {
  mocks.authCallback!(event, userId === null ? null : session(userId));
}
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
async function nativeReady() {
  await vi.dynamicImportSettled();
  await settle();
}
let windowTarget: EventTarget;
let documentTarget: EventTarget & { visibilityState: string };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  mocks.effect = undefined;
  mocks.pendingEffects = [];
  mocks.authCallback = undefined;
  mocks.getSession.mockReset().mockResolvedValue(result('user-a'));
  mocks.isNative.mockReset().mockReturnValue(false);
  mocks.removeResume.mockReset().mockResolvedValue(undefined);
  mocks.addListener.mockReset().mockResolvedValue({ remove: mocks.removeResume });
  windowTarget = new EventTarget();
  documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SessionKeeper identity reconciliation', () => {
  it('keeps the current server tree when the saved session still belongs to its user', async () => {
    render();
    windowTarget.dispatchEvent(new Event('focus'));
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it.each([null, 'user-b'])('refreshes after a successful stored identity change to %s', async (userId) => {
    // A server POST in another tab can clear the auth cookie without emitting
    // SIGNED_OUT through this tab's client instance.
    mocks.getSession.mockResolvedValue(result(userId));
    render();
    windowTarget.dispatchEvent(new Event('focus'));
    await settle();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'user-b'])('does not treat a failed read with session %s as an identity change', async (userId) => {
    mocks.getSession.mockResolvedValue(result(userId, new Error('temporarily unavailable')));
    render();
    windowTarget.dispatchEvent(new Event('online'));
    await settle();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('retries after a rejected refresh without treating the failure as sign-out', async () => {
    mocks.getSession.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(result('user-b'));
    render();
    windowTarget.dispatchEvent(new Event('focus'));
    await settle();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    vi.setSystemTime(30_000);
    windowTarget.dispatchEvent(new Event('online'));
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes changed-user sign-in and ignores same-user sign-in and initial empty bootstrap', () => {
    render();
    emit('INITIAL_SESSION', null);
    emit('SIGNED_IN');
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    emit('SIGNED_IN', 'user-b');
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    // Auth callbacks must not acquire the SDK's session lock recursively.
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each(['TOKEN_REFRESHED', 'USER_UPDATED', 'SIGNED_OUT'] as const)('preserves %s server refresh', (event) => {
    render();
    emit(event, event === 'SIGNED_OUT' ? null : 'user-a');
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('ignores a stale empty read after a later same-user sign-in event', async () => {
    const pending = deferred<SessionResult>();
    mocks.getSession.mockReturnValue(pending.promise);
    render();
    windowTarget.dispatchEvent(new Event('focus'));
    emit('SIGNED_IN');
    pending.resolve(result(null));
    await settle();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('does not refresh again for a stale read after explicit sign-out', async () => {
    const pending = deferred<SessionResult>();
    mocks.getSession.mockReturnValue(pending.promise);
    render();
    windowTarget.dispatchEvent(new Event('focus'));
    emit('SIGNED_OUT', null);
    pending.resolve(result('user-b'));
    await settle();
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });

  it('uses the latest lifecycle read when two requests finish in reverse order', async () => {
    const older = deferred<SessionResult>();
    const newer = deferred<SessionResult>();
    mocks.getSession.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render();
    windowTarget.dispatchEvent(new Event('focus'));
    vi.setSystemTime(30_000);
    windowTarget.dispatchEvent(new Event('online'));
    newer.resolve(result('user-a'));
    await settle();
    older.resolve(result(null));
    await settle();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('compares against new server props and ignores work from the previous user', async () => {
    const pending = deferred<SessionResult>();
    mocks.getSession.mockReturnValueOnce(pending.promise).mockResolvedValue(result('user-b'));
    render();
    const oldCallback = mocks.authCallback!;
    windowTarget.dispatchEvent(new Event('focus'));
    render('user-b');
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    oldCallback('SIGNED_OUT', null);
    pending.resolve(result(null));
    windowTarget.dispatchEvent(new Event('focus'));
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    emit('SIGNED_IN', 'user-a');
    expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('SessionKeeper lifecycle and cleanup', () => {
  it('throttles bursts and revives on visibility, focus, online and restored pages', async () => {
    render();
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.getSession).not.toHaveBeenCalled();
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    for (const event of ['focus', 'online', 'pageshow']) windowTarget.dispatchEvent(new Event(event));
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    for (const [index, event] of ['focus', 'online', 'pageshow'].entries()) {
      vi.setSystemTime((index + 1) * 30_000);
      windowTarget.dispatchEvent(new Event(event));
      await settle();
    }
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(4);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('unsubscribes and ignores pending reads, queued auth events and browser events after unmount', async () => {
    const pending = deferred<SessionResult>();
    mocks.getSession.mockReturnValue(pending.promise);
    render();
    windowTarget.dispatchEvent(new Event('focus'));
    const callback = mocks.authCallback!;
    unmount();
    pending.resolve(result(null));
    callback('SIGNED_OUT', null);
    vi.setSystemTime(30_000);
    for (const event of ['focus', 'online', 'pageshow']) windowTarget.dispatchEvent(new Event(event));
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });

  it('revives on native resume and removes its listener on unmount', async () => {
    mocks.isNative.mockReturnValue(true);
    render();
    await nativeReady();
    expect(mocks.addListener).toHaveBeenCalledWith('resume', expect.any(Function));
    const resume = mocks.addListener.mock.calls[0][1] as () => void;
    expect(mocks.getSession).toHaveBeenCalledTimes(1); // shared initial bootstrap
    vi.setSystemTime(30_000);
    resume();
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    unmount();
    expect(mocks.removeResume).toHaveBeenCalledTimes(1);
    vi.setSystemTime(30_000);
    resume();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it('removes a native listener that finishes registering after unmount', async () => {
    const registration = deferred<{ remove: () => Promise<void> }>();
    mocks.isNative.mockReturnValue(true);
    mocks.addListener.mockReturnValue(registration.promise);
    render();
    await nativeReady();
    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    unmount();
    registration.resolve({ remove: mocks.removeResume });
    await settle();
    expect(mocks.removeResume).toHaveBeenCalledTimes(1);
  });

  it('keeps browser lifecycle recovery available when the native plugin cannot register', async () => {
    mocks.isNative.mockReturnValue(true);
    mocks.addListener.mockRejectedValue(new Error('plugin unavailable'));
    render();
    await nativeReady();
    vi.setSystemTime(30_000);
    windowTarget.dispatchEvent(new Event('online'));
    await settle();
    expect(mocks.getSession).toHaveBeenCalledTimes(2); // bootstrap plus lifecycle recovery
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });
});
