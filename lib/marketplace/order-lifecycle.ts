// lib/marketplace/order-lifecycle.ts — the buy/sell offer + order state machine
// (pure, unit-tested). The purchase-side counterpart to rental-lifecycle: it
// encodes valid offer transitions (open → accepted/declined/withdrawn) and order
// transitions (pending → completed/sold, canceled, refunded, disputed), plus the
// "accept one offer, auto-decline the rest" rule. Statuses match the DB check
// constraints on marketplace_offers (0120) and marketplace_orders (0138) exactly,
// so persisted rows always satisfy them.

// ── Offers ─────────────────────────────────────────────────────────────────
export type OfferStatus = 'open' | 'accepted' | 'declined' | 'withdrawn';

export const OFFER_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  open: ['accepted', 'declined', 'withdrawn'],
  accepted: [],
  declined: [],
  withdrawn: [],
};

export function canOfferTransition(from: OfferStatus, to: OfferStatus): boolean {
  return (OFFER_TRANSITIONS[from] ?? []).includes(to);
}

export interface OfferLike { id: string; status: OfferStatus }

/**
 * Accept one offer on a listing: the accepted offer flips to `accepted` and every
 * OTHER still-open offer flips to `declined`. Returns a map of id → new status
 * for the rows that change (already-resolved offers are untouched). Throws if the
 * target offer isn't open.
 */
export function resolveOfferAcceptance(offers: OfferLike[], acceptedId: string): Map<string, OfferStatus> {
  const target = offers.find((o) => o.id === acceptedId);
  if (!target) throw new Error(`Offer ${acceptedId} not found.`);
  if (target.status !== 'open') throw new Error(`Offer ${acceptedId} is "${target.status}", not open.`);
  const changes = new Map<string, OfferStatus>();
  changes.set(acceptedId, 'accepted');
  for (const o of offers) {
    if (o.id !== acceptedId && o.status === 'open') changes.set(o.id, 'declined');
  }
  return changes;
}

// ── Orders ─────────────────────────────────────────────────────────────────
export type OrderStatus =
  | 'pending' | 'available' | 'sold' | 'canceled' | 'refunded' | 'disputed' | 'completed';

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  available: ['pending', 'canceled'],
  pending: ['sold', 'completed', 'canceled', 'disputed'],
  sold: ['completed', 'refunded', 'disputed'],
  completed: ['refunded', 'disputed'],
  disputed: ['completed', 'refunded', 'canceled'],
  canceled: [],
  refunded: [],
};

export function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function nextOrderStatuses(from: OrderStatus): OrderStatus[] {
  return ORDER_TRANSITIONS[from] ?? [];
}

export function isOrderTerminal(status: OrderStatus): boolean {
  return nextOrderStatuses(status).length === 0;
}

/** True once money has changed hands (eligible for refund / review). */
export function isOrderPaid(status: OrderStatus): boolean {
  return status === 'sold' || status === 'completed';
}

// ── Who takes which step ───────────────────────────────────────────────────
// The steps `setOrderStatusAction` takes (app/(app)/marketplace/actions.ts,
// ORDER_FLOW) that say the exchange is over: the item came back, or it is done.
// They belong to the seller (on a rent or a borrow, the lender), who is the one
// who knows. Left to either party, a borrower could mark an item returned that
// is still in their hands, which also ends its overdue reminders. Starting and
// cancelling stay with either side; completing in person with the hand-off code
// is its own path.
export const SELLER_ONLY_ORDER_STEPS: ReadonlySet<string> = new Set(['returned', 'completed']);

/** True when `role`'s side of the exchange may take order step `step`. */
export function mayTakeOrderStep(role: 'buyer' | 'seller', step: string): boolean {
  return role === 'seller' || !SELLER_ONLY_ORDER_STEPS.has(step);
}
