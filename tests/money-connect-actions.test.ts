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

// Actual orchestration, isManager, settleAll and describeActionError stay real.
import { startConnectOnboardingAction, refreshConnectStatusAction } from '@/app/(app)/money/actions';

const familyA = 'family-a-synthetic';
const familyB = 'family-b-synthetic';
const user = { id: 'user-synthetic', email: 'manager@example.invalid' };
const service = { from: mock.from };
const account = { stripe_account_id: 'acct_synthetic_a' };
const onboardingUrl = 'https://connect.example.invalid/hosted-onboarding';
const providerDetail = 'synthetic upstream detail must not be in response';
const forbidden = () => { throw new Error('Unrelated provider/Trust/client reached'); };
let context: { user: { id: string; email: string | null }; active: { familyId: string; role: string; member: { id: string } } };
let queryResult: { data: typeof account | null; error: unknown };
let queryFailure: unknown;
let queryCalls: [string, ...unknown[]][];

function noEffects() {
  expect(mock.createServiceClient).not.toHaveBeenCalled();
  expect(mock.capabilities).not.toHaveBeenCalled();
  expect(mock.ensureAccount).not.toHaveBeenCalled();
  expect(mock.link).not.toHaveBeenCalled();
  expect(mock.sync).not.toHaveBeenCalled();
  expect(mock.from).not.toHaveBeenCalled();
  expect(mock.headers).not.toHaveBeenCalled();
  expect(mock.revalidate).not.toHaveBeenCalled();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

beforeEach(() => {
  vi.clearAllMocks();
  mock.events = []; queryCalls = []; queryFailure = undefined;
  context = { user: { ...user }, active: { familyId: familyA, role: 'parent', member: { id: 'member-synthetic' } } };
  queryResult = { data: { ...account }, error: null };
  mock.translations.mockImplementation(async () => { mock.events.push('translations'); return (key: string) => `translated:${key}`; });
  mock.requireUserContext.mockImplementation(async () => { mock.events.push('auth'); return context; });
  mock.createServiceClient.mockImplementation(() => { mock.events.push('service'); return service; });
  mock.capabilities.mockImplementation(async () => { mock.events.push('capability'); return { connectOnboarding: true }; });
  mock.ensureAccount.mockImplementation(async () => { mock.events.push('ensure'); return { accountId: account.stripe_account_id, rowId: 'mirror-row-synthetic' }; });
  mock.headers.mockImplementation(async () => { mock.events.push('headers'); return new Headers({ host: 'bubaly.example.invalid' }); });
  mock.link.mockImplementation(async () => { mock.events.push('link'); return onboardingUrl; });
  mock.sync.mockImplementation(async () => { mock.events.push('sync'); });
  mock.revalidate.mockImplementation(() => { mock.events.push('revalidate'); });
  mock.from.mockImplementation((table: string) => {
    queryCalls.push(['from', table]);
    const query = {
      select(columns: string) { queryCalls.push(['select', columns]); return query; },
      eq(column: string, value: unknown) { queryCalls.push(['eq', column, value]); return query; },
      async maybeSingle() {
        queryCalls.push(['maybeSingle']); mock.events.push('query');
        if (queryFailure) throw queryFailure;
        return queryResult;
      },
    };
    return query;
  });
  for (const stub of [mock.treasury, mock.cardholder, mock.issueCard, mock.freezeCard, mock.controls, mock.trust, mock.roleOf, mock.stripe, mock.publishableKey, mock.audit, mock.forbiddenClient]) stub.mockImplementation(forbidden);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.stripeModuleLoads).toBe(0); expect(mock.stripeInitializations).toBe(0);
  for (const stub of [mock.treasury, mock.cardholder, mock.issueCard, mock.freezeCard, mock.controls, mock.trust, mock.roleOf, mock.stripe, mock.publishableKey, mock.audit, mock.forbiddenClient]) expect(stub).not.toHaveBeenCalled();
  vi.mocked(console.error).mockRestore();
});
afterAll(() => network.restore());

