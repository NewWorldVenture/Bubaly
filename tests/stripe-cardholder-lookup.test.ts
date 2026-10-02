import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// LIBRARY-3EC5705EFABD: run the helper, with provider/client construction sealed.
const network = await vi.hoisted(async () => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const attempts = { fetch: 0, http: 0, https: 0, socket: 0, tls: 0 };
  const deny = (kind: keyof typeof attempts) => () => { attempts[kind]++; throw new Error(`Unexpected ${kind} attempt`); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(deny('fetch'));
  const guards = [
    vi.spyOn(http, 'request').mockImplementation(deny('http')),
    vi.spyOn(http, 'get').mockImplementation(deny('http')),
    vi.spyOn(https, 'request').mockImplementation(deny('https')),
    vi.spyOn(https, 'get').mockImplementation(deny('https')),
    vi.spyOn(net, 'connect').mockImplementation(deny('socket')),
    vi.spyOn(net, 'createConnection').mockImplementation(deny('socket')),
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(deny('socket')),
    vi.spyOn(tls, 'connect').mockImplementation(deny('tls')),
  ];
  return { attempts, restore() { guards.forEach(guard => guard.mockRestore()); globalThis.fetch = originalFetch; } };
});
const mock = vi.hoisted(() => ({
  getStripe: vi.fn(), retrieve: vi.fn(), create: vi.fn(),
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), lookup: vi.fn(),
  insert: vi.fn(), single: vi.fn(), clientFactory: vi.fn(),
  sdkLoads: 0, sdkConstructions: 0,
}));
vi.mock('@/lib/stripe', () => ({ getStripe: mock.getStripe }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mock.clientFactory }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mock.clientFactory, createBrowserClient: mock.clientFactory }));
vi.mock('stripe', () => {
  mock.sdkLoads++;
  return { default: class { constructor() { mock.sdkConstructions++; throw new Error('Real Stripe SDK forbidden'); } } };
});
import { ensureCardholder } from '@/lib/stripe/issuing';

const params = {
  familyId: 'family-synthetic', memberId: 'member-synthetic', childWalletId: 'wallet-synthetic',
  name: 'Synthetic Fixture', accountId: 'acct_synthetic', userId: 'user-synthetic',
};
const existing = { id: 'existing-holder-row', stripe_cardholder_id: 'ich_existing_synthetic' };
const address = { line1: '1 Fixture Lane', city: 'Fixture', state: 'CA', postal_code: '00000', country: 'US' };
const client = { from: mock.from } as unknown as SupabaseClient<Database>;
const lookupErrors = [
  { code: '08006', message: 'synthetic internal connection detail' },
  { code: '42501', message: 'synthetic internal permission detail' },
  new Error('synthetic returned Error detail'),
  'synthetic returned string detail',
];

beforeEach(() => {
  vi.clearAllMocks();
  const read = { eq: mock.eq, maybeSingle: mock.lookup };
  mock.eq.mockReturnValue(read);
  mock.select.mockReturnValue(read);
  mock.from.mockReturnValue({ select: mock.select, insert: mock.insert });
  mock.insert.mockReturnValue({ select: vi.fn().mockReturnValue({ single: mock.single }) });
  mock.lookup.mockResolvedValue({ data: null, error: null });
  mock.single.mockResolvedValue({ data: { id: 'new-holder-row' }, error: null });
  mock.retrieve.mockResolvedValue({ individual: { address } });
  mock.create.mockResolvedValue({ id: 'ich_created_synthetic' });
  mock.getStripe.mockReturnValue({ accounts: { retrieve: mock.retrieve }, issuing: { cardholders: { create: mock.create } } });
  mock.clientFactory.mockImplementation(() => { throw new Error('Real database client forbidden'); });
});
afterEach(() => {
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.clientFactory).not.toHaveBeenCalled();
  expect(mock.sdkLoads).toBe(0);
  expect(mock.sdkConstructions).toBe(0);
});
afterAll(() => network.restore());

function expectNoProviderOrWrite() {
  expect(mock.getStripe).not.toHaveBeenCalled();
  expect(mock.retrieve).not.toHaveBeenCalled();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.insert).not.toHaveBeenCalled();
}
function expectScopedLookup() {
  expect(mock.from).toHaveBeenNthCalledWith(1, 'stripe_cardholders');
  expect(mock.select).toHaveBeenCalledExactlyOnceWith('id, stripe_cardholder_id');
  expect(mock.eq.mock.calls).toEqual([['family_id', params.familyId], ['member_id', params.memberId]]);
}

