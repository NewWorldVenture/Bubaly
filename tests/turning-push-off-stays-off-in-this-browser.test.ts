// LIBRARY-792E01B02B68: turning push off did not stick in a browser.
//
// "On, turn off" unsubscribed the browser and deleted the server row, but the
// notification permission stays "granted", and the registrar that mounts on
// every signed-in page called subscribeWebPush() whenever it was granted. With
// no subscription left, that helper made a NEW one and it was saved: the
// device was silently enrolled again on the next page. The button also read
// "On" from the permission alone, and unsubscribeWebPush() answered a refused
// or rejected unsubscribe with the endpoint, exactly as if it had worked.
//
// Driven through the real helpers, registrar and button over a stub
// PushManager; only the browser itself is replaced.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, has, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'Zml4dHVyZS1rZXk';
  return (await import('./helpers/module-state')).createModuleState();
});

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/lib/native/capacitor', () => ({ isNative: () => false, getPlatform: () => 'web' }));

const { subscribeWebPush, unsubscribeWebPush } = await import('@/lib/push/web-client');
const { PushRegistrar } = await import('@/components/native/push-registrar');
const { EnablePushButton } = await import('@/components/native/enable-push-button');

const ENDPOINT = 'https://push.example.test/abc';
type Sub = { endpoint: string; toJSON: () => unknown; unsubscribe: () => Promise<boolean> };

/** A browser whose PushManager holds `current`, and records every subscribe. */
function browser(options: { subscribed: boolean; release?: () => Promise<boolean> }) {
  const b = { current: null as Sub | null, created: 0 };
  const make = (): Sub => ({
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: options.release ?? (async () => { b.current = null; return true; }),
  });
  if (options.subscribed) b.current = make();
  const pushManager = {
    getSubscription: async () => b.current,
    subscribe: async () => { b.created += 1; b.current = make(); return b.current; },
  };
  const navigator = { userAgent: 'fixture', serviceWorker: { ready: Promise.resolve({ pushManager }) } };
  vi.stubGlobal('navigator', navigator);
  vi.stubGlobal('window', { PushManager: class {}, Notification: {}, navigator });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
  return b;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const calls = (fetchMock: ReturnType<typeof vi.fn>, path: string) => fetchMock.mock.calls.filter(([url]) => url === path);
let fetchMock: ReturnType<typeof vi.fn>;
let store: Map<string, string>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  fetchMock = vi.fn(async () => json(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the registrar re-syncs a subscription; it never makes one', () => {
  it('a browser with permission but no subscription is not subscribed by a re-sync', async () => {
    const b = browser({ subscribed: false });
    expect(await subscribeWebPush({ existingOnly: true })).toBeNull();
    expect(b.created).toBe(0);
  });

  it('mounting a signed-in page after push was turned off registers nothing', async () => {
    const b = browser({ subscribed: false });
    render(h.hooks, createElement(PushRegistrar));
    await settle();
    await settle();
    expect(b.created).toBe(0);
    expect(calls(fetchMock, '/api/push/subscribe')).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('a subscription the browser still holds is re-synced (control)', async () => {
    const b = browser({ subscribed: true });
    render(h.hooks, createElement(PushRegistrar));
    await settle();
    await settle();
    expect(b.created).toBe(0);
    const sent = calls(fetchMock, '/api/push/subscribe');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String((sent[0][1] as RequestInit).body))).toMatchObject({ endpoint: ENDPOINT, provider: 'webpush' });
  });

  it('the explicit opt-in still creates the subscription (control)', async () => {
    const b = browser({ subscribed: false });
    expect(await subscribeWebPush()).toMatchObject({ endpoint: ENDPOINT });
    expect(b.created).toBe(1);
  });
});

describe('an unsubscribe the browser did not carry out is not reported as done', () => {
  it('a false answer rejects instead of returning the endpoint', async () => {
    browser({ subscribed: true, release: async () => false });
    await expect(unsubscribeWebPush()).rejects.toThrow();
  });

  it('a rejected unsubscribe rejects instead of returning the endpoint', async () => {
    browser({ subscribed: true, release: async () => { throw new Error('InvalidStateError'); } });
    await expect(unsubscribeWebPush()).rejects.toThrow();
  });

  it('a carried-out unsubscribe returns the endpoint to remove (control)', async () => {
    const b = browser({ subscribed: true });
    expect(await unsubscribeWebPush()).toBe(ENDPOINT);
    expect(b.current).toBeNull();
  });
});

describe('the button says what this browser holds, not what it is permitted', () => {
  const screen = () => render(h.hooks, createElement(EnablePushButton));

  it('granted permission with no subscription reads as off', async () => {
    browser({ subscribed: false });
    screen();
    await settle();
    const tree = screen();
    expect(has(tree, 'On — turn off')).toBe(false);
    expect(has(tree, 'Enable push notifications')).toBe(true);
  });

  it('granted permission with a live subscription reads as on (control)', async () => {
    browser({ subscribed: true });
    screen();
    await settle();
    expect(has(screen(), 'On — turn off')).toBe(true);
  });

  it('a browser that would not let go keeps the device, the server row and "On", and says so', async () => {
    browser({ subscribed: true, release: async () => false });
    screen();
    await settle();
    store.set('bubaly.push.device', JSON.stringify({ endpoint: ENDPOINT }));
    await click(byName(screen(), 'On — turn off'));
    const tree = screen();
    expect(has(tree, 'On — turn off')).toBe(true);
    expect(has(tree, 'Push could not be turned off for this device. Please try again.')).toBe(true);
    expect(calls(fetchMock, '/api/push/unsubscribe')).toHaveLength(0);
    expect(store.size).toBe(1);
  });

  it('turning it off and opening the next page leaves it off', async () => {
    const b = browser({ subscribed: true });
    screen();
    await settle();
    await click(byName(screen(), 'On — turn off'));
    expect(calls(fetchMock, '/api/push/unsubscribe')).toHaveLength(1);
    resetHookSlots(h.hooks); // the next page: registrar and button mount afresh
    render(h.hooks, createElement(PushRegistrar));
    await settle();
    await settle();
    expect(b.created).toBe(0);
    expect(calls(fetchMock, '/api/push/subscribe')).toHaveLength(0);
    screen();
    await settle();
    expect(has(screen(), 'On — turn off')).toBe(false);
  });
});
