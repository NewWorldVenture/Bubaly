import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { syntheticProvider } from './helpers/synthetic-issuing-provider';

// JIMMY-SUPPORT-CARD-RETRY-20261001, the stale-order guard: a tab whose view is
// STALE (it still shows N cards of a type for a child) orders that type AFTER
// another tab's card was mirrored. The mirrored count is N+1 by then, so the
// attempt key alone (repair B) treats it as a new attempt and issues a second
// card. The view now sends the count it showed (expectedCount), and issueCard
// refuses an order whose count no longer matches the mirror, before the
// provider is asked for anything.
//
// These drive the real issueCardAction → ensureCardholder → issueCard against
// the synthetic provider (tests/helpers/synthetic-issuing-provider.ts) and the
// in-memory database with the 00901 unique constraints.
//
// Sealed: no network, no real Stripe SDK, no real database client.

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
  const entries = () => [
    http.request, http.get, https.request, https.get,
    net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect, globalThis.fetch,
  ] as unknown as (() => unknown)[];
  const sealed = () => entries().map(fn => vi.isMockFunction(fn));
  return { attempts, sealed, restore() { guards.forEach(guard => guard.mockRestore()); globalThis.fetch = originalFetch; } };
});
const SEALED = Array(9).fill(true);
const mock = vi.hoisted(() => ({
  requireUserContext: vi.fn(), createServiceClient: vi.fn(), capabilities: vi.fn(), getStripe: vi.fn(),
  trust: vi.fn(), roleOf: vi.fn(), audit: vi.fn(), translations: vi.fn(), revalidate: vi.fn(),
  forbidden: vi.fn(), sdkModuleLoads: 0, stripeModuleLoads: 0, stripeInitializations: 0,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mock.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mock.createServiceClient, createServer: mock.forbidden }));
vi.mock('@/lib/stripe/capabilities', () => ({ getMoneyCapabilities: mock.capabilities }));
vi.mock('@/lib/stripe/connect', () => ({ ensureConnectedAccount: mock.forbidden, createOnboardingLink: mock.forbidden, syncConnectedAccount: mock.forbidden }));
vi.mock('@/lib/stripe/treasury', () => ({ ensureFinancialAccount: mock.forbidden }));
vi.mock('@/lib/stripe/settings', () => ({ effectivePublishableKey: mock.forbidden }));
vi.mock('@/lib/stripe', () => ({ getStripe: mock.getStripe }));
vi.mock('@/lib/trust/server', () => ({ evaluateTrust: mock.trust, roleOf: mock.roleOf }));
vi.mock('@/lib/server/audit', () => ({ logWalletAudit: mock.audit }));
vi.mock('next/headers', () => ({ headers: mock.forbidden }));
vi.mock('next/cache', () => ({ revalidatePath: mock.revalidate }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: mock.translations }));
vi.mock('@supabase/supabase-js', () => { mock.sdkModuleLoads++; return { createClient: mock.forbidden }; });
vi.mock('@supabase/ssr', () => { mock.sdkModuleLoads++; return { createServerClient: mock.forbidden, createBrowserClient: mock.forbidden }; });
vi.mock('stripe', () => {
  mock.stripeModuleLoads++;
  return { default: class { constructor() { mock.stripeInitializations++; throw new Error('Stripe SDK must not initialize'); } } };
});

import { issueCardAction } from '@/app/(app)/money/actions';