describe('Connect action admission, with no real provider or database', () => {
  it.each(['parent', 'adult'])('allows %s onboarding with exact family/account/callback inputs', async role => {
    context.active.role = role;
    expect(await startConnectOnboardingAction()).toEqual({ ok: true, data: { url: onboardingUrl } });
    expect(mock.ensureAccount).toHaveBeenCalledExactlyOnceWith(service, { familyId: familyA, email: user.email, userId: user.id });
    expect(mock.link).toHaveBeenCalledExactlyOnceWith(account.stripe_account_id, {
      returnUrl: 'https://bubaly.example.invalid/wallet/cards?setup=complete',
      refreshUrl: 'https://bubaly.example.invalid/wallet/cards?setup=refresh',
    });
    expect(mock.capabilities).toHaveBeenCalledExactlyOnceWith(service);
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet/cards');
    expect(mock.events).toEqual(['translations', 'auth', 'service', 'capability', 'ensure', 'headers', 'link', 'revalidate']);
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.sync).not.toHaveBeenCalled();
  });

  it.each(['parent', 'adult'])('allows %s refresh only for the active family account', async role => {
    context.active.role = role;
    expect(await refreshConnectStatusAction()).toEqual({ ok: true });
    expect(queryCalls).toEqual([['from', 'stripe_connected_accounts'], ['select', 'stripe_account_id'], ['eq', 'family_id', familyA], ['maybeSingle']]);
    expect(mock.sync).toHaveBeenCalledExactlyOnceWith(service, familyA, account.stripe_account_id);
    expect(mock.events).toEqual(['translations', 'auth', 'service', 'query', 'sync', 'revalidate']);
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet/cards');
    expect(mock.capabilities).not.toHaveBeenCalled(); expect(mock.ensureAccount).not.toHaveBeenCalled(); expect(mock.link).not.toHaveBeenCalled();
  });

  describe.each([
    ['onboarding', startConnectOnboardingAction, 'actions.onlyParentsCanSetUp'],
    ['refresh', refreshConnectStatusAction, 'actions.onlyParentsCanDoThis'],
  ] as const)('%s', (_name, action, message) => {
    it.each(['teen', 'child', 'caregiver', 'guest'])('refuses %s before service/provider access', async role => {
      context.active.role = role;
      expect(await action()).toEqual({ ok: false, error: `translated:${message}` });
      noEffects();
    });
    it('preserves signed-out redirect/throw before any effects', async () => {
      const redirect = new Error('synthetic-sign-in-redirect');
      mock.requireUserContext.mockRejectedValue(redirect);
      await expect(action()).rejects.toBe(redirect);
      noEffects();
    });
  });
});

