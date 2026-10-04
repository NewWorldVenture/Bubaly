import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchPendingPushes, sendPushToUser } from '@/lib/server/push';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';

const transport = vi.hoisted(() => ({ native: vi.fn(), web: vi.fn() }));
vi.mock('@/lib/server/native-push', () => ({
  sendNativePush: transport.native,
  nativePushConfigured: () => ({ fcm: true, apns: false }),
}));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: transport.web } }));
vi.mock('@/lib/server/push-endpoint', () => ({
  isDeliverablePushEndpoint: async () => { throw new Error('This fixture has no web devices.'); },
}));

const NOW = new Date('2026-10-02T01:00:00Z');
const member = (fields: PushFixtureRow = {}) => ({
  user_id: 'recipient', family_id: 'family', role: 'parent', is_active: true, ...fields,
});
const notification = (id = 1, fields: PushFixtureRow = {}) => ({
  id: notificationId(id), family_id: 'family', user_id: 'recipient',
  title: 'Synthetic family reminder', body: 'Synthetic family-only content',
  created_at: NOW.toISOString(), send_at: NOW.toISOString(), pushed_at: null, ...fields,
});
function fixture(members: PushFixtureRow[] = [member()], notices: PushFixtureRow[] = [notification()], maxRows?: number) {
  return pushDispatchDb({
    notifications: notices, family_members: members, family_ai_settings: [], user_preferences: [],
    push_devices: [{ id: 'device', user_id: 'recipient', provider: 'fcm', enabled: true, token: 'synthetic-token' }],
  }, { maxRows });
}

