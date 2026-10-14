// A5 (follow-up) — one account, or one family, could still spend the push run.
//
// The per-recipient bound counted ABORTED sends, per account. So:
//  • a device that answered just inside the deadline was never aborted, and was
//    waited on for nearly 15 s on every notice of the run — and the batch was
//    never cut to what the run had left, so the run itself overran;
//  • a parent's household (the child logins they create can each register a
//    device, and one whole-family notice reaches them all) was the original
//    three stalling devices moved onto three accounts;
//  • endpoint lookups that timed out were "skipped", never counted at all.
// Every other family's pushes behind them in the batch were skipped, on every
// run. Now what is bounded is the time a recipient and a family keep the run
// waiting, and each send is given the least of its own deadline and what its
// recipient, its family and the run have left.
//
// And (A5-shared-deadline) the deadline was shared by a recipient's whole
// batch from its first web send, so the native sends and rechecks between them
// were taken out of a later web send's time — a healthy device could be given
// nothing, aborted and counted as a stall — and a fast device's receipt waited
// for the slowest send. Each web send now has its own deadline, from when it is
// sent, and is receipted as soon as it is answered.
//
// Driven through the real dispatchPendingPushes against the stateful push
// fixture; only the providers (web-push, FCM) and the endpoint lookup are fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';

const provider = vi.hoisted(() => ({
  calls: [] as { endpoint: string; at: number }[],
  behave: (_endpoint: string): Promise<unknown> => Promise.resolve({ statusCode: 201 }),
}));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: (subscription: { endpoint: string }) => {
      provider.calls.push({ endpoint: subscription.endpoint, at: Date.now() });
      return provider.behave(subscription.endpoint);
    },
  },
}));
const lookup = vi.hoisted(() => ({ behave: (_endpoint: string): Promise<boolean> => Promise.resolve(true) }));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: (endpoint: string) => lookup.behave(endpoint), __resetPushEndpointCache: () => {} }));
const native = vi.hoisted(() => ({ calls: [] as { token: string; at: number }[], behave: (_token: string): Promise<string> => Promise.resolve('sent') }));
vi.mock('@/lib/server/native-push', () => ({
  nativePushConfigured: () => ({ fcm: true, apns: false }),
  sendNativePush: (_provider: string, token: string) => {
    native.calls.push({ token, at: Date.now() });
    return native.behave(token);
  },
}));

const {
  dispatchPendingPushes, PUSH_DISPATCH_BUDGET_MS, WEB_PUSH_DEADLINE_MS, WEB_PUSH_DEADLINE_AFTER_STALL_MS, WEB_PUSH_FAMILY_ALLOWANCE_MS, WEB_PUSH_MIN_SEND_MS,
} = await import('@/lib/server/push');

const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOSTILE = 'family-hostile';
const NEIGHBOURS = 'family-neighbours';
const notice = (n: number, familyId: string, userId: string | null): PushFixtureRow => ({
  id: notificationId(n), family_id: familyId, user_id: userId, title: `Notice ${n}`, body: 'Body', related_type: null,
  pushed_at: null, send_at: new Date(NOW.getTime() - 60_000).toISOString(), created_at: new Date(NOW.getTime() - 60_000 + n).toISOString(),
});
const web = (id: string, userId: string, lastSeen = '2026-10-01T00:00:00.000Z'): PushFixtureRow => ({
  id, user_id: userId, enabled: true, provider: 'webpush', endpoint: `https://push.example.test/${id}`, p256dh: 'key', auth: 'auth', last_seen_at: lastSeen,
});
const fcm = (id: string, userId: string, lastSeen: string): PushFixtureRow => ({
  id, user_id: userId, enabled: true, platform: 'android', provider: 'fcm', token: `token-${id}`, last_seen_at: lastSeen,
});
const member = (id: string, familyId: string, userId: string, role = 'adult') => ({ id, user_id: userId, family_id: familyId, role, is_active: true });
const families = [{ id: HOSTILE, closed_at: null }, { id: NEIGHBOURS, closed_at: null }];
const neighbour = member('m-neighbour', NEIGHBOURS, 'u-neighbour', 'parent');

