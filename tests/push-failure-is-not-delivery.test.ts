import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// A push that FAILED to send is still stamped `pushed_at`, and `pushed_at` is
// the only thing the pending-push query filters on. Nothing ever clears it and
// no retry exists, so a provider outage drops the notification permanently.
// The endpoint's SSRF re-check (audit C3-S5-03) resolves the hostname before
// each send and fails closed. This file is about how a FAILED send is counted,
// not about where the endpoint points, and push.example.com does not resolve —
// so the guard is stubbed open here to keep the subject of the test the send.
vi.mock('@/lib/server/push-endpoint', () => ({
  isDeliverablePushEndpoint: async () => true,
  __resetPushEndpointCache: () => {},
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    // 500 is the interesting status: 404/410 prune the device, anything else
    // counts as `failed` and is the transient-outage case.
    sendNotification: () => Promise.reject(Object.assign(new Error('upstream down'), { statusCode: 500 })),
  },
}));

const NOW = new Date('2026-09-14T12:00:00Z');
const NOTIFICATION = {
  id: 'n1', family_id: 'f1', user_id: 'u1',
  title: 'Chore due', body: 'Take the bins out', related_type: null, related_id: null,
  created_at: '2026-09-14T11:00:00Z',
};
const DEVICE = {
  id: 'd1', platform: 'web', provider: 'webpush',
  endpoint: 'https://push.example.com/x', p256dh: 'k', auth: 'a', token: null,
};

/** Records every `notifications` update so we can see what was stamped. */
function fakeSupabase(updates: Record<string, unknown>[], createdAt = NOTIFICATION.created_at) {
  const rows: Record<string, unknown[]> = {
    notifications: [{ ...NOTIFICATION, created_at: createdAt }],
    push_devices: [DEVICE],
    family_members: [{ user_id: 'u1' }],
    child_channels: [],
  };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain, is: () => chain, lte: () => chain, eq: () => chain,
      in: () => chain, order: () => chain, limit: () => chain,
      update: (patch: Record<string, unknown>) => {
        updates.push({ table, ...patch });
        return { eq: () => Promise.resolve({ error: null }) };
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(onF),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient<Database>;
}

describe('a failed push is not a delivery', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it('counts the send as failed', async () => {
    const { dispatchPendingPushes } = await import('@/lib/server/push');
    const { result } = await dispatchPendingPushes(fakeSupabase([]), { now: NOW });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
  });

  it('does NOT stamp pushed_at when every send failed, so the next run retries', async () => {
    const updates: Record<string, unknown>[] = [];
    const { dispatchPendingPushes } = await import('@/lib/server/push');
    await dispatchPendingPushes(fakeSupabase(updates), { now: NOW });
    const stamped = updates.filter((u) => u.table === 'notifications' && u.pushed_at);
    expect(stamped).toEqual([]);
  });

  it('gives up once the retry window has passed, so a dead endpoint cannot retry forever', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const updates: Record<string, unknown>[] = [];
    const { dispatchPendingPushes } = await import('@/lib/server/push');
    // Two days old, against a 24h window.
    await dispatchPendingPushes(fakeSupabase(updates, '2026-09-12T12:00:00Z'), { now: NOW });
    expect(updates.filter((u) => u.table === 'notifications' && u.pushed_at)).toHaveLength(1);
  });
});
