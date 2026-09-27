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

// The dismiss write is compare-and-set on status = 'pending' and asks for the
// rows it changed (`.select('id')`), so `written` is what that write matched.
function client(runData: unknown, updateError: unknown, written: unknown[] = [{ id: 'r1' }]) {
  const selectChain: Record<string, unknown> = {
    eq: () => selectChain,
    maybeSingle: () => Promise.resolve({ data: runData, error: null }),
  };
  const updateChain: Record<string, unknown> = {
    eq: () => updateChain,
    select: () => updateChain,
    then: (onF: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
      Promise.resolve({ data: updateError ? null : written, error: updateError }).then(onF),
  };
  return { from: () => ({ select: () => selectChain, update: () => updateChain }) };
}

// Imported ONCE, at module load, after the mocks above are hoisted. The action
// module pulls in the approvals service, the trust engine and the i18n server;
// importing it inside each case put that whole transform inside the case's 5 s
// budget, and on a loaded machine the first case timed out while the action
// itself ran in milliseconds.
const { dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');

describe('dismissQueuedRunAction write boundary', () => {
  beforeEach(() => {
    requireUserContext.mockResolvedValue({ active: { familyId: 'fam-1', role: 'parent' }, user: { id: 'user-1' } });
  });
  afterEach(() => vi.clearAllMocks());

  it('returns ok:false when the dismiss status update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, { message: 'update failed' }));
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(false);
  });

  it('returns ok:true when the dismiss succeeds', async () => {
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, null));
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(true);
  });

  it('returns ok:false when the write matched no pending row — someone else resolved the run first', async () => {
    createServer.mockResolvedValue(client({ id: 'r1', status: 'pending', metadata: {} }, null, []));
    const res = await dismissQueuedRunAction('r1');
    expect(res.ok).toBe(false);
  });
});