/** How far into the run (fake time) each send to `deviceId` began. */
const sendTimes = (deviceId: string) => provider.calls.filter((c) => c.endpoint.endsWith(`/${deviceId}`)).map((c) => c.at - NOW.getTime());
const never = () => new Promise<never>(() => {});
const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => { setTimeout(() => resolve(value), ms); });
const stamped = (f: ReturnType<typeof pushDispatchDb>) => f.tables.notifications.filter((n) => n.pushed_at).map((n) => n.id);

/** Run a dispatch under fake timers to the end, and say how far into it (fake time) it finished. */
async function playOut(run: Promise<Awaited<ReturnType<typeof dispatchPendingPushes>>>) {
  let endedAt = Number.NaN;
  const finished = run.then((value) => { endedAt = Date.now() - NOW.getTime(); return value; });
  // Five deadlines is more than the run's whole budget, with room to see an overrun.
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(WEB_PUSH_DEADLINE_MS);
  const { result } = await finished;
  return { result, endedAt };
}

beforeEach(() => {
  provider.calls = [];
  provider.behave = () => Promise.resolve({ statusCode: 201 });
  lookup.behave = () => Promise.resolve(true);
  native.calls = [];
  native.behave = () => Promise.resolve('sent');
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('one account cannot spend the run', () => {
  it('a device that answers just inside the deadline is waited on once in full, and another family is still sent to', async () => {
    // Never aborted, so never "stalled": 14.9 s on each of four notices was
    // the whole run, and more.
    provider.behave = (endpoint) => (endpoint.endsWith('/sluggish') ? after(WEB_PUSH_DEADLINE_MS - 100, { statusCode: 201 }) : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families,
      notifications: [1, 2, 3, 4].map((n) => notice(n, HOSTILE, 'u-attacker')).concat(notice(5, NEIGHBOURS, 'u-neighbour')),
      push_devices: [web('sluggish', 'u-attacker'), web('neighbour-phone', 'u-neighbour')],
      family_members: [member('m-attacker', HOSTILE, 'u-attacker'), neighbour], family_ai_settings: [], user_preferences: [],
    });

    const { result, endedAt } = await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    // Once in full, once for the short wait that follows a slow batch, then
    // no more this run.
    expect(sendTimes('sluggish')).toEqual([0, WEB_PUSH_DEADLINE_MS - 100]);
    expect(sendTimes('neighbour-phone')).toEqual([WEB_PUSH_DEADLINE_MS - 100 + WEB_PUSH_DEADLINE_AFTER_STALL_MS]);
    expect(stamped(f)).toContain(notificationId(5));
    expect(result).toMatchObject({ sent: 2, failed: 3 });
    expect(endedAt).toBeLessThanOrEqual(PUSH_DISPATCH_BUDGET_MS);
  });

  it('a send started late in the run is given only what the run has left', async () => {
    // The batch's deadline was not cut to the run's end, so a batch started
    // at 44.7 s still got its full 15 s and the run overran its budget.
    provider.behave = (endpoint) => (endpoint.endsWith('/slow') ? never() : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families,
      notifications: [notice(1, HOSTILE, 'u-attacker')],
      push_devices: [web('slow', 'u-attacker')],
      family_members: [member('m-attacker', HOSTILE, 'u-attacker')], family_ai_settings: [], user_preferences: [],
    });

    const { result, endedAt } = await playOut(dispatchPendingPushes(f.db, { now: NOW, budgetMs: 5_000 }));

    expect(sendTimes('slow')).toEqual([0]);
    expect(endedAt).toBe(5_000);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
  });

  it('endpoint lookups that run out their time count against the account, not only sends', async () => {
    // Each lookup takes its whole 3 s and then refuses: "skipped", not a
    // stall, so sixteen notices were 48 s of lookups and the run was spent.
    lookup.behave = (endpoint) => (endpoint.includes('/lookup') ? after(3_000, false) : Promise.resolve(true));
    const f = pushDispatchDb({
      families,
      notifications: Array.from({ length: 16 }, (_, i) => notice(i + 1, HOSTILE, 'u-attacker')).concat(notice(17, NEIGHBOURS, 'u-neighbour')),
      push_devices: [web('lookup-host', 'u-attacker'), web('neighbour-phone', 'u-neighbour')],
      family_members: [member('m-attacker', HOSTILE, 'u-attacker'), neighbour], family_ai_settings: [], user_preferences: [],
    });

    const { endedAt } = await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    expect(sendTimes('neighbour-phone')).toEqual([2 * 3_000]);
    expect(stamped(f)).toEqual([notificationId(17)]);
    expect(endedAt).toBe(2 * 3_000);
  });
});

