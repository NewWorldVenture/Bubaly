import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';

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
  forbiddenClient: vi.fn(), stripeModuleLoads: 0, stripeInitializations: 0,
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
vi.mock('@supabase/supabase-js', () => ({ createClient: mock.forbiddenClient }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mock.forbiddenClient, createBrowserClient: mock.forbiddenClient }));
vi.mock('stripe', () => {
  mock.stripeModuleLoads++;
  return { default: class { constructor() { mock.stripeInitializations++; throw new Error('Stripe SDK must not initialize'); } } };
});

// Server Trust/ledgerWriter and every provider factory remain entirely mocked.
// The side-effect-free policy evaluator, role checks, settleAll and safe errors run for real.
import { activateTreasuryAction, issueCardAction } from '@/app/(app)/money/actions';
import { evaluateAction, type Decision, type Policy, type TrustRole } from '@/lib/trust/engine';

const family = 'family-synthetic-a';
const memberId = 'manager-member-synthetic';
const service = { from: mock.from };
const input = { childWalletId: 'wallet-synthetic', type: 'virtual' as const, spendLimitCents: 5000, spendWindow: 'monthly' };
const detail = 'synthetic provider detail must not reach the result';
type QueryReply = { data: Record<string, unknown> | null; error: unknown; rejection?: unknown };
let context: { user: { id: string }; active: { familyId: string; role: TrustRole; member: { id: string } } };
let replies: Record<string, QueryReply>;
let queryCalls: { table: string; method: string; args: unknown[] }[];
let decision: Decision;

function policyDecision(effect: Policy['effect']): Decision {
  const policy: Policy = { id: 'policy-synthetic', domain: 'finances', capability: 'create', subjectKind: 'everyone', effect, conditions: {}, approvalModel: 'single', requiredApprovals: 1, priority: 100, enabled: true };
  return evaluateAction({ actor: { kind: 'member', id: memberId, role: context.active.role }, domain: 'finances', capability: 'create', context: { amountCents: 5000 }, policies: [policy] });
}
function noInstrumentEffects() {
  expect(mock.cardholder).not.toHaveBeenCalled(); expect(mock.issueCard).not.toHaveBeenCalled();
  expect(mock.audit).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
}
function noEffects() {
  expect(mock.createServiceClient).not.toHaveBeenCalled(); expect(mock.capabilities).not.toHaveBeenCalled();
  expect(mock.from).not.toHaveBeenCalled(); expect(mock.trust).not.toHaveBeenCalled();
  expect(mock.roleOf).not.toHaveBeenCalled(); expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
}
beforeEach(() => {
  vi.clearAllMocks(); mock.events = []; queryCalls = [];
  context = { user: { id: 'user-synthetic' }, active: { familyId: family, role: 'parent', member: { id: memberId } } };
  replies = {
    stripe_connected_accounts: { data: { id: 'connected-row', stripe_account_id: 'acct_synthetic', treasury_enabled: true, card_issuing_enabled: true }, error: null },
    child_wallets: { data: { id: input.childWalletId, member_id: 'child-member' }, error: null },
    family_members: { data: { display_name: 'Synthetic Child' }, error: null },
  };
  decision = policyDecision('allow');
  mock.translations.mockImplementation(async () => (key: string) => `translated:${key}`);
  mock.requireUserContext.mockImplementation(async () => { mock.events.push('auth'); return context; });
  mock.createServiceClient.mockImplementation(() => { mock.events.push('service'); return service; });
  mock.capabilities.mockImplementation(async () => { mock.events.push('capabilities'); return { treasury: true, issuing: true, physicalCards: true }; });
  mock.from.mockImplementation((table: string) => {
    queryCalls.push({ table, method: 'from', args: [] });
    const query = {
      select(columns: string) { queryCalls.push({ table, method: 'select', args: [columns] }); return query; },
      eq(column: string, value: unknown) { queryCalls.push({ table, method: 'eq', args: [column, value] }); return query; },
      async maybeSingle() {
        mock.events.push(`read:${table}`); queryCalls.push({ table, method: 'maybeSingle', args: [] });
        const response = replies[table]; if (!response) throw new Error(`Unexpected table ${table}`);
        if ('rejection' in response) throw response.rejection;
        return response;
      },
    };
    return query;
  });
  mock.trust.mockImplementation(async () => { mock.events.push('trust'); return { decision, approvalId: undefined, alreadyPending: false }; });
  mock.roleOf.mockImplementation(role => role);
  mock.treasury.mockImplementation(async () => { mock.events.push('treasury'); return { rowId: 'financial-row', financialAccountId: 'fa_synthetic' }; });
  mock.cardholder.mockImplementation(async () => { mock.events.push('cardholder'); return { rowId: 'holder-row', stripeCardholderId: 'ich_synthetic' }; });
  mock.issueCard.mockImplementation(async () => { mock.events.push('issue'); return { rowId: 'card-row', stripeCardId: 'ic_synthetic' }; });
  mock.audit.mockImplementation(async () => { mock.events.push('audit'); });
  mock.revalidate.mockImplementation(() => { mock.events.push('revalidate'); });
  const forbidden = () => { throw new Error('Unrelated provider/client reached'); };
  for (const stub of [mock.ensureAccount, mock.link, mock.sync, mock.headers, mock.freezeCard, mock.controls, mock.stripe, mock.publishableKey, mock.forbiddenClient]) stub.mockImplementation(forbidden);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.stripeModuleLoads).toBe(0); expect(mock.stripeInitializations).toBe(0);
  for (const stub of [mock.ensureAccount, mock.link, mock.sync, mock.headers, mock.freezeCard, mock.controls, mock.stripe, mock.publishableKey, mock.forbiddenClient]) expect(stub).not.toHaveBeenCalled();
  vi.mocked(console.error).mockRestore();
});
afterAll(() => network.restore());

