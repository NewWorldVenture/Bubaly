import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// Existing audit rows: LIBRARY-00A48F96544F and LIBRARY-A6243E0F741C.
// Real helpers, synthetic DB/provider boundaries, and barriers installed before imports.
const network = await vi.hoisted(async () => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const attempts = { fetch: 0, http: 0, https: 0, socket: 0, tls: 0 };
  const deny = (kind: keyof typeof attempts) => () => { attempts[kind]++; throw new Error('Unexpected network attempt: ' + kind); };
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
  getStripe: vi.fn(), create: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(),
  maybeSingle: vi.fn(), insert: vi.fn(), single: vi.fn(), forbidden: vi.fn(),
  sdkLoads: 0, sdkInitializations: 0,
}));
vi.mock('@/lib/stripe', () => ({ getStripe: mock.getStripe }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mock.forbidden }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mock.forbidden, createBrowserClient: mock.forbidden }));
vi.mock('stripe', () => {
  mock.sdkLoads++;
  return { default: class { constructor() { mock.sdkInitializations++; throw new Error('Real Stripe SDK prohibited'); } } };
});
import { ensureConnectedAccount } from '@/lib/stripe/connect';
import { ensureFinancialAccount } from '@/lib/stripe/treasury';

const familyId = 'family-synthetic';
const detail = 'synthetic private database/provider detail';
const client = { from: mock.from } as unknown as SupabaseClient<Database>;
const connectParams = { familyId, email: 'fixture@example.invalid', userId: 'parent-synthetic' };
const treasuryParams = { familyId, connectedAccountRowId: 'connected-row-synthetic', accountId: 'acct_synthetic' };
const operations = [
  {
    name: 'Connect', table: 'stripe_connected_accounts', selected: 'id, stripe_account_id',
    run: () => ensureConnectedAccount(client, connectParams),
    existing: { id: 'connected-existing', stripe_account_id: 'acct_existing' },
    reused: { rowId: 'connected-existing', accountId: 'acct_existing' },
    created: { rowId: 'inserted-row', accountId: 'acct_created' },
    failure: 'Could not load the existing connected account',
    providerResult: { id: 'acct_created', charges_enabled: false, payouts_enabled: false, details_submitted: true, requirements: { disabled_reason: null } },
    providerPayload: {
      type: 'custom', country: 'US', email: connectParams.email, business_type: 'individual',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true }, treasury: { requested: true }, card_issuing: { requested: true } },
      metadata: { family_id: familyId },
    },
    providerOptions: { idempotencyKey: 'connect-acct-' + familyId },
    insert: { family_id: familyId, stripe_account_id: 'acct_created', status: 'restricted', details_submitted: true, onboarded_by: connectParams.userId },
  },
  {
    name: 'Treasury', table: 'stripe_financial_accounts', selected: 'id, stripe_financial_account_id',
    run: () => ensureFinancialAccount(client, treasuryParams),
    existing: { id: 'financial-existing', stripe_financial_account_id: 'fa_existing' },
    reused: { rowId: 'financial-existing', financialAccountId: 'fa_existing' },
    created: { rowId: 'inserted-row', financialAccountId: 'fa_created' },
    failure: 'Could not load the existing financial account',
    providerResult: { id: 'fa_created', status: 'closed' },
    providerPayload: {
      supported_currencies: ['usd'],
      features: {
        card_issuing: { requested: true }, deposit_insurance: { requested: true },
        financial_addresses: { aba: { requested: true } }, inbound_transfers: { ach: { requested: true } },
        outbound_payments: { ach: { requested: true }, us_domestic_wire: { requested: true } },
      },
      metadata: { family_id: familyId },
    },
    providerOptions: { stripeAccount: treasuryParams.accountId, idempotencyKey: 'fa-' + familyId },
    insert: { family_id: familyId, connected_account_id: treasuryParams.connectedAccountRowId, stripe_financial_account_id: 'fa_created', status: 'closed' },
  },
];
type Operation = typeof operations[number];
let events: string[];
beforeEach(() => {
  vi.clearAllMocks(); events = [];
  const query = { select: mock.select, eq: mock.eq, maybeSingle: mock.maybeSingle, insert: mock.insert, single: mock.single };
  mock.from.mockReturnValue(query);
  mock.select.mockReturnValue(query); mock.eq.mockReturnValue(query);
  mock.maybeSingle.mockImplementation(async () => { events.push('lookup'); return { data: null, error: null }; });
  mock.insert.mockImplementation(() => { events.push('insert'); return query; });
  mock.single.mockResolvedValue({ data: { id: 'inserted-row' }, error: null });
  mock.getStripe.mockImplementation(() => {
    events.push('provider factory');
    return { accounts: { create: mock.create }, treasury: { financialAccounts: { create: mock.create } } };
  });
  mock.forbidden.mockImplementation(() => { throw new Error('Real client factory prohibited'); });
});
afterEach(() => {
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.forbidden).not.toHaveBeenCalled();
  expect(mock.sdkLoads).toBe(0); expect(mock.sdkInitializations).toBe(0);
});
afterAll(() => network.restore());