beforeEach(() => {
  transport.native.mockReset().mockResolvedValue('sent'); transport.web.mockReset();
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', ''); vi.stubEnv('VAPID_PRIVATE_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('queued family push recipients', () => {
  it.each(['inactive', 'foreign', 'absent'])('withholds an %s direct recipient and resolves the stale queue row', async mode => {
    const members = mode === 'absent' ? [] : [member({
      family_id: mode === 'foreign' ? 'other-family' : 'family', is_active: mode !== 'inactive',
    })];
    const f = fixture(members);
    expect(await dispatchPendingPushes(f.db, { familyId: 'family', now: NOW })).toEqual({
      notifications: 1, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 1 },
    });
    expect(transport.native).not.toHaveBeenCalled(); expect(transport.web).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.table === 'push_devices')).toBe(false);
    expect(f.tables.push_deliveries).toEqual([]); expect(f.stamps).toEqual([notificationId(1)]);
  });

  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'])('retains delivery to an active %s recipient', async role => {
    const f = fixture([member({ role })]);
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(1);
    expect(transport.native.mock.calls).toEqual([['fcm', 'synthetic-token', {
      title: 'Synthetic family reminder', body: 'Synthetic family-only content', url: '/dashboard/notifications',
    }]]);
    expect(f.tables.push_deliveries).toMatchObject([{ notification_id: notificationId(1), device_id: 'device' }]);
  });

  it('checks each notification family in a global batch and preserves eligible broadcast fan-out', async () => {
    const f = fixture([member(), member({ family_id: 'foreign', is_active: false })], [
      notification(1), notification(2, { family_id: 'foreign' }), notification(3, { user_id: null }),
    ]);
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual({
      sent: 2, skipped: 0, failed: 0, pruned: 0, withheld: 1,
    });
    expect(transport.native).toHaveBeenCalledTimes(2);
    expect(f.stamps).toEqual([notificationId(1), notificationId(2), notificationId(3)]);
  });

  it.each(['returned', 'thrown'])('sends and acknowledges nothing after a %s roster-read failure', async failure => {
    const f = fixture();
    (failure === 'returned' ? f.faults : f.thrownFaults).add('family_members:select');
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow();
    expect(transport.native).not.toHaveBeenCalled(); expect(transport.web).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.table === 'push_devices')).toBe(false);
    expect(f.stamps).toEqual([]); expect(f.tables.notifications[0].pushed_at).toBeNull();
    expect(f.tables.push_deliveries).toEqual([]);
  });

  it('prepares every family before delivery, including a later failing roster', async () => {
    const f = fixture([member(), member({ family_id: 'second' })], [notification(1), notification(2, { family_id: 'second' })]);
    // The first family's populated and empty pages finish before the second
    // family's first page is attempted.
    f.faults.add('family_members:select:3');
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Push recipient read failed');
    expect(transport.native).not.toHaveBeenCalled(); expect(f.stamps).toEqual([]);
  });

  it.each(['direct', 'broadcast'])('retains an eligible %s recipient beyond a capped roster page', async mode => {
    const f = fixture([
      member({ id: notificationId(1), user_id: 'first' }),
      member({ id: notificationId(2) }),
    ], [notification(1, { user_id: mode === 'direct' ? 'recipient' : null })], 1);
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual({
      sent: 1, skipped: 0, failed: 0, pruned: 0, withheld: 0,
    });
    expect(transport.native).toHaveBeenCalledTimes(1);
    expect(f.stamps).toEqual([notificationId(1)]);
    expect(f.calls.filter(call => call.table === 'family_members').map(call => call.count)).toEqual([1, 1, 0, 0]);
  });

  it.each(['returned', 'thrown'])('sends and acknowledges nothing after a %s later roster-page failure', async failure => {
    const f = fixture([
      member({ id: notificationId(1) }),
      member({ id: notificationId(2), user_id: 'second' }),
    ], [notification()], 1);
    (failure === 'returned' ? f.faults : f.thrownFaults).add('family_members:select:2');
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Push recipient read failed');
    expect(transport.native).not.toHaveBeenCalled(); expect(transport.web).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.table === 'push_devices')).toBe(false);
    expect(f.stamps).toEqual([]); expect(f.tables.push_deliveries).toEqual([]);
    expect(f.tables.notifications[0].pushed_at).toBeNull();
  });

  it.each(['preference', 'parent'])('retains %s consent withholding for an eligible child', async source => {
    const f = fixture([member({ role: 'child' })]);
    if (source === 'preference') f.tables.user_preferences.push({ user_id: 'recipient', push_enabled: false });
    else f.tables.family_ai_settings.push({ family_id: 'family', child_channels: { push: false } });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.withheld).toBe(1);
    expect(transport.native).not.toHaveBeenCalled(); expect(f.stamps).toEqual([notificationId(1)]);
  });

  it.each(['failed', 'unconfigured'])('retains a %s eligible delivery for retry and rechecks removal before retry', async outcome => {
    const f = fixture(); transport.native.mockResolvedValue(outcome);
    const first = await dispatchPendingPushes(f.db, { now: NOW });
    expect(first.result[outcome === 'failed' ? 'failed' : 'skipped']).toBe(1);
    expect(f.stamps).toEqual([]); expect(f.tables.notifications[0].pushed_at).toBeNull();
    f.tables.family_members[0].is_active = false; transport.native.mockClear().mockResolvedValue('sent');
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.withheld).toBe(1);
    expect(transport.native).not.toHaveBeenCalled(); expect(f.stamps).toEqual([notificationId(1)]);
  });

  it('does not impose family eligibility on the general direct sender', async () => {
    const f = fixture([]);
    expect((await sendPushToUser(f.db, 'recipient', { title: 'Synthetic device test' })).sent).toBe(1);
    expect(transport.native).toHaveBeenCalledTimes(1);
  });

  it('documents the remaining race when membership changes after the roster snapshot', async () => {
    const f = fixture();
    const from = f.db.from.bind(f.db);
    vi.spyOn(f.db, 'from').mockImplementation((...args) => {
      // Device lookup follows roster preparation. Revocation here cannot undo
      // the earlier read: this guard is not an atomic delivery authorization.
      if (args[0] === 'push_devices') f.tables.family_members[0].is_active = false;
      return from(...args);
    });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result.sent).toBe(1);
    expect(f.tables.family_members[0].is_active).toBe(false);
  });
});