describe('card policy admission controls', () => {
  it.each(['parent', 'adult'] as const)('allows %s only after the explicit policy allow control', async role => {
    context.active.role = role; decision = policyDecision('allow');
    expect(decision).toMatchObject({ effect: 'allow', basis: 'policy' });
    expect(await issueCardAction(input)).toEqual({ ok: true, data: { cardId: 'card-row' } });
    expect(mock.trust).toHaveBeenCalledExactlyOnceWith(service, family, {
      actor: { kind: 'member', id: memberId, role }, domain: 'finances', capability: 'create',
      title: 'Issue virtual card', context: { amountCents: 5000 }, openApproval: false,
    });
    expect(mock.cardholder).toHaveBeenCalledTimes(1); expect(mock.issueCard).toHaveBeenCalledTimes(1);
    expect(mock.audit).toHaveBeenCalledTimes(1); expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
    expect(at(mock.events, 'trust')).toBeLessThan(at(mock.events, 'cardholder'));
  });

  it.each(['parent', 'adult'] as const)('refuses explicit policy deny for %s without instruments/audit/refresh', async role => {
    context.active.role = role; decision = policyDecision('deny');
    expect(decision).toMatchObject({ effect: 'deny', basis: 'policy' });
    expect(await issueCardAction(input)).toEqual({ ok: false, error: 'translated:trust.blockedByHouseholdPolicy' });
    noInstrumentEffects();
    expect(queryCalls.some(call => call.table === 'family_members')).toBe(false);
  });

  it.each(['parent', 'adult'] as const)('refuses policy-required approval for %s before any instrument effects', async role => {
    context.active.role = role; decision = policyDecision('require_approval');
    expect(decision).toMatchObject({ effect: 'require_approval', basis: 'policy' });
    expect.soft(await issueCardAction(input)).toEqual({ ok: false, error: 'translated:trust.blockedByHouseholdPolicy' });
    expect.soft(mock.cardholder).not.toHaveBeenCalled(); expect.soft(mock.issueCard).not.toHaveBeenCalled();
    expect.soft(mock.audit).not.toHaveBeenCalled(); expect.soft(mock.revalidate).not.toHaveBeenCalled();
    expect.soft(queryCalls.some(call => call.table === 'family_members')).toBe(false);
  });
  it.each(['parent', 'adult'] as const)('refuses degraded rule reads for %s before any instrument effects', async role => {
    context.active.role = role;
    decision = { effect: 'require_approval', basis: 'degraded', reason: 'Synthetic unreadable rules require approval.' };
    expect.soft(await issueCardAction(input)).toEqual({ ok: false, error: 'translated:trust.blockedByHouseholdPolicy' });
    expect.soft(mock.cardholder).not.toHaveBeenCalled(); expect.soft(mock.issueCard).not.toHaveBeenCalled();
    expect.soft(mock.audit).not.toHaveBeenCalled(); expect.soft(mock.revalidate).not.toHaveBeenCalled();
    expect.soft(queryCalls.some(call => call.table === 'family_members')).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe.each([
  ['Treasury', activateTreasuryAction, 'actions.onlyParentsCanDoThis'],
  ['card issuance', () => issueCardAction(input), 'actions.onlyParentsCanIssueCards'],
] as const)('%s manager admission', (_name, action, key) => {
  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('refuses %s before service/Trust/provider access', async role => {
    context.active.role = role;
    expect(await action()).toEqual({ ok: false, error: `translated:${key}` });
    noEffects();
  });
  it('preserves signed-out redirect without service/Trust/provider access', async () => {
    const redirect = new Error('synthetic sign-in redirect');
    mock.requireUserContext.mockRejectedValue(redirect);
    await expect(action()).rejects.toBe(redirect); noEffects();
  });
});

describe('Treasury capability, family scope and helper completion', () => {
  it.each(['parent', 'adult'] as const)('admits %s with exact scoped account and success-only refresh', async role => {
    context.active.role = role;
    expect(await activateTreasuryAction()).toEqual({ ok: true });
    expect(mock.capabilities).toHaveBeenCalledExactlyOnceWith(service);
    expect(queryCalls).toEqual([
      { table: 'stripe_connected_accounts', method: 'from', args: [] },
      { table: 'stripe_connected_accounts', method: 'select', args: ['id, stripe_account_id, treasury_enabled'] },
      { table: 'stripe_connected_accounts', method: 'eq', args: ['family_id', family] },
      { table: 'stripe_connected_accounts', method: 'maybeSingle', args: [] },
    ]);
    expect(mock.treasury).toHaveBeenCalledExactlyOnceWith(service, {
      familyId: family, connectedAccountRowId: 'connected-row', accountId: 'acct_synthetic',
    });
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet/cards');
    expect(mock.events).toEqual(['auth', 'service', 'capabilities', 'read:stripe_connected_accounts', 'treasury', 'revalidate']);
    expect(mock.trust).not.toHaveBeenCalled(); expect(mock.cardholder).not.toHaveBeenCalled();
    expect(mock.issueCard).not.toHaveBeenCalled(); expect(mock.audit).not.toHaveBeenCalled();
  });
  it('uses a changed active family and its returned account only', async () => {
    context.active.familyId = 'family-synthetic-b';
    replies.stripe_connected_accounts.data = { id: 'connected-b', stripe_account_id: 'acct_synthetic_b', treasury_enabled: true };
    expect(await activateTreasuryAction()).toEqual({ ok: true });
    expect(queryCalls).toContainEqual({ table: 'stripe_connected_accounts', method: 'eq', args: ['family_id', 'family-synthetic-b'] });
    expect(mock.treasury).toHaveBeenCalledExactlyOnceWith(service, { familyId: 'family-synthetic-b', connectedAccountRowId: 'connected-b', accountId: 'acct_synthetic_b' });
  });
  it('refuses a missing capability before reads or financial-account helper', async () => {
    mock.capabilities.mockResolvedValue({ treasury: false, issuing: true });
    expect(await activateTreasuryAction()).toEqual({ ok: false, error: 'translated:actions.thisFeatureIsNotAvailable' });
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([null, { id: 'connected-row', stripe_account_id: 'acct_synthetic', treasury_enabled: false }])('refuses absent or unfinished mirrored account %j', async data => {
    replies.stripe_connected_accounts.data = data;
    expect(await activateTreasuryAction()).toEqual({ ok: false, error: 'translated:actions.finishAccountSetupFirst' });
    expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('sanitizes account response error %j despite stale account data', async error => {
    replies.stripe_connected_accounts.error = error;
    expect(await activateTreasuryAction()).toEqual({ ok: false, error: 'translated:money.couldNotLoadTheTreasuryAccount' });
    expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([new Error(detail), detail, { code: 'provider_internal', message: detail }])('sanitizes helper rejection %j without success refresh', async error => {
    mock.treasury.mockRejectedValue(error);
    expect(await activateTreasuryAction()).toEqual({ ok: false, error: 'translated:money.couldNotOpenTheTreasuryAccount' });
    expect(mock.treasury).toHaveBeenCalledTimes(1); noInstrumentEffects();
  });
  it('waits for financial-account helper completion before refresh', async () => {
    const completion = deferred<unknown>(); mock.treasury.mockReturnValue(completion.promise);
    const pending = activateTreasuryAction(); await flush();
    expect(mock.treasury).toHaveBeenCalledTimes(1); expect(mock.revalidate).not.toHaveBeenCalled();
    completion.resolve({ rowId: 'financial-row' }); expect(await pending).toEqual({ ok: true });
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet/cards');
  });
});

describe('card capability, lookup and orchestration boundaries', () => {
  it.each([
    ['issuing', { issuing: false, physicalCards: true }, 'virtual', 'actions.cardsAreNotAvailableYet'],
    ['physical', { issuing: true, physicalCards: false }, 'physical', 'actions.physicalCardsAreNotAvailable'],
  ] as const)('refuses missing %s capability before mirrors or Trust', async (_name, caps, type, key) => {
    mock.capabilities.mockResolvedValue(caps);
    expect(await issueCardAction({ ...input, type })).toEqual({ ok: false, error: `translated:${key}` });
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.trust).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it('does not require physical capability for a virtual card', async () => {
    mock.capabilities.mockResolvedValue({ issuing: true, physicalCards: false });
    expect(await issueCardAction(input)).toEqual({ ok: true, data: { cardId: 'card-row' } });
  });
  it.each([
    ['stripe_connected_accounts', 'money.couldNotLoadCardIssuingCapabilities'],
    ['child_wallets', 'money.couldNotLoadTheChildWallet'],
  ] as const)('settles rejected %s reads into safe refusal without Trust or instruments', async (table, key) => {
    replies[table].rejection = new Error(detail);
    expect(await issueCardAction(input)).toEqual({ ok: false, error: `translated:${key}` });
    expect(mock.trust).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([
    ['stripe_connected_accounts', 'money.couldNotLoadCardIssuingCapabilities'],
    ['child_wallets', 'money.couldNotLoadTheChildWallet'],
    ['family_members', 'money.couldNotLoadTheCardholderProfile'],
  ] as const)('sanitizes %s response errors instead of using accompanying data', async (table, key) => {
    replies[table].error = { code: 'XX999', message: detail };
    expect(await issueCardAction(input)).toEqual({ ok: false, error: `translated:${key}` });
    noInstrumentEffects();
  });
  it('prioritizes the account error when both initial reads fail', async () => {
    replies.stripe_connected_accounts.error = new Error(detail); replies.child_wallets.rejection = new Error(detail);
    expect(await issueCardAction(input)).toEqual({ ok: false, error: 'translated:money.couldNotLoadCardIssuingCapabilities' });
    expect(mock.trust).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([null, { stripe_account_id: 'acct_synthetic', card_issuing_enabled: false }])('refuses missing or disabled issuing account %j', async data => {
    replies.stripe_connected_accounts.data = data;
    expect(await issueCardAction(input)).toEqual({ ok: false, error: 'translated:actions.finishAccountSetupFirst' });
    expect(mock.trust).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it('refuses a missing family wallet before Trust or instruments', async () => {
    replies.child_wallets.data = null;
    expect(await issueCardAction(input)).toEqual({ ok: false, error: 'translated:actions.childWalletNotFound' });
    expect(mock.trust).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([
    { childWalletId: 'wallet-synthetic', type: 'virtual' as const, spendLimitCents: null, spendWindow: 'per_authorization' },
    { childWalletId: 'wallet-synthetic', type: 'physical' as const, spendLimitCents: 5000, spendWindow: 'daily' },
  ])('preserves scoped helper/audit payloads, mirror id and ordering for %j', async request => {
    context.active.familyId = 'family-synthetic-b';
    replies.stripe_connected_accounts.data = { stripe_account_id: 'acct_synthetic_b', card_issuing_enabled: true };
    expect(await issueCardAction(request)).toEqual({ ok: true, data: { cardId: 'card-row' } });
    expect(queryCalls.filter(call => call.method === 'eq')).toEqual([
      { table: 'stripe_connected_accounts', method: 'eq', args: ['family_id', 'family-synthetic-b'] },
      { table: 'child_wallets', method: 'eq', args: ['family_id', 'family-synthetic-b'] },
      { table: 'child_wallets', method: 'eq', args: ['id', request.childWalletId] },
      { table: 'family_members', method: 'eq', args: ['id', 'child-member'] },
    ]);
    expect(mock.trust).toHaveBeenCalledExactlyOnceWith(service, 'family-synthetic-b', {
      actor: { kind: 'member', id: memberId, role: 'parent' }, domain: 'finances', capability: 'create',
      title: `Issue ${request.type} card`, context: { amountCents: request.spendLimitCents ?? undefined }, openApproval: false,
    });
    expect(mock.cardholder).toHaveBeenCalledExactlyOnceWith(service, {
      familyId: 'family-synthetic-b', memberId: 'child-member', childWalletId: request.childWalletId,
      name: 'Synthetic Child', accountId: 'acct_synthetic_b', userId: context.user.id,
    });
    expect(mock.issueCard).toHaveBeenCalledExactlyOnceWith(service, {
      familyId: 'family-synthetic-b', childWalletId: request.childWalletId, cardholderRowId: 'holder-row', stripeCardholderId: 'ich_synthetic',
      accountId: 'acct_synthetic_b', type: request.type, spendLimitCents: request.spendLimitCents, spendWindow: request.spendWindow, userId: context.user.id,
    });
    expect(mock.audit).toHaveBeenCalledExactlyOnceWith(service, {
      family_id: 'family-synthetic-b', actor_user_id: context.user.id, action: 'card_issued',
      entity_type: 'stripe_issuing_cards', entity_id: 'card-row', detail: `${request.type} card issued`,
    }, 'card issuance');
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
    expect(mock.events).toEqual(['auth', 'service', 'capabilities', 'read:stripe_connected_accounts', 'read:child_wallets', 'trust', 'read:family_members', 'cardholder', 'issue', 'audit', 'revalidate']);
  });
  it.each([null, { display_name: null }])('retains the existing Child fallback for absent profile/name %j', async data => {
    replies.family_members.data = data;
    expect(await issueCardAction(input)).toMatchObject({ ok: true });
    expect(mock.cardholder.mock.calls[0][1].name).toBe('Child');
  });
  it.each(['cardholder', 'issue'] as const)('sanitizes %s helper rejection and never emits success/audit/refresh', async stage => {
    const stub = stage === 'cardholder' ? mock.cardholder : mock.issueCard;
    stub.mockRejectedValue(new Error(detail));
    expect(await issueCardAction(input)).toEqual({ ok: false, error: 'translated:money.couldNotIssueTheCard' });
    if (stage === 'cardholder') expect(mock.issueCard).not.toHaveBeenCalled();
    expect(mock.audit).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });
  it('preserves safe classified permission errors without leaking detail', async () => {
    replies.child_wallets.error = { code: '42501', message: detail };
    expect(await issueCardAction(input)).toEqual({ ok: false, error: "You don't have permission to do that. Ask a family admin if you think this is a mistake." });
    expect(mock.trust).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it('awaits cardholder, issue and audit completion before refreshing', async () => {
    const holder = deferred<unknown>(); const card = deferred<unknown>(); const audit = deferred<void>();
    mock.cardholder.mockReturnValue(holder.promise); mock.issueCard.mockReturnValue(card.promise); mock.audit.mockReturnValue(audit.promise);
    const pending = issueCardAction(input); await flush();
    expect(mock.cardholder).toHaveBeenCalledTimes(1); expect(mock.issueCard).not.toHaveBeenCalled();
    holder.resolve({ rowId: 'holder-row', stripeCardholderId: 'ich_synthetic' }); await flush();
    expect(mock.issueCard).toHaveBeenCalledTimes(1); expect(mock.audit).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
    card.resolve({ rowId: 'card-row', stripeCardId: 'ic_synthetic' }); await flush();
    expect(mock.audit).toHaveBeenCalledTimes(1); expect(mock.revalidate).not.toHaveBeenCalled();
    audit.resolve(); expect(await pending).toEqual({ ok: true, data: { cardId: 'card-row' } });
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
  });
});

describe('safe refusal for Treasury and issuance prerequisites', () => {
  it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('Treasury capabilities rejects safely for %j', async error => {
    mock.capabilities.mockRejectedValue(error);
    await expect.soft(activateTreasuryAction()).resolves.toEqual({ ok: false, error: 'translated:money.couldNotOpenTheTreasuryAccount' });
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.trust).not.toHaveBeenCalled();
    expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('Treasury mirror rejection refuses safely for %j', async error => {
    replies.stripe_connected_accounts.rejection = error;
    await expect.soft(activateTreasuryAction()).resolves.toEqual({ ok: false, error: 'translated:money.couldNotLoadTheTreasuryAccount' });
    expect(mock.trust).not.toHaveBeenCalled(); expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('issuance capabilities rejects safely for %j', async error => {
    mock.capabilities.mockRejectedValue(error);
    await expect.soft(issueCardAction(input)).resolves.toEqual({ ok: false, error: 'translated:money.couldNotLoadCardIssuingCapabilities' });
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.trust).not.toHaveBeenCalled();
    expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('Trust evaluation rejection refuses safely for %j', async error => {
    mock.trust.mockRejectedValue(error);
    await expect.soft(issueCardAction(input)).resolves.toEqual({ ok: false, error: 'translated:money.couldNotIssueTheCard' });
    expect(mock.trust).toHaveBeenCalledTimes(1);
    expect(queryCalls.some(call => call.table === 'family_members')).toBe(false);
    expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
  it.each([new Error(detail), detail, { code: 'XX999', message: detail }])('cardholder profile rejection refuses safely for %j', async error => {
    replies.family_members.rejection = error;
    await expect.soft(issueCardAction(input)).resolves.toEqual({ ok: false, error: 'translated:money.couldNotLoadTheCardholderProfile' });
    expect(mock.trust).toHaveBeenCalledTimes(1);
    expect(mock.treasury).not.toHaveBeenCalled(); noInstrumentEffects();
  });
});