describe('a send is not started with a sliver of time (A5-sliver)', () => {
  it('a healthy device reached with less than a second of the run left waits for the next run, skipped and not failed', async () => {
    // The attacker's device answers at 4.8 s of a 5 s run. The neighbour's
    // phone was then sent with 200 ms, cut off, and counted failed.
    provider.behave = (endpoint) => (endpoint.endsWith('/slow') ? after(4_800, { statusCode: 201 }) : after(500, { statusCode: 201 }));
    const f = pushDispatchDb({
      families,
      notifications: [notice(1, HOSTILE, 'u-attacker'), notice(2, NEIGHBOURS, 'u-neighbour')],
      push_devices: [web('slow', 'u-attacker'), web('neighbour-phone', 'u-neighbour')],
      family_members: [member('m-attacker', HOSTILE, 'u-attacker'), neighbour], family_ai_settings: [], user_preferences: [],
    });

    const { result } = await playOut(dispatchPendingPushes(f.db, { now: NOW, budgetMs: 5_000 }));

    expect(5_000 - 4_800).toBeLessThan(WEB_PUSH_MIN_SEND_MS);
    expect(sendTimes('neighbour-phone')).toEqual([]);
    expect(result).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    // Pending, not expired: the neighbours' notice is sent by the next run.
    expect(stamped(f)).toEqual([notificationId(1)]);
  });

  it('a device reached with a second or more left is still sent to (control)', async () => {
    provider.behave = (endpoint) => (endpoint.endsWith('/slow') ? after(3_500, { statusCode: 201 }) : after(500, { statusCode: 201 }));
    const f = pushDispatchDb({
      families,
      notifications: [notice(1, HOSTILE, 'u-attacker'), notice(2, NEIGHBOURS, 'u-neighbour')],
      push_devices: [web('slow', 'u-attacker'), web('neighbour-phone', 'u-neighbour')],
      family_members: [member('m-attacker', HOSTILE, 'u-attacker'), neighbour], family_ai_settings: [], user_preferences: [],
    });

    const { result } = await playOut(dispatchPendingPushes(f.db, { now: NOW, budgetMs: 5_000 }));

    expect(sendTimes('neighbour-phone')).toEqual([3_500]);
    expect(result).toMatchObject({ sent: 2, failed: 0, skipped: 0 });
  });
});

