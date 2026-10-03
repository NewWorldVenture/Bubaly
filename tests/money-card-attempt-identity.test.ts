import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { syntheticProvider } from './helpers/synthetic-issuing-provider';

// JIMMY-SUPPORT-CARD-RETRY-20261001, repair B: one card ORDER that reaches the
// server more than once — two tabs, two devices, a re-click from a remounted
// view — before its card is mirrored must not become two live cards.
//
// The pending-claim repair (A) scopes a claim to one browser tab's module
// registry, so it cannot see a second tab or device. These cases drive the
// real issueCardAction → ensureCardholder → issueCard against the synthetic
// provider (tests/helpers/synthetic-issuing-provider.ts: Stripe's idempotency
// rules, including the in-flight 409 and the completed-key replay) and the
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
// What the two UI entry points send (components/wallet/money-cards-view.tsx)
// from a view showing no card of that type for the child; `shown` gives the
// count a view showing others sends.
const VIRTUAL = { childWalletId: 'wallet-a', type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization', expectedCount: 0 } as const;
const PHYSICAL = { childWalletId: 'wallet-a', type: 'physical', spendLimitCents: 2500, spendWindow: 'daily', expectedCount: 0 } as const;
const shown = <T extends object>(input: T, expectedCount: number) => ({ ...input, expectedCount });
// The action's own text, and lib/supabase/errors.ts's text for a duplicate key.
const REFUSED = 'translated:money.couldNotIssueTheCard';
// The answer to an order made against a count the mirror has moved past.
const STALE = 'translated:wallet.refreshToTryAgain';
const DUPLICATE_TEXT = 'That already exists. Try a different value.';
type Result = Awaited<ReturnType<typeof issueCardAction>>;
/** A canned answer for one `from('stripe_issuing_cards')` builder, or a rejection. */
type Scripted = { data?: unknown; error?: unknown; count?: number | null } | 'reject';

let db: ReturnType<typeof createInMemorySupabase>;
let provider: ReturnType<typeof syntheticProvider>;
let service: SupabaseClient<Database>;
// Per `from('stripe_issuing_cards')` call, in order: null is the real table.
let script: (Scripted | null)[];
// While `on`, every card mirror INSERT waits until the test releases it.
let mirrorGate: { on: boolean; waiting: (() => void)[] };
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

function seedHousehold() {
  db.seed('stripe_connected_accounts', [{ family_id: FAMILY, stripe_account_id: ACCOUNT, card_issuing_enabled: true }]);
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' },
    { id: 'wallet-b', family_id: FAMILY, member_id: 'member-b' },
  ]);
  db.seed('family_members', [
    { id: 'member-a', family_id: FAMILY, display_name: 'Synthetic A' },
    { id: 'member-b', family_id: FAMILY, display_name: 'Synthetic B' },
  ]);
}
const mirrorCards = (childWalletId = 'wallet-a') => db.table('stripe_issuing_cards').filter(row => row.child_wallet_id === childWalletId);
/** The cardholder ROW (stripe_cardholders.id) the child's cards hang off. */
const holderRow = (childWalletId = 'wallet-a') => db.table('stripe_cardholders').find(row => row.child_wallet_id === childWalletId)!.id as string;
/** The attempt key repair B gives the n-th mirrored card of a type for a child under one cardholder row. */
const key = (type: string, n: number, holder = holderRow(), wallet = 'wallet-a') => `card-${holder}-${wallet}-${type}-${n}`;
/** What issueCard logged for a card the provider created but the mirror refused. */
const UNMIRRORED = '[money] card mirror insert failed after the provider created the card';
const unmirroredLogs = () => vi.mocked(console.error).mock.calls.filter(([message]) => message === UNMIRRORED);
/** entity_id of every card_issued audit, in the order they were written. */
const issuedAudits = () => mock.audit.mock.calls.filter(([, row]) => (row as Row).action === 'card_issued').map(([, row]) => (row as Row).entity_id);
/** How many builders the card mirror table was asked for: count reads, inserts, re-reads. */
const cardTableCalls = () => db.log.filter(entry => entry.table === 'stripe_issuing_cards').length;
/** What issueCardAction logged for each failed order. */
const failures = () => vi.mocked(console.error).mock.calls
  .filter(([message]) => message === '[money-action] issue the card failed')
  .map(([, error]) => (error instanceof Error ? error.message : error));
const rereadLogs = () => vi.mocked(console.error).mock.calls
  .filter(([message]) => typeof message === 'string' && message.startsWith('[money] card duplicate re-read'));
