// lib/behavior/insights.ts — pure helpers for Behavior Tracking & parenting
// insights. Aggregation, balance score, weekly trend and positive-streak math.
// No Supabase/React so it's deterministically unit-testable.

export const BEHAVIOR_KINDS = ['positive', 'concern', 'neutral'] as const;
export type BehaviorKind = (typeof BEHAVIOR_KINDS)[number];

/** Suggested categories — free text is allowed, these power the quick-pick UI. */
export const BEHAVIOR_CATEGORIES = [
  'responsibility', 'kindness', 'focus', 'respect', 'honesty',
  'cooperation', 'mood', 'screen', 'homework', 'general',
] as const;

export function kindMeta(kind: string): { label: string; tone: 'success' | 'danger' | 'neutral'; sign: number } {
  if (kind === 'positive') return { label: 'Positive', tone: 'success', sign: 1 };
  if (kind === 'concern') return { label: 'Concern', tone: 'danger', sign: -1 };
  return { label: 'Neutral', tone: 'neutral', sign: 0 };
}

export type BehaviorLogLike = {
  member_id: string | null;
  kind: string;
  category: string;
  points: number;
  occurred_at: string;
};

export type MemberSummary = {
  positive: number;
  concern: number;
  neutral: number;
  total: number;
  netPoints: number;
  balanceScore: number;
  topCategories: Array<{ category: string; count: number }>;
};

/** Positive share of meaningful (positive+concern) observations, 0–100.
 *  Returns 100 when there are no positive/concern logs (nothing negative yet). */
export function balanceScore(positive: number, concern: number): number {
  const meaningful = positive + concern;
  if (meaningful === 0) return 100;
  return Math.round((positive / meaningful) * 100);
}

export function summarizeMember(logs: BehaviorLogLike[]): MemberSummary {
  let positive = 0, concern = 0, neutral = 0, netPoints = 0;
  const cats = new Map<string, number>();
  for (const l of logs) {
    if (l.kind === 'positive') positive++;
    else if (l.kind === 'concern') concern++;
    else neutral++;
    netPoints += l.points ?? 0;
    cats.set(l.category, (cats.get(l.category) ?? 0) + 1);
  }
  const topCategories = [...cats.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
    .slice(0, 3);
  return { positive, concern, neutral, total: logs.length, netPoints, balanceScore: balanceScore(positive, concern), topCategories };
}

const DAY = 86_400_000;
const dayKey = (iso: string) => iso.slice(0, 10);

/** Per-week positive/concern counts for the last `weeks` weeks (oldest→newest). */
export function trendByWeek(logs: BehaviorLogLike[], weeks = 6, now = new Date()): Array<{ weekStart: string; positive: number; concern: number }> {
  const buckets: Array<{ weekStart: string; positive: number; concern: number }> = [];
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  // Monday-anchored week start.
  const dow = (start.getUTCDay() + 6) % 7;
  const thisWeek = start.getTime() - dow * DAY;
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = thisWeek - i * 7 * DAY;
    buckets.push({ weekStart: new Date(ws).toISOString().slice(0, 10), positive: 0, concern: 0 });
  }
  for (const l of logs) {
    const t = new Date(l.occurred_at).getTime();
    for (let i = 0; i < buckets.length; i++) {
      const ws = new Date(buckets[i].weekStart + 'T00:00:00.000Z').getTime();
      if (t >= ws && t < ws + 7 * DAY) {
        if (l.kind === 'positive') buckets[i].positive++;
        else if (l.kind === 'concern') buckets[i].concern++;
        break;
      }
    }
  }
  return buckets;
}

/** Consecutive days (ending today) with ≥1 positive log and zero concerns. */
export function positiveStreakDays(logs: BehaviorLogLike[], now = new Date()): number {
  const byDay = new Map<string, { pos: number; con: number }>();
  for (const l of logs) {
    const k = dayKey(l.occurred_at);
    const d = byDay.get(k) ?? { pos: 0, con: 0 };
    if (l.kind === 'positive') d.pos++;
    else if (l.kind === 'concern') d.con++;
    byDay.set(k, d);
  }
  let streak = 0;
  const cursor = new Date(now.getTime());
  cursor.setUTCHours(0, 0, 0, 0);
  // Allow today to be empty without breaking a prior streak.
  for (let i = 0; i < 366; i++) {
    const k = new Date(cursor.getTime() - i * DAY).toISOString().slice(0, 10);
    const d = byDay.get(k);
    if (!d) { if (i === 0) continue; break; }
    if (d.con > 0 || d.pos === 0) break;
    streak++;
  }
  return streak;
}