describe('one family cannot spend the run', () => {
  it('three member accounts that never answer one whole-family notice cost the family\'s share, and another family is still sent to', async () => {
    provider.behave = (endpoint) => (/\/laptop-a\d$/.test(endpoint) ? never() : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families,
      // One notice to the whole household, and one to a neighbouring family.
      notifications: [notice(1, HOSTILE, null), notice(2, NEIGHBOURS, 'u-neighbour')],
      push_devices: [web('laptop-a1', 'u-a1'), web('laptop-a2', 'u-a2'), web('laptop-a3', 'u-a3'), web('neighbour-phone', 'u-neighbour')],
      family_members: [member('m-a1', HOSTILE, 'u-a1', 'parent'), member('m-a2', HOSTILE, 'u-a2', 'child'), member('m-a3', HOSTILE, 'u-a3', 'child'), neighbour],
      family_ai_settings: [], user_preferences: [],
    });

    const { result, endedAt } = await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    // The first account gets a full deadline, the second what the family has
    // left, and the third waits for the next run.
    expect(sendTimes('laptop-a1')).toEqual([0]);
    expect(sendTimes('laptop-a2')).toEqual([WEB_PUSH_DEADLINE_MS]);
    expect(sendTimes('laptop-a3')).toEqual([]);
    expect(sendTimes('neighbour-phone')).toEqual([WEB_PUSH_FAMILY_ALLOWANCE_MS]);
    expect(endedAt).toBe(WEB_PUSH_FAMILY_ALLOWANCE_MS);
    expect(WEB_PUSH_FAMILY_ALLOWANCE_MS).toBeLessThan(PUSH_DISPATCH_BUDGET_MS);
    expect(result).toMatchObject({ sent: 1, failed: 2, skipped: 1 });
    // The household's notice stays pending (skipped is never expired); the neighbours' is done.
    expect(stamped(f)).toEqual([notificationId(2)]);
  });
});

describe('each web push has its own deadline (A5-shared-deadline)', () => {
  it('a native send between two web pushes is not taken out of the second one\'s time', async () => {
    // The newest first: a browser, a phone on FCM that takes 14 s to answer,
    // and a tablet whose push service answers in 2 s.
    native.behave = () => after(14_000, 'sent');
    provider.behave = (endpoint) => (endpoint.endsWith('/tablet') ? after(2_000, { statusCode: 201 }) : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families,
      notifications: [notice(1, NEIGHBOURS, 'u-neighbour'), notice(2, NEIGHBOURS, 'u-neighbour')],
      push_devices: [
        web('browser', 'u-neighbour', '2026-10-12T00:00:00.000Z'),
        fcm('phone', 'u-neighbour', '2026-10-11T00:00:00.000Z'),
        web('tablet', 'u-neighbour', '2026-10-10T00:00:00.000Z'),
      ],
      family_members: [neighbour], family_ai_settings: [], user_preferences: [],
    });

    const { result } = await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    // Sent at 14 s, it still had its full deadline: answered, not aborted,
    // and not a stall that cut the member to 3 s for the next notice.
    expect(sendTimes('tablet')).toEqual([14_000, 30_000]);
    expect(result).toMatchObject({ sent: 6, failed: 0, skipped: 0 });
    expect(f.tables.push_deliveries.filter((r) => r.device_id === 'tablet')).toHaveLength(2);
    expect(stamped(f)).toEqual([notificationId(1), notificationId(2)]);
  });

  it('a device that answered is receipted at once, not when the slowest send gives up', async () => {
    provider.behave = (endpoint) => (endpoint.endsWith('/laptop') ? never() : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families,
      notifications: [notice(1, NEIGHBOURS, 'u-neighbour')],
      push_devices: [web('laptop', 'u-neighbour', '2026-10-12T00:00:00.000Z'), web('phone', 'u-neighbour', '2026-10-11T00:00:00.000Z')],
      family_members: [neighbour], family_ai_settings: [], user_preferences: [],
    });

    const run = dispatchPendingPushes(f.db, { now: NOW });
    await vi.advanceTimersByTimeAsync(1_000);
    // The laptop is still being waited on. A worker killed now must not lose
    // the phone's receipt, or the next run buzzes the phone again.
    expect(f.tables.push_deliveries.map((r) => r.device_id)).toEqual(['phone']);

    const { result } = await playOut(run);
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(f.tables.push_deliveries.map((r) => r.device_id)).toEqual(['phone']);
  });
});
