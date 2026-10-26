// household-roles round 10 (R9-RV2-RETRY-RESERVE-ALWAYS-RESTARTS-AT-THE-OLDEST-ROW-BEHIND):
// the retries behind the push cursor keep a place of their own.
//
// Round 9 kept a quarter of every read for the rows behind the cursor
// (PUSH_RETRY_SHARE), but the read behind always started from the OLDEST
// pending row there, and the cursor wraps only once everything ahead of it
// has been taken, which a child's flood ahead prevents. So under a sustained
// flood the reserve re-read the same oldest rows every tick: a retry whose
// provider had recovered, behind a reserve's worth of older rows still
// failing, waited until those aged out of the retry window (24 hours), or for
// good if they were skipped for configuration.
//
// The stored cursor now carries where the retries go on from (`retry`), and
// they start again from the oldest once they have taken everything behind.
// Driven through the real dispatchPendingPushes on the in-memory database
// with PostgREST's row cap, the web-push mock live, one call per two-hourly
// tick.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { notificationId } from './helpers/push-dispatch-db';

const providers = vi.hoisted(() => ({ pushed: [] as string[], failing: new Set<string>() }));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (subscription: { endpoint: string }) => {
      const device = subscription.endpoint.split('/').pop()!;
      providers.pushed.push(device);
      if (providers.failing.has(device)) throw Object.assign(new Error('provider unavailable'), { statusCode: 503 });
      return { statusCode: 201 };
    },
  },
}));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));

const { dispatchPendingPushes } = await import('@/lib/server/push');

type DB = SupabaseClient<Database>;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const TICK_MS = 2 * 60 * 60 * 1000;
const GLOBAL = 'push_dispatch_cursor:v1:global';
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

