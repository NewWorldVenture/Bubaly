// Household workload balancing — the "mental load" engine (competitor gap #3/#4).
//
// Pure + deterministic: given the family's members, chore assignments, todo
// items, and events for a window, compute who is actually carrying the
// household, how fair the split is, and concrete one-tap rebalance moves
// ("Move 'Unload dishwasher' from Maya to Dad — she's at 62% of family load").
// No I/O here; callers fetch and pass rows, the module ranks and explains.

export interface WorkloadMember {
  id: string;
  name: string;
  role: string;           // 'parent' | 'guardian' | 'teen' | 'child' | ...
}

export interface WorkloadChoreAssignment {
  id: string;
  choreId: string;
  memberId: string;
  status: string;         // 'todo' | 'in_progress' | 'done' | ...
  choreTitle: string;
  estMinutes: number | null;
  points: number;
}

export interface WorkloadTask {
  assignedToId: string | null;
  isDone: boolean;
}

export interface WorkloadEvent {
  createdBy: string | null;      // member who organized it
}

export interface MemberLoad {
  memberId: string;
  name: string;
  role: string;
  choreMinutes: number;
  choreCount: number;
  taskCount: number;
  eventCount: number;
  /** 0-100 composite: minutes dominate, tasks + organizing count too. */
  loadScore: number;
  /** This member's share of total family load (0-100). */
  sharePct: number;
  overloaded: boolean;
}

export interface RebalanceSuggestion {
  assignmentId: string;
  choreTitle: string;
  fromMemberId: string;
  fromName: string;
  toMemberId: string;
  toName: string;
  minutes: number;
  reason: string;
}

export interface WorkloadReport {
  loads: MemberLoad[];              // sorted heaviest first
  /** 0-100. 100 = perfectly even split; low = one person carries it. */
  fairness: number;
  headline: string;
  suggestions: RebalanceSuggestion[];
}

const DEFAULT_CHORE_MINUTES = 15;
const OVERLOAD_SHARE = 40;          // >40% of family load with 3+ members = carrying too much

function isOpen(status: string): boolean {
  return status === 'todo' || status === 'in_progress';
}

function isDone(status: string): boolean {
  return status === 'done' || status === 'approved';
}

/** Compute per-member load + fairness + human-readable rebalance moves. */
export function computeWorkload(
  members: WorkloadMember[],
  assignments: WorkloadChoreAssignment[],
  tasks: WorkloadTask[],
  events: WorkloadEvent[],
): WorkloadReport {
  const byMember = new Map<string, MemberLoad>();
  for (const m of members) {
    byMember.set(m.id, {
      memberId: m.id, name: m.name, role: m.role,
      choreMinutes: 0, choreCount: 0, taskCount: 0, eventCount: 0,
      loadScore: 0, sharePct: 0, overloaded: false,
    });
  }

  for (const a of assignments) {
    const l = byMember.get(a.memberId);
    if (!l) continue;
    l.choreMinutes += a.estMinutes ?? DEFAULT_CHORE_MINUTES;
    l.choreCount += 1;
  }
  for (const t of tasks) {
    if (!t.assignedToId) continue;
    const l = byMember.get(t.assignedToId);
    if (l) l.taskCount += 1;
  }
  for (const e of events) {
    if (!e.createdBy) continue;
    const l = byMember.get(e.createdBy);
    if (l) l.eventCount += 1;
  }

  // Composite: a task ≈ 10 min of load, organizing an event ≈ 12 (the
  // "invisible labor" weight — planning counts even when it isn't a chore).
  const raw = new Map<string, number>();
  let total = 0;
  for (const l of byMember.values()) {
    const r = l.choreMinutes + l.taskCount * 10 + l.eventCount * 12;
    raw.set(l.memberId, r);
    total += r;
  }

  const loads = [...byMember.values()];
  for (const l of loads) {
    const r = raw.get(l.memberId) ?? 0;
    l.sharePct = total > 0 ? Math.round((r / total) * 1000) / 10 : 0;
    l.loadScore = total > 0 ? Math.min(100, Math.round((r / Math.max(total / Math.max(members.length, 1), 1)) * 50)) : 0;
    l.overloaded = members.length >= 3 ? l.sharePct > OVERLOAD_SHARE : l.sharePct > 65;
  }
  loads.sort((a, b) => b.sharePct - a.sharePct || a.name.localeCompare(b.name));

  // Fairness: 100 − normalized gap between heaviest and lightest share.
  let fairness = 100;
  if (loads.length >= 2 && total > 0) {
    const even = 100 / loads.length;
    const gap = loads[0].sharePct - loads[loads.length - 1].sharePct;
    fairness = Math.max(0, Math.min(100, Math.round(100 - (gap / Math.max(even * (loads.length - 1), 1)) * 100)));
  }

  const heaviest = loads[0];
  let headline: string;
  if (total === 0) headline = 'No load recorded this week yet — assign a few chores to see the balance.';
  else if (fairness >= 80) headline = 'Nicely balanced — everyone is pulling a fair share this week.';
  else if (heaviest?.overloaded) headline = `${heaviest.name} is carrying ${heaviest.sharePct}% of the household load — time to rebalance.`;
  else headline = `The split is uneven — ${heaviest?.name ?? 'one person'} is doing the most.`;

  return { loads, fairness, headline, suggestions: rebalanceSuggestions(loads, assignments) };
}

