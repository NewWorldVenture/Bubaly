// lib/wallet/hub.ts — pure, tested helpers for the "My Wallet" hub.
// Turns raw accounts / cards / passes / rewards / transaction rows into the
// overview totals and display strings the page renders. No Supabase/React so
// the money math stays deterministically unit-testable. Cents are integers;
// account balances arrive as dollars (numeric) and are converted once.

import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

export interface AccountLite { balance: number } // dollars
export interface CardLite { available_cents: number }
export interface RewardLite { unit: string; balance: number; value_cents: number }

export function dollarsToCents(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
}

export interface WalletOverview {
  accountsCents: number;
  accountsCount: number;
  cardsCents: number;
  cardsCount: number;
  rewardsValueCents: number;
  rewardsPoints: number;
  totalCents: number;
}

export function walletOverview(
  accounts: AccountLite[],
  cards: CardLite[],
  rewards: RewardLite[],
): WalletOverview {
  const accountsCents = accounts.reduce((s, a) => s + dollarsToCents(a.balance), 0);
  const cardsCents = cards.reduce((s, c) => s + (c.available_cents ?? 0), 0);
  const rewardsValueCents = rewards.reduce((s, r) => s + (r.value_cents ?? 0), 0);
  const rewardsPoints = rewards
    .filter((r) => r.unit === 'points')
    .reduce((s, r) => s + Math.round(r.balance ?? 0), 0);
  return {
    accountsCents,
    accountsCount: accounts.length,
    cardsCents,
    cardsCount: cards.length,
    rewardsValueCents,
    rewardsPoints,
    totalCents: accountsCents + cardsCents + rewardsValueCents,
  };
}

/**
 * Integer cents as USD with cents always shown. The LOCALE is the reader's; the
 * CURRENCY stays the money's own — a family's wallet is in dollars whichever
 * language they read, so de-DE renders "8.245,50 $" and never euros.
 */
export function fmtUsd(cents: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
}

/** Format a dollars value (numeric account balance) as USD. */
export function fmtDollars(n: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  return fmtUsd(dollarsToCents(n), locale);
}

/**
 * Grouped integer count. The comment already said "locale separators" and the code
 * pinned en-US, so a German reader saw "2,850" where their own grouping is "2.850"
 * — the separator and the decimal mark are SWAPPED between those two conventions,
 * which is the one case where a wrong separator can be read as a different number.
 */
export function fmtCount(n: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale).format(Math.round(n ?? 0));
}

export interface TxnLike {
  amount: number; // dollars, signed by type
  type: string;   // income | expense | transfer
  status: string;
}

/** Signed cents for a transaction: income positive, expense/transfer negative. */
export function txnSignedCents(t: TxnLike): number {
  const cents = dollarsToCents(Math.abs(t.amount));
  return t.type === 'income' ? cents : -cents;
}

export function fmtSignedUsd(cents: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  const sign = cents >= 0 ? '+' : '-';
  return `${sign}${fmtUsd(Math.abs(cents), locale)}`;
}

export const ACCOUNT_KIND_META: Record<string, { label: string; tint: string }> = {
  checking: { label: 'Checking', tint: 'bg-blue-500/15 text-blue-300' },
  savings: { label: 'Savings', tint: 'bg-emerald-500/15 text-emerald-300' },
  cash: { label: 'Cash', tint: 'bg-amber-500/15 text-amber-300' },
  credit: { label: 'Credit', tint: 'bg-rose-500/15 text-rose-300' },
  investment: { label: 'Investment', tint: 'bg-violet-500/15 text-violet-300' },
  retirement: { label: 'Retirement', tint: 'bg-violet-500/15 text-violet-300' },
};

export const CARD_BRAND_LABEL: Record<string, string> = {
  visa: 'VISA', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', other: 'Card',
};

export function fmtTxnDate(iso: string, locale: LocaleCode = DEFAULT_LOCALE): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
