import { describe, expect, it, vi } from 'vitest';
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
