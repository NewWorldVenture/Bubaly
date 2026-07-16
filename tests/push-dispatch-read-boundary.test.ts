import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { dispatchPendingPushes } from '@/lib/server/push';

// dispatchPendingPushes previously discarded the pending-push read error, so a
// failed read returned "0 notifications" — indistinguishable from an empty queue
// — silently dropping every push. It now fails closed (throws) so the caller
// (cron / on-demand) counts a dispatch failure instead of hiding it.
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {
    select: () => c, is: () => c, eq: () => c, order: () => c, limit: () => c,
    then: (onF: (v: unknown) => unknown) => Promise.resolve(result).then(onF),
  };
  return c;
}

function fakeSupabase(result: { data: unknown; error: unknown }): SupabaseClient<Database> {
  return { from: () => chain(result) } as unknown as SupabaseClient<Database>;
}

describe('dispatchPendingPushes read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws when the pending-push read fails (instead of reporting 0)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({ data: null, error: { message: 'permission denied for table notifications' } });
    await expect(dispatchPendingPushes(supabase)).rejects.toThrow(/Pending-push read failed/);
  });

  it('returns an empty result (no throw) when the queue is genuinely empty', async () => {
    const supabase = fakeSupabase({ data: [], error: null });
    await expect(dispatchPendingPushes(supabase)).resolves.toEqual({
      notifications: 0,
      result: { sent: 0, skipped: 0, failed: 0, pruned: 0 },
    });
  });
});
