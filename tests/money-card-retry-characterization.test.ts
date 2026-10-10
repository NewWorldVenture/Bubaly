import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';

// JIMMY-SUPPORT-CARD-RETRY-20261001: what the server and the provider do when a
// card order or a freeze reaches them more than once. Characterization only —
// these pin CURRENT behaviour so a repair has to change them on purpose. Tests
// named "reproduces" describe a defect candidate; "preserves" describe the
// existing multiple-card contract any repair must keep.
//
// Sealed: no network, no real Stripe SDK, no real database client. The provider
// is an in-process double with Stripe's documented idempotency semantics, and
// the database is the in-memory fake with the 00901 unique constraints.

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
  // Whether every native entry point is still the denying guard. A spy that was
  // restored puts the real function back while `attempts` keeps reading zero,
  // so the counters alone cannot show the seal is still in place.
  const entries = () => [
    http.request, http.get, https.request, https.get,
    net.connect, net.createConnection, net.Socket.prototype.connect, tls.connect, globalThis.fetch,
  ] as unknown as (() => unknown)[];
  const sealed = () => entries().map(fn => vi.isMockFunction(fn));
  /**
   * Call every entry point and report which refused; the counters are put back.
   * It calls nothing unless every entry point is still a guard, so a broken
   * seal can never turn the probe itself into a real request.
   */
  const probe = () => {
    if (!sealed().every(Boolean)) return { refused: sealed(), counted: 0 };
    const before = { ...attempts };
    const refused = entries().map(fn => { try { fn(); return false; } catch { return true; } });
    const counted = Object.values(attempts).reduce((a, b) => a + b, 0) - Object.values(before).reduce((a, b) => a + b, 0);
    Object.assign(attempts, before);
    return { refused, counted };
  };
  return { attempts, sealed, probe, restore() { guards.forEach(guard => guard.mockRestore()); globalThis.fetch = originalFetch; } };
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

import { issueCardAction, setCardFrozenAction } from '@/app/(app)/money/actions';
import { handleIssuingCardUpdated } from '@/lib/stripe/webhook';

