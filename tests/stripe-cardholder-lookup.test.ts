import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

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
