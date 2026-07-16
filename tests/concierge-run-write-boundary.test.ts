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

function client(runData: unknown, updateError: unknown) {
  const selectChain: Record<string, unknown> = {
    eq: () => selectChain,
    maybeSingle: () => Promise.resolve({ data: runData, error: null }),
  };
  const updateChain: Record<string, unknown> = {
    eq: () => updateChain,
    then: (onF: (v: { data: null; error: unknown }) => unknown) => Promise.resolve({ data: null, error: updateError }).then(onF),
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
});
