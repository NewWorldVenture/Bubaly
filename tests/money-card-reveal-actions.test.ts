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
  trust: vi.fn(), roleOf: vi.fn(), stripe: vi.fn(), publishableKey: vi.fn(), audit: vi.fn(), ephemeral: vi.fn(),
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



import { createCardRevealAction, prepareCardRevealAction } from '@/app/(app)/money/actions';

// Deliberately invented fixtures: no real key, nonce, card, account or PAN.
const family = 'family-synthetic-a';
const cardId = 'card-row-synthetic';
const nonce = 'synthetic-nonce-fixture';
const ephemeral = 'synthetic-ephemeral-fixture';
const publishable = 'synthetic-publishable-fixture';
const detail = 'synthetic private provider detail must not reach the result';
const service = { from: mock.from };
const stripe = { ephemeralKeys: { create: mock.ephemeral } };
type Reply = { data: Record<string, unknown> | null; error: unknown; rejection?: unknown; deferred?: Promise<Reply> };
let replies: Record<string, Reply>;
let queryCalls: { table: string; method: string; args: unknown[] }[];
let context: { user: { id: string }; active: { familyId: string; role: string; member: { id: string } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function noKeyEffects() {
  expect(mock.stripe).not.toHaveBeenCalled(); expect(mock.ephemeral).not.toHaveBeenCalled();
  expect(mock.audit).not.toHaveBeenCalled();
}
function noEffects() {
  expect(mock.createServiceClient).not.toHaveBeenCalled(); expect(mock.capabilities).not.toHaveBeenCalled();
  expect(mock.from).not.toHaveBeenCalled(); expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
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
  mock.publishableKey.mockImplementation(() => { mock.events.push('publishable'); return publishable; });
  mock.stripe.mockImplementation(() => { mock.events.push('stripe'); return stripe; });
  mock.ephemeral.mockImplementation(async () => { mock.events.push('ephemeral'); return { secret: ephemeral }; });
  mock.audit.mockImplementation(async () => { mock.events.push('audit'); });
  const forbidden = () => { throw new Error('Unrelated client/provider/Trust operation'); };
  for (const stub of [mock.ensureAccount, mock.link, mock.sync, mock.headers, mock.treasury, mock.cardholder, mock.issueCard, mock.freezeCard, mock.controls, mock.trust, mock.roleOf, mock.revalidate, mock.forbiddenClient]) stub.mockImplementation(forbidden);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.sdkModuleLoads).toBe(0); expect(mock.stripeModuleLoads).toBe(0); expect(mock.stripeInitializations).toBe(0);
  for (const stub of [mock.ensureAccount, mock.link, mock.sync, mock.headers, mock.treasury, mock.cardholder, mock.issueCard, mock.freezeCard, mock.controls, mock.trust, mock.roleOf, mock.revalidate, mock.forbiddenClient]) expect(stub).not.toHaveBeenCalled();
  vi.mocked(console.error).mockRestore();
});
afterAll(() => network.restore());

