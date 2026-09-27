// Marketplace "Make an Offer" — pure negotiation engine, no I/O.
//
// The atomic state transitions live in the DB (marketplace_negotiation_offer /
// marketplace_negotiation_respond RPCs, which row-lock the listing). These pure
// helpers power the UI: whose turn it is, what actions are legal, sensible
// suggested amounts, and human-readable thread lines. Fully unit-tested.
//
// THE THREAD LINES ARE THE READER'S. Every one of them used to be an English
// sentence with `$${(c / 100).toFixed(2)}` inside it — a literal symbol and a
// number with no locale at all, so a German family read "Your move — they're at
// $2768.50." Localising only the number would have left an English sentence
// around a German amount, so the sentences are catalogue keys with the amount
// as a placeholder, and `locale` + `t` are REQUIRED: every caller has a reader.
import type { LocaleCode } from '@/lib/i18n/locales';
import { createFormat } from '@/lib/utils/format';
import { MARKETPLACE_CURRENCY } from './listings';

/** A translator, in the shape `useTranslations()` and `getTranslations()` return. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

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

/** An offer amount, always to the cent (an offer of $60 reads "$60.00", as it
 *  did), in the reader's notation. The currency is the money's own — see
 *  MARKETPLACE_CURRENCY. */
const money = (c: number, locale: LocaleCode) => createFormat(locale).fmtMoney(c, MARKETPLACE_CURRENCY);

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
export function validateOfferAmount(
  amountCents: number, askCents: number, locale: LocaleCode, t: Translate,
): string | null {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return t('negotiation.enterAnAmountAboveZero');
  if (askCents > 0 && amountCents >= askCents) {
    return t('negotiation.atOrAboveTheAskingPrice', { ask: money(askCents, locale) });
  }
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
export function statusLine(n: Negotiation, viewer: Party, locale: LocaleCode, t: Translate): string {
  switch (n.status) {
    case 'agreed':
      return t('negotiation.dealAgreedAt', { amount: money(n.agreedAmountCents ?? n.currentAmountCents, locale) });
    case 'declined':  return t('negotiation.statusDeclined');
    case 'withdrawn': return t('negotiation.statusWithdrawn');
    case 'expired':   return t('negotiation.statusExpired');
    default: break;
  }
  const amount = money(n.currentAmountCents, locale);
  const turn = whoseTurn(n);
  if (turn === viewer) return t('negotiation.yourMoveTheyreAt', { amount });
  return t(turn === 'seller' ? 'negotiation.waitingOnTheSellerYoureAt' : 'negotiation.waitingOnTheBuyerYoureAt', { amount });
}

/**
 * One whole sentence per side and move, rather than "{who} {verb}": a translator
 * gets "Buyer offered {amount}" to render as one thought, and no language has to
 * agree a verb with a noun glued in from somewhere else. The amount-less forms
 * are for a round whose amount_cents is null (the column is nullable).
 */
const ROUND_WITH_AMOUNT: Record<Party, Partial<Record<string, string>>> = {
  buyer: {
    offer: 'negotiation.buyerOfferedAmount',
    counter: 'negotiation.buyerCounteredAmount',
    accept: 'negotiation.buyerAcceptedAmount',
  },
  seller: {
    offer: 'negotiation.sellerOfferedAmount',
    counter: 'negotiation.sellerCounteredAmount',
    accept: 'negotiation.sellerAcceptedAmount',
  },
};
const ROUND_BARE: Record<Party, Partial<Record<string, string>>> = {
  buyer: {
    offer: 'negotiation.buyerOffered',
    counter: 'negotiation.buyerCountered',
    accept: 'negotiation.buyerAccepted',
    decline: 'negotiation.buyerDeclined',
    withdraw: 'negotiation.buyerWithdrew',
  },
  seller: {
    offer: 'negotiation.sellerOffered',
    counter: 'negotiation.sellerCountered',
    accept: 'negotiation.sellerAccepted',
    decline: 'negotiation.sellerDeclined',
    withdraw: 'negotiation.sellerWithdrew',
  },
};

/** Render a round as a short thread line (for the timeline UI). */
export function roundLine(r: Round, locale: LocaleCode, t: Translate): string {
  const side: Party = r.actorRole === 'seller' ? 'seller' : 'buyer';
  const withAmount = ROUND_WITH_AMOUNT[side][r.kind];
  if (withAmount && r.amountCents != null) return t(withAmount, { amount: money(r.amountCents, locale) });
  // `kind` arrives from the database as a string; an unknown one names the side.
  return t(ROUND_BARE[side][r.kind] ?? (side === 'seller' ? 'negotiation.roleSeller' : 'negotiation.roleBuyer'));
}

/** Sort rounds oldest→newest (defensive; the query already orders). */
export function orderRounds(rounds: Round[]): Round[] {
  return [...rounds].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
