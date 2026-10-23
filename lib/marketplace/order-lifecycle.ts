// lib/marketplace/order-lifecycle.ts — the offer + order state machine (pure,
// unit-tested). It encodes valid offer transitions (open → accepted/declined/
// withdrawn), the "accept one offer, auto-decline the rest" rule, and THE order
// state machine the app runs: setOrderStatusAction (app/(app)/marketplace/
// actions.ts) allows exactly ORDER_TRANSITIONS, and the Orders page offers
// exactly those steps (components/marketplace/order-controls.tsx).
//
// The statuses are the database's own: marketplace_orders.status is checked
// against requested/confirmed/active/returned/completed/cancelled (0151), and
// tests/an-order-step-is-one-the-database-knows.test.ts holds this table to
// that check. It used to say the same of a vocabulary the database never had
// (pending/available/sold/canceled/refunded/disputed), while the live flow was
// a second table in actions.ts and a third in order-controls.tsx.

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
/** marketplace_orders.status, exactly as 0151's check constraint spells it. */
export type OrderStatus = 'requested' | 'confirmed' | 'active' | 'returned' | 'completed' | 'cancelled';

/**
 * requested → confirmed → active → (returned →) completed; an order not yet
 * under way can be cancelled. `active` is a sale handed over or a loan running.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['active', 'cancelled'],
  active: ['returned', 'completed'],
  returned: ['completed'],
  completed: [],
  cancelled: [],
};

export function canOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function nextOrderStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from] ?? [];
}

export function isOrderTerminal(status: OrderStatus): boolean {
  return nextOrderStatuses(status).length === 0;
}

/**
 * True once the exchange is finished (reviews open). No marketplace order is
 * charged in-app, so this is "done", not "money moved".
 */
export function isOrderPaid(status: OrderStatus): boolean {
  return status === 'completed';
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