const FAMILY = 'family-synthetic';
const ACCOUNT = 'acct_synthetic';
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
// What the two UI entry points send (components/wallet/money-cards-view.tsx):
// the row's Virtual button and the physical order dialog with a limit entered.
// lib/supabase/errors.ts's text for a 23505, which describeActionError passes
// through instead of the action's own translated fallback.
const DUPLICATE_TEXT = 'That already exists. Try a different value.';
const VIRTUAL = { childWalletId: 'wallet-a', type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization' } as const;
const PHYSICAL = { childWalletId: 'wallet-a', type: 'physical', spendLimitCents: 2500, spendWindow: 'daily' } as const;

type Held = { release: () => void };
type ProviderCard = { id: string; status: 'active' | 'inactive' | 'canceled'; type: string; cardholder: string; limits: unknown[] };

/**
 * A provider double with Stripe's documented idempotency rules, per connected
 * account: a key seen before returns the first result and creates nothing; the
 * same key with different parameters is refused; a new key creates a new
 * object. An update applies when the provider receives it; its RESPONSE can be
 * held, which is how a test orders two in-flight requests.
 */
function syntheticProvider() {
  const replay = new Map<string, { body: string; result: unknown }>();
  const cardholders: string[] = [];
  const cards = new Map<string, ProviderCard>();
  const log = { cardholderKeys: [] as string[], cardKeys: [] as string[], updates: [] as { id: string; status: unknown }[] };
  const held: Held[] = [];
  let holdUpdates = false;
  let barrier: { size: number; arrived: number; open: () => void; opened: Promise<void> } | null = null;
  let next = 0;

  function idempotent<T>(account: string, key: string, body: unknown, make: () => T): T {
    const scoped = `${account}:${key}`;
    const json = JSON.stringify(body);
    const prior = replay.get(scoped);
    if (prior) {
      if (prior.body !== json) throw new Error('synthetic idempotency_error: key reused with different parameters');
      return prior.result as T;
    }
    const result = make();
    replay.set(scoped, { body: json, result });
    return result;
  }

  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ individual: { address: { line1: '1 Fixture Lane', city: 'Fixture', state: 'CA', postal_code: '00000', country: 'US' } } })) },
    issuing: {
      cardholders: {
        create: vi.fn(async (body: unknown, opts: { stripeAccount: string; idempotencyKey: string }) => {
          log.cardholderKeys.push(opts.idempotencyKey);
          const result = idempotent(opts.stripeAccount, opts.idempotencyKey, body, () => {
            const id = `ich_synthetic_${++next}`;
            cardholders.push(id);
            return { id };
          });
          if (barrier) {
            barrier.arrived += 1;
            if (barrier.arrived >= barrier.size) barrier.open();
            await barrier.opened;
          }
          return result;
        }),
      },
      cards: {
        create: vi.fn(async (body: { type: string; cardholder: string; status: 'active'; spending_controls?: { spending_limits: unknown[] } }, opts: { stripeAccount: string; idempotencyKey: string }) => {
          log.cardKeys.push(opts.idempotencyKey);
          return idempotent(opts.stripeAccount, opts.idempotencyKey, body, () => {
            const id = `ic_synthetic_${++next}`;
            cards.set(id, { id, status: body.status, type: body.type, cardholder: body.cardholder, limits: body.spending_controls?.spending_limits ?? [] });
            return { id, last4: '0000', brand: 'Visa', exp_month: 1, exp_year: 2030 };
          });
        }),
        update: vi.fn(async (id: string, body: { status?: ProviderCard['status'] }) => {
          const card = cards.get(id);
          if (!card) throw new Error('synthetic resource_missing');
          if (body.status) card.status = body.status;
          log.updates.push({ id, status: body.status });
          // The response describes the card as this request left it.
          const response = { id, status: card.status };
          if (holdUpdates) await new Promise<void>(resolve => { held.push({ release: resolve }); });
          return response;
        }),
      },
    },
  };

  return {
    stripe, cardholders, cards, log, held,
    holdUpdates() { holdUpdates = true; },
    /**
     * Hold every cardholder create until `size` of them have reached the
     * provider. It opens on its own after a second, so a change that stops the
     * second request from arriving fails the assertions instead of hanging.
     */
    cardholderBarrier(size: number) {
      let open!: () => void;
      const opened = new Promise<void>(resolve => { open = resolve; setTimeout(resolve, 1000); });
      barrier = { size, arrived: 0, open, opened };
    },
    seedCard(id: string, status: ProviderCard['status']) { cards.set(id, { id, status, type: 'virtual', cardholder: 'ich_seeded', limits: [] }); },
    /** The event body issuing_card.updated would carry for this card. */
    event(id: string): Stripe.Issuing.Card {
      const card = cards.get(id)!;
      return { id, status: card.status, spending_controls: { spending_limits: card.limits, blocked_categories: [] } } as unknown as Stripe.Issuing.Card;
    },
    active(type?: string) { return [...cards.values()].filter(card => card.status === 'active' && (!type || card.type === type)); },
  };
}