/**
 * Concrete moves: take OPEN chores from the heaviest member and hand them to
 * the lightest members who can take them (kids never receive an adult's load
 * automatically — same-or-adjacent role only). At most 3, biggest first.
 */
export function rebalanceSuggestions(
  loads: MemberLoad[],
  assignments: WorkloadChoreAssignment[],
): RebalanceSuggestion[] {
  if (loads.length < 2) return [];
  const heaviest = loads[0];
  if (!heaviest || heaviest.sharePct < 34) return [];   // nothing worth moving

  const adults = new Set(['parent', 'adult', 'caregiver', 'guardian']);
  const candidates = [...loads].reverse().filter(l =>
    l.memberId !== heaviest.memberId &&
    (adults.has(heaviest.role) ? adults.has(l.role) || l.role === 'teen' : true));
  if (candidates.length === 0) return [];

  const movable = assignments
    .filter(a => a.memberId === heaviest.memberId && isOpen(a.status))
    .sort((a, b) => (b.estMinutes ?? DEFAULT_CHORE_MINUTES) - (a.estMinutes ?? DEFAULT_CHORE_MINUTES));

  const out: RebalanceSuggestion[] = [];
  for (const a of movable) {
    if (out.length >= 3) break;
    const to = candidates[out.length % candidates.length];
    const minutes = a.estMinutes ?? DEFAULT_CHORE_MINUTES;
    out.push({
      assignmentId: a.id, choreTitle: a.choreTitle,
      fromMemberId: heaviest.memberId, fromName: heaviest.name,
      toMemberId: to.memberId, toName: to.name,
      minutes,
      reason: `${heaviest.name} holds ${heaviest.sharePct}% of the load; ${to.name} is at ${to.sharePct}% — moving “${a.choreTitle}” (~${minutes} min) evens it out.`,
    });
  }
  return out;
}

/** Weekly trend line from persisted snapshots: share% per member per week. */
export function shareTrend(
  snapshots: { memberId: string; weekStart: string; sharePct: number }[],
): Map<string, { weekStart: string; sharePct: number }[]> {
  const m = new Map<string, { weekStart: string; sharePct: number }[]>();
  for (const s of [...snapshots].sort((a, b) => a.weekStart.localeCompare(b.weekStart))) {
    const arr = m.get(s.memberId) ?? [];
    arr.push({ weekStart: s.weekStart, sharePct: s.sharePct });
    m.set(s.memberId, arr);
  }
  return m;
}

/** Monday of the ISO week containing d, as YYYY-MM-DD. */
export function isoWeekStart(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;    // Mon=0..Sun=6
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export { isOpen as isOpenAssignment, isDone as isDoneAssignment };
