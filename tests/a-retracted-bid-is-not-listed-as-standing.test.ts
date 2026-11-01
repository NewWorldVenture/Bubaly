// OA2-unshare (app half) — a retracted bid is not listed as a standing one.
//
// The circle-boundary SQL proposed after 0483 retracts the bids of a family
// that can no longer see an auction: one removed from the circle, one that
// left it, or one the seller unshared the listing from. It then re-prices the
// auction from the bids left. 0183 has always allowed the 'retracted' status,
// but the auction box listed every bid the history read returned. A retracted
// $35.00 bid stayed in the history as "A bidder $35.00", above the re-priced
// $10.00 current bid, so it read as a live bid. The history now lists only the
// bids that stand.
//
// Driven through the REAL AuctionPanel, rendered as the app renders it, under
// the real en-US catalogue.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { localeOrDefault } from '@/lib/i18n/locales';

// Only the I/O boundaries: the browser client (used by the realtime refetch,
// which a static render never runs), the router, toasts and the server actions.
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/app/(app)/marketplace/auctions/actions', () => ({ placeBidAction: vi.fn(), buyNowAction: vi.fn() }));

const { AuctionPanel } = await import('@/components/marketplace/auction-panel');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const HOUR = 3_600_000;

type Bid = { id: string; bidder_family_id: string; amount_cents: number; status: string; created_at: string; is_auto: boolean };
const bid = (id: string, family: string, cents: number, status: string, at: string): Bid =>
  ({ id, bidder_family_id: family, amount_cents: cents, status, created_at: at, is_auto: false });

function panel(bids: Bid[], current: { currentBidCents: number; bidCount: number; leader: string | null }) {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    createElement(AuctionPanel, {
      listingId: 'canoe', isOwner: true, myFamilyId: 'fam-seller',
      initial: {
        saleFormat: 'auction', status: 'available', startingBidCents: 1000, currentBidCents: current.currentBidCents,
        bidCount: current.bidCount, hasReserve: false, reserveMet: true, buyNowCents: null,
        auctionStartsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
        auctionEndsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
        highestBidderFamilyId: current.leader,
      },
      initialBids: bids,
    }),
  ));
}

/** The bid history list: the markup after its heading. */
const history = (html: string) => {
  const at = html.indexOf(t('auction.bidHistory'));
  return at < 0 ? null : html.slice(at);
};

describe('the auction box after a bidder\'s family loses sight of the auction', () => {
  it('lists the bid that stands and not the retracted one above it', () => {
    // The Elm Street family's $35.00 was retracted when the canoe was unshared
    // from Elm Street; the Oak Lane family's $25.00 max now leads at the $10.00 start.
    const html = panel([
      bid('b-gone', 'fam-elm', 3500, 'retracted', '2026-10-22T10:05:00Z'),
      bid('b-oak', 'fam-oak', 1000, 'active', '2026-10-22T10:00:00Z'),
    ], { currentBidCents: 1000, bidCount: 1, leader: 'fam-oak' });

    const list = history(html);
    expect(list).not.toBeNull();
    expect(list).toContain('$10.00');
    expect(list).not.toContain('$35.00');
  });

  it('shows no history at all once every bid was retracted', () => {
    const html = panel([bid('b-gone', 'fam-elm', 2200, 'retracted', '2026-10-22T10:05:00Z')],
      { currentBidCents: 0, bidCount: 0, leader: null });

    expect(history(html)).toBeNull();
    expect(html).not.toContain('$22.00');
  });

  it('control: an outbid bid still stands in the history, marked outbid', () => {
    const html = panel([
      bid('b-lead', 'fam-oak', 2550, 'active', '2026-10-22T10:05:00Z'),
      bid('b-under', 'fam-elm', 2500, 'outbid', '2026-10-22T10:00:00Z'),
    ], { currentBidCents: 2550, bidCount: 2, leader: 'fam-oak' });

    const list = history(html);
    expect(list).toContain('$25.50');
    expect(list).toContain('$25.00');
    expect(list).toContain('outbid');
  });
});
