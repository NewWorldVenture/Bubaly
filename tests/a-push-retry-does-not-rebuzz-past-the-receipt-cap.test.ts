import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { notificationId, pushDispatchDb, type PushFixtureRow } from './helpers/push-dispatch-db';
import { dispatchPendingPushes } from '@/lib/server/push';

/**
 * `dispatchPendingPushes` keeps a receipt per device a notification reached
 * (push_deliveries, 0440), so a retry of a partly failed notification skips the
 * devices that already have it. The receipts for a batch of up to 200 pending
 * notifications were read in ONE unpaged `.in('notification_id', ...)`.
 *
 * The rows still pending are exactly the partly failed ones, each holding a
 * receipt for every device it reached, so during a provider outage a batch
 * passes PostgREST's 1,000-row cap. The answer comes back short with no error,
 * and every device whose receipt fell past the cap was buzzed again.
 *
 * The receipt read is now chunked by 100 ids and paged, and every id list the
 * dispatch sends (receipts, push preferences) holds at most 100 ids.
 */

const provider = vi.hoisted(() => ({ endpoints: [] as string[] }));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (subscription: { endpoint: string }) => { provider.endpoints.push(subscription.endpoint); return { statusCode: 201 }; },
  },
}));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true, __resetPushEndpointCache: () => {} }));

type DB = SupabaseClient<Database>;
const NOW = new Date();
const CAP = 1000;

function notice(n: number, userId: string): PushFixtureRow {
  return {
    id: notificationId(n), family_id: 'family', user_id: userId, title: `Notice ${n}`, body: 'Body', related_type: null,
    pushed_at: null, send_at: new Date(NOW.getTime() - 60_000).toISOString(),
    // Fresh, so a retry is still inside the push retry window.
    created_at: new Date(NOW.getTime() - 60_000 + n).toISOString(),
  };
}
const device = (id: string, userId: string): PushFixtureRow => ({
  id, user_id: userId, enabled: true, provider: 'webpush', endpoint: `https://push.example.test/${id}`, p256dh: 'key', auth: 'auth',
});

/** Records the size of every `.in()` id list the dispatch sends. */
function recordingIn(db: DB, sizes: { table: string; key: string; n: number }[]): DB {
  const from = (db as unknown as { from: (t: string) => Record<string, unknown> }).from;
  return {
    from: (table: string) => {
      const query = from(table);
      const original = query.in as (key: string, values: unknown[]) => unknown;
      query.in = (key: string, values: unknown[]) => { sizes.push({ table, key, n: values.length }); return original(key, values); };
      return query;
    },
  } as unknown as DB;
}

beforeEach(() => {
  provider.endpoints = [];
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'fixture-public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'fixture-private-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a push retry', () => {
  it('does not re-send to devices whose receipts sit past the server row cap', async () => {
    // 150 notifications each reached 11 of one member's 12 devices: 1,650
    // receipts, and 1,100 in a single chunk of 100 notifications, so a chunk
    // must be paged too. Only the twelfth device has anything left to receive.
    const devices = Array.from({ length: 12 }, (_, i) => device(`d${String(i).padStart(2, '0')}`, 'u1'));
    const notifications = Array.from({ length: 150 }, (_, n) => notice(n + 1, 'u1'));
    const receipts = notifications.flatMap((n) => devices.slice(0, 11).map((d) => ({ notification_id: n.id, device_id: d.id })));
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications, push_devices: devices, push_deliveries: receipts,
      family_members: [{ id: 'm1', user_id: 'u1', family_id: 'family', role: 'parent', is_active: true }],
      family_ai_settings: [], user_preferences: [],
    }, { maxRows: CAP });

    await dispatchPendingPushes(f.db, { now: NOW, limit: 200 });

    const resent = provider.endpoints.filter((e) => !e.endsWith('/d11'));
    expect(resent.length, 'devices buzzed again for a notification they already had').toBe(0);
    expect(provider.endpoints).toHaveLength(150);
    expect(f.tables.notifications.every((n) => n.pushed_at)).toBe(true);
  });

  it('sends no id list longer than 100 for a full batch of 200 recipients', async () => {
    const users = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: users.map((u, i) => notice(i + 1, u)),
      push_devices: users.map((u) => device(`d-${u}`, u)),
      family_members: users.map((u, i) => ({ id: `m${String(i).padStart(3, '0')}`, user_id: u, family_id: 'family', role: 'parent', is_active: true })),
      family_ai_settings: [], user_preferences: [],
    });
    const sizes: { table: string; key: string; n: number }[] = [];

    const out = await dispatchPendingPushes(recordingIn(f.db, sizes), { now: NOW, limit: 200 });

    expect(out.result.sent).toBe(200);
    expect(sizes.filter((s) => s.n > 100), 'an id list past the 100 the repo bounds a URL filter to').toEqual([]);
    // Non-vacuity: the receipts and preferences were read by id.
    expect(sizes.some((s) => s.table === 'push_deliveries')).toBe(true);
    expect(sizes.some((s) => s.table === 'user_preferences')).toBe(true);
  });

  it('sends nothing when a receipt chunk cannot be read', async () => {
    const users = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const f = pushDispatchDb({
      families: [{ id: 'family', closed_at: null }],
      notifications: users.map((u, i) => notice(i + 1, u)),
      push_devices: users.map((u) => device(`d-${u}`, u)),
      family_members: users.map((u, i) => ({ id: `m${String(i).padStart(3, '0')}`, user_id: u, family_id: 'family', role: 'parent', is_active: true })),
      family_ai_settings: [], user_preferences: [],
    });
    // The second receipt request fails: the first chunk read fine.
    f.faults.add('push_deliveries:select:2');

    await expect(dispatchPendingPushes(f.db, { now: NOW, limit: 200 })).rejects.toThrow('Push receipt read failed.');
    expect(provider.endpoints).toEqual([]);
  });
});