const FAMILY = 'family-synthetic';
const ACCOUNT = 'acct_synthetic';
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
// What the two UI entry points send (components/wallet/money-cards-view.tsx),
// without the count the view showed; each case adds it.
const VIRTUAL = { childWalletId: 'wallet-a', type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization' } as const;
const PHYSICAL = { childWalletId: 'wallet-a', type: 'physical', spendLimitCents: 2500, spendWindow: 'daily' } as const;
// The stale refusal, and the action's own text for every other failure.
const STALE = 'translated:wallet.refreshToTryAgain';
const REFUSED = 'translated:money.couldNotIssueTheCard';
type Input = Parameters<typeof issueCardAction>[0];
type Order = typeof VIRTUAL | typeof PHYSICAL | { childWalletId: string; type: 'virtual' | 'physical'; spendLimitCents: number | null; spendWindow: string };
/** A canned answer for one `from('stripe_issuing_cards')` builder, or a rejection. */
type Scripted = { data?: unknown; error?: unknown; count?: number | null } | 'reject';

let db: ReturnType<typeof createInMemorySupabase>;
let provider: ReturnType<typeof syntheticProvider>;
let service: SupabaseClient<Database>;
// Per `from('stripe_issuing_cards')` call, in order: null is the real table.
let script: (Scripted | null)[];
let quiet: { mockRestore(): void }[] = [];

function scripted(reply: Scripted) {
  const settle = () => reply === 'reject'
    ? Promise.reject(new Error('synthetic transport failure'))
    : Promise.resolve({ data: null, error: null, count: null, ...reply });
  const chain: Record<string, unknown> = {
    single: settle, maybeSingle: settle,
    then: (ok: (value: unknown) => unknown, bad: (reason: unknown) => unknown) => settle().then(ok, bad),
  };
  for (const method of ['select', 'insert', 'eq']) chain[method] = () => chain;
  return chain;
}

/** One order, sent with the count the sending view showed. */
const order = (input: Order, expectedCount: number) => issueCardAction({ ...input, expectedCount });
const mirrorCards = (childWalletId = 'wallet-a') => db.table('stripe_issuing_cards').filter(row => row.child_wallet_id === childWalletId);
const holderRow = (childWalletId = 'wallet-a') => db.table('stripe_cardholders').find(row => row.child_wallet_id === childWalletId)!.id as string;
/** Repair B's attempt key for the n-th mirrored card of a type for a child. */
const key = (type: string, n: number, wallet = 'wallet-a') => `card-${holderRow(wallet)}-${wallet}-${type}-${n}`;
/** entity_id of every card_issued audit, in the order they were written. */
const issuedAudits = () => mock.audit.mock.calls.filter(([, row]) => (row as Row).action === 'card_issued').map(([, row]) => (row as Row).entity_id);
/** What issueCardAction logged for each failed order. */
const failures = () => vi.mocked(console.error).mock.calls
  .filter(([message]) => message === '[money-action] issue the card failed')
  .map(([, error]) => (error instanceof Error ? error.message : error));
/** Every effect a card order can have: provider creates, live cards, mirror rows, card_issued audits. */
const tally = () => ({
  creates: provider.stripe.issuing.cards.create.mock.calls.length,
  live: provider.active().length,
  rows: db.table('stripe_issuing_cards').length,
  audits: issuedAudits().length,
});

beforeEach(() => {
  expect(network.sealed()).toEqual(SEALED);
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = createInMemorySupabase({
    uniques: {
      stripe_cardholders: [['family_id', 'member_id'], ['stripe_cardholder_id']],
      stripe_issuing_cards: [['stripe_card_id']],
    },
  });
  db.seed('stripe_connected_accounts', [{ family_id: FAMILY, stripe_account_id: ACCOUNT, card_issuing_enabled: true }]);
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' },
    { id: 'wallet-b', family_id: FAMILY, member_id: 'member-b' },
  ]);
  db.seed('family_members', [
    { id: 'member-a', family_id: FAMILY, display_name: 'Synthetic A' },
    { id: 'member-b', family_id: FAMILY, display_name: 'Synthetic B' },
  ]);
  provider = syntheticProvider();
  script = [];
  service = {
    from(table: string) {
      const builder = db.from(table);
      if (table !== 'stripe_issuing_cards') return builder;
      const reply = script.shift();
      return reply ? scripted(reply) : builder;
    },
  } as unknown as SupabaseClient<Database>;
  mock.requireUserContext.mockResolvedValue({
    user: { id: 'user-synthetic', email: 'parent@example.invalid' },
    active: { familyId: FAMILY, role: 'parent', member: { id: 'manager-synthetic' } },
  });
  mock.createServiceClient.mockReturnValue(service);
  mock.capabilities.mockResolvedValue({ issuing: true, physicalCards: true });
  mock.getStripe.mockReturnValue(provider.stripe);
  mock.trust.mockResolvedValue({ decision: { effect: 'allow' } });
  mock.roleOf.mockReturnValue('parent');
  mock.audit.mockResolvedValue(undefined);
  mock.translations.mockResolvedValue((text: string) => `translated:${text}`);
  mock.forbidden.mockImplementation(() => { throw new Error('Unrelated client/provider call'); });
  quiet = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  vi.useRealTimers();
  // Only this case's console spies; restoring every mock would unseal the network.
  quiet.forEach(spy => spy.mockRestore());
  expect(network.sealed()).toEqual(SEALED);
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.forbidden).not.toHaveBeenCalled();
  expect(mock.sdkModuleLoads).toBe(0);
  expect(mock.stripeModuleLoads).toBe(0);
  expect(mock.stripeInitializations).toBe(0);
});
afterAll(() => network.restore());

