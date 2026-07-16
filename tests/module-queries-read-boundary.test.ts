import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Auto and Home record queries previously swallowed read errors and returned
// [] — rendering a misleading "you have no records" empty state when the data was
// really just unreadable. They now fail closed (throw) so the dedicated page shows
// a visible error. Source-of-truth reads, unlike optional enrichment reads.
const createServer = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));

// A universal query chain: every builder method returns the chain, and the chain
// is awaitable, resolving to the configured PostgREST-shaped result.
function queryClient(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, is: () => chain, neq: () => chain,
    not: () => chain, order: () => chain, limit: () => chain, in: () => chain,
    ilike: () => chain, maybeSingle: () => Promise.resolve(result),
    then: (onF: (v: unknown) => unknown) => Promise.resolve(result).then(onF),
  };
  return { from: () => chain };
}

describe('module record queries fail closed on read error', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('auto getVehicles throws (does not return an empty list) when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createServer.mockResolvedValue(queryClient({ data: null, error: { message: 'permission denied for table vehicles' } }));
    const { getVehicles } = await import('@/lib/auto/queries');
    await expect(getVehicles('fam-1')).rejects.toThrow(/Could not load your vehicle records/);
  });

  it('auto getVehicles returns rows on success', async () => {
    createServer.mockResolvedValue(queryClient({ data: [{ id: 'v1' }], error: null }));
    const { getVehicles } = await import('@/lib/auto/queries');
    await expect(getVehicles('fam-1')).resolves.toEqual([{ id: 'v1' }]);
  });

  it('home getWarranties throws when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createServer.mockResolvedValue(queryClient({ data: null, error: { message: 'relation home_warranties does not exist' } }));
    const { getWarranties } = await import('@/lib/home/queries');
    await expect(getWarranties('fam-1')).rejects.toThrow(/Could not load your home records/);
  });

  it('home getAssets returns rows on success', async () => {
    createServer.mockResolvedValue(queryClient({ data: [{ id: 'a1' }], error: null }));
    const { getAssets } = await import('@/lib/home/queries');
    await expect(getAssets('fam-1')).resolves.toEqual([{ id: 'a1' }]);
  });

  it('social getAccounts throws when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createServer.mockResolvedValue(queryClient({ data: null, error: { message: 'permission denied for table social_accounts' } }));
    const { getAccounts } = await import('@/lib/social/queries');
    await expect(getAccounts('fam-1')).rejects.toThrow(/Could not load your social data/);
  });

  it('social getPosts returns rows on success', async () => {
    createServer.mockResolvedValue(queryClient({ data: [{ id: 'p1' }], error: null }));
    const { getPosts } = await import('@/lib/social/queries');
    await expect(getPosts('fam-1')).resolves.toEqual([{ id: 'p1' }]);
  });

  // listReferralsForFamily takes the client directly, so drive it without the
  // createServer mock.
  it('referrals listReferralsForFamily throws when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = queryClient({ data: null, error: { message: 'permission denied for table referrals' } });
    const { listReferralsForFamily } = await import('@/lib/referrals/server');
    await expect(listReferralsForFamily(client as never, 'fam-1')).rejects.toThrow(/Could not load your referrals/);
  });

  it('referrals listReferralsForFamily returns rows on success', async () => {
    const client = queryClient({ data: [{ id: 'r1' }], error: null });
    const { listReferralsForFamily } = await import('@/lib/referrals/server');
    await expect(listReferralsForFamily(client as never, 'fam-1')).resolves.toEqual([{ id: 'r1' }]);
  });
});
