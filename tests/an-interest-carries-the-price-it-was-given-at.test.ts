import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

/**
 * An "I'm interested" carries the price it was given at (MT-4).
 *
 * An interest offer had no amount. marketplace_accept_offer (0315) records the
 * confirmed order at `coalesce(offer.amount_cents, listing.price_cents)`, the
 * listing's price at ACCEPT time, and nothing freezes that price while offers
 * are open: the seller could re-price after the interest and accept, and the
 * buyer's Orders page then read "You pay" a price they never saw. Both ways
 * in, the listing page's makeOfferAction and the board's "I'm interested",
 * now record the price on the offer, which the owner's inbox already shows.
 */
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/marketplace/listing-image', () => ({ ListingImage: () => null }));
vi.mock('@/components/marketplace/photo-upload', () => ({ PhotoUpload: () => null }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' }, memberships: [],
    active: { familyId: h.app.familyId, role: 'parent', member: { id: 'member-1', family_id: h.app.familyId } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { MarketplaceModule } = await import('@/components/modules/marketplace-module');
const { makeOfferAction } = await import('@/app/(app)/marketplace/actions');

const FAMILY = h.app.familyId;

/** marketplace_accept_offer as 0315 records it: the offer's amount, else the listing's price now. */
function acceptOffer(args: Record<string, unknown>, mem: InMemorySupabase) {
  const offer = mem.table('marketplace_offers').find((o) => o.id === args.p_offer)!;
  const listing = mem.table('marketplace_listings').find((l) => l.id === offer.listing_id)!;
  offer.status = 'accepted';
  listing.status = 'claimed';
  mem.table('marketplace_orders').push({
    id: 'order-1', family_id: listing.family_id, listing_id: listing.id, buyer_member: offer.member_id,
    seller_member: listing.member_id, status: 'confirmed', amount_cents: offer.amount_cents ?? listing.price_cents,
  });
  return null;
}

const listing = (over: Row): Row => ({
  id: 'l-desk', family_id: FAMILY, member_id: 'member-2', title: 'Oak desk', description: null, kind: 'sell', category: 'furniture',
  condition: null, price_cents: 4_000, rent_period: null, photo_url: null, location: null, status: 'available',
  claimed_by: null, claimed_at: null, created_by: 'user-2', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  sale_format: 'fixed', auction_starts_at: null, auction_ends_at: null, starting_bid_cents: 0, buy_now_cents: null,
  current_bid_cents: 0, bid_count: 0, highest_bidder_member_id: null, highest_bidder_family_id: null,
  anti_snipe_minutes: 2, auction_closed_at: null, has_reserve: false, reserve_met: true, ...over,
});

let db: InMemorySupabase;
beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ rpc: { marketplace_accept_offer: acceptOffer } });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
});

/** The seller re-prices, then accepts the one open offer. */
async function repriceAndAccept() {
  db.table('marketplace_listings')[0].price_cents = 9_000;
  const offer = db.table('marketplace_offers')[0];
  await db.rpc('marketplace_accept_offer', { p_offer: offer.id });
  return db.table('marketplace_orders')[0];
}

describe('an interest from the listing page (makeOfferAction)', () => {
  it('is accepted at the price the buyer reached out at, not one set after', async () => {
    db.seed('marketplace_listings', [listing({})]);
    expect(await makeOfferAction('l-desk')).toEqual({ ok: true });
    expect(db.table('marketplace_offers')[0]).toMatchObject({ kind: 'interest', amount_cents: 4_000 });
    expect((await repriceAndAccept()).amount_cents).toBe(4_000);
  });

  it('a claim on a free listing names no amount', async () => {
    db.seed('marketplace_listings', [listing({ kind: 'free', price_cents: 0 })]);
    expect(await makeOfferAction('l-desk')).toEqual({ ok: true });
    expect(db.table('marketplace_offers')[0]).toMatchObject({ kind: 'claim' });
    expect(db.table('marketplace_offers')[0].amount_cents ?? null).toBeNull();
  });
});

describe('an interest from the board ("I\'m interested")', () => {
  it('is accepted at the price on the screen, not one set after', async () => {
    db.seed('marketplace_listings', [listing({ kind: 'rent', price_cents: 1_500, rent_period: 'day' })]);
    const tree = render(h.hooks, createElement(MarketplaceModule, {}));
    await click(byName(tree, /I'm interested/));
    expect(db.table('marketplace_offers')[0]).toMatchObject({ kind: 'interest', amount_cents: 1_500 });
    expect((await repriceAndAccept()).amount_cents).toBe(1_500);
  });
});
