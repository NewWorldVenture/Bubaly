import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pushDispatchDb } from './helpers/push-dispatch-db';
import { pushConfigured, sendPushToUser } from '@/lib/server/push';

const native = vi.hoisted(() => ({ send: vi.fn(), configured: vi.fn() }));
vi.mock('@/lib/server/native-push', () => ({ sendNativePush: native.send, nativePushConfigured: native.configured }));
type Device = { id: string; user_id: string; enabled: boolean; provider: string; token: string };
function fixture(devices: Device[], pruneError = false) {
  const f = pushDispatchDb({ push_devices: devices, family_members: [], family_ai_settings: [], user_preferences: [] });
  if (pruneError) f.faults.add('push_devices:delete');
  return { db: f.db, get deleted() { return devices.filter(device => !f.tables.push_devices.some(row => row.id === device.id)).map(device => device.id); } };
}
const device = (provider: string, id = provider, user_id = 'u1'): Device => ({ id, user_id, enabled: true, provider, token: `${provider}-fixture-token` });
const payload = { title: 'Family update', body: 'Body', url: '/dashboard/notifications' };
beforeEach(() => {
  native.send.mockReset().mockResolvedValue('sent');
  native.configured.mockReset().mockReturnValue({ fcm: false, apns: false });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '');
  vi.stubEnv('VAPID_PRIVATE_KEY', '');
});
afterEach(() => vi.unstubAllEnvs());

it('sends Android and iOS registrations to their actual providers, scoped to the recipient', async () => {
  const f = fixture([device('fcm'), device('apns'), device('fcm', 'other-family', 'u2')]);
  expect(await sendPushToUser(f.db, 'u1', payload)).toEqual({ sent: 2, failed: 0, skipped: 0, pruned: 0, withheld: 0 });
  expect(native.send.mock.calls).toEqual([['fcm', 'fcm-fixture-token', payload], ['apns', 'apns-fixture-token', payload]]);
});

it.each(['fcm', 'apns'])('only prunes a %s registration the provider has confirmed unregistered', async provider => {
  native.send.mockResolvedValue('unregistered');
  const f = fixture([device(provider)]);
  expect(await sendPushToUser(f.db, 'u1', payload)).toEqual({ sent: 0, failed: 0, skipped: 0, pruned: 1, withheld: 0 });
  expect(f.deleted).toEqual([provider]);
});

it.each(['failed', 'unconfigured'])('keeps native registration on %s outcome', async outcome => {
  native.send.mockResolvedValue(outcome);
  const f = fixture([device('apns')]);
  const result = await sendPushToUser(f.db, 'u1', payload);
  expect(result.failed).toBe(outcome === 'failed' ? 1 : 0);
  expect(result.skipped).toBe(outcome === 'unconfigured' ? 1 : 0);
  expect(f.deleted).toEqual([]);
});

it('reports a failed native prune as a retryable failure', async () => {
  native.send.mockResolvedValue('unregistered');
  const f = fixture([device('apns')], true);
  expect(await sendPushToUser(f.db, 'u1', payload)).toEqual({ sent: 0, failed: 1, skipped: 0, pruned: 0, withheld: 0 });
});

it('rejects unknown providers without sending their token to Firebase', async () => {
  const f = fixture([device('unknown')]);
  expect((await sendPushToUser(f.db, 'u1', payload)).failed).toBe(1);
  expect(native.send).not.toHaveBeenCalled();
});

it.each([{ fcm: true, apns: false }, { fcm: false, apns: true }])('reports native configuration for either provider: %j', configured => {
  native.configured.mockReturnValue(configured);
  expect(pushConfigured().native).toBe(true);
});
