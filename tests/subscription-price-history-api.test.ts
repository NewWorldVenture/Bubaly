import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/subscriptions/price-history/route';

const mocks = vi.hoisted(() => ({ context: vi.fn(), createServer: vi.fn(), superAdmin: vi.fn(), plan: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: mocks.context, isSuperAdmin: mocks.superAdmin }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: mocks.plan }));

const ID = '10000000-0000-4000-8000-000000000001';
type ReadResult = { data: unknown; error: unknown; count?: number | null };
let results: Record<string, ReadResult>;
let queries: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
let from: ReturnType<typeof vi.fn>;
const contextFor = (role = 'parent') => ({ user: { id: 'user-a' }, active: { familyId: 'family-a', role, member: { id: 'member-a', is_active: true } } });
const request = (query = `subscriptionId=${ID}`) => new Request(`http://localhost/api/subscriptions/price-history?${query}`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  mocks.context.mockReset().mockResolvedValue(contextFor());
  mocks.superAdmin.mockReset().mockResolvedValue(false);
  mocks.plan.mockReset().mockResolvedValue(2);
  results = {
    app_settings: { data: { value: {} }, error: null },
    transactions: { data: ['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => ({ id: `txn-${i}`, family_id: 'family-a', name: 'Example Media', amount: i === 2 ? 18 : 15, type: 'expense', date, category: 'Subscriptions', account_id: 'account-a', member_id: 'member-a' })), error: null, count: 3 },
    subscriptions_tracked: { data: { id: ID, family_id: 'family-a', name: 'Example Media', cost_cents: 1500, cadence: 'monthly', note: null }, error: null },
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

describe('authorized recorded subscription charge history API', () => {
  it('uses exact authenticated identity and family-filtered bounded RLS reads only', async () => {
    const response = await GET(request(`subscriptionId=${ID}&familyId=another-family`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.context).toEqual({ familyId: 'family-a', userId: 'user-a', memberId: 'member-a', role: 'parent', active: true });
    expect(body.history.state).toBe('matched');
    expect(body.history.groups[0].evidence[2].differenceFromTrackedCents).toBe(300);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    for (const table of ['transactions', 'subscriptions_tracked', 'financial_accounts']) expect(queries[table].eq).toHaveBeenCalledWith('family_id', 'family-a');
    expect(queries.subscriptions_tracked.eq).toHaveBeenCalledWith('id', ID);
    expect(queries.transactions.eq).toHaveBeenCalledWith('type', 'expense');
    expect(queries.transactions.select).toHaveBeenCalledWith(expect.any(String), { count: 'exact' });
    expect(queries.transactions.limit).toHaveBeenCalledWith(501);
    expect(queries.transactions.gte).toHaveBeenCalledWith('date', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(queries.transactions.lte).toHaveBeenCalledWith('date', '2026-09-06');
    expect(queries.financial_accounts.in).toHaveBeenCalledWith('id', ['account-a']);
    expect(from.mock.calls.map(([table]) => table).sort()).toEqual(['app_settings', 'financial_accounts', 'subscriptions_tracked', 'transactions']);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('denies %s before source access, even for a super-admin login', async (role) => {
    mocks.context.mockResolvedValue(contextFor(role));
    mocks.superAdmin.mockResolvedValue(true);
    expect((await GET(request())).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('allows active adults, but not signed-out, missing-family or inactive membership requests', async () => {
    mocks.context.mockResolvedValue(contextFor('adult'));
    expect((await GET(request())).status).toBe(200);
    mocks.context.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    mocks.context.mockResolvedValue({ needsFamily: true });
    expect((await GET(request())).status).toBe(403);
    const inactive = contextFor();
    inactive.active.member.is_active = false;
    mocks.context.mockResolvedValue(inactive);
    expect((await GET(request())).status).toBe(403);
  });

  it.each(['', 'subscriptionId=bad', `subscriptionId=${ID}&subscriptionId=${ID}`])('rejects invalid target query %s', async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['subscription-tracking', 'finances'])('honors disabled %s access', async (key) => {
    results.app_settings.data = { value: { [key]: 'off' } };
    expect((await GET(request())).status).toBe(404);
    expect(from).not.toHaveBeenCalledWith('transactions');
  });

  it('checks the family plan before recorded expenses', async () => {
    mocks.plan.mockResolvedValue(0);
    expect((await GET(request())).status).toBe(403);
    expect(from).not.toHaveBeenCalledWith('transactions');
  });

  it.each(['app_settings', 'transactions', 'subscriptions_tracked', 'financial_accounts'])('returns %s failure explicitly, without false empty evidence or source-error disclosure', async (table) => {
    results[table].error = { message: 'private source failure' };
    const response = await GET(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toHaveProperty('error');
    expect(body).not.toHaveProperty('history');
    expect(JSON.stringify(body)).not.toContain('private source failure');
  });

  it('does not fetch expenses for a missing or inaccessible tracked subscription', async () => {
    results.subscriptions_tracked.data = null;
    expect((await GET(request())).status).toBe(404);
    expect(from).not.toHaveBeenCalledWith('transactions');
  });

  it.each(['transactions', 'subscriptions_tracked', 'financial_accounts'])('rejects cross-family %s rows without returning their content', async (table) => {
    const foreign = { id: table === 'subscriptions_tracked' ? ID : 'foreign-id', family_id: 'another-family', name: 'Private merchant' };
    results[table].data = table === 'subscriptions_tracked' ? foreign : [foreign];
    if (table === 'transactions') results[table].count = 1;
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('Private merchant');
  });

  it.each([undefined, null, NaN, Infinity, -1, 0.5])('never treats missing or invalid source count %s as complete history', async (count) => {
    results.transactions.count = count;
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('history');
  });

  it('rejects count/row mismatch and labels honest truncation without enabling a matched prefill', async () => {
    results.transactions.count = 4;
    expect((await GET(request())).status).toBe(503);
    const original = results.transactions.data as { id: string; name: string }[];
    results.transactions.data = Array.from({ length: 501 }, (_, i) => i < 3 ? original[i] : { ...original[0], id: `bounded-${i}`, name: `Other merchant ${i}` });
    results.transactions.count = 900;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ history: { state: 'unknown', coverage: { state: 'limited', recordsRead: 500, totalRecords: 900 } } });
  });

  it.each(['EUR', null])('does not infer or convert unavailable or %s currency', async (currency) => {
    results.financial_accounts.data = currency ? [{ id: 'account-a', family_id: 'family-a', currency }] : [];
    expect(await (await GET(request())).json()).toMatchObject({ history: { state: 'unknown', groups: [], excluded: { unsupportedCurrencyRecords: 3 } } });
  });

  it('returns a truthful empty window after successful empty reads', async () => {
    results.transactions = { data: [], error: null, count: 0 };
    expect(await (await GET(request())).json()).toMatchObject({ history: { state: 'unknown', groups: [], coverage: { state: 'complete', recordsRead: 0 } } });
    expect(from).not.toHaveBeenCalledWith('financial_accounts');
  });
});