describe.each([{ label: 'empty data', data: null }, { label: 'stale data', data: existing }])('failed lookup with $label', ({ data }) => {
  it.each(lookupErrors)('refuses returned error %j before reuse or creation', async error => {
    mock.lookup.mockResolvedValue({ data, error });
    await expect(ensureCardholder(client, params)).rejects.toThrow('Could not load the existing cardholder');
    expectScopedLookup();
    expectNoProviderOrWrite();
  });
});

it.each(lookupErrors.slice(0, 3))('preserves lookup rejection %j without provider access', async error => {
  mock.lookup.mockRejectedValue(error);
  await expect(ensureCardholder(client, params)).rejects.toBe(error);
  expectScopedLookup();
  expectNoProviderOrWrite();
});

it('reuses an existing row after a successful scoped lookup', async () => {
  mock.lookup.mockResolvedValue({ data: existing, error: null });
  await expect(ensureCardholder(client, params)).resolves.toEqual({ rowId: existing.id, stripeCardholderId: existing.stripe_cardholder_id });
  expectScopedLookup();
  expectNoProviderOrWrite();
});

it.each([params.userId, null])('creates and persists after verified absence with actor %s', async userId => {
  await expect(ensureCardholder(client, { ...params, userId })).resolves.toEqual({ rowId: 'new-holder-row', stripeCardholderId: 'ich_created_synthetic' });
  expectScopedLookup();
  expect(mock.retrieve).toHaveBeenCalledExactlyOnceWith(params.accountId);
  expect(mock.create).toHaveBeenCalledExactlyOnceWith({
    name: params.name, type: 'individual', status: 'active',
    billing: { address: { ...address, line2: undefined } },
    metadata: { family_id: params.familyId, child_wallet_id: params.childWalletId },
  }, { stripeAccount: params.accountId, idempotencyKey: `cardholder-${params.memberId}` });
  expect(mock.insert).toHaveBeenCalledExactlyOnceWith({
    family_id: params.familyId, member_id: params.memberId, child_wallet_id: params.childWalletId,
    stripe_cardholder_id: 'ich_created_synthetic', created_by: userId,
  });
  expect(mock.lookup.mock.invocationCallOrder[0]).toBeLessThan(mock.getStripe.mock.invocationCallOrder[0]);
  expect(mock.create.mock.invocationCallOrder[0]).toBeLessThan(mock.insert.mock.invocationCallOrder[0]);
});

it('keeps the existing missing-address refusal before holder creation', async () => {
  mock.retrieve.mockResolvedValue({ individual: { address: null } });
  await expect(ensureCardholder(client, params)).rejects.toThrow('Finish account setup');
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.insert).not.toHaveBeenCalled();
});

it.each(['retrieve', 'create'] as const)('keeps provider %s rejection before mirror insertion', async stage => {
  const error = new Error('synthetic provider refusal');
  mock[stage].mockRejectedValue(error);
  await expect(ensureCardholder(client, params)).rejects.toBe(error);
  expect(mock.insert).not.toHaveBeenCalled();
});

it('preserves a returned mirror insert error after provider creation', async () => {
  mock.single.mockResolvedValue({ data: null, error: { message: 'synthetic insert refusal' } });
  await expect(ensureCardholder(client, params)).rejects.toThrow('Failed to persist cardholder: synthetic insert refusal');
  expect(mock.create).toHaveBeenCalledTimes(1);
});

it('preserves a rejected mirror insert after provider creation', async () => {
  const error = new Error('synthetic mirror transport failure');
  mock.single.mockRejectedValue(error);
  await expect(ensureCardholder(client, params)).rejects.toBe(error);
  expect(mock.create).toHaveBeenCalledTimes(1);
});

