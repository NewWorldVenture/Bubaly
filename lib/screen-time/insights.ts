// lib/screen-time/insights.ts — pure helpers for the Screen Time dashboard.
// Daily/weekly totals, category breakdown, balance score, limit progress and
// under-limit streaks. No Supabase/React so it's deterministically testable.

export const SCREEN_CATEGORIES = [
  'educational', 'creative', 'communication', 'social', 'entertainment', 'gaming', 'other',
] as const;
export type ScreenCategory = (typeof SCREEN_CATEGORIES)[number];

/** Categories that count as "productive" for the balance score. */
const PRODUCTIVE = new Set<string>(['educational', 'creative', 'communication']);

export function categoryMeta(cat: string): { label: string; productive: boolean } {
  const label = cat.charAt(0).toUpperCase() + cat.slice(1);
  return { label, productive: PRODUCTIVE.has(cat) };
}

export function formatMinutes(min: number): string {
  if (min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export type ScreenEntryLike = {
  member_id: string | null;
  entry_date: string; // YYYY-MM-DD
  minutes: number;
  category: string;
};

/** Total minutes on a given YYYY-MM-DD. */
export function minutesOnDate(entries: ScreenEntryLike[], date: string): number {
  return entries.reduce((sum, e) => (e.entry_date === date ? sum + (e.minutes ?? 0) : sum), 0);
}

/** Total minutes within the last `days` days (inclusive of today). */
export function minutesInWindow(entries: ScreenEntryLike[], days: number, now = new Date()): number {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCHours(0, 0, 0, 0);
  const from = cutoff.getTime() - (days - 1) * 86_400_000;
  return entries.reduce((sum, e) => {
    const t = new Date(e.entry_date + 'T00:00:00.000Z').getTime();
    return t >= from ? sum + (e.minutes ?? 0) : sum;
  }, 0);
}

/** Minutes per category (descending). */
export function categoryBreakdown(entries: ScreenEntryLike[]): Array<{ category: string; minutes: number }> {
  const map = new Map<string, number>();
  for (const e of entries) map.set(e.category, (map.get(e.category) ?? 0) + (e.minutes ?? 0));
  return [...map.entries()]
    .map(([category, minutes]) => ({ category, minutes }))
    .sort((a, b) => b.minutes - a.minutes || a.category.localeCompare(b.category));
}

/** Productive share of total minutes, 0–100. 100 when there's no screen time. */
export function balanceScore(entries: ScreenEntryLike[]): number {
  let total = 0, productive = 0;
  for (const e of entries) {
    total += e.minutes ?? 0;
    if (PRODUCTIVE.has(e.category)) productive += e.minutes ?? 0;
  }
  if (total === 0) return 100;
  return Math.round((productive / total) * 100);
}

export type LimitProgress = { used: number; limit: number; pct: number; over: boolean; remaining: number };

/** Today's usage vs a daily limit (limit ≤ 0 means "no limit set"). */
export function limitProgress(usedToday: number, limit: number): LimitProgress {
  if (!limit || limit <= 0) return { used: usedToday, limit: 0, pct: 0, over: false, remaining: 0 };
  const pct = Math.min(100, Math.round((usedToday / limit) * 100));
  return { used: usedToday, limit, pct, over: usedToday > limit, remaining: Math.max(0, limit - usedToday) };
}

/** Consecutive days (ending today) at or under the daily limit. Days with no
 *  logged time count as under-limit. Stops at the first over-limit day. */
export function underLimitStreak(entries: ScreenEntryLike[], limit: number, now = new Date()): number {
  if (!limit || limit <= 0) return 0;
  const byDay = new Map<string, number>();
  for (const e of entries) byDay.set(e.entry_date, (byDay.get(e.entry_date) ?? 0) + (e.minutes ?? 0));
  let streak = 0;
  const cursor = new Date(now.getTime());
  cursor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 366; i++) {
    const k = new Date(cursor.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    if ((byDay.get(k) ?? 0) > limit) break;
    streak++;
  }
  return streak;
}
