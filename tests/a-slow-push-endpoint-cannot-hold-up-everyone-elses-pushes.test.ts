// A5 — one hostile web-push endpoint could stall push delivery for every family.
//
// web-push's `timeout` is https.request's socket IDLE timeout, and it gathers
// the reply with `responseText += chunk` and no limit. Any member can register
// (or insert) push devices pointing at a host they run, with no cap on how
// many, and dispatch is serial — so an endpoint that answered 201 and then
// trickled a byte every few seconds held the whole run, on every run, and
// could stream an unbounded body into memory.
//
// Now each web push has an absolute deadline and a 64 KiB reply cap, a device
// that ran out its deadline is not waited on again in the same run, the run has
// an overall budget, and an account is sent to on at most its newest ten
// devices (and registration switches the older ones off).
//
// The budget alone still let one account spend the run: three devices that
// never answered were waited on one after another, 3 x 15 s = the whole 45 s.
// So a recipient's web pushes (and their endpoint lookups) for one notification
// now go out together under one deadline, and a recipient is waited on in full
// once per run, briefly once more, and then not again until the next run.
import { Agent as HttpsAgent } from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';

const provider = vi.hoisted(() => ({
  calls: [] as { endpoint: string; options: { timeout?: number; agent?: HttpsAgent }; at: number }[],
  behave: (_endpoint: string, _options: { agent?: HttpsAgent }): Promise<unknown> => Promise.resolve({ statusCode: 201 }),
}));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: (subscription: { endpoint: string }, _body: string, options: { timeout?: number; agent?: HttpsAgent }) => {
      provider.calls.push({ endpoint: subscription.endpoint, options, at: Date.now() });
      return provider.behave(subscription.endpoint, options);
    },
  },
}));
const lookup = vi.hoisted(() => ({ behave: (_endpoint: string): Promise<boolean> => Promise.resolve(true) }));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: (endpoint: string) => lookup.behave(endpoint), __resetPushEndpointCache: () => {} }));
const sub = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUser: async () => ({ id: 'u-attacker' }) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => sub.db, createServiceClient: () => sub.db }));

const { dispatchPendingPushes, WEB_PUSH_DEADLINE_MS, WEB_PUSH_DEADLINE_AFTER_STALL_MS } = await import('@/lib/server/push');
const { POST: subscribe } = await import('@/app/api/push/subscribe/route');

const NOW = new Date('2026-10-13T12:00:00.000Z');
const notice = (n: number, userId: string): PushFixtureRow => ({
  id: notificationId(n), family_id: 'family', user_id: userId, title: `Notice ${n}`, body: 'Body', related_type: null,
  pushed_at: null, send_at: new Date(NOW.getTime() - 60_000).toISOString(), created_at: new Date(NOW.getTime() - 60_000 + n).toISOString(),
});
const device = (id: string, userId: string, lastSeen = '2026-10-01T00:00:00.000Z'): PushFixtureRow => ({
  id, user_id: userId, enabled: true, provider: 'webpush', endpoint: `https://push.example.test/${id}`, p256dh: 'key', auth: 'auth', last_seen_at: lastSeen,
});
const members = [
  { id: 'm-attacker', user_id: 'u-attacker', family_id: 'family', role: 'adult', is_active: true },
  { id: 'm-parent', user_id: 'u-parent', family_id: 'family', role: 'parent', is_active: true },
];
const sentTo = () => provider.calls.map((c) => c.endpoint.split('/').pop());
/** How far into the run (fake time) each send to `deviceId` began. */
const sendTimes = (deviceId: string) => provider.calls.filter((c) => c.endpoint.endsWith(`/${deviceId}`)).map((c) => c.at - NOW.getTime());
const never = () => new Promise<never>(() => {});
/** Let a run play out under fake timers: four deadlines is more than the run's whole budget. */
async function playOut<T>(run: Promise<T>): Promise<T> {
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(WEB_PUSH_DEADLINE_MS);
  return run;
}