describe('an order made against a count the mirror has moved past', () => {
  it.each([
    { input: VIRTUAL, shown: 0, label: 'no' },
    { input: VIRTUAL, shown: 2, label: 'two' },
    { input: PHYSICAL, shown: 0, label: 'no' },
    { input: PHYSICAL, shown: 2, label: 'two' },
  ])('a stale tab still showing $label $input.type cards orders after another tab\'s card was mirrored: refused with "refresh to try again", no card, row or audit', async ({ input, shown }) => {
    // The child already has `shown` cards of this type, each ordered on purpose.
    for (let n = 0; n < shown; n++) {
      vi.setSystemTime(T0 + n * 60_000);
      expect((await order(input, n)).ok).toBe(true);
    }
    // Tab 1 orders against the same view and its card is mirrored.
    vi.setSystemTime(T0 + shown * 60_000);
    expect((await order(input, shown)).ok).toBe(true);
    const before = tally();
    expect(before).toEqual({ creates: shown + 1, live: shown + 1, rows: shown + 1, audits: shown + 1 });

    // Tab 2 was never refreshed: it still shows `shown` cards.
    vi.setSystemTime(T0 + (shown + 1) * 60_000);
    expect(await order(input, shown)).toEqual({ ok: false, error: STALE, stale: true });

    expect(tally()).toEqual(before);
    expect(provider.log.cardKeys).toEqual(Array.from({ length: shown + 1 }, (_, n) => key(input.type, n)));
    expect(provider.log.cardOutcomes).toEqual(Array(shown + 1).fill('created'));
    // The cardholder is reused, not recreated; nothing else reached the provider.
    expect(provider.log.cardholderKeys).toEqual(['cardholder-member-a']);
    expect(provider.stripe.accounts.retrieve).toHaveBeenCalledTimes(1);
    // A stale view is an expected answer, not a failure, and nothing changed to revalidate.
    expect(failures()).toEqual([]);
    expect(mock.revalidate).toHaveBeenCalledTimes(shown + 1);
  });

  it.each([VIRTUAL, PHYSICAL])('a deliberate $type order from an up-to-date view (expectedCount = the mirrored count) issues a new card', async input => {
    expect((await order(input, 0)).ok).toBe(true);
    vi.setSystemTime(T0 + 60_000);
    const next = await order(input, 1);

    const rows = mirrorCards();
    expect(next).toEqual({ ok: true, data: { cardId: rows[1].id } });
    expect(tally()).toEqual({ creates: 2, live: 2, rows: 2, audits: 2 });
    expect(provider.log.cardKeys).toEqual([key(input.type, 0), key(input.type, 1)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(rows.map(row => row.stripe_card_id)).toEqual(provider.active(input.type).map(card => card.id));
    expect(issuedAudits()).toEqual(rows.map(row => row.id));
  });

  it.each([VIRTUAL, PHYSICAL])('after the stale refusal the refreshed view orders a second $type card on purpose against the new count', async input => {
    expect((await order(input, 0)).ok).toBe(true);
    vi.setSystemTime(T0 + 60_000);
    expect(await order(input, 0)).toEqual({ ok: false, error: STALE, stale: true });
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 1, audits: 1 });
    vi.setSystemTime(T0 + 120_000);
    expect((await order(input, 1)).ok).toBe(true);

    expect(tally()).toEqual({ creates: 2, live: 2, rows: 2, audits: 2 });
    expect(provider.log.cardKeys).toEqual([key(input.type, 0), key(input.type, 1)]);
  });

  it('an order ahead of the mirror (expectedCount above the count) is refused too, before any card reaches the provider', async () => {
    // A view can show a card the mirror no longer counts (a recreated
    // cardholder's cards cascade away). It is just as stale.
    expect(await order(VIRTUAL, 1)).toEqual({ ok: false, error: STALE, stale: true });
    expect(tally()).toEqual({ creates: 0, live: 0, rows: 0, audits: 0 });
    // The cardholder is ensured first, as for any order; it is reused later.
    expect(provider.log.cardholderKeys).toEqual(['cardholder-member-a']);
    expect(mock.revalidate).not.toHaveBeenCalled();
    expect((await order(VIRTUAL, 0)).ok).toBe(true);
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 1, audits: 1 });
    expect(provider.log.cardKeys).toEqual([key('virtual', 0)]);
  });
});

