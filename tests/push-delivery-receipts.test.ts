import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchPendingPushes } from '@/lib/server/push';
import { notificationId, pushDispatchDb } from './helpers/push-dispatch-db';

// PUSH-003. A whole-family notice fans out to every active member, and
// `pushed_at` is one timestamp for all of them. When any one recipient's
// delivery failed the row stayed pending, and the retry re-sent it to EVERY
// recipient, so the members whose phones already buzzed buzzed again, every
// run, until the last one succeeded. Receipts per (notification, recipient)
// make the retry reach only the people it has not reached.

const provider = vi.hoisted(() => ({ send: vi.fn(), failing: new Set<string>() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: provider.send } }));

const NOW = new Date('2026-09-12T12:00:00Z');
const FAMILY = 'family-a';
const device = (user: string) => ({
  id: `device-${user}`, user_id: user, enabled: true, provider: 'webpush',
  endpoint: `https://push.example.test/${user}`, p256dh: 'key', auth: 'auth',
});

function fixture() {
  return pushDispatchDb({
    notifications: [{
      id: notificationId(1), family_id: FAMILY, user_id: null, title: 'Take the evening medication', body: '',
      pushed_at: null, send_at: NOW.toISOString(), created_at: NOW.toISOString(),
    }],
    push_devices: [device('parent'), device('teen')],
    family_members: [
      { family_id: FAMILY, user_id: 'parent', is_active: true },
      { family_id: FAMILY, user_id: 'teen', is_active: true },
    ],
    family_ai_settings: [], user_preferences: [],
  });
}

const sendsTo = (user: string) => provider.send.mock.calls.filter(([subscription]) => subscription.endpoint.endsWith(`/${user}`)).length;

beforeEach(() => {
  provider.failing.clear();
  provider.send.mockReset().mockImplementation(async (subscription: { endpoint: string }) => {
    if ([...provider.failing].some((user) => subscription.endpoint.endsWith(`/${user}`))) throw new Error('provider outage');
    return { statusCode: 201 };
  });
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a partly failed fan-out retries only the people it has not reached', () => {
  it('does not buzz the parent again while the teen\'s delivery is retried', async () => {
    const f = fixture();
    provider.failing.add('teen');

    const first = await dispatchPendingPushes(f.db, { now: NOW });
    expect(first.result).toMatchObject({ sent: 1, failed: 1 });
    expect(f.stamps).toEqual([]); // still pending: the teen has not got it
    expect(f.tables.notification_push_receipts).toEqual([
      expect.objectContaining({ notification_id: notificationId(1), user_id: 'parent' }),
    ]);

    // Still failing: the retry must not touch the parent.
    await dispatchPendingPushes(f.db, { now: NOW });
    expect(sendsTo('parent')).toBe(1);
    expect(sendsTo('teen')).toBe(2);

    // The teen's device recovers.
    provider.failing.clear();
    const third = await dispatchPendingPushes(f.db, { now: NOW });
    expect(third.result).toMatchObject({ sent: 1, failed: 0 });
    expect(sendsTo('parent')).toBe(1);
    expect(sendsTo('teen')).toBe(3);
    expect(f.stamps).toEqual([notificationId(1)]);
    expect(f.tables.notification_push_receipts.map((r) => r.user_id).sort()).toEqual(['parent', 'teen']);
  });

  it('stamps at once when every recipient succeeds', async () => {
    const f = fixture();
    const run = await dispatchPendingPushes(f.db, { now: NOW });
    expect(run.result).toMatchObject({ sent: 2, failed: 0 });
    expect(f.stamps).toEqual([notificationId(1)]);
  });

  it('sends nothing and moves no cursor when the receipts cannot be read', async () => {
    const f = fixture();
    f.faults.add('notification_push_receipts:select');
    await expect(dispatchPendingPushes(f.db, { now: NOW })).rejects.toThrow('Push receipt read failed.');
    expect(provider.send).not.toHaveBeenCalled();
    expect(f.tables.app_settings).toEqual([]);
  });

  it('leaves the notice pending when a delivery cannot be recorded, and repeats only that delivery', async () => {
    const f = fixture();
    // The parent's receipt write fails once; the teen's succeeds.
    f.faults.add('notification_push_receipts:upsert:1');
    const first = await dispatchPendingPushes(f.db, { now: NOW });
    expect(first.result.failed).toBe(1);
    expect(f.stamps).toEqual([]);

    await dispatchPendingPushes(f.db, { now: NOW });
    // The residual this design accepts: the unrecorded delivery repeats once,
    // and the recorded one does not.
    expect(sendsTo('parent')).toBe(2);
    expect(sendsTo('teen')).toBe(1);
    expect(f.stamps).toEqual([notificationId(1)]);
  });
});
