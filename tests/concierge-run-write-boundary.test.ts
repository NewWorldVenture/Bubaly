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

// `updateRows` models what PostgREST actually returns once the write asks for
// `.select()`: the affected rows. The previous version hardcoded `data: null`
// for every outcome, which is a shape the real client cannot produce for a
// write that matched something — so a confirmed write looked like a no-op and
// this fake, not the code, is what broke when C1-S9-48 added the confirmation.
// Same class as C1-S9-26 and the writeClient repair in C1-S9-46. Pass
// `updateRows: []` to model the case the confirmation exists for.
function client(
  runData: unknown,
  updateError: unknown,
  updateRows: unknown[] = [{ id: 'r1' }],
) {
  const selectChain: Record<string, unknown> = {
    eq: () => selectChain,
    maybeSingle: () => Promise.resolve({ data: runData, error: null }),
  };
  const settle = (onF: (v: { data: unknown; error: unknown }) => unknown) =>
    Promise.resolve({ data: updateError ? null : updateRows, error: updateError }).then(onF);
  const updateChain: Record<string, unknown> = {
    eq: () => updateChain,
    select: () => updateChain,
    then: settle,
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

  it('returns ok:true when the dismiss succeeds', async () => {
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, null));
    const { dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(true);
  });

  it('returns ok:false when the dismiss matched no rows (C1-S9-48)', async () => {
    // No error, and nothing changed — the case a `.select()` exists to detect.
    // Before C1-S9-48 this returned ok, so the run stayed queued while the
    // manager was told it was dismissed, and the next tick offered it again.
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, null, []));
    const { dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(false);
  });
});