describe('two overlapping orders that were both made against N', () => {
  it.each([VIRTUAL, PHYSICAL])('the second reads N (the first is not mirrored yet): one shared key, one $type card, both answered with it', async input => {
    provider.holdCards('response');
    const requests = [order(input, 0)];
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(1));
    vi.setSystemTime(T0 + 1);
    requests.push(order(input, 0));
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(2));
    provider.heldCards.forEach(request => request.release());
    const results = await Promise.all(requests);

    const rows = mirrorCards();
    expect(results).toEqual([{ ok: true, data: { cardId: rows[0].id } }, { ok: true, data: { cardId: rows[0].id } }]);
    expect(tally()).toEqual({ creates: 2, live: 1, rows: 1, audits: 1 });
    expect(provider.log.cardKeys).toEqual([key(input.type, 0), key(input.type, 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'replayed']);
  });

  it.each([VIRTUAL, PHYSICAL])('the second reads N+1 (the first was mirrored before its count read): the second is refused as stale, one $type card', async input => {
    // The second tab's request was sent first but is held at the Trust step,
    // before it reads the count, while the first tab's order completes.
    let admit!: () => void;
    mock.trust.mockImplementationOnce(() => new Promise(resolve => { admit = () => resolve({ decision: { effect: 'allow' } }); }));
    const late = order(input, 0);
    await vi.waitFor(() => expect(mock.trust).toHaveBeenCalledTimes(1));
    vi.setSystemTime(T0 + 1);
    const first = await order(input, 0);
    expect(mirrorCards()).toHaveLength(1);
    admit();
    const second = await late;

    expect(first).toEqual({ ok: true, data: { cardId: mirrorCards()[0].id } });
    expect(second).toEqual({ ok: false, error: STALE, stale: true });
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 1, audits: 1 });
    expect(provider.log.cardKeys).toEqual([key(input.type, 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created']);
  });
});

describe('what the count is made of', () => {
  it('virtual and physical, and each child, are counted on their own', async () => {
    const steps: [Order, number, boolean][] = [
      [VIRTUAL, 0, true],
      // No physical card yet, although a virtual one exists.
      [PHYSICAL, 0, true],
      // The child's total (2) is not its physical count (1), nor its virtual count (1).
      [PHYSICAL, 2, false],
      [VIRTUAL, 2, false],
      [VIRTUAL, 1, true],
      // Another child's count is its own, not the family's total (3).
      [{ ...VIRTUAL, childWalletId: 'wallet-b' }, 3, false],
      [{ ...VIRTUAL, childWalletId: 'wallet-b' }, 0, true],
    ];
    const results: Awaited<ReturnType<typeof issueCardAction>>[] = [];
    for (const [step, [input, shown]] of steps.entries()) {
      vi.setSystemTime(T0 + step * 60_000);
      results.push(await order(input, shown));
    }

    expect(results.map(result => (result.ok ? 'issued' : result.error))).toEqual(steps.map(([, , issues]) => (issues ? 'issued' : STALE)));
    expect(tally()).toEqual({ creates: 4, live: 4, rows: 4, audits: 4 });
    expect(provider.log.cardKeys).toEqual([key('virtual', 0), key('physical', 0), key('virtual', 1), key('virtual', 0, 'wallet-b')]);
    expect(mirrorCards('wallet-a').map(row => row.type)).toEqual(['virtual', 'physical', 'virtual']);
    expect(mirrorCards('wallet-b').map(row => row.type)).toEqual(['virtual']);
  });

  it('every status counts, as the view shows every status', async () => {
    db.seed('stripe_cardholders', [{ id: 'holder-a', family_id: FAMILY, member_id: 'member-a', child_wallet_id: 'wallet-a', stripe_cardholder_id: 'ich_seeded_a' }]);
    db.seed('stripe_issuing_cards', [
      { family_id: FAMILY, child_wallet_id: 'wallet-a', cardholder_id: 'holder-a', stripe_card_id: 'ic_seeded_1', type: 'virtual', status: 'canceled' },
      { family_id: FAMILY, child_wallet_id: 'wallet-a', cardholder_id: 'holder-a', stripe_card_id: 'ic_seeded_2', type: 'virtual', status: 'inactive', is_frozen: true },
    ]);
    // Counting only the active cards (0) is stale.
    expect(await order(VIRTUAL, 0)).toEqual({ ok: false, error: STALE, stale: true });
    expect(provider.stripe.issuing.cards.create).not.toHaveBeenCalled();
    expect((await order(VIRTUAL, 2)).ok).toBe(true);
    expect(provider.log.cardKeys).toEqual([key('virtual', 2)]);
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 3, audits: 1 });
  });
});

