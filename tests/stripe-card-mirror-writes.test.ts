import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// LIBRARY-3EC5705EFABD / C1-S9-64: provider success remains authoritative;
// a failed local mirror is reported without pretending the provider refused.
const mock = vi.hoisted(() => ({
  getStripe: vi.fn(), providerUpdate: vi.fn(), from: vi.fn(),
  update: vi.fn(), eq: vi.fn(), select: vi.fn(), clientFactory: vi.fn(),
}));
vi.mock('@/lib/stripe', () => ({ getStripe: mock.getStripe }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mock.clientFactory }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mock.clientFactory, createBrowserClient: mock.clientFactory }));
vi.mock('stripe', () => ({ default: class { constructor() { throw new Error('Real Stripe SDK forbidden'); } } }));
import { setCardFrozen, updateCardControls } from '@/lib/stripe/issuing';

const params = { familyId: 'family-synthetic', cardRowId: 'row-synthetic', stripeCardId: 'ic_synthetic', accountId: 'acct_synthetic' };
const controls = { ...params, spendLimitCents: 1200, spendWindow: 'weekly', blockedCategories: ['betting_casino_gambling'] };
const client = { from: mock.from } as unknown as SupabaseClient<Database>;
const operations = [
  {
    name: 'controls', run: () => updateCardControls(client, controls),
    provider: { spending_controls: { spending_limits: [{ amount: 1200, interval: 'weekly' }], blocked_categories: controls.blockedCategories } },
    mirror: { spend_limit_cents: 1200, spend_window: 'weekly', blocked_categories: controls.blockedCategories },
    log: '[money] card controls changed at Stripe but the mirror write failed; issuing_card.updated reconciles it',
    context: { cardRowId: params.cardRowId },
  },
  ...[true, false].map(frozen => ({
    name: frozen ? 'freeze' : 'unfreeze', run: () => setCardFrozen(client, { ...params, frozen }),
    provider: { status: frozen ? 'inactive' : 'active' },
    mirror: { is_frozen: frozen, status: frozen ? 'inactive' : 'active' },
    log: '[money] card freeze changed at Stripe but the mirror write failed; issuing_card.updated reconciles it',
    context: { cardRowId: params.cardRowId, frozen },
  })),
];
const failures = [
  { name: 'Error', value: new Error('synthetic sensitive failure detail') },
  { name: 'object', value: { message: 'synthetic sensitive failure detail', details: 'synthetic sensitive row', code: '08006' } },
  { name: 'string', value: 'synthetic sensitive failure detail' },
  { name: 'null', value: null },
  { name: 'undefined', value: undefined },
];
const log = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  const write = { eq: mock.eq, select: mock.select };
  mock.from.mockReturnValue({ update: mock.update });
  mock.update.mockReturnValue(write);
  mock.eq.mockReturnValue(write);
  mock.select.mockResolvedValue({ data: [{ id: params.cardRowId }], error: null });
  mock.providerUpdate.mockResolvedValue({ id: params.stripeCardId });
  mock.getStripe.mockReturnValue({ issuing: { cards: { update: mock.providerUpdate } } });
  mock.clientFactory.mockImplementation(() => { throw new Error('Real database client forbidden'); });
});
afterEach(() => { expect(mock.clientFactory).not.toHaveBeenCalled(); });
afterAll(() => { log.mockRestore(); });

function expectScopedWrite(operation: typeof operations[number]) {
  expect(mock.providerUpdate).toHaveBeenCalledExactlyOnceWith(params.stripeCardId, operation.provider, { stripeAccount: params.accountId });
  expect(mock.from).toHaveBeenCalledExactlyOnceWith('stripe_issuing_cards');
  expect(mock.update).toHaveBeenCalledExactlyOnceWith(operation.mirror);
  expect(mock.eq.mock.calls).toEqual([['id', params.cardRowId], ['family_id', params.familyId]]);
  expect(mock.select).toHaveBeenCalledExactlyOnceWith('id');
}

describe.each(operations)('$name mirror reporting', operation => {
  it.each(failures)('logs a rejected mirror ($name) after provider success without exposing the reason', async ({ value }) => {
    mock.select.mockRejectedValue(value);
    await expect(operation.run()).resolves.toBeUndefined();
    expectScopedWrite(operation);
    expect(log).toHaveBeenCalledExactlyOnceWith(operation.log, operation.context);
  });

  it.each([{ data: null }, { data: [{ id: params.cardRowId }] }])('logs a returned mirror error with data $data without exposing its details', async ({ data }) => {
    mock.select.mockResolvedValue({ data, error: failures[1].value });
    await expect(operation.run()).resolves.toBeUndefined();
    expectScopedWrite(operation);
    expect(log).toHaveBeenCalledExactlyOnceWith(operation.log, operation.context);
  });

  it.each([{ data: null }, { data: [] }, { data: undefined }])('retains the no-row best-effort result for $data', async ({ data }) => {
    mock.select.mockResolvedValue({ data, error: null });
    await expect(operation.run()).resolves.toBeUndefined();
    expectScopedWrite(operation);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(operation.log);
  });

  it('does not log after a confirmed mirror write', async () => {
    await expect(operation.run()).resolves.toBeUndefined();
    expectScopedWrite(operation);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(failures)('preserves provider rejection ($name) without attempting a mirror or success log', async ({ value }) => {
    mock.providerUpdate.mockRejectedValue(value);
    await expect(operation.run()).rejects.toBe(value);
    expect(mock.from).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('waits for provider success before issuing the mirror write', async () => {
    let complete!: () => void;
    mock.providerUpdate.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    const result = operation.run();
    expect(mock.from).not.toHaveBeenCalled();
    complete();
    await expect(result).resolves.toBeUndefined();
    expectScopedWrite(operation);
  });

  it('does not swallow synchronous query construction errors', async () => {
    const error = new Error('synthetic construction failure');
    mock.from.mockImplementation(() => { throw error; });
    await expect(operation.run()).rejects.toBe(error);
    expect(mock.providerUpdate).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});

it.each([
  { limit: null, window: 'daily', expected: [] },
  { limit: 0, window: 'monthly', expected: [{ amount: 0, interval: 'monthly' }] },
  { limit: 1, window: 'unknown', expected: [{ amount: 1, interval: 'per_authorization' }] },
])('retains controls payload semantics for $limit / $window', async ({ limit, window, expected }) => {
  await updateCardControls(client, { ...controls, spendLimitCents: limit, spendWindow: window, blockedCategories: [] });
  expect(mock.providerUpdate).toHaveBeenCalledExactlyOnceWith(params.stripeCardId,
    { spending_controls: { spending_limits: expected, blocked_categories: [] } }, { stripeAccount: params.accountId });
  expect(mock.update).toHaveBeenCalledExactlyOnceWith({ spend_limit_cents: limit, spend_window: window, blocked_categories: [] });
  expect(log).not.toHaveBeenCalled();
});
