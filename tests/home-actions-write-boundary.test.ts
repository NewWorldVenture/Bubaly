import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the auth context and the Supabase server client so the write path can be
// driven deterministically. These actions previously discarded the write result
// and returned normally on failure — the user saw "saved" while the row was lost.
const requireUserContext = vi.fn();
const createServer = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// A write chain whose terminal awaited call resolves to the supplied result.
// insert() is itself awaitable; update() returns a chain whose .eq().eq() resolves.
function writeClient(result: { error: unknown }) {
  const eqChain: Record<string, unknown> = {
    eq: () => eqChain,
    then: (onF: (v: { data: null; error: unknown }) => unknown) => Promise.resolve({ data: null, error: result.error }).then(onF),
  };
  return {
    from: () => ({
      insert: () => Promise.resolve({ data: null, error: result.error }),
      update: () => eqChain,
    }),
  };
}

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe('home actions write boundary', () => {
  beforeEach(() => {
    requireUserContext.mockResolvedValue({ active: { familyId: 'fam-1' }, user: { id: 'user-1' } });
  });
  afterEach(() => vi.clearAllMocks());

  it('saveWarrantyAction throws when the insert fails instead of silently succeeding', async () => {
    createServer.mockResolvedValue(writeClient({ error: { message: 'new row violates row-level security policy' } }));
    const { saveWarrantyAction } = await import('@/app/(app)/dashboard/home/actions');
    await expect(saveWarrantyAction(fd({ name: 'Fridge warranty' }))).rejects.toThrow();
  });

  it('saveContractorAction resolves when the insert succeeds', async () => {
    createServer.mockResolvedValue(writeClient({ error: null }));
    const { saveContractorAction } = await import('@/app/(app)/dashboard/home/actions');
    await expect(saveContractorAction(fd({ name: 'Ace Plumbing' }))).resolves.toBeUndefined();
  });

  it('deleteWarrantyAction throws when the soft-delete update fails', async () => {
    createServer.mockResolvedValue(writeClient({ error: { message: 'permission denied' } }));
    const { deleteWarrantyAction } = await import('@/app/(app)/dashboard/home/actions');
    await expect(deleteWarrantyAction('w-1')).rejects.toThrow();
  });
});
