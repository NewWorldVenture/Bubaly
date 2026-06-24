// lib/marketing/quotes.ts — pure helpers for proposals/quotes. Status lifecycle,
// expiry, and summary math are deterministic and unit-tested; the admin page/
// actions do the DB I/O.

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

export const QUOTE_STATUSES: QuoteStatus[] = ['draft', 'sent', 'accepted', 'declined', 'expired'];
export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', expired: 'Expired',
};

export function isQuoteStatus(s: string): s is QuoteStatus {
  return (QUOTE_STATUSES as string[]).includes(s);
}

export interface QuoteLike {
  status: QuoteStatus;
  amount_cents: number;
  valid_until: string | null;
}

/**
 * Whether a quote is past its valid_until date and still open (draft/sent).
 * Accepted/declined/expired quotes are never "newly expired".
 */
export function isExpired(quote: QuoteLike, now: Date = new Date()): boolean {
  if (quote.status !== 'draft' && quote.status !== 'sent') return false;
  if (!quote.valid_until) return false;
  const due = new Date(`${quote.valid_until}T23:59:59Z`).getTime();
  return !Number.isNaN(due) && now.getTime() > due;
}

/** Effective status: open quotes past their valid_until read as 'expired'. */
export function effectiveStatus(quote: QuoteLike, now: Date = new Date()): QuoteStatus {
  return isExpired(quote, now) ? 'expired' : quote.status;
}

export interface QuoteSummary {
  total: number;
  outstandingCents: number; // sent (awaiting response)
  acceptedCents: number;
  acceptRate: number; // accepted / (accepted + declined)
}

/** Aggregates a list of quotes for the dashboard cards. */
export function summarizeQuotes(quotes: QuoteLike[], now: Date = new Date()): QuoteSummary {
  let outstandingCents = 0;
  let acceptedCents = 0;
  let accepted = 0;
  let declined = 0;
  for (const q of quotes) {
    const st = effectiveStatus(q, now);
    if (st === 'sent') outstandingCents += q.amount_cents || 0;
    if (st === 'accepted') { acceptedCents += q.amount_cents || 0; accepted += 1; }
    if (st === 'declined') declined += 1;
  }
  const decided = accepted + declined;
  return {
    total: quotes.length,
    outstandingCents,
    acceptedCents,
    acceptRate: decided === 0 ? 0 : accepted / decided,
  };
}
