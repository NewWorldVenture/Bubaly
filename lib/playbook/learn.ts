// lib/playbook/learn.ts — the Family Intelligence Layer (Operating Layer pillar
// #3). Where the Knowledge Base stores facts a family TYPES IN, the Playbook
// LEARNS them from how the family actually behaves: the dinners they cook most,
// the day they usually shop, the routines that repeat. Each learned insight is a
// candidate `family_fact` the family can accept (and then edit like any other) —
// the family stays fully in control; nothing is saved without a tap.
//
// Pure + deterministic: the server gathers the raw signals, this derives the
// insights. No Supabase, no DOM — fully unit-testable.

import type { FactCategory } from '@/lib/memory/facts';

/** A durable pattern learned from real family behavior. */
export interface PlaybookInsight {
  /** Stable key so an already-saved insight isn't re-suggested. */
  key: string;
  /** Which Knowledge Base category it becomes when saved. */
  factCategory: FactCategory;
  label: string;   // the fact label, e.g. "Favorite dinner"
  value: string;   // the fact value, e.g. "Tacos"
  detail: string;  // human "why we think this", e.g. "Cooked 8× recently"
  confidence: number; // 0–100
}

export interface PlaybookSignals {
  /** Dinner names from meal history (most recent window). */
  dinners: string[];
  /** JS getDay() (0=Sun) for each grocery item's created date. */
  groceryDays: number[];
  /** Active recurring routines. */
  routines: { title: string; daysOfWeek: number[] }[];
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Count occurrences, returning [value, count] sorted most-frequent first. */
function tally<T>(items: T[]): [T, number][] {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Favorite dinners: names cooked ≥ `minCount` times. */
function learnMeals(dinners: string[], minCount: number, limit: number): PlaybookInsight[] {
  // Preserve a display casing for each normalized name (first seen wins).
  const display = new Map<string, string>();
  for (const d of dinners) { const n = norm(d); if (n && !display.has(n)) display.set(n, d.trim()); }
  const counts = tally(dinners.map(norm).filter(Boolean));
  const out: PlaybookInsight[] = [];
  for (const [name, count] of counts) {
    if (count < minCount) continue;
    out.push({
      key: `meal:${name}`,
      factCategory: 'preference',
      label: 'Favorite dinner',
      value: display.get(name) ?? name,
      detail: `Cooked ${count}× recently`,
      confidence: clamp(45 + count * 8),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Usual shopping day: the dominant weekday of grocery adds. */
function learnShoppingDay(days: number[], minSamples: number): PlaybookInsight[] {
  if (days.length < minSamples) return [];
  const counts = tally(days);
  const [topDay, topCount] = counts[0];
  const share = topCount / days.length;
  if (share < 0.4) return []; // no clear pattern
  return [{
    key: `shopday:${topDay}`,
    factCategory: 'preference',
    label: 'Usual shopping day',
    value: WEEKDAY[topDay] ?? 'Unknown',
    detail: `${topCount} of the last ${days.length} grocery runs`,
    confidence: clamp(share * 100),
  }];
}

/** Weekly routines that repeat on set days. */
function learnRoutines(routines: { title: string; daysOfWeek: number[] }[], limit: number): PlaybookInsight[] {
  const out: PlaybookInsight[] = [];
  for (const r of routines) {
    const title = r.title?.trim();
    if (!title || !r.daysOfWeek?.length) continue;
    const days = [...new Set(r.daysOfWeek)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
    if (days.length === 0) continue;
    const label = days.length === 7 ? 'Every day' : days.map((d) => WEEKDAY_SHORT[d]).join(', ');
    out.push({
      key: `routine:${norm(title)}`,
      factCategory: 'preference',
      label: 'Weekly routine',
      value: title,
      detail: label,
      confidence: 80,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface LearnOptions {
  minMealCount?: number;    // default 3
  minGrocerySamples?: number; // default 4
  limit?: number;           // max insights returned, default 8
}

/**
 * Learn the family playbook from real behavior signals. Deterministic; returns
 * [] when there isn't enough signal (a new family isn't "wrong", just unknown).
 * Ranked most-confident first, capped at `limit`.
 */
export function learnPlaybook(signals: PlaybookSignals, opts: LearnOptions = {}): PlaybookInsight[] {
  const insights = [
    ...learnMeals(signals.dinners ?? [], opts.minMealCount ?? 3, 3),
    ...learnShoppingDay(signals.groceryDays ?? [], opts.minGrocerySamples ?? 4),
    ...learnRoutines(signals.routines ?? [], 4),
  ];
  insights.sort((a, b) => b.confidence - a.confidence);
  return insights.slice(0, opts.limit ?? 8);
}

/** Drop insights already saved as facts (matched by normalized label+value). */
export function filterAlreadyKnown(
  insights: PlaybookInsight[],
  existing: { label: string; value: string }[],
): PlaybookInsight[] {
  const known = new Set(existing.map((f) => `${norm(f.label)}=${norm(f.value)}`));
  return insights.filter((i) => !known.has(`${norm(i.label)}=${norm(i.value)}`));
}
