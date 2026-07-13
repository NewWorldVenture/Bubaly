// Marketplace "Make an Offer" — pure negotiation engine, no I/O.
//
// The atomic state transitions live in the DB (marketplace_negotiation_offer /
// marketplace_negotiation_respond RPCs, which row-lock the listing). These pure
// helpers power the UI: whose turn it is, what actions are legal, sensible
// suggested amounts, and human-readable thread lines. Fully unit-tested.

export type NegotiationStatus = 'open' | 'agreed' | 'declined' | 'withdrawn' | 'expired';
export type Party = 'buyer' | 'seller';
export type RoundKind = 'offer' | 'counter' | 'accept' | 'decline' | 'withdraw';

export interface Negotiation {
  status: NegotiationStatus;
  currentAmountCents: number;
  lastActor: Party;             // who moved last → the OTHER party responds
  agreedAmountCents?: number | null;
}

export interface Round {
  actorRole: Party;
  kind: RoundKind;
  amountCents?: number | null;
  message?: string | null;
  createdAt: string;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Whose turn is it to move? Null once the thread is closed. */
export function whoseTurn(n: Pick<Negotiation, 'status' | 'lastActor'>): Party | null {
  if (n.status !== 'open') return null;
  return n.lastActor === 'buyer' ? 'seller' : 'buyer';
}

/** Is it `viewer`'s move on an open thread? */
export function isMyTurn(n: Pick<Negotiation, 'status' | 'lastActor'>, viewer: Party): boolean {
  return whoseTurn(n) === viewer;
}

/** The actions `viewer` may legally take right now. */
export function availableActions(
  n: Pick<Negotiation, 'status' | 'lastActor'>, viewer: Party,
): RoundKind[] {
  if (n.status !== 'open') return [];
  const turn = whoseTurn(n) === viewer;
  const out: RoundKind[] = [];
  if (turn) {
    out.push('accept', 'counter');
    out.push(viewer === 'seller' ? 'decline' : 'withdraw');
  } else {
    // Off-turn you can still bail: buyer withdraws, seller declines.
    out.push(viewer === 'seller' ? 'decline' : 'withdraw');
  }
  return out;
}

/** Clamp/validate a proposed counter given the listing ask (cents). Returns a
 *  reason string when invalid, else null. Mirrors the RPC's amount guards. */
export function validateOfferAmount(amountCents: number, askCents: number): string | null {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 'Enter an amount above $0.';
  if (askCents > 0 && amountCents >= askCents) return `That's at or above the ${money(askCents)} asking price — just buy it.`;
  return null;
}

/** A gentle first-offer suggestion: ~85% of ask, rounded to a tidy dollar. */
export function suggestedOpeningCents(askCents: number): number {
  if (askCents <= 0) return 0;
  const raw = Math.round(askCents * 0.85);
  return Math.max(100, Math.round(raw / 100) * 100);
}

/** Seller's suggested counter: meet in the middle of current offer and ask. */
export function suggestedCounterCents(currentCents: number, askCents: number): number {
  if (askCents <= currentCents) return askCents;
  const mid = Math.round((currentCents + askCents) / 2);
  return Math.round(mid / 100) * 100;
}

/** Savings vs. asking, as a whole percent (0 when ask is unknown). */
export function savingsPercent(agreedCents: number, askCents: number): number {
  if (askCents <= 0 || agreedCents <= 0 || agreedCents >= askCents) return 0;
  return Math.round(((askCents - agreedCents) / askCents) * 100);
}

/** One-line human summary of a thread's live state, from `viewer`'s side. */
export function statusLine(n: Negotiation, viewer: Party): string {
  switch (n.status) {
    case 'agreed':    return `Deal agreed at ${money(n.agreedAmountCents ?? n.currentAmountCents)}.`;
    case 'declined':  return 'Declined.';
    case 'withdrawn': return 'Withdrawn.';
    case 'expired':   return 'Expired.';
    default: break;
  }
  const turn = whoseTurn(n);
  if (turn === viewer) return `Your move — they're at ${money(n.currentAmountCents)}.`;
  return `Waiting on ${turn === 'seller' ? 'the seller' : 'the buyer'} — you're at ${money(n.currentAmountCents)}.`;
}

/** Render a round as a short thread line (for the timeline UI). */
export function roundLine(r: Round): string {
  const who = r.actorRole === 'seller' ? 'Seller' : 'Buyer';
  const amt = r.amountCents != null ? ` ${money(r.amountCents)}` : '';
  switch (r.kind) {
    case 'offer':   return `${who} offered${amt}`;
    case 'counter': return `${who} countered${amt}`;
    case 'accept':  return `${who} accepted${amt}`;
    case 'decline': return `${who} declined`;
    case 'withdraw':return `${who} withdrew`;
    default:        return `${who}`;
  }
}

/** Sort rounds oldest→newest (defensive; the query already orders). */
export function orderRounds(rounds: Round[]): Round[] {
  return [...rounds].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
