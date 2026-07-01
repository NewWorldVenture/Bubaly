// lib/wallet/hub.ts — pure, tested helpers for the "My Wallet" hub.
// Turns raw accounts / cards / passes / rewards / transaction rows into the
// overview totals and display strings the page renders. No Supabase/React so
// the money math stays deterministically unit-testable. Cents are integers;
// account balances arrive as dollars (numeric) and are converted once.

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

/** Format integer cents as USD with cents always shown ($8,245.50). */
export function fmtUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
}

/** Format a dollars value (numeric account balance) as USD. */
export function fmtDollars(n: number): string {
  return fmtUsd(dollarsToCents(n));
}

/** Grouped integer count with locale separators (2,850). */
export function fmtCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n ?? 0));
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

export function fmtSignedUsd(cents: number): string {
  const sign = cents >= 0 ? '+' : '-';
  return `${sign}${fmtUsd(Math.abs(cents))}`;
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

export function fmtTxnDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
