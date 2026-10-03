import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { syntheticProvider } from './helpers/synthetic-issuing-provider';

// JIMMY-SUPPORT-CARD-RETRY-20261001: what the server and the provider do when a
// card order or a freeze reaches them more than once. Characterization only —
// these pin CURRENT behaviour so a repair has to change them on purpose. Tests
// named "reproduces" describe a defect candidate; "preserves" describe the
// existing multiple-card contract any repair must keep; "repaired (B)" pin what
// attempt identity (issueCard's count-based key, lib/stripe/issuing.ts)
// changed on purpose. Its interleavings live in
// tests/money-card-attempt-identity.test.ts.
//
// Sealed: no network, no real Stripe SDK, no real database client. The provider
// is an in-process double with Stripe's documented idempotency semantics
// (tests/helpers/synthetic-issuing-provider.ts), and
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
const VIRTUAL = { childWalletId: 'wallet-a', type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization' } as const;
const PHYSICAL = { childWalletId: 'wallet-a', type: 'physical', spendLimitCents: 2500, spendWindow: 'daily' } as const;

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
/** Repair B's attempt key: the child's cardholder row, wallet, type and mirrored count. */
const cardKey = (type: string, n: number) => `card-${db.table('stripe_cardholders')[0].id}-wallet-a-${type}-${n}`;

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
    // The key carries the attempt now (the mirrored count), not the clock, but
    // the first card was mirrored before the re-click arrived: the count moved,
    // so the provider still cannot tell it from a second order. Telling them
    // apart needs the view to send the count it saw (not implemented).
    expect(provider.log.cardKeys).toEqual([cardKey(input.type, 0), cardKey(input.type, 1)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(provider.active(input.type)).toHaveLength(2);
    expect(mirrorCards().map(row => row.type)).toEqual([input.type, input.type]);
    expect(audits('card_issued')).toHaveLength(2);
    // The cardholder is created once (stable key + lookup) and reused.
    expect(provider.log.cardholderKeys).toEqual(['cardholder-member-a']);
    expect(provider.cardholders).toHaveLength(1);
  });

  it('repaired (B): the same order sent again within one millisecond, after the first card is mirrored, is a new attempt — no clock collision, a second live card', async () => {
    const first = await issueCardAction(VIRTUAL);
    const second = await issueCardAction(VIRTUAL);

    // Before B the shared clock key replayed one card and the second mirror
    // insert's 23505 reached the parent as "That already exists". The key no
    // longer reads the clock: the first card was mirrored before the second
    // order read the count, so it is a new attempt (the re-click case above).
    // Orders that overlap before the first is mirrored share one key: see
    // tests/money-card-attempt-identity.test.ts.
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data?.cardId).not.toBe(second.data?.cardId);
    expect(provider.log.cardKeys).toEqual([cardKey('virtual', 0), cardKey('virtual', 1)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(provider.cards.size).toBe(2);
    expect(provider.active('virtual')).toHaveLength(2);
    expect(mirrorCards().map(row => row.id)).toEqual([first.data?.cardId, second.data?.cardId]);
    expect(audits('card_issued')).toHaveLength(2);
  });

  it('repaired (B): virtual and physical for one child in the same millisecond carry their own keys and both issue', async () => {
    const virtual = await issueCardAction(VIRTUAL);
    const physical = await issueCardAction(PHYSICAL);

    const rows = mirrorCards();
    expect(rows.map(row => row.type)).toEqual(['virtual', 'physical']);
    expect([virtual, physical]).toEqual(rows.map(row => ({ ok: true, data: { cardId: row.id } })));
    expect(provider.log.cardKeys).toEqual([cardKey('virtual', 0), cardKey('physical', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(provider.active('virtual')).toHaveLength(1);
    expect(provider.active('physical')).toHaveLength(1);
    expect(audits('card_issued')).toHaveLength(2);
  });

  it('reproduces: a mirror outage after provider creation reports failure and leaves a live unlisted card; repaired (B): the identical retry replays and mirrors that card instead of issuing a second', async () => {
    outage.cardMirrorInserts = 1;
    const failed = await issueCardAction(PHYSICAL);

    expect(failed).toEqual({ ok: false, error: 'translated:money.couldNotIssueTheCard' });
    const [orphan] = provider.active('physical');
    expect(orphan).toBeDefined();
    expect(mirrorCards()).toHaveLength(0);
    // Nothing compensates: no cancel or deactivate reaches the provider. The
    // log now names the card, so it can be found.
    expect(provider.stripe.issuing.cards.update).not.toHaveBeenCalled();
    expect(audits('card_issued')).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith('[money] card mirror insert failed after the provider created the card', { stripeCardId: orphan.id, code: '08006' });

    // The reconciler does not adopt it either: a card this deployment does not
    // mirror is logged and skipped (lib/stripe/webhook.ts).
    await expect(handleIssuingCardUpdated(service, provider.event(orphan.id))).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('does not mirror'), { stripeCardId: orphan.id });
    expect(mirrorCards()).toHaveLength(0);

    // The parent saw "could not issue" and tries again with the same order.
    // Nothing was mirrored, so the count and the key are unchanged and the
    // provider replays the orphan, which is now mirrored: no second card.
    // Only an IDENTICAL retry while the provider keeps the key (at least 24
    // hours) heals it: a changed retry is refused, and a retry that never comes
    // leaves the card live and unlisted. Nothing cancels it (repair E, not
    // implemented); see the residuals in money-card-attempt-identity.test.ts.
    vi.setSystemTime(T0 + 1);
    const retried = await issueCardAction(PHYSICAL);
    expect(provider.log.cardKeys).toEqual([cardKey('physical', 0), cardKey('physical', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'replayed']);
    expect(provider.active('physical')).toEqual([orphan]);
    expect(provider.cards.size).toBe(1);
    expect(mirrorCards().map(row => row.stripe_card_id)).toEqual([orphan.id]);
    expect(retried).toEqual({ ok: true, data: { cardId: mirrorCards()[0].id } });
    expect(audits('card_issued').map(([, row]) => (row as Row).entity_id)).toEqual([mirrorCards()[0].id]);
    expect(provider.stripe.issuing.cards.update).not.toHaveBeenCalled();
  });

  it('repaired (B): virtual and physical ordered together for a child with no cardholder share one cardholder, and each issues its own card', async () => {
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

    // Before B both carried `card-<wallet>-<ms>`, one key with different
    // parameters in one millisecond, and the provider refused one. Each type is
    // its own attempt now, so neither is refused and nothing needs ordering again.
    expect([...provider.log.cardKeys].sort()).toEqual([cardKey('physical', 0), cardKey('virtual', 0)]);
    expect(provider.log.cardOutcomes).toEqual(['created', 'created']);
    expect(console.error).not.toHaveBeenCalledWith('[money-action] issue the card failed', expect.anything());
    const rows = mirrorCards();
    expect(rows.map(row => row.type).sort()).toEqual(['physical', 'virtual']);
    expect([virtual, physical]).toEqual([
      { ok: true, data: { cardId: rows.find(row => row.type === 'virtual')!.id } },
      { ok: true, data: { cardId: rows.find(row => row.type === 'physical')!.id } },
    ]);
    expect(provider.cards.size).toBe(2);
    expect(provider.active('virtual')).toHaveLength(1);
    expect(provider.active('physical')).toHaveLength(1);
    expect(audits('card_issued')).toHaveLength(2);
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
