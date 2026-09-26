import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';
import { dispatchPendingPushes } from '@/lib/server/push';

/**
 * PUSH-003's open half: a partial failure re-sent to every device.
 *
 * `pushed_at` stamps a notification only when every device succeeds. A
 * whole-family notice reaching two phones, one of which fails, stayed pending —
 * and the next run sent to BOTH again, so the phone that already had it buzzed
 * twice. 0336's per-device receipt makes the retry reach only the device that
 * missed it, without claiming anything ahead of a send (so a worker dying
 * mid-batch still loses nothing).
 */

const provider = vi.hoisted(() => ({ send: vi.fn(), configure: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: provider.configure, sendNotification: provider.send } }));

const NOW = new Date('2026-09-12T12:00:00Z');
const PHONE = 'https://push.example.test/phone';
const TABLET = 'https://push.example.test/tablet';

function fixture(options: { withReceipts?: boolean } = {}) {
  const tables: Record<string, PushFixtureRow[]> = {
    notifications: [{ id: notificationId(1), family_id: 'family', user_id: 'u1', title: 'Medication due', body: 'Body', related_type: null, pushed_at: null, send_at: NOW.toISOString(), created_at: NOW.toISOString() }],
    push_devices: [
      { id: 'phone', user_id: 'u1', enabled: true, provider: 'webpush', endpoint: PHONE, p256dh: 'k', auth: 'a' },
      { id: 'tablet', user_id: 'u1', enabled: true, provider: 'webpush', endpoint: TABLET, p256dh: 'k', auth: 'a' },
    ],
    family_members: [{ user_id: 'u1', family_id: 'family', role: 'parent', is_active: true }],
    family_ai_settings: [],
    user_preferences: [],
  };
  const f = pushDispatchDb(tables);
  if (options.withReceipts === false) f.missingTables.add('push_deliveries');
  return f;
}

const sendsTo = (endpoint: string) => provider.send.mock.calls.filter(([sub]) => sub.endpoint === endpoint).length;

beforeEach(() => {
  provider.send.mockReset().mockResolvedValue({ statusCode: 201 });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a device is buzzed once per notification', () => {
  it('a retry after a partial failure reaches only the device that missed it', async () => {
    const f = fixture();
    provider.send.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === TABLET) throw new Error('temporary provider outage');
      return { statusCode: 201 };
    });

    const first = await dispatchPendingPushes(f.db, { now: NOW });
    expect(first.result).toMatchObject({ sent: 1, failed: 1 });
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    expect(f.tables.push_deliveries).toEqual([expect.objectContaining({ notification_id: notificationId(1), device_id: 'phone' })]);

    provider.send.mockResolvedValue({ statusCode: 201 });
    const second = await dispatchPendingPushes(f.db, { now: NOW });
    expect(second.result).toMatchObject({ sent: 1, failed: 0 });
    expect(f.tables.notifications[0].pushed_at).toEqual(expect.any(String));

    // The phone had it after the first run and was not sent it again.
    expect(sendsTo(PHONE)).toBe(1);
    expect(sendsTo(TABLET)).toBe(2);
  });

  it('a failed receipt read sends nothing, rather than re-sending to devices that have it', async () => {
    const f = fixture();
    f.tables.push_deliveries.push({ notification_id: notificationId(1), device_id: 'phone', delivered_at: NOW.toISOString() });
    f.faults.add('push_deliveries:select');

    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Push receipt read failed.');
    expect(provider.send).not.toHaveBeenCalled();
    expect(f.tables.notifications[0].pushed_at).toBeNull();
  });

  it('a database without 0336 keeps delivering, as it did before', async () => {
    // Deploy can precede migration: the missing table is not a reason to stop
    // pushing a medication reminder.
    const f = fixture({ withReceipts: false });
    const run = await dispatchPendingPushes(f.db, { now: NOW });
    expect(run.result).toMatchObject({ sent: 2, failed: 0 });
    expect(f.tables.notifications[0].pushed_at).toEqual(expect.any(String));
  });
});
