import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Install hard network barriers before importing any action or provider module.
// These guards count ATTEMPTS, so a caught transport exception still fails.
const network = await vi.hoisted(async () => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const attempts = { fetch: 0, http: 0, https: 0, socket: 0, tls: 0 };
  const deny = (kind: keyof typeof attempts) => () => { attempts[kind]++; throw new Error(`Unexpected ${kind} network attempt`); };
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
  events: [] as string[],
  requireUserContext: vi.fn(), createServiceClient: vi.fn(), capabilities: vi.fn(),
  ensureAccount: vi.fn(), link: vi.fn(), sync: vi.fn(), headers: vi.fn(),
  translations: vi.fn(), revalidate: vi.fn(), from: vi.fn(),
  treasury: vi.fn(), cardholder: vi.fn(), issueCard: vi.fn(), freezeCard: vi.fn(), controls: vi.fn(),
  trust: vi.fn(), roleOf: vi.fn(), stripe: vi.fn(), publishableKey: vi.fn(), audit: vi.fn(),
  forbiddenClient: vi.fn(), stripeModuleLoads: 0, stripeInitializations: 0, sdkModuleLoads: 0,
}));
// Every provider/server factory is replaced outright: no importOriginal/importActual.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mock.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mock.createServiceClient, createServer: mock.forbiddenClient }));
vi.mock('@/lib/stripe/capabilities', () => ({ getMoneyCapabilities: mock.capabilities }));
vi.mock('@/lib/stripe/connect', () => ({ ensureConnectedAccount: mock.ensureAccount, createOnboardingLink: mock.link, syncConnectedAccount: mock.sync }));
vi.mock('@/lib/stripe/treasury', () => ({ ensureFinancialAccount: mock.treasury }));
vi.mock('@/lib/stripe/issuing', () => ({ ensureCardholder: mock.cardholder, issueCard: mock.issueCard, setCardFrozen: mock.freezeCard, updateCardControls: mock.controls }));
vi.mock('@/lib/stripe', () => ({ getStripe: mock.stripe }));
vi.mock('@/lib/stripe/settings', () => ({ effectivePublishableKey: mock.publishableKey }));
vi.mock('@/lib/trust/server', () => ({ evaluateTrust: mock.trust, roleOf: mock.roleOf }));
vi.mock('@/lib/server/audit', () => ({ logWalletAudit: mock.audit }));
vi.mock('next/headers', () => ({ headers: mock.headers }));
vi.mock('next/cache', () => ({ revalidatePath: mock.revalidate }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: mock.translations }));
vi.mock('@supabase/supabase-js', () => { mock.sdkModuleLoads++; return { createClient: mock.forbiddenClient }; });
vi.mock('@supabase/ssr', () => { mock.sdkModuleLoads++; return { createServerClient: mock.forbiddenClient, createBrowserClient: mock.forbiddenClient }; });
vi.mock('stripe', () => {
  mock.stripeModuleLoads++;
  return { default: class { constructor() { mock.stripeInitializations++; throw new Error('Stripe SDK must not initialize'); } } };
});


import { setCardFrozenAction, updateCardControlsAction } from '@/app/(app)/money/actions';

