// lib/food/leftovers.ts — pure helpers for Leftover Intelligence.
// Track leftovers and tell the family what to eat before it spoils. No I/O.

import { daysUntil, type ExpiryTone } from '@/lib/pantry/logic';

export type LeftoverStatus = 'fresh' | 'eaten' | 'frozen' | 'tossed' | 'donated';

export interface LeftoverLike {
  id?: string;
  name?: string;
  source_meal?: string | null;
  use_by?: string | null;
  status?: string | null;
  location?: string | null;
}

export const LEFTOVER_LOCATIONS = [
  { id: 'fridge', label: 'Fridge', emoji: '🧊' },
  { id: 'freezer', label: 'Freezer', emoji: '❄️' },
  { id: 'counter', label: 'Counter', emoji: '🍞' },
  { id: 'other', label: 'Other', emoji: '🏠' },
] as const;

export interface LeftoverUrgency {
  tone: ExpiryTone;
  label: string;
  days: number | null;
  /** Recommended next action. */
  suggestion: 'eat_now' | 'eat_soon' | 'freeze' | 'ok' | 'expired';
}

/** Classify a leftover by its eat-before date into an action recommendation. */
export function leftoverUrgency(useBy: string | null | undefined, now: number = Date.now()): LeftoverUrgency {
  const days = daysUntil(useBy, now);
  if (days === null) return { tone: 'neutral', label: 'No date', days: null, suggestion: 'ok' };
  if (days < 0) return { tone: 'danger', label: days === -1 ? 'Past use-by (1d)' : `Past use-by (${-days}d)`, days, suggestion: 'expired' };
  if (days === 0) return { tone: 'danger', label: 'Eat today', days, suggestion: 'eat_now' };
  if (days === 1) return { tone: 'warning', label: 'Eat tomorrow', days, suggestion: 'eat_soon' };
  if (days <= 2) return { tone: 'warning', label: `Eat within ${days}d`, days, suggestion: 'eat_soon' };
  if (days <= 4) return { tone: 'caution', label: `Use by ${days}d — or freeze`, days, suggestion: 'freeze' };
  return { tone: 'success', label: `Good for ${days}d`, days, suggestion: 'ok' };
}

/** Active (fresh) leftovers sorted most-urgent first. */
export function activeLeftovers<T extends LeftoverLike>(items: T[], now: number = Date.now()): T[] {
  return items
    .filter((l) => (l.status ?? 'fresh') === 'fresh')
    .sort((a, b) => {
      const da = daysUntil(a.use_by, now);
      const db = daysUntil(b.use_by, now);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
}

/** A short, friendly "eat me first" line for the dashboard, or null. */
export function leftoverNudge<T extends LeftoverLike>(items: T[], now: number = Date.now()): string | null {
  const active = activeLeftovers(items, now);
  if (active.length === 0) return null;
  const top = active[0];
  const u = leftoverUrgency(top.use_by, now);
  const name = top.source_meal || top.name || 'a leftover';
  if (u.suggestion === 'expired') return `Toss or check ${name} — it's past its use-by date.`;
  if (u.suggestion === 'eat_now') return `Eat ${name} today before it goes bad.`;
  if (u.suggestion === 'eat_soon') return `${name} should be eaten ${u.days === 1 ? 'tomorrow' : 'in the next couple days'}.`;
  if (u.suggestion === 'freeze') return `Freeze ${name} if you won't eat it in the next few days.`;
  return `You have ${active.length} leftover${active.length === 1 ? '' : 's'} ready to use.`;
}

/** Count of leftovers that need attention soon (eat now/soon or expired). */
export function urgentLeftoverCount<T extends LeftoverLike>(items: T[], now: number = Date.now()): number {
  return activeLeftovers(items, now).filter((l) => {
    const s = leftoverUrgency(l.use_by, now).suggestion;
    return s === 'eat_now' || s === 'eat_soon' || s === 'expired';
  }).length;
}
