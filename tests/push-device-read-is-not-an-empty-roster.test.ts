import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// A failed `push_devices` read is not "this person owns no phone".
//
// `sendPushToUser` destructured `{ data: devices }` alone, so a refused read
// fell into the `!devices` branch and returned a clean all-zero PushResult.
// `dispatchPendingPushes` reads `failed > 0` to decide whether anything got
// through, so zero failures meant "delivered": it stamped `pushed_at`, the only
// column the pending query filters on, and nothing ever clears it. One blip on
// that table therefore marked every notification in the batch delivered without
// sending one — and the cron answered 200, because it had nothing to count.
vi.mock('@/lib/server/push-endpoint', () => ({
  isDeliverablePushEndpoint: async () => true,
  __resetPushEndpointCache: () => {},
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: () => {}, sendNotification: () => Promise.resolve() },
}));

const NOW = new Date('2026-09-14T12:00:00Z');
const NOTIFICATION = {
  // A real UUID: main's dispatch cursor (PUSH-003) interpolates this id into a
  // PostgREST `or(...)` filter and rejects anything that is not one.
  id: '11111111-1111-4111-8111-111111111111', family_id: 'f1', user_id: 'u1',
  title: 'Chore due', body: 'Take the bins out', related_type: null, related_id: null,
  created_at: '2026-09-14T11:00:00Z',
};
const DEVICE = {
  id: 'd1', platform: 'web', provider: 'webpush',
  endpoint: 'https://push.example.com/x', p256dh: 'k', auth: 'a', token: null,
};

/** Records every `notifications` update, and lets one table refuse its read. */
function fakeSupabase(updates: Record<string, unknown>[], unreadable: string | null) {
  const rows: Record<string, unknown[]> = {
    notifications: [NOTIFICATION],
    push_devices: [DEVICE],
    family_members: [{ user_id: 'u1' }],
  };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain, is: () => chain, lte: () => chain, eq: () => chain,
      in: () => chain, order: () => chain, limit: () => chain, or: () => chain,
      // main added a compare-and-set dispatch cursor in `app_settings` (PUSH-003)
      // after this guard was written. Served as "no cursor stored yet", which is
      // the first-run path: the batch is claimed with a plain upsert and the
      // subject of this file — how a send OUTCOME is counted — is unchanged.
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      upsert: (row: Record<string, unknown>) => ({
        select: () => ({ maybeSingle: () => Promise.resolve({ data: { key: row.key }, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => {
        updates.push({ table, ...patch });
        return { eq: () => Promise.resolve({ error: null }) };
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      then: (onF: (v: unknown) => unknown) => Promise.resolve(
        table === unreadable
          ? { data: null, error: { message: `permission denied for table ${table}` } }
          : { data: rows[table] ?? [], error: null },
      ).then(onF),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient<Database>;
}

describe('an unreadable device roster is a failure, not an empty one', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('counts the refused device read as a failed send', async () => {
    const { dispatchPendingPushes } = await import('@/lib/server/push');
    const { result } = await dispatchPendingPushes(fakeSupabase([], 'push_devices'), { now: NOW });
    expect(result.sent).toBe(0);
    expect(result.failed, 'a refused push_devices read was reported as a clean run').toBe(1);
  });

  it('does NOT stamp pushed_at, so the notification is still delivered later', async () => {
    const updates: Record<string, unknown>[] = [];
    const { dispatchPendingPushes } = await import('@/lib/server/push');
    await dispatchPendingPushes(fakeSupabase(updates, 'push_devices'), { now: NOW });
    expect(
      updates.filter((u) => u.table === 'notifications' && u.pushed_at),
      'a notification nobody was sent was marked delivered',
    ).toEqual([]);
  });

  it('a genuinely empty roster is still a clean, settled no-op', async () => {
    const updates: Record<string, unknown>[] = [];
    const { dispatchPendingPushes } = await import('@/lib/server/push');
    const { result } = await dispatchPendingPushes(fakeSupabase(updates, null), { now: NOW });
    expect(result.failed).toBe(0);
    expect(updates.filter((u) => u.table === 'notifications' && u.pushed_at)).toHaveLength(1);
  });
});
