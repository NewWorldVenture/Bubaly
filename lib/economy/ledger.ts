// lib/economy/ledger.ts — Family Economy token math. PURE + tested.
//
// The custom-currency economy uses the same immutable-ledger model as the cash
// wallet: a member's balance in a currency is the sum of credits minus debits.
// All amounts are whole positive integers (tokens); `direction` signs them.

export type EconomyEntry = { direction: 'credit' | 'debit'; amount: number };

/** Signed value of a single ledger entry (credit = +, debit = −). */
export function signedAmount(e: EconomyEntry): number {
  const amt = Math.max(0, Math.trunc(e.amount));
  return e.direction === 'credit' ? amt : -amt;
}

/** Balance = Σ credits − Σ debits. Never returns NaN. */
export function balanceFrom(entries: EconomyEntry[]): number {
  return (entries ?? []).reduce((sum, e) => sum + signedAmount(e), 0);
}

/** Can this member afford `cost` given their current balance? */
export function canAfford(balance: number, cost: number): boolean {
  return Number.isFinite(cost) && cost > 0 && balance >= cost;
}

/** Validate/normalize a token amount entered by a parent. Returns null if invalid. */
export function normalizeTokenAmount(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** Trim + bound a single emoji-ish token icon (fallback when empty). */
export function normalizeEmoji(raw: string | null | undefined, fallback = '⭐'): string {
  const e = (raw ?? '').trim();
  if (!e) return fallback;
  // Keep it short — a token icon, not a sentence. Use the grapheme-ish first chars.
  return Array.from(e).slice(0, 2).join('');
}

/** Format a token balance with its currency emoji, e.g. "12 ⭐". */
export function formatTokens(amount: number, emoji: string): string {
  return `${Math.trunc(amount)} ${emoji}`;
}