describe.each([
  ['prepare', () => prepareCardRevealAction(cardId), 'stripe_card_id'],
  ['create', () => createCardRevealAction({ cardId, nonce }), 'id, stripe_card_id'],
] as const)('%s reveal admission and scoped prerequisites', (name, action, selection) => {
  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses %s before any client/read/key access', async role => {
    context.active.role = role;
    expect(await action()).toEqual({ ok: false, error: 'translated:actions.onlyParentsCanRevealCard' }); noEffects();
  });
  it('preserves the signed-out redirect before any side effect', async () => {
    const redirect = new Error('synthetic sign-in redirect'); mock.requireUserContext.mockRejectedValue(redirect);
    await expect(action()).rejects.toBe(redirect); noEffects();
  });
  it('refuses unavailable issuing capability before lookups or key access', async () => {
    mock.capabilities.mockResolvedValue({ issuing: false });
    expect(await action()).toEqual({ ok: false, error: 'translated:actions.cardsAreNotAvailableYet' });
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
  });
  it.each(['parent', 'adult'])('admits %s with exact family/card queries and safe response shape', async role => {
    context.active.role = role;
    const expected = { stripeCardId: 'ic_synthetic', publishableKey: publishable, stripeAccount: 'acct_synthetic' };
    expect(await action()).toEqual({ ok: true, data: name === 'prepare' ? expected : { ...expected, ephemeralKeySecret: ephemeral } });
    expect(queryCalls).toEqual([
      { table: 'stripe_issuing_cards', method: 'from', args: [] },
      { table: 'stripe_issuing_cards', method: 'select', args: [selection] },
      { table: 'stripe_issuing_cards', method: 'eq', args: ['family_id', family] },
      { table: 'stripe_issuing_cards', method: 'eq', args: ['id', cardId] },
      { table: 'stripe_issuing_cards', method: 'maybeSingle', args: [] },
      { table: 'stripe_connected_accounts', method: 'from', args: [] },
      { table: 'stripe_connected_accounts', method: 'select', args: ['stripe_account_id'] },
      { table: 'stripe_connected_accounts', method: 'eq', args: ['family_id', family] },
      { table: 'stripe_connected_accounts', method: 'maybeSingle', args: [] },
    ]);
    expect(mock.capabilities).toHaveBeenCalledExactlyOnceWith(service);
    expect(mock.publishableKey).toHaveBeenCalledExactlyOnceWith(null);
    if (name === 'prepare') {
      noKeyEffects();
      expect(mock.events).toEqual(['auth', 'service', 'capabilities', 'read:stripe_issuing_cards', 'read:stripe_connected_accounts', 'publishable']);
    } else {
      expect(mock.stripe).toHaveBeenCalledExactlyOnceWith();
      expect(mock.ephemeral).toHaveBeenCalledExactlyOnceWith(
        { issuing_card: 'ic_synthetic', nonce },
        { apiVersion: '2026-05-27.dahlia', stripeAccount: 'acct_synthetic' },
      );
      expect(mock.audit).toHaveBeenCalledExactlyOnceWith(service, {
        family_id: family, actor_user_id: context.user.id, action: 'card_revealed',
        entity_type: 'stripe_issuing_cards', entity_id: cardId,
      }, 'card reveal');
      expect(mock.events).toEqual(['auth', 'service', 'capabilities', 'read:stripe_issuing_cards', 'read:stripe_connected_accounts', 'publishable', 'stripe', 'ephemeral', 'audit']);
    }
  });
  it('uses changed active-family identifiers and its returned card/account', async () => {
    context.active.familyId = 'family-synthetic-b';
    replies.stripe_issuing_cards.data = { id: 'returned-card-b', stripe_card_id: 'ic_synthetic_b' };
    replies.stripe_connected_accounts.data = { stripe_account_id: 'acct_synthetic_b' };
    expect(await action()).toMatchObject({ ok: true, data: { stripeCardId: 'ic_synthetic_b', stripeAccount: 'acct_synthetic_b' } });
    expect(queryCalls.filter(call => call.method === 'eq' && call.args[0] === 'family_id')).toEqual([
      { table: 'stripe_issuing_cards', method: 'eq', args: ['family_id', 'family-synthetic-b'] },
      { table: 'stripe_connected_accounts', method: 'eq', args: ['family_id', 'family-synthetic-b'] },
    ]);
    if (name === 'prepare') noKeyEffects();
    else {
      expect(mock.ephemeral).toHaveBeenCalledExactlyOnceWith({ issuing_card: 'ic_synthetic_b', nonce }, { apiVersion: '2026-05-27.dahlia', stripeAccount: 'acct_synthetic_b' });
      expect(mock.audit.mock.calls[0][1]).toMatchObject({ family_id: 'family-synthetic-b', entity_id: 'returned-card-b' });
    }
  });
  it.each([
    ['stripe_issuing_cards', 'actions.cardNotFound'],
    ['stripe_connected_accounts', 'actions.noAccountConfigured'],
  ] as const)('refuses genuinely absent %s before key/config access', async (table, key) => {
    replies[table].data = null;
    expect(await action()).toEqual({ ok: false, error: `translated:${key}` });
    expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
  });
  it.each([null, ''])('refuses unavailable public configuration %j without provider or audit', async value => {
    mock.publishableKey.mockReturnValue(value);
    expect(await action()).toEqual({ ok: false, error: 'translated:actions.cardRevealIsNotConfigured' }); noKeyEffects();
  });
  it('waits for both independent reads before publishing configuration or creating a key', async () => {
    const card = deferred<Reply>(); const account = deferred<Reply>();
    const cardReply = replies.stripe_issuing_cards; const accountReply = replies.stripe_connected_accounts;
    replies.stripe_issuing_cards = { data: null, error: null, deferred: card.promise };
    replies.stripe_connected_accounts = { data: null, error: null, deferred: account.promise };
    const pending = action(); await flush();
    expect(mock.from.mock.calls).toEqual([['stripe_issuing_cards'], ['stripe_connected_accounts']]);
    expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
    card.resolve(cardReply); await flush(); expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
    account.resolve(accountReply); expect(await pending).toMatchObject({ ok: true });
    expect(mock.publishableKey).toHaveBeenCalledTimes(1);
  });
});

