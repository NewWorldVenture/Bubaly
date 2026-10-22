// A16 — "Enable push" said On when the server refused the device.
//
// /api/push/subscribe deliberately refuses a device it cannot scope or save
// (503, 500), one whose endpoint it will not POST to (400) and a flood (429),
// so that the client is not told it worked (C1-S9-39). The button ignored the
// answer — `if (res.ok) rememberPushDevice(payload); setState('on')` — and a
// rejected fetch left it spinning on "busy". Turning push off ignored the
// unsubscribe answer the same way, and /api/push/test let a consent-read
// failure escape as an unhandled 500 the button called a network error.
//
// Driven through the real button on hook slots, and the real test route.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const dev = vi.hoisted(() => ({
  subscribe: vi.fn(), unsubscribe: vi.fn(), remember: vi.fn(), forget: vi.fn(),
  send: vi.fn(), configured: vi.fn(),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/lib/native/capacitor', () => ({ isNative: () => false }));
vi.mock('@/lib/push/web-client', () => ({
  webPushSupported: () => true, VAPID_PUBLIC_KEY: 'fixture-key',
  subscribeWebPush: dev.subscribe, unsubscribeWebPush: dev.unsubscribe,
}));
vi.mock('@/lib/push/device-registration', () => ({ rememberPushDevice: dev.remember, forgetPushDevice: dev.forget }));
// The test route's collaborators: the signed-in user, the limiter and the sender.
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUser: async () => ({ id: 'u-1' }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/push', async (original) => ({
  ...await original<typeof import('@/lib/server/push')>(),
  sendPushToUser: dev.send, pushConfigured: dev.configured,
}));

const { EnablePushButton } = await import('@/components/native/enable-push-button');
const { POST: sendTestPush } = await import('@/app/api/push/test/route');
const { PushPreparationError } = await import('@/lib/server/push');

const PAYLOAD = { platform: 'web', provider: 'webpush', endpoint: 'https://push.example.test/abc', p256dh: 'p', auth: 'a' };
const screen = () => render(h.hooks, createElement(EnablePushButton));
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  for (const fn of Object.values(dev)) fn.mockReset();
  dev.subscribe.mockResolvedValue(PAYLOAD);
  dev.unsubscribe.mockResolvedValue(PAYLOAD.endpoint);
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('turning push on', () => {
  it.each([[503, 'This device could not be registered.'], [500, 'Could not save.'], [400, 'Invalid web push subscription'], [429, 'Too many.']])(
    'a %i from the server leaves it off, says why, and remembers no device', async (status, error) => {
      fetchMock.mockResolvedValue(json(status, { error }));
      await click(byName(screen(), 'Enable push notifications'));
      const tree = screen();
      expect(has(tree, 'On — turn off')).toBe(false);
      expect(has(tree, error)).toBe(true);
      expect(byName(tree, 'Enable push notifications').props.disabled).toBe(false);
      expect(dev.remember).not.toHaveBeenCalled();
    });

  it('a fetch that never reached the server is not left spinning on "busy"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await click(byName(screen(), 'Enable push notifications'));
    const tree = screen();
    expect(byName(tree, 'Enable push notifications').props.disabled).toBe(false);
    expect(has(tree, 'Push could not be turned on for this device. Please try again.')).toBe(true);
  });

  it('an accepted registration is On, and the device is remembered (control)', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    await click(byName(screen(), 'Enable push notifications'));
    expect(has(screen(), 'On — turn off')).toBe(true);
    expect(dev.remember).toHaveBeenCalledWith(PAYLOAD);
  });
});

describe('turning push off', () => {
  it('a refused unsubscribe is not shown as Off', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await click(byName(screen(), 'Enable push notifications'));
    fetchMock.mockResolvedValueOnce(json(500, { error: 'Could not remove this device.' }));
    await click(byName(screen(), 'On — turn off'));
    const tree = screen();
    expect(has(tree, 'On — turn off')).toBe(true);
    expect(has(tree, 'Could not remove this device.')).toBe(true);
  });
});

describe('the test push route', () => {
  it('answers a consent read it could not make as a 503 with a translated reason, not an unhandled 500', async () => {
    dev.configured.mockReturnValue({ web: true, native: false });
    dev.send.mockRejectedValue(new PushPreparationError(new Error('preference read failed')));
    const res = await sendTestPush();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'test.couldNotCheckPushSettings' });
  });

  it('still reports a delivered test (control)', async () => {
    dev.configured.mockReturnValue({ web: true, native: false });
    dev.send.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, pruned: 0, withheld: 0 });
    expect((await sendTestPush()).status).toBe(200);
  });
});
