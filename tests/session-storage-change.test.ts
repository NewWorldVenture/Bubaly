import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionStorageChangeRevision, notifySessionStorageChanged, subscribeSessionStorageChanges } from '@/lib/auth/session-change';

const KEY = 'bubaly:session-storage-change';
const disposers: Array<() => void> = [];
let target: EventTarget;
let channels: Channel[];
let setItem: ReturnType<typeof vi.fn>;
let removeItem: ReturnType<typeof vi.fn>;
class Channel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(readonly name: string) { channels.push(this); }
}
function subscribe(callback = vi.fn()) {
  disposers.push(subscribeSessionStorageChanges(callback));
  return callback;
}
function storage(key: string, value: string | null) {
  target.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: value }));
}
beforeEach(() => {
  target = new EventTarget(); channels = []; setItem = vi.fn(); removeItem = vi.fn();
  vi.stubGlobal('window', Object.assign(target, { BroadcastChannel: Channel, localStorage: { setItem, removeItem } }));
});
afterEach(() => { disposers.splice(0).forEach(stop => stop()); vi.unstubAllGlobals(); });

describe('explicit session storage change transport', () => {
  it('invalidates same-tab observers synchronously and sends only a reread nonce through both transports', () => {
    const nativeRandom = Math.random, nativeNow = Date.now;
    const random = vi.spyOn(Math, 'random').mockReturnValue(5e-7);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const revision = getSessionStorageChangeRevision(), callback = subscribe();
      notifySessionStorageChanged();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(getSessionStorageChangeRevision()).toBe(revision + 1);
      expect(channels).toHaveLength(1);
      expect(channels[0].name).toBe(KEY);
      const message = channels[0].postMessage.mock.calls[0][0];
      expect(message.split(':')).toEqual(['reread-session', '1700000000000', expect.stringMatching(/^[0-9]+$/), '5e-7']);
      expect(message.length).toBeLessThanOrEqual(160);
      expect(setItem).toHaveBeenCalledWith(KEY, message);
      expect(removeItem).toHaveBeenCalledWith(KEY);
      expect(callback.mock.invocationCallOrder[0]).toBeLessThan(channels[0].postMessage.mock.invocationCallOrder[0]);
      expect(callback.mock.invocationCallOrder[0]).toBeLessThan(setItem.mock.invocationCallOrder[0]);
    } finally { random.mockRestore(); now.mockRestore(); }
    expect(Math.random).toBe(nativeRandom);
    expect(Date.now).toBe(nativeNow);
  });
  it('deduplicates a peer notification received through both transports', () => {
    const callback = subscribe();
    channels[0].onmessage!({ data: 'reread-session:peer-once' });
    storage(KEY, 'reread-session:peer-once'); storage(KEY, null);
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('a local reread reaches same-tab observers without a peer rebroadcast loop', () => {
    const callback = subscribe(), revision = getSessionStorageChangeRevision();
    notifySessionStorageChanged({ broadcast: false });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(getSessionStorageChangeRevision()).toBe(revision + 1);
    expect(channels[0].postMessage).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
  it('observes storage-only peers while BroadcastChannel works locally', () => {
    const callback = subscribe();
    storage(KEY, 'reread-session:storage-only');
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('uses storage events when BroadcastChannel construction is denied', () => {
    Object.assign(target, { BroadcastChannel: class { constructor() { throw new Error('denied'); } } });
    const callback = subscribe(); notifySessionStorageChanged();
    expect(callback).toHaveBeenCalledTimes(1); expect(setItem).toHaveBeenCalledTimes(1);
    storage(KEY, 'reread-session:denied-channel-peer');
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it('contains denied transports while preserving same-tab reconciliation', () => {
    const callback = subscribe();
    channels[0].postMessage.mockImplementation(() => { throw new Error('channel closed'); });
    setItem.mockImplementation(() => { throw new Error('storage denied'); });
    expect(() => notifySessionStorageChanged()).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('a throwing reader cannot prevent later readers or either transport from reconciling', () => {
    subscribe(vi.fn(() => { throw new Error('reader unmounted'); }));
    const callback = subscribe();
    expect(() => notifySessionStorageChanged()).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(channels[0].postMessage).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledTimes(1);
  });
  it('contains transport close failures both at final disposal and temporary publication', () => {
    subscribe(); channels[0].close.mockImplementation(() => { throw new Error('close failed'); });
    expect(() => disposers.shift()!()).not.toThrow();
    Object.assign(target, { BroadcastChannel: class extends Channel {
      constructor(name: string) { super(name); this.close.mockImplementation(() => { throw new Error('close failed'); }); }
    } });
    expect(() => notifySessionStorageChanged()).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
  });
  it('ignores unrelated, oversized and authoritative-looking messages', () => {
    const callback = subscribe();
    for (const data of [null, undefined, {}, { event: 'SIGNED_OUT' }, 'SIGNED_OUT', 'reread-session:', `reread-session:${'x'.repeat(160)}`]) channels[0].onmessage!({ data });
    storage('unrelated-preference', 'reread-session:unrelated');
    expect(callback).not.toHaveBeenCalled();
  });
  it('shares subscriptions and tears down listeners after the last consumer', () => {
    const first = subscribe(), second = subscribe(); const channel = channels[0];
    disposers.shift()!(); expect(channel.close).not.toHaveBeenCalled();
    storage(KEY, 'reread-session:one-consumer');
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
    disposers.shift()!(); expect(channel.close).toHaveBeenCalledTimes(1);
    storage(KEY, 'reread-session:no-consumers'); expect(second).toHaveBeenCalledTimes(1);
  });
  it('publishes and closes a temporary channel when no local component is mounted', () => {
    notifySessionStorageChanged();
    expect(channels).toHaveLength(1); expect(channels[0].postMessage).toHaveBeenCalledTimes(1);
    expect(channels[0].close).toHaveBeenCalledTimes(1); expect(setItem).toHaveBeenCalledTimes(1);
  });
  it('leaves server state unchanged', () => {
    vi.stubGlobal('window', undefined); const revision = getSessionStorageChangeRevision();
    const callback = subscribe(); notifySessionStorageChanged();
    expect(callback).not.toHaveBeenCalled(); expect(getSessionStorageChangeRevision()).toBe(revision);
    expect(channels).toHaveLength(0);
  });
  it.each([
    { value: 0, suffix: '0' },
    { value: 0.5, suffix: '0.5' },
    { value: 0.9999999999999999, suffix: '0.9999999999999999' },
  ])('preserves notification and peer deduplication with random suffix $suffix', ({ value, suffix }) => {
    const nativeRandom = Math.random, nativeNow = Date.now;
    const random = vi.spyOn(Math, 'random').mockReturnValue(value);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const revision = getSessionStorageChangeRevision(), callback = subscribe();
      notifySessionStorageChanged();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(getSessionStorageChangeRevision()).toBe(revision + 1);
      expect(channels).toHaveLength(1);
      expect(channels[0].name).toBe(KEY);
      expect(channels[0].postMessage).toHaveBeenCalledTimes(1);
      const message = channels[0].postMessage.mock.calls[0][0];
      expect(message.split(':')).toEqual(['reread-session', '1700000000000', expect.stringMatching(/^[0-9]+$/), suffix]);
      expect(message.length).toBeLessThanOrEqual(160);
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(setItem).toHaveBeenCalledWith(KEY, message);
      expect(removeItem).toHaveBeenCalledTimes(1);
      expect(removeItem).toHaveBeenCalledWith(KEY);
      expect(callback.mock.invocationCallOrder[0]).toBeLessThan(channels[0].postMessage.mock.invocationCallOrder[0]);
      expect(callback.mock.invocationCallOrder[0]).toBeLessThan(setItem.mock.invocationCallOrder[0]);
      channels[0].onmessage!({ data: message });
      storage(KEY, message);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(getSessionStorageChangeRevision()).toBe(revision + 1);
    } finally { random.mockRestore(); now.mockRestore(); }
    expect(Math.random).toBe(nativeRandom);
    expect(Date.now).toBe(nativeNow);
  });
});