const MISMATCH = "[money] card duplicate is not this attempt's row; keeping the refusal";
const mismatchLogs = () => vi.mocked(console.error).mock.calls.filter(([message]) => message === MISMATCH);
const PROVIDER_FAILED = '[money] card create failed at the provider';
const providerFailureLogs = () => vi.mocked(console.error).mock.calls.filter(([message]) => message === PROVIDER_FAILED);

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
  seedHousehold();
  provider = syntheticProvider();
  script = [];
  mirrorGate = { on: false, waiting: [] };
  // The service client the action and the library share. Every read and write
  // reaches the in-memory tables unless the case scripted that call.
  service = {
    from(table: string) {
      const builder = db.from(table);
      if (table !== 'stripe_issuing_cards') return builder;
      const reply = script.shift();
      if (reply) return scripted(reply);
      if (!mirrorGate.on) return builder;
      return Object.assign(Object.create(builder), {
        insert(row: Row) {
          const pending = builder.insert(row);
          return {
            select: (list: string) => ({
              single: async () => {
                await new Promise<void>(resolve => { mirrorGate.waiting.push(resolve); });
                return pending.select(list).single();
              },
            }),
          };
        },
      });
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

/** The one-card outcome both answered tabs must share. */
function expectOneCardBothAnswered(type: string, results: Result[]) {
  const rows = mirrorCards();
  expect(rows.map(row => [row.stripe_card_id, row.type])).toEqual([[provider.active()[0].id, type]]);
  expect(results).toEqual([{ ok: true, data: { cardId: rows[0].id } }, { ok: true, data: { cardId: rows[0].id } }]);
  // One card, one card_issued audit: the request that adopted the other's row
  // does not audit an issue it did not make.
  expect(issuedAudits()).toEqual([rows[0].id]);
  // Each request read the count and inserted; the later insert met UNIQUE
  // (stripe_card_id) and re-read the row it adopted.
  expect(cardTableCalls()).toBe(5);
  expect(rereadLogs()).toEqual([]);
  expect(unmirroredLogs()).toEqual([]);
  expect(provider.log.cardholderKeys).toEqual(['cardholder-member-a']);
}

describe('one card order reaching the server twice before its card is mirrored', () => {
  it.each([
    { input: VIRTUAL, order: 'the later tab answered first', releases: [1, 0] },
    { input: VIRTUAL, order: 'the earlier tab answered first', releases: [0, 1] },
    { input: PHYSICAL, order: 'the later tab answered first', releases: [1, 0] },
    { input: PHYSICAL, order: 'the earlier tab answered first', releases: [0, 1] },
  ])('(a/b) two tabs order one $input.type card at different milliseconds after the provider completed the first: one live card, both answered with it ($order)', async ({ input, releases }) => {
    provider.holdCards('response');
    const requests = [issueCardAction(input)];
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(1));
    vi.setSystemTime(T0 + 1);
    requests.push(issueCardAction(input));
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(2));
    const results: Result[] = [];
    for (const index of releases) {
      provider.heldCards[index].release();
      results[index] = await requests[index];
    }

    expect(provider.active(input.type)).toHaveLength(1);
    expect(provider.cards.size).toBe(1);
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(2);
    expect(provider.log.cardKeys).toEqual([key(input.type, 0), key(input.type, 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'replayed']);
    expectOneCardBothAnswered(input.type, results);
  });

  it.each([VIRTUAL, PHYSICAL])('(a/b) two tabs order one $type card at different milliseconds while the first is still executing at the provider: the conflict surfaces as a refusal, one live card', async input => {
    provider.holdCards('execution');
    const first = issueCardAction(input);
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(1));
    vi.setSystemTime(T0 + 1);
    let secondAnswered = false;
    const second = issueCardAction(input).finally(() => { secondAnswered = true; });
    await vi.waitFor(() => expect(provider.log.cardOutcomes).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    const answeredWhileFirstExecuting = secondAnswered;
    provider.heldCards.forEach(request => request.release());
    const results = [await first, await second];

    expect(provider.active(input.type)).toHaveLength(1);
    expect(provider.cards.size).toBe(1);
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(2);
    expect(provider.log.cardKeys).toEqual([key(input.type, 0), key(input.type, 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'in_use']);
    expect(answeredWhileFirstExecuting).toBe(true);
    const rows = mirrorCards();
    expect(rows.map(row => [row.stripe_card_id, row.type])).toEqual([[provider.active()[0].id, input.type]]);
    // The second tab is told the order failed, although the card it asked for
    // exists once the first lands; a refresh shows it.
    expect(results).toEqual([{ ok: true, data: { cardId: rows[0].id } }, { ok: false, error: REFUSED }]);
    expect(failures()).toEqual([expect.stringContaining('idempotency_key_in_use')]);
    expect(issuedAudits()).toEqual([rows[0].id]);
    expect(cardTableCalls()).toBe(3);
  });

  it.each([VIRTUAL, PHYSICAL])('(a/b) two tabs order one $type card while the first is still executing, and the conflict is retried after it finished: one live card, both answered with it', async input => {
    provider.holdCards('execution');
    provider.retryConflicts();
    const first = issueCardAction(input);
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(1));
    vi.setSystemTime(T0 + 1);
    const second = issueCardAction(input);
    await vi.waitFor(() => expect(provider.log.cardOutcomes).toHaveLength(2));
    provider.heldCards.forEach(request => request.release());
    const results = [await first, await second];

    expect(provider.active(input.type)).toHaveLength(1);
    expect(provider.cards.size).toBe(1);
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(2);
    expect(provider.log.cardKeys).toEqual([key(input.type, 0), key(input.type, 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'in_use', 'replayed']);
    expectOneCardBothAnswered(input.type, results);
  });

  it('(a/b) two tabs order a physical card with different limits after the provider completed the first: the second is refused (idempotency_error), one live card', async () => {
    provider.holdCards('response');
    const first = issueCardAction(PHYSICAL);
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(1));
    vi.setSystemTime(T0 + 1);
    const second = issueCardAction({ ...PHYSICAL, spendLimitCents: 5000 });
    await vi.waitFor(() => expect(provider.log.cardOutcomes).toHaveLength(2));
    provider.heldCards.forEach(request => request.release());
    const results = [await first, await second];

    expect(provider.active('physical')).toHaveLength(1);
    expect(provider.cards.size).toBe(1);
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(2);
    expect(provider.log.cardKeys).toEqual([key('physical', 0), key('physical', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'mismatch']);
    const rows = mirrorCards();
    expect(rows.map(row => [row.stripe_card_id, row.spend_limit_cents])).toEqual([[provider.active()[0].id, 2500]]);
    expect(results).toEqual([{ ok: true, data: { cardId: rows[0].id } }, { ok: false, error: REFUSED }]);
    expect(failures()).toEqual([expect.stringContaining('idempotency_error')]);
    expect(issuedAudits()).toEqual([rows[0].id]);
  });

  it.each([
    { input: VIRTUAL, order: 'the later order mirrored first', releases: [1, 0] },
    { input: VIRTUAL, order: 'the first order mirrored first', releases: [0, 1] },
    { input: PHYSICAL, order: 'the later order mirrored first', releases: [1, 0] },
    { input: PHYSICAL, order: 'the first order mirrored first', releases: [0, 1] },
  ])('(c) a second $input.type order arriving after the provider created the first card but before it was mirrored is answered with that card ($order)', async ({ input, releases }) => {
    mirrorGate.on = true;
    const requests = [issueCardAction(input)];
    await vi.waitFor(() => expect(mirrorGate.waiting).toHaveLength(1));
    // The first is past provider creation: its card exists, unmirrored.
    expect(provider.log.cardOutcomes).toEqual(['created']);
    expect(mirrorCards()).toHaveLength(0);
    vi.setSystemTime(T0 + 1);
    requests.push(issueCardAction(input));
    await vi.waitFor(() => expect(mirrorGate.waiting).toHaveLength(2));
    const results: Result[] = [];
    for (const index of releases) {
      mirrorGate.waiting[index]();
      results[index] = await requests[index];
    }

    expect(provider.active(input.type)).toHaveLength(1);
    expect(provider.cards.size).toBe(1);
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(2);
    expect(provider.log.cardKeys).toEqual([key(input.type, 0), key(input.type, 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'replayed']);
    expectOneCardBothAnswered(input.type, results);
  });

  it('(d) virtual and physical ordered in the same millisecond each get their own attempt and both issue', async () => {
    const [virtual, physical] = await Promise.all([issueCardAction(VIRTUAL), issueCardAction(PHYSICAL)]);

    expect([virtual.ok, physical.ok]).toEqual([true, true]);
    expect([...provider.log.cardKeys].sort()).toEqual([key('physical', 0), key('virtual', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(provider.active('virtual')).toHaveLength(1);
    expect(provider.active('physical')).toHaveLength(1);
    const rows = mirrorCards();
    expect(rows.map(row => row.type).sort()).toEqual(['physical', 'virtual']);
    expect([virtual, physical]).toEqual([
      { ok: true, data: { cardId: rows.find(row => row.type === 'virtual')!.id } },
      { ok: true, data: { cardId: rows.find(row => row.type === 'physical')!.id } },
    ]);
    expect(issuedAudits().sort()).toEqual(rows.map(row => row.id).sort());
    // One cardholder for both (repair C adopts the duplicate first insert).
    expect(provider.cardholders).toHaveLength(1);
    expect(db.table('stripe_cardholders')).toHaveLength(1);
  });

  it('after a mirror outage, the identical retry replays the orphan and mirrors it: no second card', async () => {
    script.push(null, { error: { code: '08006', message: 'synthetic mirror outage' } });
    expect(await issueCardAction(PHYSICAL)).toEqual({ ok: false, error: REFUSED });
    const [orphan] = provider.active('physical');
    expect(orphan).toBeDefined();
    expect(mirrorCards()).toHaveLength(0);
    // The card the provider made is named in the log, so it can be found.
    expect(unmirroredLogs()).toEqual([[UNMIRRORED, { stripeCardId: orphan.id, code: '08006' }]]);

    vi.setSystemTime(T0 + 60_000);
    const retried = await issueCardAction(PHYSICAL);
    expect(provider.log.cardKeys).toEqual([key('physical', 0), key('physical', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'replayed']);
    expect(provider.active('physical')).toEqual([orphan]);
    const rows = mirrorCards();
    expect(rows.map(row => row.stripe_card_id)).toEqual([orphan.id]);
    expect(retried).toEqual({ ok: true, data: { cardId: rows[0].id } });
    expect(issuedAudits()).toEqual([rows[0].id]);
    expect(provider.stripe.issuing.cards.update).not.toHaveBeenCalled();
  });

  it('a recreated cardholder row starts fresh attempts instead of replaying a card the mirror dropped with the old row', async () => {
    expect((await issueCardAction(VIRTUAL)).ok).toBe(true);
    const oldHolder = holderRow();
    const [oldCard] = provider.active('virtual');
    // Deleting the cardholder row cascades its cards (00901: ON DELETE CASCADE),
    // so the mirrored count for the child goes back to zero.
    db.replace('stripe_issuing_cards', []);
    db.replace('stripe_cardholders', []);
    vi.setSystemTime(T0 + 60_000);
    const again = await issueCardAction(VIRTUAL);

    const newHolder = holderRow();
    expect(newHolder).not.toBe(oldHolder);
    expect(provider.log.cardKeys).toEqual([key('virtual', 0, oldHolder), key('virtual', 0, newHolder)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    const rows = mirrorCards();
    expect(rows.map(row => row.stripe_card_id)).toEqual([provider.active('virtual')[1].id]);
    expect(rows[0].stripe_card_id).not.toBe(oldCard.id);
    expect(again).toEqual({ ok: true, data: { cardId: rows[0].id } });
  });
});

describe('controls: orders that must stay separate cards, before and after the repair', () => {
  it('control: deliberate later orders, each after the previous card is mirrored, each issue a new card', async () => {
    // Each is made from a view that shows the cards issued before it.
    const orders = [VIRTUAL, shown(VIRTUAL, 1), PHYSICAL, shown(PHYSICAL, 1)];
    const results: Result[] = [];
    for (const [step, input] of orders.entries()) {
      vi.setSystemTime(T0 + step * 60_000);
      results.push(await issueCardAction(input));
    }

    const rows = mirrorCards();
    expect(rows.map(row => row.type)).toEqual(['virtual', 'virtual', 'physical', 'physical']);
    expect(results).toEqual(rows.map(row => ({ ok: true, data: { cardId: row.id } })));
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(4);
    expect(new Set(provider.log.cardKeys).size).toBe(4);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created', 'created', 'created']);
    expect(provider.active()).toHaveLength(4);
    expect(rows.map(row => row.stripe_card_id)).toEqual(provider.active().map(card => card.id));
    expect(issuedAudits()).toEqual(rows.map(row => row.id));
  });

  it('control: virtual and physical in flight together for one child are independent cards', async () => {
    provider.holdCards('response');
    const virtual = issueCardAction(VIRTUAL);
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(1));
    vi.setSystemTime(T0 + 1);
    const physical = issueCardAction(PHYSICAL);
    await vi.waitFor(() => expect(provider.heldCards).toHaveLength(2));
    provider.heldCards.forEach(request => request.release());
    const results = [await virtual, await physical];

    const rows = mirrorCards();
    expect(rows.map(row => row.type).sort()).toEqual(['physical', 'virtual']);
    expect(results).toEqual([
      { ok: true, data: { cardId: rows.find(row => row.type === 'virtual')!.id } },
      { ok: true, data: { cardId: rows.find(row => row.type === 'physical')!.id } },
    ]);
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(2);
    expect(new Set(provider.log.cardKeys).size).toBe(2);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(provider.active('virtual')).toHaveLength(1);
    expect(provider.active('physical')).toHaveLength(1);
    expect(issuedAudits().sort()).toEqual(rows.map(row => row.id).sort());
  });
});

describe('residuals the attempt key does not cover', () => {
  it.each([0, 1, 60_000])('formerly residual, now refused: a second order of the same type after the first card is mirrored, from a view that never showed it, is refused as stale; from one that did, it is a new card keyed by the count and not the clock (%i ms later)', async gap => {
    // A second tab whose stale view never showed the first card sends the
    // count it saw (0), which the mirror has moved past (1): refused before the
    // provider. A view that shows the first card sends 1, a deliberate second
    // order. See tests/money-card-stale-order.test.ts.
    const first = await issueCardAction(VIRTUAL);
    vi.setSystemTime(T0 + gap);
    const stale = await issueCardAction(VIRTUAL);
    expect(stale).toEqual({ ok: false, error: STALE, stale: true });
    expect(provider.active('virtual')).toHaveLength(1);
    expect(provider.log.cardKeys).toEqual([key('virtual', 0)]);
    const deliberate = await issueCardAction(shown(VIRTUAL, 1));

    const rows = mirrorCards();
    expect([first, deliberate]).toEqual(rows.map(row => ({ ok: true, data: { cardId: row.id } })));
    expect(provider.active('virtual')).toHaveLength(2);
    expect(provider.log.cardKeys).toEqual([key('virtual', 0), key('virtual', 1)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(issuedAudits()).toEqual(rows.map(row => row.id));
  });

  it('residual: after a mirror outage the orphan stays live and unlisted; a changed retry is refused while the provider keeps the key, and issues a second card after it forgets', async () => {
    script.push(null, { error: { code: '08006', message: 'synthetic mirror outage' } });
    expect(await issueCardAction(PHYSICAL)).toEqual({ ok: false, error: REFUSED });
    const [orphan] = provider.active('physical');
    expect(orphan).toBeDefined();
    expect(mirrorCards()).toHaveLength(0);

    vi.setSystemTime(T0 + 60_000);
    const changed = { ...PHYSICAL, spendLimitCents: 5000 };
    expect(await issueCardAction(changed)).toEqual({ ok: false, error: REFUSED });
    expect(provider.log.cardKeys).toEqual([key('physical', 0), key('physical', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'mismatch']);
    expect(provider.active('physical')).toEqual([orphan]);
    expect(mirrorCards()).toHaveLength(0);

    // Another type is another attempt, unaffected.
    expect((await issueCardAction(VIRTUAL)).ok).toBe(true);

    // Nothing compensates the orphan (repair E is not implemented): once the
    // provider forgets the key, the changed order issues a second physical card.
    provider.forgetKeys();
    const later = await issueCardAction(changed);
    expect(later.ok).toBe(true);
    expect(provider.log.cardKeys).toEqual([key('physical', 0), key('physical', 0), key('virtual', 0), key('physical', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'mismatch', 'created', 'created']);
    expect(provider.active('physical')).toHaveLength(2);
    expect(provider.active('physical')[0]).toBe(orphan);
    expect(mirrorCards().filter(row => row.type === 'physical').map(row => row.stripe_card_id)).toEqual([provider.active('physical')[1].id]);
    expect(provider.stripe.issuing.cards.update).not.toHaveBeenCalled();
  });

  it('residual: a provider failure saved under the key is replayed to an identical retry at the same count until the provider forgets the key', async () => {
    provider.failNextCardCreate(Object.assign(new Error('synthetic card refusal after execution began'), { code: 'synthetic_refusal' }));
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    vi.setSystemTime(T0 + 60_000);
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    expect(provider.log.cardKeys).toEqual([key('virtual', 0), key('virtual', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['failed', 'replayed_failure']);
    expect(provider.cards.size).toBe(0);
    expect(mirrorCards()).toHaveLength(0);
    // Both answers are named; the second is the provider's replay of the saved
    // failure. Without an HTTP status it is not retried under a fresh key.
    const failed = { childWalletId: 'wallet-a', type: 'virtual', attempt: 0, requestId: undefined, statusCode: undefined, replayed: false };
    expect(providerFailureLogs()).toEqual([[PROVIDER_FAILED, failed], [PROVIDER_FAILED, { ...failed, replayed: true }]]);

    provider.forgetKeys();
    expect((await issueCardAction(VIRTUAL)).ok).toBe(true);
    expect(provider.log.cardOutcomes).toEqual(['failed', 'replayed_failure', 'created']);
    expect(provider.active('virtual')).toHaveLength(1);
    expect(providerFailureLogs()).toHaveLength(2);
  });

  it.each([
    { label: 'a first answer', replayedHeader: undefined, replayed: false },
    { label: "the provider's replay of a saved failure", replayedHeader: 'true', replayed: true },
  ])('names a failed provider create ($label) by request, status and attempt, so a blocked parent can be traced', async ({ replayedHeader, replayed }) => {
    const failure = Object.assign(new Error('synthetic card refusal after execution began'), {
      requestId: 'req_synthetic_1', statusCode: 402,
      headers: replayedHeader === undefined ? {} : { 'idempotent-replayed': replayedHeader },
    });
    provider.failNextCardCreate(failure);
    expect(await issueCardAction(PHYSICAL)).toEqual({ ok: false, error: REFUSED });
    expect(providerFailureLogs()).toEqual([[PROVIDER_FAILED, {
      childWalletId: 'wallet-a', type: 'physical', attempt: 0, requestId: 'req_synthetic_1', statusCode: 402, replayed,
    }]]);
    expect(mirrorCards()).toHaveLength(0);
    expect(issuedAudits()).toEqual([]);
  });
});

describe('a provider refusal saved under the attempt key and replayed to a later order', () => {
  /** A refusal that began executing at the provider, so the provider saved it under the key. */
  const refusal = (statusCode: number | undefined) => Object.assign(
    new Error('synthetic card refusal after execution began'), { statusCode, requestId: 'req_saved_1' },
  );
  const retryKey = (type: string, n: number) => `${key(type, n)}-retry`;

  it.each([400, 402, 403, 404])('a replayed %i is tried once more under the attempt\'s retry key, so a parent who fixed the cause gets the card', async status => {
    provider.failNextCardCreate(refusal(status));
    // The provider's first answer is not a replay: it stands.
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    expect(provider.log.cardKeys).toEqual([key('virtual', 0)]);

    vi.setSystemTime(T0 + 60_000);
    const second = await issueCardAction(VIRTUAL);
    const [row] = mirrorCards();
    expect(second).toEqual({ ok: true, data: { cardId: row.id } });
    expect(provider.log.cardKeys).toEqual([key('virtual', 0), key('virtual', 0), retryKey('virtual', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['failed', 'replayed_failure', 'created']);
    expect(provider.active()).toHaveLength(1);
    expect(mirrorCards()).toHaveLength(1);
    expect(issuedAudits()).toEqual([row.id]);
  });

  it.each([500, 502, undefined])('a replayed %s is not retried: whether it created a card is unknown, so the refusal stands', async status => {
    provider.failNextCardCreate(refusal(status));
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    vi.setSystemTime(T0 + 60_000);
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    expect(provider.log.cardKeys).toEqual([key('virtual', 0), key('virtual', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['failed', 'replayed_failure']);
    expect(provider.cards.size).toBe(0);
    expect(issuedAudits()).toEqual([]);
  });

  it('when the retry key fails too, a later order is refused without a third attempt until the provider forgets the keys', async () => {
    provider.failNextCardCreate(refusal(402));
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    vi.setSystemTime(T0 + 60_000);
    provider.failNextCardCreate(refusal(402));
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    vi.setSystemTime(T0 + 120_000);
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    const k = key('virtual', 0);
    expect(provider.log.cardKeys).toEqual([k, k, retryKey('virtual', 0), k, retryKey('virtual', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['failed', 'replayed_failure', 'failed', 'replayed_failure', 'replayed_failure']);
    expect(provider.cards.size).toBe(0);
    expect(issuedAudits()).toEqual([]);
  });

  it('two tabs retrying a replayed refusal at once share the retry key: one card, both answered with it, one audit', async () => {
    provider.failNextCardCreate(refusal(402));
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    vi.setSystemTime(T0 + 60_000);
    const [a, b] = await Promise.all([issueCardAction(VIRTUAL), issueCardAction(VIRTUAL)]);
    const [row] = mirrorCards();
    expect([a, b]).toEqual([{ ok: true, data: { cardId: row.id } }, { ok: true, data: { cardId: row.id } }]);
    expect(provider.active()).toHaveLength(1);
    expect(mirrorCards()).toHaveLength(1);
    expect(issuedAudits()).toEqual([row.id]);
    expect(new Set(provider.log.cardKeys.slice(1))).toEqual(new Set([key('virtual', 0), retryKey('virtual', 0)]));
  });

  it('a parameter mismatch on the attempt key is never retried under the retry key: it may be another order', async () => {
    provider.failNextCardCreate(refusal(402));
    expect(await issueCardAction(PHYSICAL)).toEqual({ ok: false, error: REFUSED });
    vi.setSystemTime(T0 + 60_000);
    expect(await issueCardAction({ ...PHYSICAL, spendLimitCents: 9900 })).toEqual({ ok: false, error: REFUSED });
    expect(provider.log.cardKeys).toEqual([key('physical', 0), key('physical', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['failed', 'mismatch']);
    expect(provider.cards.size).toBe(0);
  });
});

describe('the count that names the attempt', () => {
  it.each([
    { label: 'a returned error', reply: { error: { code: '08006', message: 'synthetic read refusal' } }, logged: 'Could not count the existing cards' },
    { label: 'a returned error, even beside a count', reply: { count: 0, error: { code: '08006', message: 'synthetic read refusal' } }, logged: 'Could not count the existing cards' },
    { label: 'no count', reply: { count: null }, logged: 'Could not count the existing cards' },
    { label: 'a negative count', reply: { count: -1 }, logged: 'Could not count the existing cards' },
    { label: 'a fractional count', reply: { count: 1.5 }, logged: 'Could not count the existing cards' },
    { label: 'a rejection', reply: 'reject' as const, logged: 'synthetic transport failure' },
  ])('refuses before the provider when the count read gives $label', async ({ reply, logged }) => {
    script.push(reply);
    expect(await issueCardAction(VIRTUAL)).toEqual({ ok: false, error: REFUSED });
    expect(provider.stripe.issuing.cards.create).not.toHaveBeenCalled();
    expect(provider.cards.size).toBe(0);
    expect(mirrorCards()).toHaveLength(0);
    expect(issuedAudits()).toEqual([]);
    expect(failures()).toEqual([logged]);
    expect(cardTableCalls()).toBe(1);
  });

  it("counts this family's mirrored cards of this type for this child, in every status", async () => {
    db.seed('stripe_issuing_cards', [
      { family_id: 'family-other', child_wallet_id: 'wallet-a', cardholder_id: 'holder-x', stripe_card_id: 'ic_seeded_1', type: 'virtual', status: 'active' },
      { family_id: FAMILY, child_wallet_id: 'wallet-b', cardholder_id: 'holder-b', stripe_card_id: 'ic_seeded_2', type: 'virtual', status: 'active' },
      { family_id: FAMILY, child_wallet_id: 'wallet-a', cardholder_id: 'holder-a', stripe_card_id: 'ic_seeded_3', type: 'physical', status: 'active' },
      { family_id: FAMILY, child_wallet_id: 'wallet-a', cardholder_id: 'holder-a', stripe_card_id: 'ic_seeded_4', type: 'virtual', status: 'canceled' },
      { family_id: FAMILY, child_wallet_id: 'wallet-a', cardholder_id: 'holder-a', stripe_card_id: 'ic_seeded_5', type: 'virtual', status: 'inactive', is_frozen: true },
    ]);
    expect((await issueCardAction(shown(VIRTUAL, 2))).ok).toBe(true);
    vi.setSystemTime(T0 + 60_000);
    expect((await issueCardAction(shown(VIRTUAL, 3))).ok).toBe(true);
    expect((await issueCardAction(shown(PHYSICAL, 1))).ok).toBe(true);
    expect(provider.log.cardKeys).toEqual([key('virtual', 2), key('virtual', 3), key('physical', 1)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created', 'created']);
  });
});

describe('a card mirror insert that meets UNIQUE (stripe_card_id)', () => {
  const CARD = 'ic_already_mirrored';
  const EXACT = {
    id: 'row-mirrored', family_id: FAMILY, child_wallet_id: 'wallet-a', cardholder_id: 'holder-a',
    stripe_card_id: CARD, type: 'virtual', status: 'active',
  };
  beforeEach(() => {
    db.seed('stripe_cardholders', [{ id: 'holder-a', family_id: FAMILY, member_id: 'member-a', child_wallet_id: 'wallet-a', stripe_cardholder_id: 'ich_seeded_a' }]);
    // The provider answers with a card the mirror already holds.
    provider.nextCardId(CARD);
  });

  it.each([
    { label: 'as it was mirrored', row: EXACT },
    {
      label: 'after its controls, freeze, status and author changed',
      row: {
        ...EXACT, status: 'inactive', is_frozen: true, spend_limit_cents: 900, spend_window: 'weekly',
        blocked_categories: ['gambling'], created_by: 'user-other', last4: '9999',
      },
    },
  ])('adopts the row that is exactly this family, child wallet, type, cardholder row and card ($label), without a second audit', async ({ row }) => {
    db.seed('stripe_issuing_cards', [row]);
    expect(await issueCardAction(shown(VIRTUAL, 1))).toEqual({ ok: true, data: { cardId: EXACT.id } });
    // Adopted as it is: nothing about the row is rewritten.
    expect(db.table('stripe_issuing_cards')).toEqual([expect.objectContaining(row)]);
    expect(provider.log.cardKeys).toEqual([key('virtual', 1)]);
    expect(issuedAudits()).toEqual([]);
    expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
    expect(cardTableCalls()).toBe(3);
    expect(console.error).not.toHaveBeenCalled();
  });

  // The last column is how many of this child's virtual cards the view shows:
  // the seeded row counts only when it is this family's, this child's and virtual.
  it.each([
    ['another family', { family_id: 'family-other' }, 0],
    ['another child wallet', { child_wallet_id: 'wallet-b' }, 0],
    ['another type', { type: 'physical' }, 0],
    ['another cardholder row', { cardholder_id: 'holder-other' }, 1],
  ])('keeps the refusal when the mirrored row belongs to %s', async (_label, change, count) => {
    db.seed('stripe_issuing_cards', [{ ...EXACT, ...change }]);
    expect(await issueCardAction(shown(VIRTUAL, count))).toEqual({ ok: false, error: DUPLICATE_TEXT });
    expect(db.table('stripe_issuing_cards')).toEqual([expect.objectContaining({ ...EXACT, ...change })]);
    expect(provider.stripe.issuing.cards.create).toHaveBeenCalledTimes(1);
    expect(issuedAudits()).toEqual([]);
    expect(cardTableCalls()).toBe(3);
    expect(failures()).toEqual([expect.stringMatching(/^Failed to persist card: duplicate key value/)]);
    expect(rereadLogs()).toEqual([]);
    expect(mismatchLogs()).toEqual([[MISMATCH, { stripeCardId: CARD, found: true }]]);
  });

  it.each([
    { label: 'no row', reply: { data: null } as Scripted, logged: [], mismatch: [[MISMATCH, { stripeCardId: CARD, found: false }]] },
    {
      label: 'a row for another provider card', reply: { data: { ...EXACT, stripe_card_id: 'ic_other' } } as Scripted, logged: [],
      mismatch: [[MISMATCH, { stripeCardId: CARD, found: true }]],
    },
    {
      label: 'a returned error, even beside exact data',
      reply: { data: EXACT, error: { code: '08006', message: 'synthetic re-read refusal' } } as Scripted,
      logged: [['[money] card duplicate re-read failed; keeping the refusal', { stripeCardId: CARD, code: '08006' }]],
      mismatch: [],
    },
    {
      label: 'a rejection',
      reply: 'reject' as Scripted,
      logged: [['[money] card duplicate re-read rejected; keeping the refusal', { stripeCardId: CARD }]],
      mismatch: [],
    },
  ])('keeps the original refusal when the re-read gives $label', async ({ reply, logged, mismatch }) => {
    db.seed('stripe_issuing_cards', [EXACT]);
    script.push(null, null, reply);
    expect(await issueCardAction(shown(VIRTUAL, 1))).toEqual({ ok: false, error: DUPLICATE_TEXT });
    expect(failures()).toEqual([expect.stringMatching(/^Failed to persist card: duplicate key value/)]);
    expect(rereadLogs()).toEqual(logged);
    expect(mismatchLogs()).toEqual(mismatch);
    expect(issuedAudits()).toEqual([]);
    expect(cardTableCalls()).toBe(3);
  });

  const NON_DUPLICATE = [
    { code: '08006', message: 'synthetic connection refusal' },
    { code: '23503', message: 'synthetic foreign key refusal' },
    { message: 'synthetic refusal without a code' },
  ];
  const readBackLogs = () => vi.mocked(console.error).mock.calls
    .filter(([message]) => typeof message === 'string' && message.startsWith('[money] card mirror read-back'));

  it.each(NON_DUPLICATE)('reads the card back after a non-duplicate mirror insert failure %j and, when this attempt\'s exact row is there (the insert committed, its reply was lost), answers with it and audits it once', async error => {
    db.seed('stripe_issuing_cards', [EXACT]);
    script.push(null, { error });
    expect(await issueCardAction(shown(VIRTUAL, 1))).toEqual({ ok: true, data: { cardId: EXACT.id } });
    // This order's own card: audited here, by the request whose insert committed.
    expect(issuedAudits()).toEqual([EXACT.id]);
    expect(cardTableCalls()).toBe(3);
    expect(failures()).toEqual([]);
    expect(unmirroredLogs()).toEqual([]);
    expect(readBackLogs()).toEqual([]);
    expect(rereadLogs()).toEqual([]);
  });

  it.each(NON_DUPLICATE)('keeps the refusal after a non-duplicate mirror insert failure %j when the read-back finds no row, and names the provider card', async error => {
    script.push(null, { error });
    expect(await issueCardAction(shown(VIRTUAL, 0))).toEqual({ ok: false, error: REFUSED });
    expect(failures()).toEqual([`Failed to persist card: ${error.message}`]);
    expect(unmirroredLogs()).toEqual([[UNMIRRORED, { stripeCardId: CARD, code: error.code }]]);
    expect(cardTableCalls()).toBe(3);
    expect(issuedAudits()).toEqual([]);
    expect(mismatchLogs()).toEqual([]);
  });

  it.each([
    { label: 'a returned error', reply: { error: { code: '08006', message: 'synthetic read-back refusal' } } as Scripted, logged: [['[money] card mirror read-back after a failed insert failed; keeping the refusal', { stripeCardId: CARD, code: '08006' }]] },
    { label: 'a rejection', reply: 'reject' as Scripted, logged: [['[money] card mirror read-back after a failed insert rejected; keeping the refusal', { stripeCardId: CARD }]] },
  ])('keeps the refusal after a non-duplicate mirror insert failure when the read-back gives $label', async ({ reply, logged }) => {
    db.seed('stripe_issuing_cards', [EXACT]);
    script.push(null, { error: { code: '08006', message: 'synthetic connection refusal' } }, reply);
    expect(await issueCardAction(shown(VIRTUAL, 1))).toEqual({ ok: false, error: REFUSED });
    expect(readBackLogs()).toEqual(logged);
    expect(unmirroredLogs()).toEqual([[UNMIRRORED, { stripeCardId: CARD, code: '08006' }]]);
    expect(issuedAudits()).toEqual([]);
    expect(cardTableCalls()).toBe(3);
  });
});
