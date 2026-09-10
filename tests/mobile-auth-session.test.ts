import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectAuthSession } from '../mobile/src/lib/auth-session';

type Session = { user: string; token: string };
function setup() {
  let resolve!: (value: { session: Session | null; error: unknown }) => void;
  let reject!: (error: unknown) => void;
  let event!: (name: string, session: Session | null) => void;
  const read = new Promise<{ session: Session | null; error: unknown }>((a, b) => { resolve = a; reject = b; });
  const unsubscribed = vi.fn(); const session = vi.fn(); const restoring = vi.fn(); const ready = vi.fn();
  const connection = connectAuthSession({ read: () => read, subscribe: (listener) => { event = listener; return unsubscribed; }, session, restoring, ready });
  return { connection, resolve, reject, event, session, restoring, ready, unsubscribed };
}
const stale = { user: 'old-user', token: 'old-token' };
const current = { user: 'new-user', token: 'new-token' };
const transient = { name: 'AuthRetryableFetchError', message: 'offline' };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('auth bootstrap versus newer auth events', () => {
  it.each(['SIGNED_IN', 'TOKEN_REFRESHED', 'SIGNED_OUT', 'INITIAL_SESSION'])('a late bootstrap session cannot overwrite %s', async (eventName) => {
    const h = setup(); const next = eventName === 'SIGNED_OUT' ? null : current;
    h.event(eventName, next); h.resolve({ session: stale, error: null }); await h.connection.settled;
    expect(h.session.mock.calls).toEqual([[next]]); expect(h.restoring.mock.calls).toEqual([[false]]);
    expect(h.ready).toHaveBeenLastCalledWith(true);
  });
  it.each(['SIGNED_IN', 'TOKEN_REFRESHED', 'SIGNED_OUT'])('a late bootstrap rejection cannot undo %s', async (eventName) => {
    const h = setup(); h.event(eventName, eventName === 'SIGNED_OUT' ? null : current);
    h.reject(transient); await h.connection.settled;
    expect(h.restoring.mock.calls).toEqual([[false]]); expect(h.session).toHaveBeenCalledTimes(1);
  });
  it('an INITIAL_SESSION null preserves transient bootstrap evidence and later refresh recovers', async () => {
    const h = setup(); h.event('INITIAL_SESSION', null); h.resolve({ session: null, error: transient }); await h.connection.settled;
    expect(h.restoring).toHaveBeenLastCalledWith(true); expect(h.session).toHaveBeenLastCalledWith(null);
    h.event('TOKEN_REFRESHED', current); expect(h.session).toHaveBeenLastCalledWith(current); expect(h.restoring).toHaveBeenLastCalledWith(false);
  });
  it('an INITIAL_SESSION null also preserves a rejected offline bootstrap', async () => {
    const h = setup(); h.event('INITIAL_SESSION', null); h.reject(transient); await h.connection.settled;
    expect(h.restoring).toHaveBeenLastCalledWith(true); expect(h.ready).toHaveBeenLastCalledWith(true);
  });
  it('explicit sign-out clears an existing restoring state; a later initial null does not revive it', async () => {
    const h = setup(); h.resolve({ session: null, error: transient }); await h.connection.settled;
    h.event('SIGNED_OUT', null); h.event('INITIAL_SESSION', null);
    expect(h.restoring.mock.calls).toEqual([[true], [false]]); expect(h.session).toHaveBeenLastCalledWith(null);
  });
  it('a delayed non-null initial event cannot revive the account after explicit sign-out', async () => {
    const h = setup(); h.event('SIGNED_OUT', null); h.event('INITIAL_SESSION', stale);
    h.resolve({ session: stale, error: null }); await h.connection.settled;
    expect(h.session.mock.calls).toEqual([[null]]); expect(h.restoring.mock.calls).toEqual([[false]]);
  });
  it('a settled signed-out bootstrap with no error does not claim to be restoring', async () => {
    const h = setup(); h.resolve({ session: null, error: null }); await h.connection.settled;
    expect(h.session).toHaveBeenLastCalledWith(null); expect(h.restoring).toHaveBeenLastCalledWith(false);
  });
  it('unmount unsubscribes and suppresses deferred bootstrap and subscription callbacks', async () => {
    const h = setup(); h.connection.dispose(); h.resolve({ session: stale, error: null }); h.event('SIGNED_IN', current); await h.connection.settled;
    expect(h.unsubscribed).toHaveBeenCalledTimes(1); expect(h.session).not.toHaveBeenCalled(); expect(h.ready).not.toHaveBeenCalled();
  });
});

