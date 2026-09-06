import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/subscriptions/candidates/route';

const mocks = vi.hoisted(() => ({ context: vi.fn(), createServer: vi.fn(), superAdmin: vi.fn(), plan: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: mocks.context, isSuperAdmin: mocks.superAdmin }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: mocks.plan }));

type ReadResult = { data: unknown; error: unknown; count?: number | null };
let results: Record<string, ReadResult>;
let queries: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
let from: ReturnType<typeof vi.fn>;
const contextFor = (role = 'parent') => ({ user: { id: 'user-a' }, active: { familyId: 'family-a', role, member: { id: 'member-a', is_active: true } } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  mocks.context.mockReset().mockResolvedValue(contextFor());
  mocks.superAdmin.mockReset().mockResolvedValue(false);
  mocks.plan.mockReset().mockResolvedValue(2);
  results = {
    app_settings: { data: { value: {} }, error: null },
    transactions: { data: ['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => ({ id: `txn-${i}`, family_id: 'family-a', name: 'Example Media', amount: 15, type: 'expense', date, category: 'Subscriptions', account_id: 'account-a', member_id: 'member-a' })), error: null, count: 3 },
    subscriptions_tracked: { data: [], error: null, count: 0 },
    financial_accounts: { data: [{ id: 'account-a', family_id: 'family-a', currency: 'USD' }], error: null },
  };
  queries = {};
  from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const methods: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'in']) { methods[name] = vi.fn(() => chain); chain[name] = methods[name]; }
    methods.maybeSingle = vi.fn(async () => results[table]);
    chain.maybeSingle = methods.maybeSingle;
    chain.then = (resolve: (value: ReadResult) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(results[table]).then(resolve, reject);
    queries[table] = methods;
    return chain;
  });
  mocks.createServer.mockReset().mockResolvedValue({ from });
});

afterEach(() => vi.useRealTimers());

describe('read-only subscription candidate API', () => {
  it('uses the authenticated family, bounded RLS client reads and actual account currency', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.familyId).toBe('family-a');
    expect(body.context).toEqual({ familyId: 'family-a', userId: 'user-a', memberId: 'member-a', role: 'parent', active: true });
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].evidence[0].recordId).toBe('txn-0');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    for (const table of ['transactions', 'subscriptions_tracked', 'financial_accounts']) expect(queries[table].eq).toHaveBeenCalledWith('family_id', 'family-a');
    expect(queries.transactions.eq).toHaveBeenCalledWith('type', 'expense');
    expect(queries.transactions.limit).toHaveBeenCalledWith(501);
    expect(queries.transactions.lte).toHaveBeenCalledWith('date', '2026-09-06');
    expect(queries.financial_accounts.in).toHaveBeenCalledWith('id', ['account-a']);
    expect(from.mock.calls.map(([table]) => table).sort()).toEqual(['app_settings', 'financial_accounts', 'subscriptions_tracked', 'transactions']);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('denies the %s role before reading sources', async (role) => {
    mocks.context.mockResolvedValue(contextFor(role));
    expect((await GET()).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('allows an adult manager and denies signed-out or missing-family context', async () => {
    mocks.context.mockResolvedValue(contextFor('adult'));
    expect((await GET()).status).toBe(200);
    mocks.context.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    mocks.context.mockResolvedValue({ needsFamily: true });
    expect((await GET()).status).toBe(403);
  });

  it.each(['subscription-tracking', 'finances'])('honors disabled %s access', async (key) => {
    results.app_settings.data = { value: { [key]: 'off' } };
    expect((await GET()).status).toBe(404);
    expect(from).not.toHaveBeenCalledWith('transactions');
  });

  it('honors plan gating without fetching expense data', async () => {
    mocks.plan.mockResolvedValue(0);
    expect((await GET()).status).toBe(403);
    expect(from).not.toHaveBeenCalledWith('transactions');
  });

  it('rejects an inactive membership before any source access', async () => {
    const context = contextFor();
    context.active.member.is_active = false;
    mocks.context.mockResolvedValue(context);
    expect((await GET()).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['app_settings', 'transactions', 'subscriptions_tracked', 'financial_accounts'])('returns %s failures explicitly without a false empty result', async (table) => {
    results[table].error = { message: 'private source error' };
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toHaveProperty('error');
    expect(body).not.toHaveProperty('candidates');
    expect(JSON.stringify(body)).not.toContain('private source error');
  });

  it.each(['transactions', 'subscriptions_tracked', 'financial_accounts'])('rejects unexpected cross-family %s rows', async (table) => {
    results[table].data = [{ family_id: 'another-family', name: 'Private merchant' }];
    results[table].count = 1;
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('Private merchant');
  });

  it('omits expenses when their account currency is non-USD or inaccessible', async () => {
    results.financial_accounts.data = [{ id: 'account-a', family_id: 'family-a', currency: 'EUR' }];
    expect(await (await GET()).json()).toMatchObject({ candidates: [], unsupportedCurrencyRecords: 3 });
    results.financial_accounts.data = [];
    expect(await (await GET()).json()).toMatchObject({ candidates: [], unsupportedCurrencyRecords: 3 });
  });

  it('suppresses tracked duplicates and reports an incomplete duplicate comparison as a failure', async () => {
    results.subscriptions_tracked = { data: [{ family_id: 'family-a', name: 'Example Media', note: null }], error: null, count: 1 };
    expect(await (await GET()).json()).toMatchObject({ candidates: [] });
    results.subscriptions_tracked.count = 501;
    expect((await GET()).status).toBe(503);
  });

  it('labels a bounded partial history and does not silently accept missing source rows', async () => {
    const original = results.transactions.data as { id: string }[];
    results.transactions.data = Array.from({ length: 501 }, (_, i) => ({ ...original[i % 3], id: `bounded-${i}` }));
    results.transactions.count = 900;
    expect(await (await GET()).json()).toMatchObject({ limited: true, recordsRead: 500 });
    results.transactions.data = [];
    expect((await GET()).status).toBe(503);
  });

  it('returns a genuine empty review only after successful empty source reads', async () => {
    results.transactions = { data: [], error: null, count: 0 };
    expect(await (await GET()).json()).toMatchObject({ candidates: [], recordsRead: 0, limited: false });
  });
});
