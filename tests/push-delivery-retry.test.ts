import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';
import { dispatchPendingPushes } from '@/lib/server/push';
import { GET as pushScan } from '@/app/api/cron/push-scan/route';
import { GET as notificationCron } from '@/app/api/cron/notifications/route';
import { POST as testPush } from '@/app/api/push/test/route';
import { NextRequest } from 'next/server';

const provider = vi.hoisted(() => ({ send: vi.fn(), configure: vi.fn() }));
const cron = vi.hoisted(() => ({ db: null as unknown }));
const user = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: provider.configure, sendNotification: provider.send } }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => cron.db }));
vi.mock('@/lib/server/notifications', () => ({ generateFamilyNotifications: vi.fn().mockResolvedValue(0) }));
vi.mock('@/lib/server/notification-emails', () => ({ deliverNotificationEmails: async () => ({ sent: 0, failed: 0, skipped: 0 }) }));
vi.mock('@/lib/briefing/deliver', () => ({ deliverMorningBriefs: async () => ({ delivered: 0, families: 0, skipped: 0, failed: 0 }) }));
vi.mock('@/lib/services/approvals', () => ({ expireStale: async () => ({ expired: 0, blockedRuns: 0 }), remindPendingApprovals: async () => ({ reminded: 0, families: 0 }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUser: user.get }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

type Row = PushFixtureRow;
const NOW = new Date('2026-09-12T12:00:00Z');
function fixture() {
  const tables: Record<string, Row[]> = {
    families: [{ id: 'family' }],
    notifications: [{ id: notificationId(1), family_id: 'family', user_id: 'u1', title: 'Family update', body: 'Body', related_type: null, pushed_at: null, send_at: NOW.toISOString(), created_at: NOW.toISOString() }],
    push_devices: [{ id: 'd1', user_id: 'u1', enabled: true, provider: 'webpush', endpoint: 'https://push.example.test/device', p256dh: 'key', auth: 'auth' }],
    family_members: [{ user_id: 'u1', family_id: 'family', role: 'parent', is_active: true }],
    family_ai_settings: [],
    user_preferences: [],
  };
  return pushDispatchDb(tables);
}

beforeEach(() => {
  provider.send.mockReset().mockResolvedValue({ statusCode: 201 });
  user.get.mockReset().mockResolvedValue({ id: 'u1' });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  vi.stubEnv('FCM_SERVER_KEY', '');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_PRIVATE_KEY', 'APNS_TOPIC']) vi.stubEnv(name, '');
  vi.stubEnv('CRON_SECRET', 'audit-fixture-cron-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('pending push delivery and durable acknowledgement', () => {
  it('retries a transient provider failure, then reads back acknowledged state without sending a third time', async () => {
    const f = fixture();
    provider.send.mockRejectedValueOnce(new Error('temporary provider outage'));
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.failed).toBe(1);
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    expect(f.stamps).toEqual([]);
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(1);
    expect(f.tables.notifications[0].pushed_at).toEqual(expect.any(String));
    expect((await dispatchPendingPushes(f.db, { now: NOW })).notifications).toBe(0);
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it('retains an unconfigured native device for later delivery', async () => {
    const f = fixture();
    Object.assign(f.tables.push_devices[0], { provider: 'fcm', token: 'fixture-token' });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.skipped).toBe(1);
    expect(f.stamps).toEqual([]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('retains an incomplete registration instead of acknowledging it as sent', async () => {
    const f = fixture();
    f.tables.push_devices[0].auth = null;
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.skipped).toBe(1);
    expect(f.stamps).toEqual([]);
  });

  it('does not acknowledge a device read error and retries after recovery', async () => {
    const f = fixture();
    f.faults.add('push_devices:select');
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.failed).toBe(1);
    expect(f.stamps).toEqual([]);
    f.faults.clear();
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(1);
    expect(f.stamps).toEqual([notificationId(1)]);
  });

  it('does not send or acknowledge an unreadable whole-family recipient list', async () => {
    const f = fixture();
    f.tables.notifications[0].user_id = null;
    f.faults.add('family_members:select');
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Push recipient read failed');
    expect(f.stamps).toEqual([]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each(['family_members', 'family_ai_settings', 'user_preferences'])('retains notifications when %s permissions cannot be read', async table => {
    const f = fixture();
    f.tables.family_members[0].role = 'child';
    f.faults.add(`${table}:select`);
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow(/read failed/);
    expect(f.stamps).toEqual([]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each(['parent', 'child'])('honors the %s recipient push toggle and settles intentional opt-out', async role => {
    const f = fixture();
    f.tables.family_members[0].role = role;
    f.tables.user_preferences.push({ user_id: 'u1', push_enabled: false });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.failed).toBe(0);
    expect(f.stamps).toEqual([notificationId(1)]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('honors parental channel opt-out for whole-family notices', async () => {
    const f = fixture();
    f.tables.notifications[0].user_id = null;
    f.tables.family_members[0].role = 'child';
    f.tables.family_ai_settings.push({ family_id: 'family', child_channels: { push: false } });
    await dispatchPendingPushes(f.db, { now: NOW });
    expect(f.stamps).toEqual([notificationId(1)]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each([404, 410])('prunes a confirmed stale %s subscription and acknowledges it', async statusCode => {
    const f = fixture();
    provider.send.mockRejectedValueOnce({ statusCode });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual({ sent: 0, failed: 0, skipped: 0, pruned: 1, withheld: 0 });
    expect(f.tables.push_devices).toEqual([]);
    expect(f.stamps).toEqual([notificationId(1)]);
  });

  it('does not claim a stale subscription was pruned when its deletion failed', async () => {
    const f = fixture();
    provider.send.mockRejectedValueOnce({ statusCode: 410 });
    f.faults.add('push_devices:delete');
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual({ sent: 0, failed: 1, skipped: 0, pruned: 0, withheld: 0 });
    expect(f.tables.push_devices).toHaveLength(1);
    expect(f.stamps).toEqual([]);
  });

  it('reports a failed acknowledgement and preserves the pending row', async () => {
    const f = fixture();
    f.faults.add('notifications:update');
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual({ sent: 1, failed: 1, skipped: 0, pruned: 0, withheld: 0 });
    expect(f.tables.notifications[0].pushed_at).toBeNull();
  });

  it('retains partially delivered notifications and continues other due notifications', async () => {
    const f = fixture();
    f.tables.push_devices.push({ ...f.tables.push_devices[0], id: 'd2' });
    f.tables.notifications.push({ ...f.tables.notifications[0], id: notificationId(2) });
    provider.send.mockResolvedValueOnce({ statusCode: 201 }).mockRejectedValueOnce(new Error('transient'));
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual({ sent: 3, failed: 1, skipped: 0, pruned: 0, withheld: 0 });
    expect(f.stamps).toEqual([notificationId(2)]);
    expect(f.tables.notifications[0].pushed_at).toBeNull();
  });

  it('returns a failed cron status, recovers delivery on retry and does not send an acknowledged row again', async () => {
    const f = fixture();
    cron.db = f.db;
    provider.send.mockRejectedValueOnce(new Error('provider down'));
    const request = () => new NextRequest('https://bubaly.example.test/api/cron/push-scan', { headers: { authorization: 'Bearer audit-fixture-cron-secret' } });
    const first = await pushScan(request());
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ ok: false, failed: 1 });
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    const retry = await pushScan(request());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, pushed: { result: { sent: 1 } } });
    const duplicate = await pushScan(request());
    expect(await duplicate.json()).toMatchObject({ pushed: { notifications: 0 } });
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it('rejects an unauthorized cron invocation before touching a provider', async () => {
    const f = fixture();
    cron.db = f.db;
    const response = await pushScan(new NextRequest('https://bubaly.example.test/api/cron/push-scan'));
    expect(response.status).toBe(401);
    expect(provider.send).not.toHaveBeenCalled();
    expect(f.stamps).toEqual([]);
  });

  it.each([['push-scan', pushScan], ['notifications', notificationCron]] as const)('%s reports missing provider configuration, then recovers after a registration is repaired', async (path, handler) => {
    const f = fixture();
    cron.db = f.db;
    Object.assign(f.tables.push_devices[0], { provider: 'fcm', token: 'fixture-token' });
    const request = () => new NextRequest(`https://bubaly.example.test/api/cron/${path}`, { headers: { authorization: 'Bearer audit-fixture-cron-secret' } });
    const missing = await handler(request());
    expect(missing.status).toBe(502);
    expect(await missing.json()).toMatchObject({ ok: false, failed: 1, pushed: { result: { skipped: 1, sent: 0 } } });
    expect(f.tables.notifications[0].pushed_at).toBeNull();
    Object.assign(f.tables.push_devices[0], { provider: 'webpush' });
    const recovered = await handler(request());
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, pushed: { result: { sent: 1 } } });
    expect(f.stamps).toEqual([notificationId(1)]);
  });

  it.each([['push-scan', pushScan], ['notifications', notificationCron]] as const)('%s reports cursor failure without sending or acknowledging pending work', async (path, handler) => {
    const f = fixture();
    cron.db = f.db;
    f.faults.add('app_settings:upsert');
    const response = await handler(new NextRequest(`https://bubaly.example.test/api/cron/${path}`, { headers: { authorization: 'Bearer audit-fixture-cron-secret' } }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, failed: 1 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(f.stamps).toEqual([]);
  });

  it('does not tell a user their test push succeeded when the provider failed', async () => {
    const f = fixture();
    cron.db = f.db;
    provider.send.mockRejectedValueOnce(new Error('provider unavailable'));
    const response = await testPush();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, result: { failed: 1, sent: 0 } });
  });

  it('reports an absent registration and then succeeds after registration', async () => {
    const f = fixture();
    cron.db = f.db;
    const device = f.tables.push_devices.pop()!;
    const missing = await testPush();
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ ok: false, result: { sent: 0 } });
    f.tables.push_devices.push(device);
    const response = await testPush();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { sent: 1 } });
  });

  it('rejects anonymous test pushes', async () => {
    user.get.mockResolvedValueOnce(null);
    const response = await testPush();
    expect(response.status).toBe(401);
    expect(provider.send).not.toHaveBeenCalled();
  });
});