beforeEach(() => {
  provider.calls = [];
  provider.behave = () => Promise.resolve({ statusCode: 201 });
  lookup.behave = () => Promise.resolve(true);
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a web push has an absolute deadline', () => {
  it('an endpoint that never finishes answering is abandoned at the deadline, once, and everyone else is still sent to', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The hostile endpoint accepts and never completes its reply.
    provider.behave = (endpoint) => (endpoint.endsWith('/slow') ? new Promise(() => {}) : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [notice(1, 'u-attacker'), notice(2, 'u-attacker'), notice(3, 'u-attacker'), notice(4, 'u-parent')],
      push_devices: [device('slow', 'u-attacker'), device('parent-phone', 'u-parent')],
      family_members: members, family_ai_settings: [], user_preferences: [],
    });

    const run = dispatchPendingPushes(f.db, { now: NOW });
    await vi.advanceTimersByTimeAsync(WEB_PUSH_DEADLINE_MS + 1);
    const { result } = await run;

    // Waited on once, for its first notification only; never for the next two.
    expect(sentTo().filter((d) => d === 'slow')).toHaveLength(1);
    expect(sentTo()).toContain('parent-phone');
    expect(result).toMatchObject({ sent: 1, failed: 3 });
    // The parent's notice is stamped; the stalled ones stay pending for a retry.
    const stamped = f.tables.notifications.filter((n) => n.pushed_at).map((n) => n.id);
    expect(stamped).toEqual([notificationId(4)]);
    // Every send carries the bounded agent, not only the idle timeout.
    expect(provider.calls.every((c) => c.options.agent instanceof HttpsAgent)).toBe(true);
  });

  it('a reply past 64 KiB is cut off and counted as a failure', async () => {
    const socket = new PassThrough();
    vi.spyOn(HttpsAgent.prototype, 'createConnection').mockImplementation(() => socket as never);
    provider.behave = (_endpoint, options) => new Promise(() => {
      // What https.request does with the agent: ask it for a connection, then
      // read the reply off that socket. This one streams without end.
      const s = options.agent!.createConnection({ host: 'push.example.test', port: 443 } as never) as PassThrough;
      for (let i = 0; i < 80; i++) s.emit('data', Buffer.alloc(1024));
    });
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [notice(1, 'u-attacker')],
      push_devices: [device('flood', 'u-attacker')],
      family_members: members, family_ai_settings: [], user_preferences: [],
    });
    const { result } = await dispatchPendingPushes(f.db, { now: new Date() });
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(socket.destroyed).toBe(true);
  });

  it('a run past its budget leaves the rest pending rather than waiting on them', async () => {
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [notice(1, 'u-parent'), notice(2, 'u-parent')],
      push_devices: [device('parent-phone', 'u-parent')],
      family_members: members, family_ai_settings: [], user_preferences: [],
    });
    const { result } = await dispatchPendingPushes(f.db, { now: new Date(), budgetMs: 0 });
    expect(provider.calls).toEqual([]);
    expect(result).toMatchObject({ sent: 0, skipped: 2 });
    expect(f.tables.notifications.every((n) => n.pushed_at == null)).toBe(true);
  });
});