// JIMMY-SUPPORT-CARD-RETRY-20261001, repair C. Two first orders for one child
// both miss the lookup; the stable idempotency key gives both the SAME provider
// cardholder, so the second insert meets the first one's row. That exact
// duplicate is adopted; anything else keeps the refusal.
describe('a duplicate first cardholder insert', () => {
  const duplicate = { code: '23505', message: 'duplicate key value violates unique constraint "stripe_cardholders_family_id_member_id_key"' };
  const exact = { id: 'winner-row', family_id: params.familyId, member_id: params.memberId, stripe_cardholder_id: 'ich_created_synthetic' };
  const refusal = `Failed to persist cardholder: ${duplicate.message}`;
  beforeEach(() => {
    mock.single.mockResolvedValue({ data: null, error: duplicate });
    mock.lookup.mockResolvedValueOnce({ data: null, error: null });
  });

  it('adopts the row only when it is exactly this family, member and provider cardholder', async () => {
    mock.lookup.mockResolvedValueOnce({ data: exact, error: null });
    await expect(ensureCardholder(client, params)).resolves.toEqual({ rowId: 'winner-row', stripeCardholderId: 'ich_created_synthetic' });
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.insert).toHaveBeenCalledTimes(1);
    expect(mock.select.mock.calls).toEqual([['id, stripe_cardholder_id'], ['id, family_id, member_id, stripe_cardholder_id']]);
    expect(mock.eq.mock.calls).toEqual([
      ['family_id', params.familyId], ['member_id', params.memberId],
      ['family_id', params.familyId], ['member_id', params.memberId],
    ]);
    expect(mock.insert.mock.invocationCallOrder[0]).toBeLessThan(mock.lookup.mock.invocationCallOrder[1]);
  });

  it.each([
    ['another provider cardholder', { data: { ...exact, stripe_cardholder_id: 'ich_other_synthetic' }, error: null }],
    ['another family', { data: { ...exact, family_id: 'family-other' }, error: null }],
    ['another member', { data: { ...exact, member_id: 'member-other' }, error: null }],
    ['no row', { data: null, error: null }],
    ['a returned error, even beside exact data', { data: exact, error: { code: '08006', message: 'synthetic re-read refusal' } }],
  ])('keeps the refusal when the re-read finds %s', async (_label, reread) => {
    mock.lookup.mockResolvedValueOnce(reread);
    await expect(ensureCardholder(client, params)).rejects.toThrow(refusal);
    expect(mock.lookup).toHaveBeenCalledTimes(2);
  });

  it('keeps the refusal when the re-read rejects', async () => {
    mock.lookup.mockRejectedValueOnce(new Error('synthetic re-read transport failure'));
    await expect(ensureCardholder(client, params)).rejects.toThrow(refusal);
  });

  it.each([
    { code: '08006', message: 'synthetic connection refusal' },
    { code: '23503', message: 'synthetic foreign key refusal' },
    { message: 'synthetic refusal without a code' },
  ])('does not re-read after a non-duplicate insert failure %j', async error => {
    mock.single.mockResolvedValue({ data: null, error });
    await expect(ensureCardholder(client, params)).rejects.toThrow(`Failed to persist cardholder: ${error.message}`);
    expect(mock.lookup).toHaveBeenCalledTimes(1);
    expect(mock.select).toHaveBeenCalledTimes(1);
  });
});

describe('two concurrent first orders for one child, against the unique constraints', () => {
  function concurrentProvider(ids: (key: string, arrival: number) => string) {
    let arrived = 0;
    let open!: () => void;
    // Both creates are held until both have arrived, so both lookups miss first.
    const both = new Promise<void>(resolve => { open = resolve; setTimeout(resolve, 1000); });
    mock.create.mockImplementation(async (_body: unknown, opts: { idempotencyKey: string }) => {
      const arrival = ++arrived;
      if (arrival >= 2) open();
      await both;
      return { id: ids(opts.idempotencyKey, arrival) };
    });
  }
  const database = () => createInMemorySupabase({
    uniques: { stripe_cardholders: [['family_id', 'member_id'], ['stripe_cardholder_id']] },
  });

  it('both resolve to the one row when the provider replays one cardholder for the stable key', async () => {
    concurrentProvider(key => `ich_for_${key}`);
    const db = database();
    const dbClient = db as unknown as SupabaseClient<Database>;
    const [first, second] = await Promise.all([ensureCardholder(dbClient, params), ensureCardholder(dbClient, params)]);
    expect(first).toEqual(second);
    expect(first.stripeCardholderId).toBe(`ich_for_cardholder-${params.memberId}`);
    expect(db.table('stripe_cardholders')).toEqual([expect.objectContaining({
      id: first.rowId, family_id: params.familyId, member_id: params.memberId, stripe_cardholder_id: first.stripeCardholderId,
    })]);
    expect(mock.create.mock.calls.map(([, opts]) => opts.idempotencyKey)).toEqual([`cardholder-${params.memberId}`, `cardholder-${params.memberId}`]);
  });

  it('still refuses the second when the provider answered with a different cardholder', async () => {
    concurrentProvider((_key, arrival) => `ich_distinct_${arrival}`);
    const db = database();
    const dbClient = db as unknown as SupabaseClient<Database>;
    const results = await Promise.allSettled([ensureCardholder(dbClient, params), ensureCardholder(dbClient, params)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(((results[1] as PromiseRejectedResult).reason as Error).message).toMatch(/^Failed to persist cardholder: duplicate key/);
    expect(db.table('stripe_cardholders').map(row => row.stripe_cardholder_id)).toEqual(['ich_distinct_1']);
  });
});
