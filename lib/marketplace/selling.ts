// Marketplace seller cockpit — pure engine, no I/O.
//
// Turns the per-listing signals we already collect (watchers, offers,
// negotiations awaiting the seller, unanswered questions, ending-soon auctions,
// pickups to confirm, overdue returns) into a ranked "what needs my attention"
// view — the eBay Seller Hub idea. The page gathers the counts; this decides
// what's urgent, how to phrase it, and how to order the board. Fully tested.

export interface ListingSignals {
  id: string;
  title: string;
  status: string;                 // available / pending / claimed / …
  saleFormat: string;             // 'auction' | 'fixed'
  watchers: number;               // saves (♥)
  openOffers: number;             // open marketplace_offers
  openNegotiations: number;       // open negotiation threads
  myTurnNegotiations: number;     // threads where the SELLER must respond
  unansweredQuestions: number;
  auctionBids: number;
  auctionEndingSoon: boolean;
  pendingHandoffs: number;        // pickups awaiting the seller's confirm
  overdueReturns: number;         // rent/borrow they haven't returned, past due
}

export type AttentionTone = 'danger' | 'warn' | 'info' | 'muted';
export interface AttentionItem { label: string; tone: AttentionTone; urgent: boolean; }

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** The action chips for a listing, most-urgent first. */
export function attentionItems(s: ListingSignals): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (s.overdueReturns > 0) items.push({ label: `${plural(s.overdueReturns, 'overdue return')}`, tone: 'danger', urgent: true });
  if (s.unansweredQuestions > 0) items.push({ label: `${plural(s.unansweredQuestions, 'question')} to answer`, tone: 'warn', urgent: true });
  if (s.myTurnNegotiations > 0) items.push({ label: `${plural(s.myTurnNegotiations, 'offer')} need your reply`, tone: 'warn', urgent: true });
  if (s.pendingHandoffs > 0) items.push({ label: `confirm ${plural(s.pendingHandoffs, 'pickup')}`, tone: 'warn', urgent: true });
  if (s.auctionEndingSoon) items.push({ label: 'auction ending soon', tone: 'info', urgent: false });
  const otherOffers = s.openOffers + s.openNegotiations - s.myTurnNegotiations;
  if (otherOffers > 0) items.push({ label: `${plural(otherOffers, 'open offer')}`, tone: 'info', urgent: false });
  if (s.auctionBids > 0) items.push({ label: `${plural(s.auctionBids, 'bid')}`, tone: 'info', urgent: false });
  if (s.watchers > 0) items.push({ label: `${plural(s.watchers, 'watcher')}`, tone: 'muted', urgent: false });
  return items;
}

/** Higher = needs attention sooner. Urgent signals dominate; interest breaks ties. */
export function attentionScore(s: ListingSignals): number {
  return (
    s.overdueReturns * 1000 +
    s.unansweredQuestions * 200 +
    s.myTurnNegotiations * 180 +
    s.pendingHandoffs * 150 +
    (s.auctionEndingSoon ? 120 : 0) +
    (s.openOffers + s.openNegotiations) * 40 +
    s.auctionBids * 8 +
    s.watchers * 3
  );
}

export function needsAttention(s: ListingSignals): boolean {
  return attentionItems(s).some((i) => i.urgent);
}

/** Rank: attention first, then interest; stable by title for equal scores. */
export function rankListings(list: ListingSignals[]): ListingSignals[] {
  return [...list].sort((a, b) => {
    const d = attentionScore(b) - attentionScore(a);
    return d !== 0 ? d : a.title.localeCompare(b.title);
  });
}

export interface SellerTotals {
  activeListings: number;
  watchers: number;
  openOffers: number;
  questionsToAnswer: number;
  needsAttention: number;
}

/** Roll-up tiles for the top of the cockpit. */
export function sellerTotals(list: ListingSignals[]): SellerTotals {
  const active = (s: ListingSignals) => s.status === 'available' || s.status === 'pending';
  return {
    activeListings: list.filter(active).length,
    watchers: list.reduce((n, s) => n + s.watchers, 0),
    openOffers: list.reduce((n, s) => n + s.openOffers + s.openNegotiations, 0),
    questionsToAnswer: list.reduce((n, s) => n + s.unansweredQuestions, 0),
    needsAttention: list.filter(needsAttention).length,
  };
}