describe('an expectedCount that is not a count', () => {
  const MISSING = Symbol('missing');
  it.each([
    { label: 'negative', value: -1 },
    { label: 'fractional', value: 0.5 },
    { label: 'NaN', value: Number.NaN },
    { label: 'infinite', value: Number.POSITIVE_INFINITY },
    { label: 'beyond the safe integers', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'a numeric string', value: '0' },
    { label: 'null', value: null },
    { label: 'missing', value: MISSING },
  ])('refuses an order whose expectedCount is $label before any read, Trust check or provider call', async ({ value }) => {
    const input: Record<string, unknown> = { ...VIRTUAL };
    if (value !== MISSING) input.expectedCount = value;
    expect(await issueCardAction(input as unknown as Input)).toEqual({ ok: false, error: REFUSED });

    expect(tally()).toEqual({ creates: 0, live: 0, rows: 0, audits: 0 });
    expect(provider.stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(provider.stripe.issuing.cardholders.create).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(mock.trust).not.toHaveBeenCalled();
    expect(mock.revalidate).not.toHaveBeenCalled();
  });

  it('still refuses an invalid expectedCount when the child already has cards', async () => {
    expect((await order(VIRTUAL, 0)).ok).toBe(true);
    const tables = db.log.length;
    expect(await issueCardAction({ ...VIRTUAL, expectedCount: '1' } as unknown as Input)).toEqual({ ok: false, error: REFUSED });
    expect(db.log).toHaveLength(tables);
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 1, audits: 1 });
  });
});

describe('a count that cannot be read', () => {
  it.each([
    { label: 'a returned error', reply: { error: { code: '08006', message: 'synthetic read refusal' } }, logged: 'Could not count the existing cards' },
    { label: 'a returned error beside a matching count', reply: { count: 0, error: { code: '08006', message: 'synthetic read refusal' } }, logged: 'Could not count the existing cards' },
    { label: 'no count', reply: { count: null }, logged: 'Could not count the existing cards' },
    { label: 'a rejection', reply: 'reject' as const, logged: 'synthetic transport failure' },
  ])('still refuses with the generic text, not as stale, when the count read gives $label', async ({ reply, logged }) => {
    script.push(reply);
    expect(await order(VIRTUAL, 0)).toEqual({ ok: false, error: REFUSED });
    expect(tally()).toEqual({ creates: 0, live: 0, rows: 0, audits: 0 });
    expect(failures()).toEqual([logged]);
    expect(db.log.filter(entry => entry.table === 'stripe_issuing_cards')).toHaveLength(1);
  });
});

describe('a card that was mirrored but whose success never reached the parent', () => {
  /**
   * The next card mirror INSERT commits its row, then its reply is lost (a
   * dropped connection or a timeout after commit): the server sees an error
   * although the row is there.
   */
  function loseNextInsertReplyAfterCommit() {
    const realFrom = service.from.bind(service);
    let armed = true;
    (service as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      const builder = realFrom(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
      if (table !== 'stripe_issuing_cards' || !armed) return builder;
      return Object.assign(Object.create(builder), {
        insert(values: unknown) {
          armed = false;
          const committed = (builder.insert(values) as { select: (c: string) => { single: () => Promise<unknown> } }).select('id').single();
          const lost = committed.then(() => ({ data: null, error: { code: '08006', message: 'synthetic reply lost after commit' } }));
          return { select: () => ({ single: () => lost }) };
        },
      });
    };
  }

  it.each([VIRTUAL, PHYSICAL])('the action\'s own answer is lost after a $type card was mirrored and audited: the retry from the unrefreshed view is refused as stale, so one card, row and audit', async input => {
    // Tab 1's answer never arrives; its view still shows no card.
    expect((await order(input, 0)).ok).toBe(true);
    vi.setSystemTime(T0 + 30_000);
    expect(await order(input, 0)).toEqual({ ok: false, error: STALE, stale: true });
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 1, audits: 1 });
  });

  it.each([VIRTUAL, PHYSICAL])('the mirror insert of a $type card committed but its reply was lost: the order answers with that card and audits it once, and a retry from the unrefreshed view is refused as stale', async input => {
    loseNextInsertReplyAfterCommit();
    const first = await order(input, 0);
    const [row] = mirrorCards();
    expect(row).toBeDefined();
    // Recovered: the committed row is this order's card.
    expect(first).toEqual({ ok: true, data: { cardId: row.id } });
    expect(issuedAudits()).toEqual([row.id]);
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 1, audits: 1 });

    vi.setSystemTime(T0 + 30_000);
    expect(await order(input, 0)).toEqual({ ok: false, error: STALE, stale: true });
    expect(tally()).toEqual({ creates: 1, live: 1, rows: 1, audits: 1 });
  });
});
