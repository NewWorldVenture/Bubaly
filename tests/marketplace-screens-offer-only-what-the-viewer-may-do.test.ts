import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { allByName, byName, click, nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

/**
 * The marketplace's client screens offer only what the viewer may do, driven
 * through tests/helpers/module-harness.tsx: the real components, their own
 * handlers, an in-memory database.
 *
 *  - the board (components/modules/marketplace-module.tsx): no legacy "Mark
 *    complete" that completed a listing and stranded its order (N18); no
 *    Withdraw or Remove on a live auction holding bids, and no "I'm
 *    interested" on an auction, which froze it (N8); no Post and no interest
 *    for a guest (N12);
 *  - the community circles (components/marketplace/community-module.tsx): only
 *    a parent or adult of the founding family is offered Dissolve (N4), and a
 *    shared listing links to its page (N1);
 *  - the pickup panel (components/marketplace/handoff-panel.tsx): Confirm sends
 *    the proposal it rendered (N9), and the code is shown only to its holder,
 *    the entry box only to the other party (N2, N11).
 */
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const spies = vi.hoisted(() => ({
  confirmHandoff: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, data: { code: 'K7Q4MZ' } })),
  leaveCircle: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/marketplace/listing-image', () => ({ ListingImage: () => null }));
vi.mock('@/components/marketplace/photo-upload', () => ({ PhotoUpload: () => null }));
vi.mock('@/app/(app)/marketplace/handoff/actions', () => ({
  proposeHandoffAction: vi.fn(async () => ({ ok: true })),
  confirmHandoffAction: spies.confirmHandoff,
  cancelHandoffAction: vi.fn(async () => ({ ok: true })),
  completeHandoffAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/app/(app)/marketplace/community/actions', () => ({
  createCircleAction: vi.fn(async () => ({ ok: true })),
  joinCircleAction: vi.fn(async () => ({ ok: true })),
  leaveCircleAction: spies.leaveCircle,
  shareListingAction: vi.fn(async () => ({ ok: true })),
  unshareListingAction: vi.fn(async () => ({ ok: true })),
}));

const { MarketplaceModule } = await import('@/components/modules/marketplace-module');
const { CommunityModule } = await import('@/components/marketplace/community-module');
const { HandoffPanel } = await import('@/components/marketplace/handoff-panel');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const SELF = 'member-1';
const app = h.app as typeof h.app & { role?: string };

const listing = (over: Row): Row => ({
  family_id: FAMILY, member_id: SELF, title: 'Kids bike', description: null, kind: 'sell', category: 'sports',
  condition: null, price_cents: 4_000, rent_period: null, photo_url: null, location: null, status: 'available',
  claimed_by: null, claimed_at: null, created_by: 'user-1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  sale_format: 'fixed', auction_starts_at: null, auction_ends_at: null, starting_bid_cents: 0, buy_now_cents: null,
  current_bid_cents: 0, bid_count: 0, highest_bidder_member_id: null, highest_bidder_family_id: null,
  anti_snipe_minutes: 2, auction_closed_at: null, has_reserve: false, reserve_met: true, ...over,
});

let db: ReturnType<typeof createInMemorySupabase>;
beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  app.role = 'parent';
  spies.confirmHandoff.mockClear();
  spies.leaveCircle.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

const board = (props: Record<string, unknown> = {}) => render(h.hooks, createElement(MarketplaceModule, props));
const named = (tree: ReactNode, name: string | RegExp) => allByName(tree, name).length;

describe('the marketplace board', () => {
  it('offers no legacy "Mark complete" on a claimed listing (N18)', () => {
    db.seed('marketplace_listings', [listing({ id: 'l-claimed', status: 'claimed', claimed_by: 'member-2' })]);
    const tree = board();
    expect(named(tree, 'Kids bike')).toBeGreaterThan(0);
    expect(named(tree, t('marketplace.markComplete'))).toBe(0);
    // The owner's other controls are still there: it is this one that went.
    expect(named(tree, t('marketplace.edit'))).toBe(1);
  });

  it('offers no Withdraw or Remove on a live auction holding bids, and both once it holds none (N8)', () => {
    db.seed('marketplace_listings', [
      listing({ id: 'l-bid', title: 'Bid-on lamp', sale_format: 'auction', bid_count: 2, current_bid_cents: 2_500 }),
    ]);
    let tree = board();
    expect(named(tree, t('marketplace.withdraw'))).toBe(0);
    expect(named(tree, t('marketplace.remove'))).toBe(0);

    resetHookSlots(h.hooks);
    h.rows = {};
    db.replace('marketplace_listings', [listing({ id: 'l-quiet', title: 'Quiet lamp', sale_format: 'auction', bid_count: 0 })]);
    tree = board();
    expect(named(tree, t('marketplace.withdraw'))).toBe(1);
    expect(named(tree, t('marketplace.remove'))).toBe(1);
  });

  it('offers no "I\'m interested" on a sibling\'s auction, which an offer would freeze (N8)', () => {
    db.seed('marketplace_listings', [
      listing({ id: 'l-auction', member_id: 'member-2', title: 'Auction lamp', sale_format: 'auction' }),
      listing({ id: 'l-sale', member_id: 'member-2', title: 'Sale desk' }),
    ]);
    // One for the sale, none for the auction.
    expect(named(board(), /I'm interested/)).toBe(1);
  });

  it('offers a guest no Post and no interest, and does not open the post form for them (N12)', () => {
    db.seed('marketplace_listings', [listing({ id: 'l-sale', member_id: 'member-2', title: 'Sale desk' })]);
    app.role = 'guest';
    const tree = board({ autoOpenPost: 'sell' });
    expect(named(tree, t('marketplace.postAListing'))).toBe(0);
    expect(named(tree, /I'm interested/)).toBe(0);
    expect(nodes(tree).filter((n) => n.props.role === 'dialog')).toHaveLength(0);

    resetHookSlots(h.hooks);
    app.role = 'parent';
    const parent = board();
    expect(named(parent, t('marketplace.postAListing'))).toBeGreaterThan(0);
    expect(named(parent, /I'm interested/)).toBe(1);
  });
});

describe('the community circles', () => {
  const circle = { id: 'c1', name: 'Maple Street', emoji: '🍁', join_code: 'ABCDEFGH' };
  const props = (role: 'owner' | 'member', canManage: boolean) => ({
    migrated: true, familyId: FAMILY, canManage,
    circles: [circle],
    members: [
      { circle_id: 'c1', family_id: FAMILY, family_name: 'Us', role },
      { circle_id: 'c1', family_id: 'fam-other', family_name: 'The Riveras', role: role === 'owner' ? 'member' : 'owner' },
    ],
    shares: [{ listing_id: 'l-theirs', circle_id: 'c1', family_id: 'fam-other', created_at: '2026-10-02T00:00:00Z' }],
    sharedListings: [{ id: 'l-theirs', title: 'Camping tent', kind: 'sell', category: 'sports', condition: null, price_cents: 3_000, status: 'available', family_id: 'fam-other' }],
    myListings: [],
  });
  const screen = (role: 'owner' | 'member', canManage: boolean) => render(h.hooks, createElement(CommunityModule, props(role, canManage)));

  it('does not offer Dissolve to a child, teen or guest of the founding family (N4)', () => {
    expect(named(screen('owner', false), 'Dissolve')).toBe(0);
  });

  it('offers Dissolve to its parent or adult, and Leave to anyone in a member family', () => {
    expect(named(screen('owner', true), 'Dissolve')).toBe(1);
    resetHookSlots(h.hooks);
    expect(named(screen('member', false), 'Leave')).toBe(1);
  });

  it('links a shared listing from another family to its page (N1)', () => {
    const links = nodes(screen('member', false)).filter((n) => n.type === 'a' && n.props.href === '/marketplace/item/l-theirs');
    expect(links).toHaveLength(1);
  });
});

describe('the pickup panel', () => {
  const proposed = {
    status: 'proposed' as const, proposerRole: 'seller' as const, meetAt: '2026-10-24T17:00:00.000Z',
    locationLabel: 'Library', locationKind: 'public_spot' as const, confirmCode: null, notes: null, hasCalendar: false,
  };
  const panel = (viewerRole: 'buyer' | 'seller', handoff: typeof proposed | Record<string, unknown>) =>
    render(h.hooks, createElement(HandoffPanel, { orderId: 'order-1', viewerRole, handoff: handoff as never }));

  it('Confirm sends the time and place it showed, so a reschedule since is refused (N9)', async () => {
    await click(byName(panel('buyer', proposed), new RegExp(t('handoff.confirmPickup'))));
    expect(spies.confirmHandoff).toHaveBeenCalledWith('order-1', { meetAt: '2026-10-24T17:00:00.000Z', locationLabel: 'Library' });
  });

  it('shows the code to the confirmer, who holds it, and the entry box to the proposer (N2, N11)', () => {
    const confirmed = { ...proposed, status: 'confirmed', confirmCode: 'K7Q4MZ' };
    const holder = panel('buyer', confirmed);
    expect(nodes(holder).some((n) => n.props.children === 'K7Q4MZ')).toBe(true);
    expect(nodes(holder).some((n) => n.type === 'input' && n.props.placeholder === t('handoff.enterCodeToComplete'))).toBe(false);

    resetHookSlots(h.hooks);
    // Even handed the code, the proposer's screen does not show it.
    const proposer = panel('seller', confirmed);
    expect(nodes(proposer).some((n) => n.props.children === 'K7Q4MZ')).toBe(false);
    expect(nodes(proposer).some((n) => n.type === 'input' && n.props.placeholder === t('handoff.enterCodeToComplete'))).toBe(true);
  });
});