describe('create reveal nonce, settled errors and synthetic provider boundary', () => {
  it.each(['', ' ', '\n\t'])('rejects blank nonce %j before lookups, provider or audit', async invalidNonce => {
    expect(await createCardRevealAction({ cardId, nonce: invalidNonce })).toEqual({ ok: false, error: 'translated:actions.missingRevealSession' });
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
  });
  describe.each([
    ['stripe_issuing_cards', 'money.couldNotLoadTheCard'],
    ['stripe_connected_accounts', 'money.couldNotLoadTheConnectedAccount'],
  ] as const)('%s errors', (table, key) => {
    it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('refuses resolved error %j over any accompanying data', async error => {
      replies[table].error = error;
      expect(await createCardRevealAction({ cardId, nonce })).toEqual({ ok: false, error: `translated:${key}` });
      expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
    });
    it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('settles transport rejection %j into a safe error', async rejection => {
      replies[table].rejection = rejection;
      expect(await createCardRevealAction({ cardId, nonce })).toEqual({ ok: false, error: `translated:${key}` });
      expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
    });
  });
  it('retains safe permission classification for a resolved database error', async () => {
    replies.stripe_issuing_cards.error = { code: '42501', message: detail };
    expect(await createCardRevealAction({ cardId, nonce })).toEqual({ ok: false, error: "You don't have permission to do that. Ask a family admin if you think this is a mistake." }); noKeyEffects();
  });
  it('prioritizes a card error if both parallel reads fail', async () => {
    replies.stripe_issuing_cards.rejection = new Error(detail); replies.stripe_connected_accounts.error = new Error(detail);
    expect(await createCardRevealAction({ cardId, nonce })).toEqual({ ok: false, error: 'translated:money.couldNotLoadTheCard' });
    expect(mock.publishableKey).not.toHaveBeenCalled(); noKeyEffects();
  });
  it('sanitizes a throwing mocked Stripe accessor before any key operation', async () => {
    mock.stripe.mockImplementation(() => { throw new Error(detail); });
    expect(await createCardRevealAction({ cardId, nonce })).toEqual({ ok: false, error: 'translated:money.couldNotStartTheCardReveal' });
    expect(mock.ephemeral).not.toHaveBeenCalled(); expect(mock.audit).not.toHaveBeenCalled();
  });
  it.each([new Error(detail), detail, { code: 'provider_internal', message: detail }])('sanitizes ephemeral-operation rejection %j before audit', async error => {
    mock.ephemeral.mockRejectedValue(error);
    expect(await createCardRevealAction({ cardId, nonce })).toEqual({ ok: false, error: 'translated:money.couldNotStartTheCardReveal' });
    expect(mock.ephemeral).toHaveBeenCalledTimes(1); expect(mock.audit).not.toHaveBeenCalled();
  });
  it('waits for the synthetic key and audit before returning the reveal payload', async () => {
    const key = deferred<{ secret: string }>(); const audit = deferred<void>();
    mock.ephemeral.mockReturnValue(key.promise); mock.audit.mockReturnValue(audit.promise);
    let settled = false;
    const pending = createCardRevealAction({ cardId, nonce }).then(value => { settled = true; return value; }); await flush();
    expect(mock.ephemeral).toHaveBeenCalledTimes(1); expect(mock.audit).not.toHaveBeenCalled(); expect(settled).toBe(false);
    key.resolve({ secret: ephemeral }); await flush(); expect(mock.audit).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
    audit.resolve(); expect(await pending).toEqual({ ok: true, data: { ephemeralKeySecret: ephemeral, stripeCardId: 'ic_synthetic', publishableKey: publishable, stripeAccount: 'acct_synthetic' } });
  });
});
