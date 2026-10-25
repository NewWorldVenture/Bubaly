// A saved sign-in this device cannot read is not a reconnect (N11).
//
// On a cold start, a missing chunk, a corrupt header or an invalidated Keystore
// makes the chunked store throw `session_storage_unavailable`; the auth
// bootstrap classified it as retryable, armed a fixed 30 s retry with no cap
// and no backoff, and ReconnectingScreen said "Reconnecting…" — for a state
// nothing ever rewrites without a session, and that only "Sign out of this
// device" ends. A Supabase 5xx that never cleared showed the same spinner for
// as long as it lasted. The bootstrap now reports WHY it is restoring and for
// how many reads, backs off to a ceiling, and the screen names the storage
// case at once, escalates the network case after minutes, and makes the
// sign-out the primary action for both.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectAuthSession } from '../mobile/src/lib/auth-session';
import { RESTORE_ESCALATE_AFTER, restoreCopy, restoreReason, restoreRetryDelay, type RestoreIssue } from '../mobile/src/lib/auth-core';
import { mobileTranslate } from '../mobile/src/lib/mobile-i18n';

type Session = { user: string };
const current: Session = { user: 'new-user' };
const storage = { name: 'SessionStorageUnavailableError', code: 'session_storage_unavailable', message: 'chunk 2 of 3 is missing' };
const offline = { name: 'AuthRetryableFetchError', message: 'offline' };
const definitive = { status: 401, message: 'Invalid Refresh Token: Refresh Token Not Found' };

