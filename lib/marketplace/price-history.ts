// Marketplace price history — pure engine, no I/O.
//
// The change log itself is written by a DB trigger (marketplace_log_price_change).
// These helpers read that log for the item page: how big the latest drop is,
// the lowest price in a window, and a plain-language trend line. Fully tested.
import type { LocaleCode } from '@/lib/i18n/locales';
import { createFormat } from '@/lib/utils/format';
import { MARKETPLACE_CURRENCY } from './listings';

export interface PriceChange {
  oldCents: number;
  newCents: number;
  changedAt: string;   // ISO
}

/** To the cent, as the history panel always showed it, in the READER's notation:
 *  `$${(c / 100).toFixed(2)}` wrote the symbol as text and had no locale at all. */
const money = (c: number, locale: LocaleCode) => createFormat(locale).fmtMoney(c, MARKETPLACE_CURRENCY);

/** Whole-percent drop from old→new (0 when it isn't a drop). */
export function dropPercent(oldCents: number, newCents: number): number {
  if (oldCents <= 0 || newCents >= oldCents) return 0;
  return Math.round(((oldCents - newCents) / oldCents) * 100);
}

export function isDrop(c: Pick<PriceChange, 'oldCents' | 'newCents'>): boolean {
  return c.newCents < c.oldCents;
}

/** The most recent change (assumes input newest-first OR unsorted — we sort). */
export function latestChange(history: PriceChange[]): PriceChange | null {
  if (history.length === 0) return null;
  return [...history].sort((a, b) => b.changedAt.localeCompare(a.changedAt))[0];
}

/** Total drop from the earliest recorded price to the current one, as percent. */
export function totalDropPercent(history: PriceChange[], currentCents: number): number {
  if (history.length === 0) return 0;
  const earliest = [...history].sort((a, b) => a.changedAt.localeCompare(b.changedAt))[0];
  return dropPercent(earliest.oldCents, currentCents);
}

/** Lowest price the item has ever been at (across old+new of every change). */
export function lowestCents(history: PriceChange[], currentCents: number): number {
  const all = [currentCents, ...history.flatMap((h) => [h.oldCents, h.newCents])].filter((c) => c > 0);
  return all.length ? Math.min(...all) : currentCents;
}

/** True when the current price equals the lowest it's ever been (and it moved). */
export function isAtLowest(history: PriceChange[], currentCents: number): boolean {
  return history.length > 0 && currentCents > 0 && currentCents === lowestCents(history, currentCents);
}

/** Was there a drop within the last `days`? */
export function hasRecentDrop(history: PriceChange[], days = 30, now: Date = new Date()): boolean {
  const cutoff = now.getTime() - days * 86400_000;
  return history.some((h) => isDrop(h) && new Date(h.changedAt).getTime() >= cutoff);
}

/** A short badge string for the item page, or null when there's nothing to say. */
export function priceDropBadge(history: PriceChange[], currentCents: number, now: Date = new Date()): string | null {
  const latest = latestChange(history);
  if (!latest || !isDrop(latest)) return null;
  if (!hasRecentDrop(history, 30, now)) return null;
  const pct = dropPercent(latest.oldCents, latest.newCents);
  return pct > 0 ? `Price dropped ${pct}%` : `Price dropped`;
}

/** One-line summary for the price-history panel: two amounts and an arrow, no
 *  words — so the locale is all it needs, and it is REQUIRED: the item page is
 *  its only caller and it has a reader. */
export function historyLine(c: PriceChange, locale: LocaleCode): string {
  const arrow = isDrop(c) ? '↓' : '↑';
  return `${money(c.oldCents, locale)} → ${money(c.newCents, locale)} ${arrow}`;
}
