import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSessionSnapshot } from '@/lib/auth/browser-session-storage';
import { captureSignOutIntent, isBrowserSignedOut, signOutBrowserSession } from '@/lib/auth/browser-signout';

const mock = vi.hoisted(() => ({ capture: vi.fn(), clear: vi.fn(), notify: vi.fn(), purge: vi.fn(), revoke: vi.fn(), realtime: vi.fn() }));
vi.mock('@/lib/auth/browser-session-storage', () => ({ captureBrowserSessionSnapshot: mock.capture, clearBrowserSessionSnapshot: mock.clear }));
vi.mock('@/lib/auth/session-change', () => ({ notifySessionStorageChanged: mock.notify }));
vi.mock('@/lib/auth/revoke-session', () => ({ revokeSessionToken: mock.revoke }));
vi.mock('@/lib/offline/cache', () => ({ clearAllCache: mock.purge }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ realtime: { setAuth: mock.realtime } }) }));
const A: BrowserSessionSnapshot = { storageKey: 'sb-fixture-auth-token', cookies: [{ name: 'sb-fixture-auth-token', value: 'synthetic-A-cookie' }],
  generation: '', accessToken: 'synthetic-A-token', userId: 'user-A', sessionId: 'session-A' };
let current: BrowserSessionSnapshot | null;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
  current = structuredClone(A);
  mock.capture.mockImplementation(() => current);
  mock.clear.mockImplementation(() => { current = null; return true; });
  mock.revoke.mockResolvedValue('confirmed');
  mock.realtime.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('explicit logout belongs to the intended browser session', () => {
  it('clears locally and signals before waiting for captured-token revocation', async () => {
    let finish!: (value: string) => void;
    mock.revoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const intent = captureSignOutIntent()!;
    const result = signOutBrowserSession(intent);
    expect(result.status).toBe('signed-out');
    expect(current).toBeNull();
    expect(mock.clear).toHaveBeenCalledWith(A);
    expect(mock.purge).toHaveBeenCalledTimes(1);
    expect(mock.notify).toHaveBeenCalledTimes(1);
    expect(mock.realtime).toHaveBeenCalledWith('synthetic-public-key');
    expect(mock.revoke).toHaveBeenCalledWith('synthetic-A-token');
    current = { ...A, userId: 'user-B', sessionId: 'session-B' };
    finish('confirmed');
    expect(await result.revocation).toBe('confirmed');
    expect(current.userId).toBe('user-B');
    expect(mock.clear).toHaveBeenCalledTimes(1);
    expect(mock.notify).toHaveBeenCalledTimes(1);
    expect(isBrowserSignedOut()).toBe(false);
  });
  it('allows normal same-session rotation between opening confirmation and submitting', () => {
    const intent = captureSignOutIntent()!;
    current = { ...A, accessToken: 'rotated-A-token', cookies: [{ name: A.storageKey, value: 'rotated-A-cookie' }] };
    expect(signOutBrowserSession(intent).status).toBe('signed-out');
    expect(mock.revoke).toHaveBeenCalledWith('rotated-A-token');
  });
  it.each([{ userId: 'user-B' }, { sessionId: 'new-session-A' }])('leaves a replacement intact: %s', change => {
    const intent = captureSignOutIntent()!;
    current = { ...A, ...change };
    expect(signOutBrowserSession(intent).status).toBe('session-changed');
    expect(mock.clear).not.toHaveBeenCalled();
    expect(mock.purge).not.toHaveBeenCalled();
    expect(mock.revoke).not.toHaveBeenCalled();
  });
  it('does not publish or revoke if storage changed at the compare-and-clear boundary', () => {
    mock.clear.mockReturnValue(false);
    expect(signOutBrowserSession(captureSignOutIntent()!).status).toBe('session-changed');
    expect(mock.purge).not.toHaveBeenCalled();
    expect(mock.notify).not.toHaveBeenCalled();
    expect(mock.revoke).not.toHaveBeenCalled();
  });
  it('does not claim logout when cookie writes are refused', () => {
    mock.clear.mockImplementation(() => { throw new Error('Fixture cookie writes blocked'); });
    expect(signOutBrowserSession(captureSignOutIntent()!).status).toBe('unavailable');
    expect(mock.notify).not.toHaveBeenCalled();
    expect(mock.revoke).not.toHaveBeenCalled();
  });
  it('does not confuse denied cookie reads with an absent session', () => {
    mock.capture.mockImplementation(() => { throw new Error('Fixture cookie reads blocked'); });
    expect(captureSignOutIntent()).toBeNull();
    expect(isBrowserSignedOut()).toBe(false);
    expect(signOutBrowserSession({ kind: 'empty' }).status).toBe('unavailable');
  });
  it('advances the storage guard even when the intended session is already absent', async () => {
    current = null;
    const result = signOutBrowserSession(captureSignOutIntent()!);
    expect(result.status).toBe('signed-out');
    expect(mock.clear).toHaveBeenCalledWith(null);
    expect(await result.revocation).toBe('confirmed');
    expect(mock.revoke).not.toHaveBeenCalled();
  });
  it('can clear readable malformed credentials without inventing provider confirmation', async () => {
    current = { ...A, accessToken: null, userId: null, sessionId: null };
    const result = signOutBrowserSession(captureSignOutIntent()!);
    expect(result.status).toBe('signed-out');
    expect(await result.revocation).toBe('unconfirmed');
    expect(mock.revoke).not.toHaveBeenCalled();
  });
  it('finishes local logout if the intended session was already removed', () => {
    const intent = captureSignOutIntent()!;
    current = null;
    expect(signOutBrowserSession(intent).status).toBe('signed-out');
    expect(mock.clear).toHaveBeenCalledWith(null);
    expect(mock.revoke).not.toHaveBeenCalled();
  });
  it('uses exact bytes when no stable session identity is available', () => {
    current = { ...A, sessionId: null };
    const intent = captureSignOutIntent()!;
    current = { ...current, cookies: [{ name: A.storageKey, value: 'new-cookie' }] };
    expect(signOutBrowserSession(intent).status).toBe('session-changed');
    expect(mock.clear).not.toHaveBeenCalled();
  });
  it('completes a matched server POST without a second provider operation', async () => {
    const result = signOutBrowserSession(captureSignOutIntent()!, { revoke: false, revocation: 'unconfirmed' });
    expect(result.status).toBe('signed-out');
    expect(await result.revocation).toBe('unconfirmed');
    expect(mock.revoke).not.toHaveBeenCalled();
  });
});