const family = 'family-synthetic-a';
const cardId = 'card-row-synthetic';
const detail = 'synthetic private provider detail must not reach the result';
const controlsInput = { cardId, spendLimitCents: 2500, spendWindow: 'monthly', blockedCategories: ['liquor_stores'] };
const service = { from: mock.from };
type Reply = { data: Record<string, unknown> | null; error: unknown; rejection?: unknown; deferred?: Promise<Reply> };
let replies: Record<string, Reply>;
let queryCalls: { table: string; method: string; args: unknown[] }[];
let context: { user: { id: string }; active: { familyId: string; role: string; member: { id: string } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function noMutations() {
  expect(mock.freezeCard).not.toHaveBeenCalled(); expect(mock.controls).not.toHaveBeenCalled();
  expect(mock.audit).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
}
function noEffects() {
  expect(mock.createServiceClient).not.toHaveBeenCalled(); expect(mock.capabilities).not.toHaveBeenCalled();
  expect(mock.from).not.toHaveBeenCalled(); noMutations();
}
beforeEach(() => {
  vi.clearAllMocks(); mock.events = []; queryCalls = [];
  context = { user: { id: 'user-synthetic' }, active: { familyId: family, role: 'parent', member: { id: 'manager-synthetic' } } };
  replies = {
    stripe_issuing_cards: { data: { id: cardId, stripe_card_id: 'ic_synthetic' }, error: null },
    stripe_connected_accounts: { data: { stripe_account_id: 'acct_synthetic' }, error: null },
  };
  mock.requireUserContext.mockImplementation(async () => { mock.events.push('auth'); return context; });
  mock.createServiceClient.mockImplementation(() => { mock.events.push('service'); return service; });
  mock.translations.mockResolvedValue((key: string) => `translated:${key}`);
  mock.capabilities.mockImplementation(async () => { mock.events.push('capabilities'); return { issuing: true }; });
  mock.from.mockImplementation((table: string) => {
    queryCalls.push({ table, method: 'from', args: [] });
    const query = {
      select(columns: string) { queryCalls.push({ table, method: 'select', args: [columns] }); return query; },
      eq(column: string, value: unknown) { queryCalls.push({ table, method: 'eq', args: [column, value] }); return query; },
      async maybeSingle() {
        queryCalls.push({ table, method: 'maybeSingle', args: [] }); mock.events.push(`read:${table}`);
        const reply = replies[table]; if (!reply) throw new Error(`Unexpected table ${table}`);
        if ('rejection' in reply) throw reply.rejection;
        return reply.deferred ? await reply.deferred : reply;
      },
    };
    return query;
  });
  mock.freezeCard.mockImplementation(async () => { mock.events.push('freeze'); });
  mock.controls.mockImplementation(async () => { mock.events.push('controls'); });
  mock.audit.mockImplementation(async () => { mock.events.push('audit'); });
  mock.revalidate.mockImplementation(() => { mock.events.push('revalidate'); });
  const forbidden = () => { throw new Error('Unrelated client/provider/Trust call'); };
  for (const stub of [mock.ensureAccount, mock.link, mock.sync, mock.headers, mock.treasury, mock.cardholder, mock.issueCard, mock.trust, mock.roleOf, mock.stripe, mock.publishableKey, mock.forbiddenClient]) stub.mockImplementation(forbidden);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.sdkModuleLoads).toBe(0); expect(mock.stripeModuleLoads).toBe(0); expect(mock.stripeInitializations).toBe(0);
  for (const stub of [mock.ensureAccount, mock.link, mock.sync, mock.headers, mock.treasury, mock.cardholder, mock.issueCard, mock.trust, mock.roleOf, mock.stripe, mock.publishableKey, mock.forbiddenClient]) expect(stub).not.toHaveBeenCalled();
  vi.mocked(console.error).mockRestore();
});
afterAll(() => network.restore());

// These actions do not call Trust today. Its stub throws: this suite does not
// invent a freeze/unfreeze policy or substitute mocked provider work for real I/O.
describe.each([
  ['freeze', () => setCardFrozenAction({ cardId, frozen: true }), 'actions.onlyParentsCanDoThis', 'freezeCard', 'money.couldNotUpdateTheCard'],
  ['controls', () => updateCardControlsAction(controlsInput), 'actions.onlyParentsCanSetSpending', 'controls', 'money.couldNotUpdateCardControls'],
] as const)('%s admission and lookup boundary', (name, action, roleKey, helper, helperError) => {
  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses %s before service/provider access', async role => {
    context.active.role = role;
    expect(await action()).toEqual({ ok: false, error: `translated:${roleKey}` }); noEffects();
  });
  it('preserves signed-out redirects before service/provider access', async () => {
    const redirect = new Error('synthetic sign-in redirect'); mock.requireUserContext.mockRejectedValue(redirect);
    await expect(action()).rejects.toBe(redirect); noEffects();
  });
  it('selects only the active family card and account with exact filters', async () => {
    expect(await action()).toEqual({ ok: true });
    expect(queryCalls).toEqual([
      { table: 'stripe_issuing_cards', method: 'from', args: [] },
      { table: 'stripe_issuing_cards', method: 'select', args: ['id, stripe_card_id'] },
      { table: 'stripe_issuing_cards', method: 'eq', args: ['family_id', family] },
      { table: 'stripe_issuing_cards', method: 'eq', args: ['id', cardId] },
      { table: 'stripe_issuing_cards', method: 'maybeSingle', args: [] },
      { table: 'stripe_connected_accounts', method: 'from', args: [] },
      { table: 'stripe_connected_accounts', method: 'select', args: ['stripe_account_id'] },
      { table: 'stripe_connected_accounts', method: 'eq', args: ['family_id', family] },
      { table: 'stripe_connected_accounts', method: 'maybeSingle', args: [] },
    ]);
    expect(mock[helper]).toHaveBeenCalledTimes(1);
    expect(mock[name === 'freeze' ? 'controls' : 'freezeCard']).not.toHaveBeenCalled();
  });
  it('uses changed active-family and returned card/account identifiers without substitution', async () => {
    context.active.familyId = 'family-synthetic-b';
    replies.stripe_issuing_cards.data = { id: 'returned-card-b', stripe_card_id: 'ic_synthetic_b' };
    replies.stripe_connected_accounts.data = { stripe_account_id: 'acct_synthetic_b' };
    expect(await action()).toEqual({ ok: true });
    expect(queryCalls.filter(call => call.method === 'eq' && call.args[0] === 'family_id')).toEqual([
      { table: 'stripe_issuing_cards', method: 'eq', args: ['family_id', 'family-synthetic-b'] },
      { table: 'stripe_connected_accounts', method: 'eq', args: ['family_id', 'family-synthetic-b'] },
    ]);
    expect(mock[helper].mock.calls[0][1]).toMatchObject({ familyId: 'family-synthetic-b', cardRowId: 'returned-card-b', stripeCardId: 'ic_synthetic_b', accountId: 'acct_synthetic_b' });
    expect(mock.audit.mock.calls[0][1]).toMatchObject({ family_id: 'family-synthetic-b', actor_user_id: context.user.id, entity_id: 'returned-card-b' });
  });
  it('does not read the account or mutate when the scoped card is absent', async () => {
    replies.stripe_issuing_cards.data = null;
    expect(await action()).toEqual({ ok: false, error: 'translated:actions.cardNotFound' });
    expect(mock.from.mock.calls).toEqual([['stripe_issuing_cards']]); noMutations();
  });
  it('does not mutate when the scoped account is absent', async () => {
    replies.stripe_connected_accounts.data = null;
    expect(await action()).toEqual({ ok: false, error: 'translated:actions.noAccountConfigured' }); noMutations();
  });
  describe.each([
    ['stripe_issuing_cards', 'money.couldNotLoadTheCard'],
    ['stripe_connected_accounts', 'money.couldNotLoadTheConnectedAccount'],
  ] as const)('%s errors', (table, key) => {
    it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('refuses and sanitizes %j despite stale data', async error => {
      replies[table].error = error;
      expect(await action()).toEqual({ ok: false, error: `translated:${key}` });
      if (table === 'stripe_issuing_cards') expect(mock.from.mock.calls).toEqual([['stripe_issuing_cards']]);
      noMutations();
    });
    it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('settles rejected prerequisite %j into a safe error', async rejection => {
      replies[table].rejection = rejection;
      await expect.soft(action()).resolves.toEqual({ ok: false, error: `translated:${key}` });
      if (table === 'stripe_issuing_cards') expect(mock.from.mock.calls).toEqual([['stripe_issuing_cards']]);
      noMutations();
    });
    it('sanitizes a coded transport rejection through the existing settle fallback', async () => {
      replies[table].rejection = { code: '42501', message: detail };
      // settleAll treats rejections as transport failures; resolved PostgREST
      // errors retain their code and existing permission classification below.
      await expect.soft(action()).resolves.toEqual({ ok: false, error: `translated:${key}` });
      noMutations();
    });
  });
  it('preserves classified permission errors without private database detail', async () => {
    replies.stripe_issuing_cards.error = { code: '42501', message: detail };
    expect(await action()).toEqual({ ok: false, error: "You don't have permission to do that. Ask a family admin if you think this is a mistake." }); noMutations();
  });
  it.each([new Error(detail), detail, { code: 'provider_internal', message: detail }])('sanitizes helper rejection %j without audit or success refresh', async error => {
    mock[helper].mockRejectedValue(error);
    expect(await action()).toEqual({ ok: false, error: `translated:${helperError}` });
    expect(mock[helper]).toHaveBeenCalledTimes(1); expect(mock.audit).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });
  it('waits for card then account reads before the provider helper', async () => {
    const card = deferred<Reply>(); const account = deferred<Reply>();
    const cardReply = replies.stripe_issuing_cards; const accountReply = replies.stripe_connected_accounts;
    replies.stripe_issuing_cards = { data: null, error: null, deferred: card.promise };
    replies.stripe_connected_accounts = { data: null, error: null, deferred: account.promise };
    const pending = action(); await flush();
    expect(mock.from.mock.calls).toEqual([['stripe_issuing_cards']]); noMutations();
    card.resolve(cardReply); await flush(); expect(mock.from.mock.calls).toEqual([['stripe_issuing_cards'], ['stripe_connected_accounts']]); noMutations();
    account.resolve(accountReply); expect(await pending).toEqual({ ok: true });
    expect(mock[helper]).toHaveBeenCalledTimes(1);
  });
  it('waits for provider and then audit completion before success refresh', async () => {
    const provider = deferred<void>(); const audit = deferred<void>();
    mock[helper].mockReturnValue(provider.promise); mock.audit.mockReturnValue(audit.promise);
    const pending = action(); await flush();
    expect(mock[helper]).toHaveBeenCalledTimes(1); expect(mock.audit).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
    provider.resolve(); await flush(); expect(mock.audit).toHaveBeenCalledTimes(1); expect(mock.revalidate).not.toHaveBeenCalled();
    audit.resolve(); expect(await pending).toEqual({ ok: true }); expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
  });
});

