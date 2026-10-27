// household-roles round 11 (R10-REVIEW-GAP-RETRY-PLACE): the retries behind
// the push cursor go round, from their own place to the newest row behind and
// then from the oldest up to it, and the stored cursor stays readable,
// compared whole and small.
//
// Round 10 gave the retries a place of their own in the stored cursor
// (`retry`), so a run's reserve went on after the last row the retries took
// instead of re-reading the oldest. But a row they had passed was reached
// again only once their lap ended: when the batch took every row behind, or
// the cursor wrapped. A child flooding ahead while busy families fill the
// forward page leaves the flood's surplus behind the cursor every tick, so
// neither happened: a retry passed once, whose provider had then recovered,
// was not retried for as long as the flood lasted (fourteen ticks and
// counting), and one that kept failing was never given up on. And with
// nothing after the place and nothing ahead, a run read nothing at all, wrote
// nothing, and the rows before the place waited for the next new row.
//
// Driven through the real dispatchPendingPushes on the in-memory database with
// PostgREST's row cap, the web-push mock live, one call per two-hourly tick.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { notificationId } from './helpers/push-dispatch-db';

const providers = vi.hoisted(() => ({ pushed: [] as string[], failuresLeft: new Map<string, number>() }));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (subscription: { endpoint: string }) => {
      const device = subscription.endpoint.split('/').pop()!;
      providers.pushed.push(device);
      const left = providers.failuresLeft.get(device) ?? 0;
      if (left > 0) {
        providers.failuresLeft.set(device, left - 1);
        throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
      }
      return { statusCode: 201 };
    },
  },
}));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));

