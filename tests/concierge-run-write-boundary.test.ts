import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// dismissQueuedRunAction (a manager action) previously discarded the status-update
// result and returned { ok: true } even when the write failed — so the run stayed
// "pending" in the UI while the manager was told it was dismissed. It now returns
// { ok: false } on a write error.
const requireUserContext = vi.fn();
const createServer = vi.fn();
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

/**
 * `updateRows` is the third outcome, and the reason this stub grew.
 *
 * The action now reads the row back, because RLS FILTERS an UPDATE rather than
 * refusing it: a dismiss the policy blocks answers `error: null` with zero rows,
 * which is neither the error case nor the success case. A stub that returned
 * `data: null` for every update could not express it — and it could not even
 * reach the code, because it offered no `.select()` at all.
 */
function client(runData: unknown, updateError: unknown, updateRows: unknown[] | null = [{ id: 'r1' }]) {
  const selectChain: Record<string, unknown> = {
    eq: () => selectChain,
    maybeSingle: () => Promise.resolve({ data: runData, error: null }),
  };
  const settled = { data: updateRows, error: updateError };
  const updateChain: Record<string, unknown> = {
    eq: () => updateChain,
    select: () => Promise.resolve(settled),
    then: (onF: (v: typeof settled) => unknown) => Promise.resolve(settled).then(onF),
  };
  return { from: () => ({ select: () => selectChain, update: () => updateChain }) };
}

describe('dismissQueuedRunAction write boundary', () => {
  beforeEach(() => {
    requireUserContext.mockResolvedValue({ active: { familyId: 'fam-1', role: 'parent' }, user: { id: 'user-1' } });
  });
  afterEach(() => vi.clearAllMocks());

  it('returns ok:false when the dismiss status update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, { message: 'update failed' }));
    const { dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(false);
  });

  it('returns ok:false when RLS filtered the dismiss away, with no error at all', async () => {
    // The case the readback exists for: zero rows and `error: null`. Before it, the
    // run stayed "pending" and the manager was told it was dismissed — the exact
    // defect the header describes, one layer down from the one it fixed.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, null, []));
    const { dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(false);
  });

  it('returns ok:true when the dismiss succeeds', async () => {
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, null));
    const { dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(true);
  });
});
