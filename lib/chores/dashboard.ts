// lib/chores/dashboard.ts
// Pure, deterministic helpers that power the gamified Chores dashboard: per-member
// point totals, leaderboards, day-streaks, reward progress, recurrence grouping,
// due-date labels, and chore emoji resolution. No DB/network — every function is a
// pure transform of already-fetched rows so the math is unit-tested directly and
// reused by the client module without duplicating logic.

export type ChoreLike = {
  id: string;
  title: string;
  description: string | null;
  points: number;
  recurrence: string;
  icon: string | null;
  category: string | null;
};

export type AssignmentLike = {
  id: string;
  chore_id: string;
  member_id: string;
  status: string;
  due_at: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  points_awarded: number | null;
  chore: ChoreLike | null;
};

export type MemberLike = { id: string; display_name: string; color: string | null };

export const COMPLETED_STATUSES = ['approved', 'done'] as const;

export function isCompleted(status: string): boolean {
  return status === 'approved' || status === 'done';
}

/** Points earned per member = sum of points_awarded over completed assignments. */
export function pointsByMember(assignments: AssignmentLike[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const a of assignments) {
    if (!isCompleted(a.status)) continue;
    const pts = a.points_awarded ?? a.chore?.points ?? 0;
    totals.set(a.member_id, (totals.get(a.member_id) ?? 0) + pts);
  }
  return totals;
}

export type EarnerRow = { member: MemberLike; points: number; rank: number };

/**
 * Members ranked by points earned, descending. Ties broken by display name so
 * the order is stable. Members with zero points are still included (rank by name).
 */
export function topEarners(members: MemberLike[], assignments: AssignmentLike[]): EarnerRow[] {
  const totals = pointsByMember(assignments);
  return members
    .map((member) => ({ member, points: totals.get(member.id) ?? 0 }))
    .sort((a, b) => b.points - a.points || a.member.display_name.localeCompare(b.member.display_name))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

export const totalFamilyPoints = (assignments: AssignmentLike[]): number =>
  assignments.reduce((sum, a) => sum + (isCompleted(a.status) ? a.points_awarded ?? a.chore?.points ?? 0 : 0), 0);

/** Local YYYY-MM-DD for an ISO timestamp (or null). */
function localDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86400000);
}

/**
 * Consecutive-day completion streak from a set of completion dates (YYYY-MM-DD).
 * The streak is only "live" if the latest completion was today or yesterday;
 * otherwise it has lapsed and the streak is 0.
 */
export function streakDays(days: Iterable<string>, today: string): number {
  const unique = [...new Set([...days])].filter(Boolean).sort((a, b) => (a < b ? 1 : -1));
  if (unique.length === 0) return 0;
  const gapFromToday = dayDiff(unique[0], today);
  if (gapFromToday > 1) return 0; // lapsed
  let streak = 1;
  for (let i = 1; i < unique.length; i++) {
    if (dayDiff(unique[i], unique[i - 1]) === 1) streak++;
    else break;
  }
  return streak;
}

export type StreakRow = { member: MemberLike; days: number };

/** Per-member day-streak, ranked by length (then name), only live streaks > 0. */
export function streaksByMember(members: MemberLike[], assignments: AssignmentLike[], today: string): StreakRow[] {
  const daysByMember = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (!isCompleted(a.status)) continue;
    const day = localDay(a.approved_at ?? a.submitted_at);
    if (!day) continue;
    if (!daysByMember.has(a.member_id)) daysByMember.set(a.member_id, new Set());
    daysByMember.get(a.member_id)!.add(day);
  }
  return members
    .map((member) => ({ member, days: streakDays(daysByMember.get(member.id) ?? [], today) }))
    .filter((row) => row.days > 0)
    .sort((a, b) => b.days - a.days || a.member.display_name.localeCompare(b.member.display_name));
}

export type RecurrenceGroups = { daily: AssignmentLike[]; weekly: AssignmentLike[]; other: AssignmentLike[] };