let db: ReturnType<typeof createInMemorySupabase>;
let provider: ReturnType<typeof syntheticProvider>;
let outage: { cardMirrorInserts: number };
let service: SupabaseClient<Database>;
let quiet: { mockRestore(): void }[] = [];

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
const audits = (action: string) => mock.audit.mock.calls.filter(([, row]) => (row as Row).action === action);

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
  outage = { cardMirrorInserts: 0 };
  // The service client the action and the library share. A mirror outage
  // refuses the next card INSERT only; every other read and write is real.
  service = {
    from(table: string) {
      const builder = db.from(table);
      if (table !== 'stripe_issuing_cards' || outage.cardMirrorInserts === 0) return builder;
      return Object.assign(Object.create(builder), {
        insert() {
          outage.cardMirrorInserts -= 1;
          return { select: () => ({ single: async () => ({ data: null, error: { code: '08006', message: 'synthetic mirror outage' } }) }) };
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
  mock.translations.mockResolvedValue((key: string) => `translated:${key}`);
  mock.forbidden.mockImplementation(() => { throw new Error('Unrelated client/provider call'); });
  quiet = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  vi.useRealTimers();
  // Restore only this case's console spies. vi.restoreAllMocks() would also
  // put back the native functions the hoisted network guards replaced, leaving
  // every later case unsealed while `attempts` still read zero.
  quiet.forEach(spy => spy.mockRestore());
  expect(network.sealed()).toEqual(SEALED);
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.forbidden).not.toHaveBeenCalled();
  expect(mock.sdkModuleLoads).toBe(0);
  expect(mock.stripeModuleLoads).toBe(0);
  expect(mock.stripeInitializations).toBe(0);
});
afterAll(() => network.restore());

describe('card issuance reaching the server more than once', () => {
  it.each([VIRTUAL, PHYSICAL])('reproduces: one $type order sent again (a remounted view re-click) issues a second live card', async input => {
    const first = await issueCardAction(input);
    vi.setSystemTime(T0 + 1);
    const second = await issueCardAction(input);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data?.cardId).not.toBe(second.data?.cardId);
    // The key carries the wallet and the clock, not the attempt: the provider
    // cannot tell a retry of one order from a second order.
    expect(provider.log.cardKeys).toEqual([`card-wallet-a-${T0}`, `card-wallet-a-${T0 + 1}`]);
    expect(provider.active(input.type)).toHaveLength(2);
    expect(mirrorCards().map(row => row.type)).toEqual([input.type, input.type]);
    expect(audits('card_issued')).toHaveLength(2);
    // The cardholder is created once (stable key + lookup) and reused.
    expect(provider.log.cardholderKeys).toEqual(['cardholder-member-a']);
    expect(provider.cardholders).toHaveLength(1);
  });

  it('reproduces: the same order twice within one millisecond replays one provider card and reports the second as failed', async () => {
    const first = await issueCardAction(VIRTUAL);
    const second = await issueCardAction(VIRTUAL);

    expect(first.ok).toBe(true);
    // The 23505 below reaches describeActionError, which answers with its
    // generic duplicate text — untranslated, and about a card that does exist.
    expect(second).toEqual({ ok: false, error: DUPLICATE_TEXT });
    expect(provider.log.cardKeys).toEqual([`card-wallet-a-${T0}`, `card-wallet-a-${T0}`]);
    expect(provider.cards.size).toBe(1);
    expect(provider.active()).toHaveLength(1);
    // UNIQUE (stripe_card_id) refuses the second mirror row for the same card.
    expect(mirrorCards()).toHaveLength(1);
    expect(audits('card_issued')).toHaveLength(1);
  });

  it('reproduces: virtual and physical for one child in the same millisecond share one key and the provider refuses the second', async () => {
    const virtual = await issueCardAction(VIRTUAL);
    const physical = await issueCardAction(PHYSICAL);

    expect(virtual.ok).toBe(true);
    expect(physical).toEqual({ ok: false, error: 'translated:money.couldNotIssueTheCard' });
    expect(provider.log.cardKeys).toEqual([`card-wallet-a-${T0}`, `card-wallet-a-${T0}`]);
    expect(provider.active()).toHaveLength(1);
    expect(mirrorCards().map(row => row.type)).toEqual(['virtual']);
  });

  it('reproduces: a mirror outage after provider creation reports failure, leaves a live unlisted card, and the retry issues a second', async () => {
    outage.cardMirrorInserts = 1;
    const failed = await issueCardAction(PHYSICAL);

    expect(failed).toEqual({ ok: false, error: 'translated:money.couldNotIssueTheCard' });
    const [orphan] = provider.active('physical');
    expect(orphan).toBeDefined();
    expect(mirrorCards()).toHaveLength(0);
    // Nothing compensates: no cancel or deactivate reaches the provider.
    expect(provider.stripe.issuing.cards.update).not.toHaveBeenCalled();
    expect(audits('card_issued')).toHaveLength(0);

    // The reconciler does not adopt it either: a card this deployment does not
    // mirror is logged and skipped (lib/stripe/webhook.ts).
    await expect(handleIssuingCardUpdated(service, provider.event(orphan.id))).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('does not mirror'), { stripeCardId: orphan.id });
    expect(mirrorCards()).toHaveLength(0);

    // The parent saw "could not issue" and tries again.
    vi.setSystemTime(T0 + 1);
    const retried = await issueCardAction(PHYSICAL);
    expect(retried.ok).toBe(true);
    expect(provider.active('physical')).toHaveLength(2);
    expect(mirrorCards().map(row => row.stripe_card_id)).toEqual([provider.active('physical')[1].id]);
    expect(mirrorCards()[0].stripe_card_id).not.toBe(orphan.id);
  });

  it('reproduces: virtual and physical ordered together for a child with no cardholder share one cardholder, and the same-millisecond card key refuses one', async () => {
    // The view claims `issue-<child>` for Virtual and `physical-<child>` for the
    // order dialog, so one mounted view can dispatch both at once.
    provider.cardholderBarrier(2);
    const [virtual, physical] = await Promise.all([issueCardAction(VIRTUAL), issueCardAction(PHYSICAL)]);

    // Both reached the provider with the same stable key and got ONE cardholder;
    // the second mirror insert met UNIQUE (family_id, member_id) and adopted that
    // exact row (ensureCardholder, repair C), so neither is refused there.
    expect(provider.log.cardholderKeys).toEqual(['cardholder-member-a', 'cardholder-member-a']);
    expect(provider.cardholders).toHaveLength(1);
    expect(db.table('stripe_cardholders')).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalledWith('[money-action] issue the card failed',
      expect.objectContaining({ message: expect.stringContaining('Failed to persist cardholder') }));

    // Both then carry `card-<wallet>-<ms>`. In one millisecond that is one key
    // with different parameters, which the provider refuses (as in the case
    // above), so one order is still refused: at the card step, with the
    // action's own text. Attempt identity (B) is the fix for that.
    expect(provider.log.cardKeys).toEqual([`card-wallet-a-${T0}`, `card-wallet-a-${T0}`]);
    expect([virtual.ok, physical.ok].sort()).toEqual([false, true]);
    const refused = virtual.ok ? physical : virtual;
    expect(refused).toEqual({ ok: false, error: 'translated:money.couldNotIssueTheCard' });
    expect(console.error).toHaveBeenCalledWith('[money-action] issue the card failed',
      expect.objectContaining({ message: expect.stringContaining('idempotency_error') }));
    expect(provider.cards.size).toBe(1);
    expect(mirrorCards()).toHaveLength(1);

    // Ordered again once the first settled, the refused type is issued.
    vi.setSystemTime(T0 + 1);
    const again = await issueCardAction(virtual.ok ? PHYSICAL : VIRTUAL);
    expect(again.ok).toBe(true);
    expect(mirrorCards().map(row => row.type).sort()).toEqual(['physical', 'virtual']);
  });

  it('preserves: deliberate later orders each issue their own card — several virtual and physical cards per child, one cardholder', async () => {
    const orders = [VIRTUAL, PHYSICAL, VIRTUAL, { ...VIRTUAL, childWalletId: 'wallet-b' }];
    for (const [step, input] of orders.entries()) {
      vi.setSystemTime(T0 + step * 60_000);
      expect((await issueCardAction(input)).ok).toBe(true);
    }

    expect(mirrorCards('wallet-a').map(row => row.type)).toEqual(['virtual', 'physical', 'virtual']);
    expect(mirrorCards('wallet-b').map(row => row.type)).toEqual(['virtual']);
    expect(new Set(provider.log.cardKeys).size).toBe(4);
    expect(provider.active()).toHaveLength(4);
    expect(db.table('stripe_cardholders').map(row => row.member_id)).toEqual(['member-a', 'member-b']);
    expect(provider.log.cardholderKeys).toEqual(['cardholder-member-a', 'cardholder-member-b']);
  });
});