const { dispatchPendingPushes, PUSH_RETRY_WINDOW_MS } = await import('@/lib/server/push');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const TICK_MS = 2 * 60 * 60 * 1000;
const GLOBAL = 'push_dispatch_cursor:v1:global';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const at = (ms: number) => new Date(ms).toISOString();
let db: InMemorySupabase;
const asDb = () => db as unknown as DB;
const notice = (id: string, familyId: string, userId: string, createdAt: string, title: string): Row => ({
  id, family_id: familyId, user_id: userId, type: 'system', title, body: null, related_type: null, related_id: null,
  is_read: false, send_at: createdAt, created_at: createdAt, pushed_at: null, sent_at: null,
});
const device = (id: string, userId: string): Row => ({
  id, user_id: userId, enabled: true, provider: 'webpush', platform: 'web', endpoint: `https://push.example.test/${id}`,
  p256dh: 'key', auth: 'auth', token: null, last_seen_at: '2026-10-01T00:00:00.000Z',
});
const row = (id: string) => db.table('notifications').find((n) => n.id === id)!;
const stored = () => db.table('app_settings').find((s) => s.key === GLOBAL)?.value as Record<string, unknown> | undefined;
const seedCursor = (value: unknown) => db.seed('app_settings', [{ key: GLOBAL, value, updated_at: NOW.toISOString() }]);
/** The same database, telling `onCall` of every table read and every builder call made on it. */
function recording(onCall: (table: string, method: string, args: unknown[]) => void): DB {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        onCall(table, 'from', []);
        const builder = target.from(table);
        const proxy: object = new Proxy(builder, {
          get(object, key) {
            const value = Reflect.get(object, key);
            if (typeof value !== 'function') return value;
            if (key === 'then') return value.bind(object);
            return (...args: unknown[]) => {
              onCall(table, String(key), args);
              const result = Reflect.apply(value, object, args);
              return result === object ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  }) as unknown as DB;
}

/** Fifteen busy families, a neighbour whose provider is down for a while, and a child who floods. */
const BUSY = Array.from({ length: 15 }, (_, i) => `fam-busy-${i}`);
const NEIGHBOUR_ROW = notificationId(9_999);
const START = { version: 1, createdAt: at(NOW.getTime() - 86_400_000), id: '00000000-0000-4000-8000-00000000ffff' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  providers.pushed = [];
  providers.failuresLeft = new Map();
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  db.seed('user_preferences', []);
  db.seed('family_ai_settings', []);
  db.seed('families', [...BUSY, 'fam-neighbour', 'fam-child'].map((id) => ({ id, timezone: 'UTC', closed_at: null })));
  db.seed('family_members', [
    ...BUSY.map((f, i) => ({ id: `m-busy-${i}`, family_id: f, user_id: `u-busy-${i}`, role: 'parent', is_active: true })),
    { id: 'm-neighbour', family_id: 'fam-neighbour', user_id: 'u-neighbour', role: 'parent', is_active: true },
    { id: 'm-child', family_id: 'fam-child', user_id: 'u-child', role: 'child', is_active: true },
  ]);
  db.seed('push_devices', [...BUSY.map((_, i) => device(`phone-busy-${i}`, `u-busy-${i}`)), device('phone-neighbour', 'u-neighbour')]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/**
 * Each tick: a thousand of the child's rows planted ahead of the cursor, then
 * ten due rows for each busy family, which fill the rest of the forward page,
 * then one dispatch. Until `done`, at most `max` ticks; how many it took.
 */
async function floodedTicks(max: number, done: () => boolean): Promise<number> {
  let ticks = 0;
  for (; ticks < max && !done(); ticks++) {
    const t = NOW.getTime() + ticks * TICK_MS;
    vi.setSystemTime(new Date(t));
    db.seed('notifications', [
      ...Array.from({ length: 1000 }, (_, i) => notice(notificationId(100_000 + ticks * 2000 + i), 'fam-child', 'u-child', at(t - 600_000 + i), 'Planted')),
      ...BUSY.flatMap((f, b) => Array.from({ length: 10 }, (_, j) =>
        notice(notificationId(500_000 + ticks * 1000 + b * 10 + j), f, `u-busy-${b}`, at(t - 60_000 + b * 10 + j), 'Busy'))),
    ]);
    await dispatchPendingPushes(asDb(), { now: new Date(t) });
  }
  return ticks;
}
const neighbourTries = () => providers.pushed.filter((d) => d === 'phone-neighbour').length;

describe('push: a retry the retries have passed is reached again while the forward page is full every tick', () => {
  beforeEach(() => {
    db.seed('notifications', [notice(NEIGHBOUR_ROW, 'fam-neighbour', 'u-neighbour', at(NOW.getTime() - 1_800_000), 'Bin day tomorrow')]);
    seedCursor(START);
  });

  it('a row that failed on its first send and again when the retries reached it goes out on the next tick once its provider recovers', async () => {
    providers.failuresLeft.set('phone-neighbour', 2);

    const ticks = await floodedTicks(14, () => Boolean(row(NEIGHBOUR_ROW).pushed_at));

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(ticks).toBe(3);
    expect(neighbourTries()).toBe(3);
    // Non-vacuity: the forward page was full of the busy families' rows (all
    // of them went out), and the child's flood was left behind the cursor,
    // growing every tick.
    expect(db.table('notifications').filter((n) => String(n.family_id).startsWith('fam-busy') && !n.pushed_at)).toHaveLength(0);
    expect(db.table('notifications').filter((n) => n.family_id === 'fam-child' && !n.pushed_at).length).toBeGreaterThan(2500);
  });

  it('the give-up path: a row that keeps failing is retried every tick under the same load, and given up on once it is past the retry window', async () => {
    providers.failuresLeft.set('phone-neighbour', Number.POSITIVE_INFINITY);
    const windowTicks = Math.ceil(PUSH_RETRY_WINDOW_MS / TICK_MS);

    const ticks = await floodedTicks(windowTicks + 3, () => Boolean(row(NEIGHBOUR_ROW).pushed_at));

    // Stamped, never delivered: the row is given up on, not kept pending for ever.
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(ticks).toBeLessThanOrEqual(windowTicks + 1);
    expect(neighbourTries()).toBe(ticks);
    expect(console.error).toHaveBeenCalledWith(
      '[push] giving up after the retry window; notification never fully delivered', expect.objectContaining({ notificationId: NEIGHBOUR_ROW }),
    );
  });
});

describe('push: with nothing after the retries\' place, a run still reaches the rows before it', () => {
  // The neighbour's row is behind the cursor and not after the retries' place:
  // they passed it, and its provider has since recovered. Nothing else is
  // pending, ahead of the cursor or after the place.
  const POSITION = { createdAt: at(NOW.getTime() - 60_000), id: '00000000-0000-4000-8000-00000000eeee' };
  const PLACE = { createdAt: at(NOW.getTime() - 1_800_000), id: NEIGHBOUR_ROW };

  it.each([
    ['is that row, behind the main position', PLACE.createdAt, { version: 1, ...POSITION, retry: PLACE }],
    ['is ahead of the main position (written by hand)', at(NOW.getTime() - 7_200_000),
      { version: 1, createdAt: at(NOW.getTime() - 3_600_000), id: POSITION.id, retry: PLACE }],
  ])('the retries\' place %s: the row is retried on this run, not after the next new row', async (_, createdAt, cursor) => {
    db.seed('notifications', [notice(NEIGHBOUR_ROW, 'fam-neighbour', 'u-neighbour', createdAt, 'Bin day tomorrow')]);
    seedCursor(cursor);

    const { notifications } = await dispatchPendingPushes(asDb(), { now: NOW });

    expect(notifications).toBe(1);
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(providers.pushed).toEqual(['phone-neighbour']);
    // Non-vacuity: the row was behind the cursor, which did not move past it.
    expect(Date.parse(createdAt)).toBeLessThan(Date.parse(cursor.createdAt));
  });
});

describe('push: the stored cursor with the retries\' place', () => {
  beforeEach(() => {
    db.seed('notifications', [notice(NEIGHBOUR_ROW, 'fam-neighbour', 'u-neighbour', at(NOW.getTime() - 1_800_000), 'Bin day tomorrow')]);
  });

  it('one main wrote (no place, a generation) is read and carried on, and what is written back stays as small as main\'s and readable by it', async () => {
    // As main writes it, plus a field nobody writes, which is not carried on.
    seedCursor({ ...START, generation: '11111111-1111-4111-8111-111111111111', note: 'x'.repeat(5000) });
    providers.failuresLeft.set('phone-neighbour', 2);

    await floodedTicks(4, () => false);

    const cursor = stored()!;
    // main's reader takes version, createdAt and id from the top level and
    // ignores the rest, so a rollback reads this cursor.
    expect(Object.keys(cursor).sort()).toEqual(['createdAt', 'generation', 'id', 'retry', 'version']);
    expect(cursor).toMatchObject({ version: 1, id: expect.stringMatching(UUID), generation: expect.stringMatching(UUID) });
    expect(Object.keys(cursor.retry as object).sort()).toEqual(['createdAt', 'id']);
    expect(JSON.stringify(cursor).length).toBeLessThan(300);
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
  });

  it.each([
    ['a place that is a string', { ...START, retry: 'yesterday' }],
    ['a place that is a list', { ...START, retry: [START.createdAt, START.id] }],
    ['an empty place', { ...START, retry: {} }],
    ['a place whose id is not a uuid', { ...START, retry: { createdAt: START.createdAt, id: 'x),id.gt.(0' } }],
    ['a place whose date is not one', { ...START, retry: { createdAt: '2026-10-23 12:00', id: START.id } }],
    ['a position of another version', { ...START, version: 2 }],
  ])('a cursor with %s is refused before anything is read or sent', async (_, cursor) => {
    seedCursor(cursor);
    const reads: string[] = [];
    const watched = recording((table, method) => { if (method === 'from') reads.push(table); });

    await expect(dispatchPendingPushes(watched, { now: NOW })).rejects.toThrow('Push cursor is invalid.');

    expect(reads).toEqual(['app_settings']);
    expect(providers.pushed).toEqual([]);
    expect(stored()).toEqual(cursor);
  });

  it('two runs overlapping on a cursor with a place: one claims it and sends, the other sends nothing, and the place written is the winner\'s', async () => {
    const PLACE = { createdAt: at(NOW.getTime() - 2 * 86_400_000), id: '00000000-0000-4000-8000-00000000dddd' };
    const before = { ...START, retry: PLACE, generation: '22222222-2222-4222-8222-222222222222' };
    seedCursor(before);
    db.seed('notifications', Array.from({ length: 30 }, (_, i) =>
      notice(notificationId(700_000 + i), BUSY[i % 15], `u-busy-${i % 15}`, at(NOW.getTime() - 600_000 + i), 'Busy')));
    const compared: unknown[] = [];
    const watched = recording((table, method, args) => {
      if (table === 'app_settings' && method === 'eq' && args[0] === 'value') compared.push(JSON.parse(String(args[1])));
    });

    const results = await Promise.all([dispatchPendingPushes(watched, { now: NOW }), dispatchPendingPushes(watched, { now: NOW })]);

    // Both compared the whole stored value, place and generation included.
    expect(compared).toEqual([before, before]);
    expect(results.map((r) => r.notifications).sort((a, b) => a - b)).toEqual([0, 31]);
    // Every row once: no row sent by both runs.
    expect(providers.pushed).toHaveLength(31);
    expect(new Set(providers.pushed).size).toBe(16);
    const after = stored()!;
    expect(after.generation).not.toBe(before.generation);
    expect(after).not.toEqual(before);
  });
});