const FAMILIES = Array.from({ length: 6 }, (_, i) => `fam-old-${i}`);
const NEIGHBOUR_ROW = notificationId(9_999);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  providers.pushed = [];
  providers.failing = new Set();
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  db.seed('user_preferences', []);
  db.seed('family_ai_settings', []);
  // Six families of four whose provider is down, a neighbour whose provider
  // was down and has recovered, and a child who floods.
  const members: Row[] = [];
  const devices: Row[] = [];
  for (const [f, fam] of FAMILIES.entries()) for (let u = 0; u < 4; u++) {
    members.push({ id: `m-${f}-${u}`, family_id: fam, user_id: `u-${f}-${u}`, role: 'parent', is_active: true });
    devices.push(device(`phone-${f}-${u}`, `u-${f}-${u}`));
    providers.failing.add(`phone-${f}-${u}`);
  }
  members.push({ id: 'm-neighbour', family_id: 'fam-neighbour', user_id: 'u-neighbour', role: 'parent', is_active: true });
  members.push({ id: 'm-child', family_id: 'fam-child', user_id: 'u-child', role: 'child', is_active: true });
  devices.push(device('phone-neighbour', 'u-neighbour'));
  db.seed('families', [...FAMILIES, 'fam-neighbour', 'fam-child'].map((id) => ({ id, timezone: 'UTC', closed_at: null })));
  db.seed('family_members', members);
  db.seed('push_devices', devices);
  // Behind the cursor: 210 older rows of the six families (35 each, inside
  // both shares) that still fail, then the neighbour's row that failed.
  let n = 1;
  const rows: Row[] = [];
  for (const [f, fam] of FAMILIES.entries()) for (let k = 0; k < 35; k++) {
    rows.push(notice(notificationId(n++), fam, `u-${f}-${k % 4}`, at(NOW.getTime() - 3_000_000 + f * 100 + k), 'Older'));
  }
  rows.push(notice(NEIGHBOUR_ROW, 'fam-neighbour', 'u-neighbour', at(NOW.getTime() - 60_000), 'Bin day tomorrow'));
  db.seed('notifications', rows);
  db.seed('app_settings', [{
    key: GLOBAL, value: { version: 1, createdAt: at(NOW.getTime() - 30_000), id: '00000000-0000-4000-8000-00000000ffff' },
    updated_at: NOW.toISOString(),
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** One dispatch a tick, a thousand of the child's rows planted ahead before each, until the neighbour's row is pushed. */
async function ticksUntilRetried(max: number, flood: boolean): Promise<number> {
  let ticks = 0;
  for (; ticks < max && !row(NEIGHBOUR_ROW).pushed_at; ticks++) {
    const t = new Date(NOW.getTime() + (ticks + 1) * TICK_MS);
    vi.setSystemTime(t);
    if (flood) {
      db.seed('notifications', Array.from({ length: 1000 }, (_, i) =>
        notice(notificationId(200_000 + ticks * 1000 + i), 'fam-child', 'u-child', at(t.getTime() - 60_000 + i), 'Planted')));
    }
    await dispatchPendingPushes(asDb(), { now: t });
  }
  return ticks;
}

describe('push: a recovered retry behind older retries that still fail', () => {
  it('is retried within two ticks while a child floods ahead of the cursor every tick', async () => {
    const ticks = await ticksUntilRetried(6, true);

    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
    expect(ticks).toBeLessThanOrEqual(2);
    expect(providers.pushed).toContain('phone-neighbour');
    // Non-vacuity: the six families' rows are still failing and pending, and the flood still waits.
    expect(db.table('notifications').filter((n) => FAMILIES.includes(n.family_id as string) && !n.pushed_at)).toHaveLength(210);
    expect(db.table('notifications').some((n) => n.family_id === 'fam-child' && !n.pushed_at)).toBe(true);
  });

  it('control: the older ones are reached again, as the retries start again from the oldest once they have been through them all', async () => {
    await ticksUntilRetried(6, true);
    const oldest = notificationId(1);
    const before = providers.pushed.length;
    // The six families' provider recovers too; the flood goes on.
    providers.failing.clear();
    for (let tick = 0; tick < 3 && !row(oldest).pushed_at; tick++) {
      const t = new Date(NOW.getTime() + (10 + tick) * TICK_MS);
      vi.setSystemTime(t);
      db.seed('notifications', Array.from({ length: 1000 }, (_, i) =>
        notice(notificationId(300_000 + tick * 1000 + i), 'fam-child', 'u-child', at(t.getTime() - 60_000 + i), 'Planted')));
      await dispatchPendingPushes(asDb(), { now: t });
    }
    expect(row(oldest).pushed_at).toBeTruthy();
    expect(providers.pushed.length).toBeGreaterThan(before);
  });

  it('control: without the flood it is retried on the second tick, as the traversal wraps', async () => {
    expect(await ticksUntilRetried(6, false)).toBe(2);
    expect(row(NEIGHBOUR_ROW).pushed_at).toBeTruthy();
  });

  it('the retries\' place is part of the stored cursor, and a cursor whose place is not one is refused', async () => {
    vi.setSystemTime(new Date(NOW.getTime() + TICK_MS));
    db.seed('notifications', Array.from({ length: 1000 }, (_, i) =>
      notice(notificationId(200_000 + i), 'fam-child', 'u-child', at(NOW.getTime() + TICK_MS - 60_000 + i), 'Planted')));
    await dispatchPendingPushes(asDb(), { now: new Date(NOW.getTime() + TICK_MS) });
    const cursor = stored()!;
    expect(cursor.retry).toEqual({ createdAt: expect.any(String), id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(Date.parse((cursor.retry as { createdAt: string }).createdAt)).toBeLessThan(Date.parse(cursor.createdAt as string));

    db.table('app_settings').find((s) => s.key === GLOBAL)!.value = { ...cursor, retry: { createdAt: 'yesterday', id: 'x' } };
    await expect(dispatchPendingPushes(asDb(), { now: new Date(NOW.getTime() + 2 * TICK_MS) })).rejects.toThrow('Push cursor is invalid.');
  });
});
