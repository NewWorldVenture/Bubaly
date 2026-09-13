import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchPendingPushes } from '@/lib/server/push';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';

const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: provider.send } }));
const NOW = new Date('2026-09-12T12:00:00Z');
const GLOBAL = 'push_dispatch_cursor:v1:global';
const row = (id: number, fields: PushFixtureRow = {}): PushFixtureRow => ({
  id: notificationId(id), family_id: 'family-a', user_id: 'healthy', title: `notice ${id}`, body: '',
  pushed_at: null, send_at: NOW.toISOString(), created_at: NOW.toISOString(), ...fields,
});
const cursor = (id: number, createdAt = NOW.toISOString()) => ({ version: 1, id: notificationId(id), createdAt });
function fixture(rows: PushFixtureRow[]) {
  return pushDispatchDb({
    notifications: rows,
    push_devices: [
      { id: 'web', user_id: 'healthy', enabled: true, provider: 'webpush', endpoint: 'https://push.example.test/device', p256dh: 'key', auth: 'auth' },
      { id: 'native', user_id: 'unconfigured', enabled: true, provider: 'fcm', token: 'fixture-token' },
    ],
    family_members: [], family_ai_settings: [], user_preferences: [],
  });
}

beforeEach(() => {
  provider.send.mockReset().mockResolvedValue({ statusCode: 201 });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('bounded pending-push traversal', () => {
  it('reaches a healthy notification beyond 200 unresolved native deliveries and wraps to retry earlier rows', async () => {
    const f = fixture(Array.from({ length: 201 }, (_, index) => row(index + 1, { user_id: index < 200 ? 'unconfigured' : 'healthy' })).reverse());
    expect(await dispatchPendingPushes(f.db, { now: NOW })).toMatchObject({ notifications: 200, result: { skipped: 200, sent: 0 } });
    expect(f.tables.app_settings[0].value).toEqual(cursor(200));
    const second = await dispatchPendingPushes(f.db, { now: NOW });
    expect(second).toMatchObject({ notifications: 200, result: { skipped: 199, sent: 1 } });
    expect(f.stamps).toEqual([notificationId(201)]);
    expect(f.tables.app_settings[0].value).toEqual(cursor(199));
    const third = await dispatchPendingPushes(f.db, { now: NOW });
    expect(third).toMatchObject({ notifications: 200, result: { skipped: 200, sent: 0 } });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(f.tables.notifications.filter(item => item.pushed_at === null)).toHaveLength(200);
    expect(f.calls.filter(call => call.table === 'notifications' && call.operation === 'select').map(call => call.count)).toEqual([200, 1, 199, 1, 199]);
  });

  it('orders by full timestamp then ID, preserving PostgreSQL microseconds and retrying each row after wrap', async () => {
    const earlier = '2026-09-12T10:00:00.123455+00:00', later = '2026-09-12T10:00:00.123456+00:00';
    const f = fixture([row(3, { created_at: later }), row(2, { created_at: later }), row(9, { created_at: earlier })]);
    provider.send.mockRejectedValue(new Error('temporary provider outage'));
    for (const [id, createdAt] of [[9, earlier], [2, later], [3, later], [9, earlier]] as const) {
      expect((await dispatchPendingPushes(f.db, { now: NOW, limit: 1 })).result.failed).toBe(1);
      expect(f.tables.app_settings[0].value).toEqual(cursor(id, createdAt));
    }
    expect(provider.send.mock.calls.map(call => JSON.parse(call[1]).title)).toEqual(['notice 9', 'notice 2', 'notice 3', 'notice 9']);
    expect(f.stamps).toEqual([]);
  });

  it('keeps independent global and family progress and filters both sides of a family wrap', async () => {
    const f = fixture([row(1), row(2, { family_id: 'family-b' }), row(3)]);
    provider.send.mockRejectedValue(new Error('temporary provider outage'));
    for (const familyId of [undefined, 'family-a', 'family-b', 'family-a', 'family-a', undefined]) {
      await dispatchPendingPushes(f.db, { now: NOW, limit: 1, familyId });
    }
    expect(provider.send.mock.calls.map(call => JSON.parse(call[1]).title)).toEqual(['notice 1', 'notice 1', 'notice 2', 'notice 3', 'notice 1', 'notice 2']);
    expect(f.tables.app_settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: GLOBAL, value: cursor(2) }),
      expect.objectContaining({ key: 'push_dispatch_cursor:v1:family:family-a', value: cursor(1) }),
      expect.objectContaining({ key: 'push_dispatch_cursor:v1:family:family-b', value: cursor(2) }),
    ]));
  });

  it('does not mutate scheduled times and picks up newly due older rows on wrap', async () => {
    const future = new Date(NOW.getTime() + 60_000);
    const f = fixture([row(1, { send_at: future.toISOString() }), row(2)]);
    await dispatchPendingPushes(f.db, { now: NOW, limit: 1 });
    expect(f.stamps).toEqual([notificationId(2)]);
    expect((await dispatchPendingPushes(f.db, { now: NOW, limit: 1 })).notifications).toBe(0);
    await dispatchPendingPushes(f.db, { now: future, limit: 1 });
    expect(f.stamps).toEqual([notificationId(2), notificationId(1)]);
    expect(f.tables.notifications.map(item => item.send_at)).toEqual([future.toISOString(), NOW.toISOString()]);
    expect(f.tables.notifications.map(item => item.created_at)).toEqual([NOW.toISOString(), NOW.toISOString()]);
  });

  it('wraps from a cursor whose notification has been deleted', async () => {
    const f = fixture([row(1)]);
    f.tables.app_settings.push({ key: GLOBAL, value: cursor(999) });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(1);
    expect(f.stamps).toEqual([notificationId(1)]);
  });

  it.each([null, [], {}, { ...cursor(1), version: 2 }, { ...cursor(1), id: 'invalid' },
    { ...cursor(1), createdAt: 'not-a-date' }, { ...cursor(1), createdAt: '2026-01-01T00:00:00Z,id.gt.x' },
  ])('rejects malformed saved cursor %j before reading notifications', async value => {
    const f = fixture([row(1)]);
    f.tables.app_settings.push({ key: GLOBAL, value });
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Push cursor is invalid');
    expect(f.calls.some(call => call.table === 'notifications')).toBe(false);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each(['select', 'upsert'])('surfaces a cursor %s error without sending, then resumes after recovery', async operation => {
    const f = fixture([row(1)]);
    f.faults.add(`app_settings:${operation}`);
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow(/Push cursor .* failed/);
    expect(provider.send).not.toHaveBeenCalled();
    expect(f.tables.app_settings).toEqual([]);
    expect(f.stamps).toEqual([]);
    f.faults.clear();
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(1);
    expect((await dispatchPendingPushes(f.db, { now: NOW })).notifications).toBe(0);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it.each(['select', 'upsert'])('surfaces a thrown cursor %s error without sending', async operation => {
    const f = fixture([row(1)]);
    f.thrownFaults.add(`app_settings:${operation}`);
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Fixture connection failed');
    expect(provider.send).not.toHaveBeenCalled();
    expect(f.stamps).toEqual([]);
  });

  it('does not assume an unconfirmed cursor write succeeded', async () => {
    const f = fixture([row(1)]);
    f.emptyWrites.add('app_settings:upsert');
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Push cursor write failed');
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('does not advance or deliver a partially read batch when the wrap query fails', async () => {
    const f = fixture([row(1), row(3)]);
    f.tables.app_settings.push({ key: GLOBAL, value: cursor(2) });
    f.faults.add('notifications:select:2');
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Pending-push read failed');
    expect(f.tables.app_settings[0].value).toEqual(cursor(2));
    expect(provider.send).not.toHaveBeenCalled();
    f.faults.clear();
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(2);
    expect(f.stamps).toEqual([notificationId(3), notificationId(1)]);
  });

  it.each([0, -1, 201, 1.5, NaN, Infinity])('rejects an unbounded or invalid batch limit %s', async limit => {
    const f = fixture([row(1)]);
    await expect(dispatchPendingPushes(f.db, { now: NOW, limit })).rejects.toThrow('Push batch limit');
    expect(f.calls).toEqual([]);
  });
});