function assertLookup(op: Operation) {
  expect(mock.from.mock.calls[0]).toEqual([op.table]);
  expect(mock.select.mock.calls[0]).toEqual([op.selected]);
  expect(mock.eq).toHaveBeenCalledExactlyOnceWith('family_id', familyId);
  expect(mock.maybeSingle).toHaveBeenCalledExactlyOnceWith();
}
function noCreation() {
  expect(mock.getStripe).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  expect(mock.insert).not.toHaveBeenCalled(); expect(mock.single).not.toHaveBeenCalled();
}
function assertCreation(op: Operation) {
  assertLookup(op);
  expect(mock.getStripe).toHaveBeenCalledTimes(1);
  expect(mock.create).toHaveBeenCalledExactlyOnceWith(op.providerPayload, op.providerOptions);
  expect(mock.from.mock.calls).toEqual([[op.table], [op.table]]);
  expect(mock.insert).toHaveBeenCalledExactlyOnceWith(op.insert);
  expect(mock.select.mock.calls).toEqual([[op.selected], ['id']]);
  expect(mock.single).toHaveBeenCalledExactlyOnceWith();
  expect(events).toEqual(['lookup', 'provider factory', 'provider create', 'insert']);
}
const lookupErrors = [
  { code: '08006', message: detail }, { code: '42501', message: detail },
  new Error(detail), detail,
];
for (const op of operations) {
  describe(op.name + ' existing-account lookup', () => {
    beforeEach(() => {
      mock.create.mockImplementation(async () => { events.push('provider create'); return op.providerResult; });
    });
    for (const cached of [false, true]) {
      it.each(lookupErrors)('refuses returned error before reuse or creation, cached=' + cached + ', error=%j', async error => {
        mock.maybeSingle.mockResolvedValue({ data: cached ? op.existing : null, error });
        await expect(op.run()).rejects.toThrow(op.failure);
        assertLookup(op); noCreation();
        expect(mock.from).toHaveBeenCalledTimes(1);
      });
    }
    for (const error of [null, undefined]) {
      it('reuses a healthy existing row with error=' + String(error), async () => {
        mock.maybeSingle.mockResolvedValue({ data: op.existing, error });
        await expect(op.run()).resolves.toEqual(op.reused);
        assertLookup(op); noCreation();
        expect(mock.from).toHaveBeenCalledTimes(1);
      });
      it('creates after healthy absence with error=' + String(error), async () => {
        mock.maybeSingle.mockImplementation(async () => { events.push('lookup'); return { data: null, error }; });
        await expect(op.run()).resolves.toEqual(op.created);
        assertCreation(op);
      });
    }
    it.each([new Error(detail), detail, null])('propagates rejected lookup without provider work: %j', async error => {
      mock.maybeSingle.mockRejectedValue(error);
      await expect(op.run()).rejects.toBe(error);
      assertLookup(op); noCreation();
    });
    it.each([new Error(detail), { message: detail, code: 'provider_unavailable' }, detail])('preserves provider rejection without inserting a mirror: %j', async error => {
      mock.create.mockRejectedValue(error);
      await expect(op.run()).rejects.toBe(error);
      assertLookup(op);
      expect(mock.getStripe).toHaveBeenCalledTimes(1);
      expect(mock.create).toHaveBeenCalledExactlyOnceWith(op.providerPayload, op.providerOptions);
      expect(mock.insert).not.toHaveBeenCalled(); expect(mock.single).not.toHaveBeenCalled();
    });
    it('preserves a resolved initial-mirror failure after provider creation', async () => {
      mock.single.mockResolvedValue({ data: null, error: { message: detail } });
      await expect(op.run()).rejects.toThrow('Failed to persist ' + (op.name === 'Connect' ? 'connected' : 'financial') + ' account: ' + detail);
      assertCreation(op);
    });
    it('preserves a rejected initial-mirror failure after provider creation', async () => {
      const error = new Error(detail);
      mock.single.mockRejectedValue(error);
      await expect(op.run()).rejects.toBe(error);
      assertCreation(op);
    });
    it('does not reach the provider while lookup is pending or reuse a row returned with error', async () => {
      let resolve!: (value: { data: Operation['existing']; error: { message: string } }) => void;
      mock.maybeSingle.mockReturnValue(new Promise(done => { resolve = done; }));
      const pending = op.run();
      noCreation();
      resolve({ data: op.existing, error: { message: detail } });
      await expect(pending).rejects.toThrow(op.failure);
      assertLookup(op); noCreation();
    });
  });
}
it('Connect retains null input handling and account defaults on genuine absence', async () => {
  const op = operations[0];
  mock.create.mockResolvedValue({ id: 'acct_created' });
  await expect(ensureConnectedAccount(client, { familyId, email: null, userId: null })).resolves.toEqual(op.created);
  expect(mock.create).toHaveBeenCalledExactlyOnceWith({ ...op.providerPayload, email: undefined }, op.providerOptions);
  expect(mock.insert).toHaveBeenCalledExactlyOnceWith({ ...op.insert, status: 'pending', details_submitted: false, onboarded_by: null });
});
it('Treasury retains the open status default on genuine absence', async () => {
  const op = operations[1];
  mock.create.mockResolvedValue({ id: 'fa_created' });
  await expect(op.run()).resolves.toEqual(op.created);
  expect(mock.create).toHaveBeenCalledExactlyOnceWith(op.providerPayload, op.providerOptions);
  expect(mock.insert).toHaveBeenCalledExactlyOnceWith({ ...op.insert, status: 'open' });
});