describe('onboarding orchestration', () => {
  it('refuses unavailable onboarding capability without account/link creation or refresh', async () => {
    mock.capabilities.mockResolvedValue({ connectOnboarding: false, treasury: true, issuing: true });
    expect(await startConnectOnboardingAction()).toEqual({ ok: false, error: 'translated:actions.paymentsSetupIsNotAvailable' });
    expect(mock.ensureAccount).not.toHaveBeenCalled(); expect(mock.link).not.toHaveBeenCalled();
    expect(mock.headers).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });

  it('passes the active family and nullable email without substituting another household', async () => {
    context.active.familyId = familyB; context.user.email = null;
    mock.ensureAccount.mockResolvedValue({ accountId: 'acct_synthetic_b', rowId: 'mirror-b' });
    await startConnectOnboardingAction();
    expect(mock.ensureAccount).toHaveBeenCalledExactlyOnceWith(service, { familyId: familyB, email: null, userId: user.id });
    expect(mock.link.mock.calls[0][0]).toBe('acct_synthetic_b');
  });

  it.each([
    [{ 'x-forwarded-host': 'forwarded.example.invalid:444', host: 'ignored.example.invalid', 'x-forwarded-proto': 'https' }, 'https://forwarded.example.invalid:444'],
    [{ host: 'local.example.invalid:3000', 'x-forwarded-proto': 'http' }, 'http://local.example.invalid:3000'],
    [{}, 'https://www.bubaly.com'],
  ])('builds exact callbacks from supplied server headers %j', async (values, base) => {
    mock.headers.mockResolvedValue(new Headers(values as Record<string, string>));
    await startConnectOnboardingAction();
    expect(mock.link).toHaveBeenCalledExactlyOnceWith(account.stripe_account_id, { returnUrl: `${base}/wallet/cards?setup=complete`, refreshUrl: `${base}/wallet/cards?setup=refresh` });
  });

  it.each(['ensure', 'headers', 'link'] as const)('sanitizes %s rejection and never signals successful refresh', async step => {
    const stub = step === 'ensure' ? mock.ensureAccount : step === 'headers' ? mock.headers : mock.link;
    stub.mockRejectedValue(new Error(providerDetail));
    expect(await startConnectOnboardingAction()).toEqual({ ok: false, error: 'translated:money.couldNotStartStripeOnboarding' });
    expect(mock.revalidate).not.toHaveBeenCalled();
    if (step !== 'link') expect(mock.link).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('waits for account creation, then link completion, before refreshing', async () => {
    const ensure = deferred<{ accountId: string; rowId: string }>();
    const link = deferred<string>();
    mock.ensureAccount.mockReturnValue(ensure.promise); mock.link.mockReturnValue(link.promise);
    const pending = startConnectOnboardingAction(); await flush();
    expect(mock.link).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
    ensure.resolve({ accountId: account.stripe_account_id, rowId: 'mirror' }); await flush();
    expect(mock.link).toHaveBeenCalledTimes(1); expect(mock.revalidate).not.toHaveBeenCalled();
    link.resolve(onboardingUrl);
    expect(await pending).toEqual({ ok: true, data: { url: onboardingUrl } });
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet/cards');
  });
});

describe('refresh family lookup and response boundaries', () => {
  it('uses another active family only with its returned account', async () => {
    context.active.familyId = familyB; queryResult.data = { stripe_account_id: 'acct_synthetic_b' };
    await refreshConnectStatusAction();
    expect(queryCalls).toContainEqual(['eq', 'family_id', familyB]);
    expect(mock.sync).toHaveBeenCalledExactlyOnceWith(service, familyB, 'acct_synthetic_b');
  });

  it('does not sync or refresh when the family has no mirrored account', async () => {
    queryResult.data = null;
    expect(await refreshConnectStatusAction()).toEqual({ ok: false, error: 'translated:actions.noAccountToRefreshYet' });
    expect(mock.sync).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });

  it.each([new Error(providerDetail), { code: 'XX999', message: providerDetail, details: 'synthetic private schema detail' }, providerDetail])('sanitizes lookup error %j even if a stale account is present', async error => {
    queryResult.error = error;
    expect(await refreshConnectStatusAction()).toEqual({ ok: false, error: 'translated:money.couldNotLoadTheConnectedAccount' });
    expect(mock.sync).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });

  it('keeps the real classified permission message instead of leaking database detail', async () => {
    queryResult.error = { code: '42501', message: providerDetail };
    const result = await refreshConnectStatusAction();
    expect(result).toEqual({ ok: false, error: "You don't have permission to do that. Ask a family admin if you think this is a mistake." });
    expect(mock.sync).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });

  it.each([new Error(providerDetail), { code: 'provider_internal', message: providerDetail }, providerDetail])('sanitizes sync failure %j without returning success or refreshing', async error => {
    mock.sync.mockRejectedValue(error);
    expect(await refreshConnectStatusAction()).toEqual({ ok: false, error: 'translated:money.couldNotRefreshStripeOnboarding' });
    expect(mock.revalidate).not.toHaveBeenCalled();
  });

  it('waits for successful mirror helper completion before refresh', async () => {
    const sync = deferred<void>(); mock.sync.mockReturnValue(sync.promise);
    const pending = refreshConnectStatusAction(); await flush();
    expect(mock.sync).toHaveBeenCalledTimes(1); expect(mock.revalidate).not.toHaveBeenCalled();
    sync.resolve(); expect(await pending).toEqual({ ok: true });
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet/cards');
  });
});

// These two cases record existing failure behavior, not acceptance of it.
// The prerequisite awaits are outside each action's try/catch. They are reported
// as an open availability gap; the test-only slice does not repair application code.
describe('unresolved prerequisite-rejection characterization', () => {
  it('currently propagates a rejected capability read before onboarding effects', async () => {
    const cause = new Error('synthetic capability transport failure');
    mock.capabilities.mockRejectedValue(cause);
    await expect(startConnectOnboardingAction()).rejects.toBe(cause);
    expect(mock.ensureAccount).not.toHaveBeenCalled(); expect(mock.link).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });
  it('currently propagates a rejected account lookup before sync effects', async () => {
    queryFailure = new Error('synthetic mirror lookup transport failure');
    await expect(refreshConnectStatusAction()).rejects.toBe(queryFailure);
    expect(mock.sync).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
  });
});