describe('unavailable mobile session recovery', () => {
  type Result = { session: Session | null; error: unknown };
  function recovery(read: () => Promise<Result>) {
    let event!: (name: string, session: Session | null) => void;
    const session = vi.fn(); const restoring = vi.fn(); const ready = vi.fn(); const unsubscribe = vi.fn();
    const connection = connectAuthSession({ read, subscribe: listener => { event = listener; return unsubscribe; }, session, restoring, ready });
    return { connection, event, session, restoring, ready, unsubscribe };
  }
  function deferred() {
    let resolve!: (result: Result) => void; let reject!: (error: unknown) => void;
    const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  it.each(['SIGNED_OUT', 'INITIAL_SESSION'])('a synchronous %s event takes precedence over bootstrap', async (event) => {
    const next = event === 'SIGNED_OUT' ? null : current;
    const read = vi.fn<() => Promise<Result>>().mockResolvedValue({ session: stale, error: null });
    const session = vi.fn();
    const connection = connectAuthSession({ read, subscribe: listener => { listener(event, next); return vi.fn(); }, session, restoring: vi.fn(), ready: vi.fn() });
    await connection.settled;
    expect(read).not.toHaveBeenCalled(); expect(session.mock.calls).toEqual([[next]]);
    connection.dispose();
  });
  it('restores a readable session on the timer without waiting for a token-refresh event', async () => {
    const read = vi.fn<() => Promise<Result>>()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({ session: current, error: null });
    const h = recovery(read); await h.connection.settled;
    expect(h.restoring).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.session).toHaveBeenLastCalledWith(current); expect(h.restoring).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('foreground recovery can restore a session before the timer elapses', async () => {
    const read = vi.fn<() => Promise<Result>>()
      .mockResolvedValueOnce({ session: null, error: transient })
      .mockResolvedValue({ session: current, error: null });
    const h = recovery(read); await h.connection.settled; await h.connection.retry();
    expect(h.session).toHaveBeenLastCalledWith(current); expect(h.restoring).toHaveBeenLastCalledWith(false);
    expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces concurrent foreground and timer reads while recovery is pending', async () => {
    const pending = deferred();
    const read = vi.fn<() => Promise<Result>>().mockRejectedValueOnce(transient).mockImplementation(() => pending.promise);
    const h = recovery(read); await h.connection.settled;
    const first = h.connection.retry(); const second = h.connection.retry();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(2); expect(first).toBe(second);
    pending.resolve({ session: current, error: null }); await first;
    expect(h.session).toHaveBeenLastCalledWith(current); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps retrying transient failures and stops after a definitive signed-out result', async () => {
    const read = vi.fn<() => Promise<Result>>()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ session: null, error: transient })
      .mockResolvedValue({ session: null, error: null });
    const h = recovery(read); await h.connection.settled;
    await vi.advanceTimersByTimeAsync(30_000); expect(h.restoring).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(30_000); expect(h.restoring).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3); expect(h.session).toHaveBeenLastCalledWith(null);
  });
  it.each(['SIGNED_IN', 'TOKEN_REFRESHED', 'SIGNED_OUT'])('a late recovery cannot overwrite %s', async (eventName) => {
    const pending = deferred();
    const read = vi.fn<() => Promise<Result>>().mockRejectedValueOnce(transient).mockImplementation(() => pending.promise);
    const h = recovery(read); await h.connection.settled;
    const retry = h.connection.retry(); await Promise.resolve();
    const next = eventName === 'SIGNED_OUT' ? null : current;
    h.event(eventName, next); pending.resolve({ session: stale, error: null }); await retry;
    expect(h.session.mock.calls).toEqual([[next]]); expect(h.restoring.mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a late recovery rejection cannot restart restoring after explicit sign-out', async () => {
    const pending = deferred();
    const read = vi.fn<() => Promise<Result>>().mockRejectedValueOnce(transient).mockImplementation(() => pending.promise);
    const h = recovery(read); await h.connection.settled;
    const retry = h.connection.retry(); await Promise.resolve();
    h.event('SIGNED_OUT', null); pending.reject(transient); await retry;
    expect(h.restoring.mock.calls).toEqual([[true], [false]]);
    await h.connection.retry(); await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('disposal cancels future reads and suppresses a pending recovery result', async () => {
    const pending = deferred();
    const read = vi.fn<() => Promise<Result>>().mockRejectedValueOnce(transient).mockImplementation(() => pending.promise);
    const h = recovery(read); await h.connection.settled;
    const retry = h.connection.retry(); await Promise.resolve();
    h.connection.dispose(); pending.resolve({ session: current, error: null }); await retry;
    await h.connection.retry(); await vi.advanceTimersByTimeAsync(120_000);
    expect(h.session).not.toHaveBeenCalled(); expect(h.restoring.mock.calls).toEqual([[true]]);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not schedule recovery for a valid session, explicit absence, or permanent failure', async () => {
    for (const result of [{ session: current, error: null }, { session: null, error: null }, { session: null, error: { status: 401 } }]) {
      const read = vi.fn<() => Promise<Result>>().mockResolvedValue(result);
      const h = recovery(read); await h.connection.settled; await h.connection.retry();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(read).toHaveBeenCalledTimes(1); expect(h.restoring).toHaveBeenLastCalledWith(false);
      h.connection.dispose();
    }
  });
});