describe('freeze requests reaching the server more than once', () => {
  const CARD_ROW = 'card-row-synthetic';
  const STRIPE_CARD = 'ic_seeded_synthetic';
  beforeEach(() => {
    provider.seedCard(STRIPE_CARD, 'active');
    db.seed('stripe_issuing_cards', [{
      id: CARD_ROW, family_id: FAMILY, child_wallet_id: 'wallet-a', cardholder_id: 'holder-row', stripe_card_id: STRIPE_CARD,
      type: 'virtual', status: 'active', is_frozen: false, spend_limit_cents: null, spend_window: 'per_authorization', blocked_categories: [],
    }]);
    provider.holdUpdates();
  });
  const mirror = () => db.table('stripe_issuing_cards').find(row => row.id === CARD_ROW)!;

  it.each([
    { order: 'second answered first', releases: [1, 0] },
    { order: 'first answered first', releases: [0, 1] },
  ])('converges: a repeated freeze (a remounted view sends the same direction) ends frozen, $order', async ({ releases }) => {
    // The view sends `frozen: !card.isFrozen` from its props, which do not
    // change until router.refresh(), so a re-click repeats the direction.
    const requests = [setCardFrozenAction({ cardId: CARD_ROW, frozen: true })];
    await vi.waitFor(() => expect(provider.held).toHaveLength(1));
    requests.push(setCardFrozenAction({ cardId: CARD_ROW, frozen: true }));
    await vi.waitFor(() => expect(provider.held).toHaveLength(2));

    for (const index of releases) {
      provider.held[index].release();
      expect(await requests[index]).toEqual({ ok: true });
    }

    expect(provider.log.updates).toEqual([{ id: STRIPE_CARD, status: 'inactive' }, { id: STRIPE_CARD, status: 'inactive' }]);
    expect(provider.cards.get(STRIPE_CARD)?.status).toBe('inactive');
    expect(mirror()).toMatchObject({ is_frozen: true, status: 'inactive' });
    expect(audits('card_frozen')).toHaveLength(2);
  });

  it('reproduces: opposite requests answered out of order leave the mirror opposite to the provider until issuing_card.updated', async () => {
    const freeze = setCardFrozenAction({ cardId: CARD_ROW, frozen: true });
    await vi.waitFor(() => expect(provider.held).toHaveLength(1));
    const unfreeze = setCardFrozenAction({ cardId: CARD_ROW, frozen: false });
    await vi.waitFor(() => expect(provider.held).toHaveLength(2));
    // The provider applied them in arrival order: the card is active.
    expect(provider.cards.get(STRIPE_CARD)?.status).toBe('active');

    provider.held[1].release();
    expect(await unfreeze).toEqual({ ok: true });
    provider.held[0].release();
    expect(await freeze).toEqual({ ok: true });

    // The later RESPONSE wrote the mirror last: the screen says frozen while
    // the card can spend.
    expect(mirror()).toMatchObject({ is_frozen: true, status: 'inactive' });
    await handleIssuingCardUpdated(service, provider.event(STRIPE_CARD));
    expect(mirror()).toMatchObject({ is_frozen: false, status: 'active' });
  });
});

// Last on purpose: every case above has run its hooks by now.
it('keeps the native network seal installed and refusing in a later case', () => {
  expect(network.sealed()).toEqual(SEALED);
  expect(network.probe()).toEqual({ refused: SEALED, counted: 9 });
});