describe('freeze and unfreeze orchestration', () => {
  describe.each(['parent', 'adult'])('%s', role => {
    it.each([true, false])('forwards frozen=%s with exact audit action and completion order', async frozen => {
      context.active.role = role;
      expect(await setCardFrozenAction({ cardId, frozen })).toEqual({ ok: true });
      expect(mock.freezeCard).toHaveBeenCalledExactlyOnceWith(service, {
        familyId: family, cardRowId: cardId, stripeCardId: 'ic_synthetic', accountId: 'acct_synthetic', frozen,
      });
      expect(mock.audit).toHaveBeenCalledExactlyOnceWith(service, {
        family_id: family, actor_user_id: context.user.id, action: frozen ? 'card_frozen' : 'card_unfrozen',
        entity_type: 'stripe_issuing_cards', entity_id: cardId,
      }, 'card freeze change');
      expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
      expect(mock.events).toEqual(['auth', 'service', 'read:stripe_issuing_cards', 'read:stripe_connected_accounts', 'freeze', 'audit', 'revalidate']);
      expect(mock.capabilities).not.toHaveBeenCalled(); expect(mock.controls).not.toHaveBeenCalled();
    });
  });
});

describe('server-side card control normalization and forwarding', () => {
  it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('safely refuses a rejected capability read %j without mirrors or mutations', async rejection => {
    mock.capabilities.mockRejectedValue(rejection);
    await expect.soft(updateCardControlsAction(controlsInput)).resolves.toEqual({ ok: false, error: 'translated:money.couldNotLoadCardIssuingCapabilities' });
    expect(mock.from).not.toHaveBeenCalled(); noMutations();
  });
  it.each(['parent', 'adult'])('allows %s with exact normalized helper/audit payloads', async role => {
    context.active.role = role;
    expect(await updateCardControlsAction(controlsInput)).toEqual({ ok: true });
    expect(mock.capabilities).toHaveBeenCalledExactlyOnceWith(service);
    expect(mock.controls).toHaveBeenCalledExactlyOnceWith(service, {
      familyId: family, cardRowId: cardId, stripeCardId: 'ic_synthetic', accountId: 'acct_synthetic',
      spendLimitCents: 2500, spendWindow: 'monthly', blockedCategories: ['liquor_stores'],
    });
    expect(mock.audit).toHaveBeenCalledExactlyOnceWith(service, {
      family_id: family, actor_user_id: context.user.id, action: 'card_controls_updated',
      entity_type: 'stripe_issuing_cards', entity_id: cardId,
      metadata: { spendLimitCents: 2500, spendWindow: 'monthly', blockedCount: 1 },
    }, 'card controls update');
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
    expect(mock.events).toEqual(['auth', 'service', 'capabilities', 'read:stripe_issuing_cards', 'read:stripe_connected_accounts', 'controls', 'audit', 'revalidate']);
    expect(mock.freezeCard).not.toHaveBeenCalled();
  });
  it('refuses missing issuing capability before mirrors or mutations', async () => {
    mock.capabilities.mockResolvedValue({ issuing: false });
    expect(await updateCardControlsAction(controlsInput)).toEqual({ ok: false, error: 'translated:actions.cardsAreNotAvailableYet' });
    expect(mock.from).not.toHaveBeenCalled(); noMutations();
  });
  it.each([
    [null, null], [0, null], [-10, null], [Number.NaN, null], [Number.POSITIVE_INFINITY, null],
    [1, 1], [1234.4, 1234], [1234.6, 1235], [1_000_000, 1_000_000], [1_000_001, 1_000_000],
  ])('normalizes limit %s to %s in both provider inputs and audit metadata', async (spendLimitCents, expected) => {
    expect(await updateCardControlsAction({ ...controlsInput, spendLimitCents })).toEqual({ ok: true });
    expect(mock.controls.mock.calls[0][1].spendLimitCents).toBe(expected);
    expect(mock.audit.mock.calls[0][1].metadata.spendLimitCents).toBe(expected);
  });
  it.each(['per_authorization', 'daily', 'weekly', 'monthly', 'all_time'])('preserves supported window %s', async spendWindow => {
    await updateCardControlsAction({ ...controlsInput, spendWindow });
    expect(mock.controls.mock.calls[0][1].spendWindow).toBe(spendWindow);
    expect(mock.audit.mock.calls[0][1].metadata.spendWindow).toBe(spendWindow);
  });
  it.each(['unknown', '', 'MONTHLY'])('normalizes invalid window %j to per_authorization', async spendWindow => {
    await updateCardControlsAction({ ...controlsInput, spendWindow });
    expect(mock.controls.mock.calls[0][1].spendWindow).toBe('per_authorization');
    expect(mock.audit.mock.calls[0][1].metadata.spendWindow).toBe('per_authorization');
  });
  it('filters unknown categories, deduplicates and preserves catalog order without mutating caller input', async () => {
    const blockedCategories = ['fast_food_restaurants', 'liquor_stores', 'unknown', 'liquor_stores', 'betting_casino_gambling'];
    const original = [...blockedCategories];
    await updateCardControlsAction({ ...controlsInput, blockedCategories });
    expect(mock.controls.mock.calls[0][1].blockedCategories).toEqual(['betting_casino_gambling', 'liquor_stores', 'fast_food_restaurants']);
    expect(mock.audit.mock.calls[0][1].metadata.blockedCount).toBe(3);
    expect(blockedCategories).toEqual(original);
  });
  it('preserves clearing all blocked categories', async () => {
    await updateCardControlsAction({ ...controlsInput, blockedCategories: [] });
    expect(mock.controls.mock.calls[0][1].blockedCategories).toEqual([]);
    expect(mock.audit.mock.calls[0][1].metadata.blockedCount).toBe(0);
  });
});