function connect(read: () => Promise<{ session: Session | null; error: unknown }>) {
  let event!: (name: string, session: Session | null) => void;
  const session = vi.fn(); const restoring = vi.fn(); const ready = vi.fn(); const issue = vi.fn();
  const connection = connectAuthSession({ read, subscribe: (listener) => { event = listener; return vi.fn(); }, session, restoring, ready, issue });
  return { connection, event: (name: string, next: Session | null) => event(name, next), session, restoring, ready, issue };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('why the session is still being restored', () => {
  it('names a storage failure, a network failure, and no reason for a definitive sign-out', () => {
    expect(restoreReason(storage)).toBe('storage');
    expect(restoreReason(offline)).toBe('network');
    expect(restoreReason({ status: 503, message: 'upstream' })).toBe('network');
    expect(restoreReason(definitive)).toBeNull();
    expect(restoreReason(null)).toBeNull();
  });

  it('reports the reason and the consecutive count on every failed read, and clears it on success', async () => {
    const read = vi.fn<() => Promise<{ session: Session | null; error: unknown }>>()
      .mockRejectedValueOnce(storage)
      .mockResolvedValueOnce({ session: null, error: storage })
      .mockResolvedValue({ session: current, error: null });
    const h = connect(read);
    await h.connection.settled;
    expect(h.issue.mock.calls).toEqual([[{ reason: 'storage', failures: 1 }]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.issue).toHaveBeenLastCalledWith({ reason: 'storage', failures: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.issue).toHaveBeenLastCalledWith(null);
    expect(h.session).toHaveBeenLastCalledWith(current);
    expect(h.restoring).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the issue on an explicit auth event, as it clears restoring', async () => {
    const h = connect(vi.fn().mockRejectedValue(offline));
    await h.connection.settled;
    expect(h.issue).toHaveBeenLastCalledWith({ reason: 'network', failures: 1 });
    h.event('SIGNED_IN', current);
    expect(h.issue).toHaveBeenLastCalledWith(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports no issue for a definitive signed-out answer', async () => {
    const h = connect(vi.fn().mockResolvedValue({ session: null, error: definitive }));
    await h.connection.settled;
    expect(h.issue.mock.calls).toEqual([[null]]);
    expect(h.restoring).toHaveBeenLastCalledWith(false);
  });
});

describe('the retry backs off to a ceiling instead of ticking every 30 s for ever', () => {
  it('waits 30 s, 30 s, then doubles, capped at five minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(restoreRetryDelay)).toEqual([30_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });

  it('spaces the reads of an unreadable store by that schedule', async () => {
    const read = vi.fn<() => Promise<{ session: Session | null; error: unknown }>>().mockRejectedValue(storage);
    const h = connect(read);
    await h.connection.settled;
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999); expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(120_000); expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(240_000); expect(read).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(300_000); expect(read).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(300_000); expect(read).toHaveBeenCalledTimes(8);
    expect(h.issue).toHaveBeenLastCalledWith({ reason: 'storage', failures: 8 });
    expect(vi.getTimerCount()).toBe(1);
    h.connection.dispose();
  });
});

describe('what the screen says', () => {
  it('names the unreadable sign-in after a second storage failure, escalates a long network outage, and reconnects otherwise', () => {
    expect(restoreCopy(null)).toBe('mobileAssistant.reconnecting');
    expect(restoreCopy({ reason: 'network', failures: 1 })).toBe('mobileAssistant.reconnecting');
    expect(restoreCopy({ reason: 'network', failures: RESTORE_ESCALATE_AFTER - 1 })).toBe('mobileAssistant.reconnecting');
    expect(restoreCopy({ reason: 'network', failures: RESTORE_ESCALATE_AFTER })).toBe('mobileAssistant.stillReconnecting');
    expect(restoreCopy({ reason: 'storage', failures: 1 })).toBe('mobileAssistant.reconnecting');
    expect(restoreCopy({ reason: 'storage', failures: 2 })).toBe('mobileAssistant.savedSignInUnreadable');
    // Six failures on the schedule above is about eight minutes in.
    expect([1, 2, 3, 4, 5].map(restoreRetryDelay).reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(7 * 60_000);
    expect(mobileTranslate('en-US', 'mobileAssistant.savedSignInUnreadable')).toMatch(/sign out and sign in again/i);
    expect(mobileTranslate('en-US', 'mobileAssistant.stillReconnecting')).toMatch(/sign out/i);
  });
});

describe('the actual ReconnectingScreen', () => {
  // Web CI has no native dependencies. Keep native UI imports dynamic so the web
  // typecheck does not absorb the separate mobile TS project; mobile CI checks it.
  const screenModule = '../mobile/src/components/ReconnectingScreen';
  const mobileRequire = createRequire(new URL('../mobile/package.json', import.meta.url));
  const resolveNative = (name: string) => { try { return mobileRequire.resolve(name); } catch { return name; } };
  let issue: RestoreIssue | null = null;
  const slots: unknown[] = []; let cursor = 0;
  type Node = { type: unknown; props: Record<string, unknown> };
  const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value ? [value as Node, ...nodes((value as Node).props.children)] : [];

  beforeEach(async () => {
    slots.length = 0; cursor = 0; issue = null;
    vi.doMock(resolveNative('react'), async () => ({ ...await vi.importActual<Record<string, unknown>>(resolveNative('react')),
      useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next: unknown) => { slots[i] = next; }]; } }));
    vi.doMock(resolveNative('react-native'), () => ({ View: 'View', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' }));
    for (const component of ['AppText', 'Button']) vi.doMock(`../mobile/src/components/${component}`, () => ({ [component]: component }));
    vi.doMock('../mobile/src/theme/theme', () => ({ useTheme: () => ({ colors: { danger: 'red', brand: 'purple' }, spacing: [0, 4, 8, 12, 16, 20] }) }));
    vi.doMock('../mobile/src/lib/auth', () => ({ useAuth: () => ({ signOut: vi.fn(), get restoreIssue() { return issue; } }) }));
    vi.doMock('../mobile/src/lib/mobile-i18n', async () => ({ ...await vi.importActual<Record<string, unknown>>('../mobile/src/lib/mobile-i18n'), deviceLocale: () => 'en-US' }));
  });

  it('shows the reconnect copy with a quiet sign-out while the network is the reason', async () => {
    issue = { reason: 'network', failures: 3 };
    const { ReconnectingScreen } = await import(screenModule);
    const tree = nodes(ReconnectingScreen());
    expect(tree.some((n) => n.type === 'ActivityIndicator')).toBe(true);
    expect(tree.find((n) => n.type === 'AppText')?.props.children).toBe(mobileTranslate('en-US', 'mobileAssistant.reconnecting'));
    expect(tree.find((n) => n.type === 'Button')?.props.variant).toBe('ghost');
  });

  it('says the saved sign-in cannot be read on this device, and makes signing out the primary action', async () => {
    issue = { reason: 'storage', failures: 2 };
    const { ReconnectingScreen } = await import(screenModule);
    const tree = nodes(ReconnectingScreen());
    expect(tree.some((n) => n.type === 'ActivityIndicator')).toBe(false);
    expect(tree.find((n) => n.type === 'AppText')?.props.children).toBe(mobileTranslate('en-US', 'mobileAssistant.savedSignInUnreadable'));
    expect(tree.find((n) => n.type === 'Button')?.props.variant).toBe('primary');
    expect(JSON.stringify(tree)).not.toContain('chunk 2 of 3');
  });

  it('after minutes offline says Bubaly still cannot be reached, keeps trying, and offers the sign-out as the way out', async () => {
    issue = { reason: 'network', failures: RESTORE_ESCALATE_AFTER };
    const { ReconnectingScreen } = await import(screenModule);
    const tree = nodes(ReconnectingScreen());
    expect(tree.some((n) => n.type === 'ActivityIndicator')).toBe(true);
    expect(tree.find((n) => n.type === 'AppText')?.props.children).toBe(mobileTranslate('en-US', 'mobileAssistant.stillReconnecting'));
    expect(tree.find((n) => n.type === 'Button')?.props.variant).toBe('primary');
  });
});
