import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { byName, click, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

/**
 * The board's offers dialog decides one offer at a time (MT-1, its app half).
 *
 * marketplace_accept_offer (0315) reads the offer without a lock and writes
 * 'accepted' with no status predicate, so a decline that lands while an
 * accept is running is overwritten, after the decline was reported as done.
 * Both RPCs are the listing owner's alone, so the crossing a person can make
 * is with themselves, and in one tab it was this dialog: Accept, then Decline
 * before the accept answered, sent both (it had no busy guard; the listing
 * page's inbox always had one). The dialog now holds every decision while one
 * is in flight. Two tabs racing is closed only by the owner's SQL
 * (a compare-and-set in the RPC), which this cannot reach.
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
vi.mock('@/components/marketplace/listing-image', () => ({ ListingImage: () => null }));
vi.mock('@/components/marketplace/photo-upload', () => ({ PhotoUpload: () => null }));

const { MarketplaceModule } = await import('@/components/modules/marketplace-module');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;

const listing: Row = {
  id: 'l-desk', family_id: FAMILY, member_id: 'member-1', title: 'Oak desk', description: null, kind: 'sell', category: 'furniture',
  condition: null, price_cents: 4_000, rent_period: null, photo_url: null, location: null, status: 'pending',
  claimed_by: null, claimed_at: null, created_by: 'user-1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  sale_format: 'fixed', auction_starts_at: null, auction_ends_at: null, starting_bid_cents: 0, buy_now_cents: null,
  current_bid_cents: 0, bid_count: 0, highest_bidder_member_id: null, highest_bidder_family_id: null,
  anti_snipe_minutes: 2, auction_closed_at: null, has_reserve: false, reserve_met: true,
};

let db: InMemorySupabase;
let calls: string[];
let releaseAccept: () => void;

beforeEach(() => {
  resetHookSlots(h.hooks);
  calls = [];
  const accepting = new Promise<void>((resolve) => { releaseAccept = resolve; });
  db = createInMemorySupabase({
    rpc: {
      // The accept is still running when the owner clicks again.
      marketplace_accept_offer: async () => { calls.push('accept'); await accepting; return null; },
      marketplace_decline_offer: async () => { calls.push('decline'); return null; },
    },
  });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  db.seed('marketplace_listings', [listing]);
  db.seed('marketplace_offers', [
    { id: 'o-1', family_id: FAMILY, listing_id: 'l-desk', member_id: 'member-2', kind: 'interest', amount_cents: 4_000, message: null, status: 'open', created_by: 'user-2' },
  ]);
});

const board = () => render(h.hooks, createElement(MarketplaceModule, {}));

describe('the board\'s offers dialog', () => {
  it('does not send a decline while the accept of the same offer is in flight', async () => {
    await click(byName(board(), /1 offer/));
    const accepting = click(byName(board(), new RegExp(t('marketplace.accept'))));
    await settle();

    // Re-rendered mid-accept: the decision buttons are held, and a click on
    // Decline (the one the screen still shows) sends nothing.
    const mid = board();
    const decline = byName(mid, t('marketplace.decline'));
    expect(decline.props.disabled).toBe(true);
    await (decline.props.onClick as () => Promise<void>)();
    expect(calls).toEqual(['accept']);

    releaseAccept();
    await accepting;
    expect(calls).toEqual(['accept']);
    expect(h.toasts.success).toContain(t('marketplace.handedOffTo', { name: 'Someone' }));
  });

  it('lets the owner decline once nothing else is in flight', async () => {
    await click(byName(board(), /1 offer/));
    await click(byName(board(), t('marketplace.decline')));
    expect(calls).toEqual(['decline']);
    expect(h.toasts.success).toContain(t('marketplaceModule.offerDeclined'));
  });
});
