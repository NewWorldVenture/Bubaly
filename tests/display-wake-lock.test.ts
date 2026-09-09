import { describe, expect, it, vi } from 'vitest';
import {
  createWakeLock, isWakeLockSupported,
  type WakeLockDocumentLike, type WakeLockNavigatorLike, type WakeLockSentinelLike, type WakeLockState,
} from '@/lib/display/wake-lock';

// The kitchen display's screen lock. The whole contract is "never throws, never
// rejects, and says what actually happened" — a wall display cannot afford an
// exception from an API that is absent on one tablet, refuses on another, and
// silently releases itself on every tab switch.

type RequestBehaviour = 'grant' | 'reject' | 'nothing';

function fakeSentinel() {
  const listeners: (() => void)[] = [];
  const sentinel: WakeLockSentinelLike & { releaseCalls: number; fireRelease: () => void } = {
    released: false,
    releaseCalls: 0,
    release: async () => { sentinel.releaseCalls += 1; sentinel.released = true; },
    addEventListener: (_type, listener) => { listeners.push(listener); },
    removeEventListener: (_type, listener) => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
    fireRelease: () => { for (const listener of [...listeners]) listener(); },
  };
  return sentinel;
}

function fakeNavigator(behaviour: RequestBehaviour = 'grant') {
  const sentinels: ReturnType<typeof fakeSentinel>[] = [];
  const request = vi.fn(async (type: 'screen') => {
    expect(type).toBe('screen');
    if (behaviour === 'reject') throw new Error('NotAllowedError');
    if (behaviour === 'nothing') return undefined as unknown as WakeLockSentinelLike;
    const sentinel = fakeSentinel();
    sentinels.push(sentinel);
    return sentinel;
  });
  return { nav: { wakeLock: { request } } as WakeLockNavigatorLike, request, sentinels };
}

function fakeDocument(visibilityState = 'visible') {
  const listeners = new Map<string, (() => void)[]>();
  const doc: WakeLockDocumentLike & { fire: (type: string) => void; count: (type: string) => number; visibilityState: string } = {
    visibilityState,
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
    fire: (type) => { for (const listener of [...(listeners.get(type) ?? [])]) listener(); },
    count: (type) => (listeners.get(type) ?? []).length,
  };
  return doc;
}

describe('isWakeLockSupported', () => {
  it('is false for anything without a callable request()', () => {
    expect(isWakeLockSupported(null)).toBe(false);
    expect(isWakeLockSupported(undefined)).toBe(false);
    expect(isWakeLockSupported({})).toBe(false);
    expect(isWakeLockSupported({ wakeLock: null })).toBe(false);
    expect(isWakeLockSupported({ wakeLock: {} })).toBe(false);
    expect(isWakeLockSupported({ wakeLock: { request: 'yes' } })).toBe(false);
  });

  it('is true only when navigator.wakeLock.request is a function', () => {
    expect(isWakeLockSupported({ wakeLock: { request: async () => ({}) } })).toBe(true);
  });

  it('does not throw when reading the property throws (a hardened browser)', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'wakeLock', { get() { throw new Error('blocked'); } });
    expect(() => isWakeLockSupported(hostile)).not.toThrow();
    expect(isWakeLockSupported(hostile)).toBe(false);
  });
});

describe('createWakeLock on a browser without the API', () => {
  it('reports unsupported and never attempts, throws or rejects', async () => {
    const doc = fakeDocument();
    const lock = createWakeLock({ navigator: {}, document: doc });
    expect(lock.supported).toBe(false);
    expect(lock.state()).toBe('unsupported');
    await expect(lock.acquire()).resolves.toBe('unsupported');
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(lock.stop()).resolves.toBeUndefined();
    expect(lock.state()).toBe('unsupported');
  });

  it('survives a missing navigator AND a missing document', async () => {
    const lock = createWakeLock({ navigator: null, document: null });
    await expect(lock.acquire()).resolves.toBe('unsupported');
    await expect(lock.stop()).resolves.toBeUndefined();
  });
});