/** Split active (non-completed) assignments by their chore recurrence cadence. */
export function groupByRecurrence(assignments: AssignmentLike[]): RecurrenceGroups {
  const groups: RecurrenceGroups = { daily: [], weekly: [], other: [] };
  for (const a of assignments) {
    if (isCompleted(a.status)) continue;
    const rec = a.chore?.recurrence ?? 'none';
    if (rec === 'daily') groups.daily.push(a);
    else if (rec === 'weekly') groups.weekly.push(a);
    else groups.other.push(a);
  }
  return groups;
}

export type RewardProgress = {
  member: MemberLike;
  points: number;
  cost: number;
  remaining: number;
  pct: number;
  rewardTitle: string;
} | null;

/**
 * Progress of the highest-earning member toward the cheapest reward they cannot
 * yet afford. Returns null when there are no rewards or no members.
 */
export function rewardsProgress(
  members: MemberLike[],
  assignments: AssignmentLike[],
  rewards: { title: string; cost_points: number; redeemed_at: string | null }[],
): RewardProgress {
  const available = rewards
    .filter((r) => !r.redeemed_at && r.cost_points > 0)
    .sort((a, b) => a.cost_points - b.cost_points);
  if (available.length === 0 || members.length === 0) return null;
  const earners = topEarners(members, assignments);
  const leader = earners[0];
  if (!leader) return null;
  // Cheapest reward the leader can't afford yet (else the most aspirational one).
  const target = available.find((r) => r.cost_points > leader.points) ?? available[available.length - 1];
  const remaining = Math.max(0, target.cost_points - leader.points);
  const pct = Math.max(0, Math.min(100, Math.round((leader.points / target.cost_points) * 100)));
  return { member: leader.member, points: leader.points, cost: target.cost_points, remaining, pct, rewardTitle: target.title };
}

/** Human due-date label + urgency flag relative to `now`. */
export function dueLabel(due: string | null, now: Date = new Date()): { label: string; tone: 'overdue' | 'today' | 'soon' | 'normal' | 'none' } {
  if (!due) return { label: 'No due date', tone: 'none' };
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return { label: 'No due date', tone: 'none' };
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { label: 'Overdue', tone: 'overdue' };
  if (diff === 0) return { label: 'Today', tone: 'today' };
  if (diff === 1) return { label: 'Tomorrow', tone: 'soon' };
  return { label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), tone: 'normal' };
}

// Keyword → emoji map for chores that don't carry an explicit emoji icon.
const EMOJI_KEYWORDS: [RegExp, string][] = [
  [/\b(bed|tidy)\b/i, '🛏️'],
  [/\bdish/i, '🍽️'],
  [/\b(trash|garbage|recycl)/i, '🗑️'],
  [/\b(homework|study|read)/i, '📖'],
  [/\b(dog|cat|pet|feed)/i, '🐾'],
  [/\bvacuum/i, '🧹'],
  [/\b(table|dinner)\b/i, '🍴'],
  [/\b(laundry|fold|clothes)/i, '🧺'],
  [/\b(plant|garden)/i, '🪴'],
  [/\b(sweep|mop|floor)/i, '🧹'],
  [/\b(bathroom|toilet|shower)/i, '🚿'],
  [/\b(dust|shelv)/i, '🪶'],
  [/\b(kitchen|cook)/i, '🍳'],
  [/\blawn|\bmow|\byard/i, '🌱'],
  [/\b(grocery|shop)/i, '🛒'],
  [/\b(brush|teeth|hygiene)/i, '🪥'],
  [/\b(car|wash)/i, '🚗'],
  [/\bwater\b/i, '🪴'],
];

// True when a string is (probably) a single emoji rather than a keyword/icon name.
function looksLikeEmoji(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > 4) return false;
  return /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(trimmed);
}

/** Resolve a chore's display emoji from its `icon` column, title keywords, or a fallback. */
export function choreEmoji(chore: ChoreLike | null): string {
  if (chore?.icon && looksLikeEmoji(chore.icon)) return chore.icon.trim();
  const haystack = `${chore?.title ?? ''} ${chore?.description ?? ''} ${chore?.icon ?? ''} ${chore?.category ?? ''}`;
  for (const [re, emoji] of EMOJI_KEYWORDS) if (re.test(haystack)) return emoji;
  return '🧹';
}

export const RANK_MEDALS = ['🥇', '🥈', '🥉'] as const;
