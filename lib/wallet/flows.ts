/**
 * How a completed ledger row counts in "money in / money out" totals.
 *
 * A credit is money coming in and a debit is money going out, with one
 * exception: a card refund (`card_refund`, #925) is a credit in the ledger, but
 * it is a purchase undone, not new money. It reduces what was spent rather than
 * adding to what came in. Counted as income it inflated the treasury's "this
 * month in" and let the money coach read a returned purchase as a savings rate
 * (owner review 5976939812). Netting it against out keeps in − out equal to
 * the ledger's real change.
 *
 * Balances are not computed here: for a balance a refund is an ordinary credit
 * (lib/wallet/ledger.ts).
 */
export function moneyFlow(t: { type?: string | null; direction: string; amount_cents: number }): { inCents: number; outCents: number } {
  const amount = Number(t.amount_cents) || 0;
  if (t.direction !== 'credit') return { inCents: 0, outCents: amount };
  if (t.type === 'card_refund') return { inCents: 0, outCents: -amount };
  return { inCents: amount, outCents: 0 };
}