describe('createWakeLock on a browser with the API', () => {
  it('acquires the screen lock and reports active', async () => {
    const { nav, request } = fakeNavigator();
    const seen: WakeLockState[] = [];
    const lock = createWakeLock({ navigator: nav, document: fakeDocument(), onChange: (s) => seen.push(s) });
    expect(lock.state()).toBe('idle');
    await expect(lock.acquire()).resolves.toBe('active');
    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.state()).toBe('active');
    expect(seen).toEqual(['active']);
  });

  it('reports blocked — not an exception — when the browser refuses', async () => {
    const { nav } = fakeNavigator('reject');
    const lock = createWakeLock({ navigator: nav, document: fakeDocument() });
    await expect(lock.acquire()).resolves.toBe('blocked');
    expect(lock.state()).toBe('blocked');
  });

  it('reports blocked when request resolves with nothing at all', async () => {
    const { nav } = fakeNavigator('nothing');
    const lock = createWakeLock({ navigator: nav, document: fakeDocument() });
    await expect(lock.acquire()).resolves.toBe('blocked');
  });

  it('collapses concurrent acquires into one request', async () => {
    const { nav, request } = fakeNavigator();
    const lock = createWakeLock({ navigator: nav, document: fakeDocument() });
    const [a, b] = await Promise.all([lock.acquire(), lock.acquire()]);
    expect([a, b]).toEqual(['active', 'active']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not ask again while it already holds a live sentinel', async () => {
    const { nav, request } = fakeNavigator();
    const lock = createWakeLock({ navigator: nav, document: fakeDocument() });
    await lock.acquire();
    await lock.acquire();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('falls back to idle when the browser releases the sentinel by itself', async () => {
    const { nav, sentinels } = fakeNavigator();
    const lock = createWakeLock({ navigator: nav, document: fakeDocument() });
    await lock.acquire();
    sentinels[0].released = true;
    sentinels[0].fireRelease();
    expect(lock.state()).toBe('idle');
  });

  it('releases the sentinel it holds, and a failing release() does not throw', async () => {
    const { nav, sentinels } = fakeNavigator();
    const lock = createWakeLock({ navigator: nav, document: fakeDocument() });
    await lock.acquire();
    sentinels[0].release = async () => { throw new Error('already gone'); };
    await expect(lock.release()).resolves.toBeUndefined();
    expect(lock.state()).toBe('idle');
  });
});

describe('re-acquiring across visibilitychange (the reason this module exists)', () => {
  it('asks again when the tab becomes visible, because the browser drops the lock on hide', async () => {
    const { nav, request } = fakeNavigator();
    const doc = fakeDocument('visible');
    const lock = createWakeLock({ navigator: nav, document: doc });
    await lock.acquire();
    expect(request).toHaveBeenCalledTimes(1);

    // Hidden: the browser has taken the lock away.
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(lock.state()).toBe('idle');
    expect(request).toHaveBeenCalledTimes(1);

    // Visible again: ask for it back.
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.state()).toBe('active');
  });

  it('does not re-acquire a lock the caller deliberately released', async () => {
    const { nav, request } = fakeNavigator();
    const doc = fakeDocument('visible');
    const lock = createWakeLock({ navigator: nav, document: doc });
    await lock.acquire();
    await lock.release();

    doc.fire('visibilitychange');
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('detaches its listener on stop(), so an unmounted display holds nothing', async () => {
    const { nav, request, sentinels } = fakeNavigator();
    const doc = fakeDocument('visible');
    const lock = createWakeLock({ navigator: nav, document: doc });
    expect(doc.count('visibilitychange')).toBe(1);

    await lock.acquire();
    await lock.stop();

    expect(doc.count('visibilitychange')).toBe(0);
    expect(sentinels[0].releaseCalls).toBe(1);
    doc.fire('visibilitychange');
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('the listener contract', () => {
  it('reports every transition once, and a throwing listener cannot break the kiosk', async () => {
    const { nav } = fakeNavigator();
    const doc = fakeDocument();
    const seen: WakeLockState[] = [];
    const lock = createWakeLock({
      navigator: nav,
      document: doc,
      onChange: (state) => { seen.push(state); throw new Error('a careless subscriber'); },
    });
    await expect(lock.acquire()).resolves.toBe('active');
    await expect(lock.release()).resolves.toBeUndefined();
    expect(seen).toEqual(['active', 'idle']);
  });
});