// The run's budget alone was not a bound on one recipient: an account's devices
// were waited on one after another, each for the whole deadline, so three that
// never answered spent the 45 s and every recipient after them in the batch was
// skipped — on every run, since the failed rows stay pending for a retry.
describe('one recipient cannot spend the run', () => {
  it('three devices on one account that never answer cost one deadline, and the next recipient is still sent to', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    provider.behave = (endpoint) => (/\/slow\d$/.test(endpoint) ? never() : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [notice(1, 'u-attacker'), notice(2, 'u-parent')],
      push_devices: [device('slow1', 'u-attacker'), device('slow2', 'u-attacker'), device('slow3', 'u-attacker'), device('parent-phone', 'u-parent')],
      family_members: members, family_ai_settings: [], user_preferences: [],
    });

    const { result } = await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    expect(sentTo()).toContain('parent-phone');
    // The three were waited on together, not one after another.
    for (const slow of ['slow1', 'slow2', 'slow3']) expect(sendTimes(slow)).toEqual([0]);
    expect(sendTimes('parent-phone')).toEqual([WEB_PUSH_DEADLINE_MS]);
    expect(result).toMatchObject({ sent: 1, failed: 3, skipped: 0 });
    expect(f.tables.notifications.filter((n) => n.pushed_at).map((n) => n.id)).toEqual([notificationId(2)]);
  });

  it('devices that take turns to stall, one per notification, cost the account one deadline and one short wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Device turnN answers every notification but its (N+1)th, which it never
    // finishes — so no device is ever slow twice and the stalled-device memory
    // alone would wait a full deadline per notification.
    const callsTo = new Map<string, number>();
    provider.behave = (endpoint) => {
      const id = endpoint.split('/').pop() ?? '';
      if (!id.startsWith('turn')) return Promise.resolve({ statusCode: 201 });
      const n = (callsTo.get(id) ?? 0) + 1;
      callsTo.set(id, n);
      return n === Number(id.slice(4)) + 1 ? never() : Promise.resolve({ statusCode: 201 });
    };
    const turns = Array.from({ length: 10 }, (_, i) => device(`turn${i}`, 'u-attacker', `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [...Array.from({ length: 10 }, (_, i) => notice(i + 1, 'u-attacker')), notice(11, 'u-parent')],
      push_devices: [...turns, device('parent-phone', 'u-parent')],
      family_members: members, family_ai_settings: [], user_preferences: [],
    });

    await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    // One full deadline, then one short one; after a second stall the account's
    // web pushes this run are failures, retried next run, not more waiting.
    expect(sendTimes('parent-phone')).toEqual([WEB_PUSH_DEADLINE_MS + WEB_PUSH_DEADLINE_AFTER_STALL_MS]);
    expect(Math.max(...[...callsTo.values()])).toBeLessThanOrEqual(2);
    expect(f.tables.notifications.filter((n) => n.pushed_at).map((n) => n.id)).toEqual([notificationId(11)]);
  });

  it('a member\'s two old devices that never answer are one wait, and their phone still gets every notification in the run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    provider.behave = (endpoint) => (/\/(laptop|tablet)$/.test(endpoint) ? never() : Promise.resolve({ statusCode: 201 }));
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [notice(1, 'u-parent'), notice(2, 'u-parent'), notice(3, 'u-parent')],
      // The dead ones are the newest, so they come first.
      push_devices: [
        device('laptop', 'u-parent', '2026-10-12T00:00:00.000Z'),
        device('tablet', 'u-parent', '2026-10-11T00:00:00.000Z'),
        device('parent-phone', 'u-parent', '2026-10-01T00:00:00.000Z'),
      ],
      family_members: members, family_ai_settings: [], user_preferences: [],
    });

    const { result } = await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    // Not made to wait behind the dead two, and not cut off for their stall.
    expect(sendTimes('parent-phone')).toEqual([0, WEB_PUSH_DEADLINE_MS, WEB_PUSH_DEADLINE_MS]);
    expect(sendTimes('laptop')).toEqual([0]);
    expect(sendTimes('tablet')).toEqual([0]);
    expect(result).toMatchObject({ sent: 3, failed: 6 });
    expect(f.tables.push_deliveries.filter((r) => r.device_id === 'parent-phone')).toHaveLength(3);
  });

  it('an account\'s endpoint lookups are made together, so ten slow ones cost one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Each attacker host takes the lookup's whole 3 s to answer.
    lookup.behave = (endpoint) => (/\/host\d$/.test(endpoint)
      ? new Promise((resolve) => { setTimeout(() => resolve(true), 3_000); })
      : Promise.resolve(true));
    const hosts = Array.from({ length: 10 }, (_, i) => device(`host${i}`, 'u-attacker', `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [notice(1, 'u-attacker'), notice(2, 'u-parent')],
      push_devices: [...hosts, device('parent-phone', 'u-parent')],
      family_members: members, family_ai_settings: [], user_preferences: [],
    });

    const { result } = await playOut(dispatchPendingPushes(f.db, { now: NOW }));

    expect(sendTimes('parent-phone')).toEqual([3_000]);
    expect(result).toMatchObject({ sent: 11, failed: 0 });
  });
});

describe('an account is sent to on its newest ten devices', () => {
  it('dispatch reads no more than ten devices per recipient, newest first', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => device(`d${String(i).padStart(2, '0')}`, 'u-attacker', `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: [notice(1, 'u-attacker')],
      push_devices: twelve,
      family_members: members, family_ai_settings: [], user_preferences: [],
    });
    await dispatchPendingPushes(f.db, { now: new Date() });
    expect(sentTo()).toHaveLength(10);
    expect(sentTo()).not.toContain('d00');
    expect(sentTo()).not.toContain('d01');
    expect(sentTo()[0]).toBe('d11');
  });

  it('registering a device switches the account\'s oldest ones off past ten', async () => {
    const db: InMemorySupabase = createInMemorySupabase({ userId: 'u-attacker' });
    db.seed('family_members', [{ id: 'm-attacker', family_id: 'family', user_id: 'u-attacker', role: 'adult', is_active: true }]);
    db.seed('push_devices', Array.from({ length: 12 }, (_, i) => ({
      id: `old-${String(i).padStart(2, '0')}`, user_id: 'u-attacker', family_id: 'family', platform: 'android', provider: 'fcm',
      token: `tok-${i}`, device_key: `tok-${i}`, enabled: true, last_seen_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    })));
    sub.db = db;
    const res = await subscribe(new Request('https://bubaly.test/api/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'android', provider: 'fcm', token: 'tok-new' }),
    }));
    expect(res.status).toBe(200);
    const enabled = db.table('push_devices').filter((d) => d.enabled).map((d) => d.device_key).sort();
    expect(enabled).toHaveLength(10);
    expect(enabled).toContain('tok-new');
    // The three oldest are off; nothing was deleted.
    expect(db.table('push_devices').filter((d) => !d.enabled).map((d) => d.id).sort()).toEqual(['old-00', 'old-01', 'old-02']);
    expect(db.table('push_devices')).toHaveLength(13);
  });
});
