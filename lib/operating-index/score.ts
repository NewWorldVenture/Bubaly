// lib/operating-index/score.ts — the reasoning core of the Family Operating
// Layer, expressed as pure math. Given a normalized snapshot of the household
// (primitive counts/values only — no Supabase, no DOM), it produces the Family
// Operating Index: seven dimension scores (0–100), a weighted composite, a band,
// and a ranked list of PRACTICAL suggestions (each deep-linked to the capability
// that fixes it). Deterministic and fully unit-testable; the server layer is the
// only thing that touches the database.
//
// Philosophy (see todo.md ★ North Star): this measures how well a household is
// *functioning* to surface opportunities — never to judge. Missing data reads as
// "calm", not "failing": a family with nothing scheduled is not disorganized.

export type DimensionId =
  | 'planning'      // planning confidence — is the near future organized?
  | 'stability'     // schedule stability — few conflicts / churn
  | 'financial'     // financial preparedness — bills covered, budgets in range
  | 'readiness'     // household readiness — docs, maintenance, inventory
  | 'communication' // responsiveness — decisions/approvals not left hanging
  | 'routine'       // routine completion — chores/tasks getting done
  | 'goals';        // goal progress — savings/family goals advancing

export type Band = 'thriving' | 'steady' | 'stretched' | 'overloaded';

/** Per-member load, used to answer "who is overloaded this week?". */
export interface MemberLoad {
  memberId: string;
  name: string;
  upcoming: number;   // events they own in the next 7 days
  openTasks: number;  // open chores/tasks assigned to them
}

/**
 * Normalized household state. Every field is a plain count or amount the server
 * derives from real family-scoped tables. Absent data → 0 (reads as calm).
 */
export interface HouseholdSnapshot {
  memberCount: number;

  // Planning confidence
  upcomingEvents: number;         // events in the next 7 days
  upcomingEventsOwned: number;    // of those, with an assignee (someone owns it)
  eventsMissingInfo: number;      // upcoming events missing a location/time they need
  overdueReminders: number;       // active reminders already past due

  // Schedule stability
  conflicts: number;              // detected double-bookings in the upcoming window

  // Financial preparedness
  billsDueSoon: number;           // bills due in the next 14 days
  billsCovered: number;           // of those, autopay on / already funded
  overspentBudgets: number;       // budget categories over their cap this period
  negativeBalances: number;       // wallets/accounts below zero

  // Household readiness
  expiringDocs: number;           // documents expiring/expired within 30 days
  overdueMaintenance: number;     // home maintenance tasks past due
  lowInventory: number;           // grocery/pantry staples at/below threshold

  // Communication responsiveness
  pendingApprovals: number;       // trust approvals awaiting a decision
  openVotes: number;              // family votes still open
  unreadThreads: number;          // message threads with unread activity

  // Routine completion (recent window, e.g. last 7 days)
  choresAssignedRecently: number;
  choresCompletedRecently: number;
  overdueTasks: number;

  // Goal progress
  activeGoals: number;
  goalsOnTrack: number;

  // Overload detection
  memberLoads: MemberLoad[];
}

export interface DimensionScore {
  id: DimensionId;
  label: string;
  score: number;      // 0–100
  summary: string;    // one honest human sentence
}

export interface OperatingSuggestion {
  id: string;
  dimension: DimensionId;
  title: string;
  detail: string;
  href: string;
  impact: 'high' | 'medium' | 'low';
}

export interface OperatingIndex {
  composite: number;  // 0–100 weighted
  band: Band;
  dimensions: DimensionScore[];
  suggestions: OperatingSuggestion[];
  /** Most-loaded member this week, or null when the load is even/empty. */
  overloaded: MemberLoad | null;
  generatedAt: string;
}

export const DIMENSION_LABELS: Record<DimensionId, string> = {
  planning: 'Planning confidence',
  stability: 'Schedule stability',
  financial: 'Financial preparedness',
  readiness: 'Household readiness',
  communication: 'Communication',
  routine: 'Routine completion',
  goals: 'Goal progress',
};

// Weights sum to 1. Planning + routine are the day-to-day load-bearers, so they
// carry the most weight; goals move slowly and carry the least.
const WEIGHTS: Record<DimensionId, number> = {
  planning: 0.22,
  routine: 0.20,
  stability: 0.16,
  financial: 0.14,
  readiness: 0.12,
  communication: 0.10,
  goals: 0.06,
};

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** Ratio of "good" to total, as 0–100; empty → `emptyScore` (calm, not failing). */
function ratioScore(good: number, total: number, emptyScore = 100): number {
  if (total <= 0) return emptyScore;
  return clamp((good / total) * 100);
}

/** Start from 100 and subtract `per` for each problem, floored. */
function penalize(problems: number, per: number, floor = 0): number {
  return clamp(Math.max(floor, 100 - problems * per));
}

function scorePlanning(s: HouseholdSnapshot): DimensionScore {
  // Owned upcoming events drive it; missing info + overdue reminders subtract.
  const owned = ratioScore(s.upcomingEventsOwned, s.upcomingEvents, 100);
  const penalties = s.eventsMissingInfo * 6 + s.overdueReminders * 8;
  const score = clamp(owned - penalties);
  const summary = s.upcomingEvents === 0
    ? 'Nothing scheduled in the next week — a clear runway.'
    : `${s.upcomingEventsOwned}/${s.upcomingEvents} upcoming events have an owner`
      + (s.overdueReminders ? `, ${s.overdueReminders} reminder${s.overdueReminders > 1 ? 's' : ''} overdue.` : '.');
  return { id: 'planning', label: DIMENSION_LABELS.planning, score, summary };
}

function scoreStability(s: HouseholdSnapshot): DimensionScore {
  const score = penalize(s.conflicts, 22);
  const summary = s.conflicts === 0
    ? 'No double-bookings on the calendar.'
    : `${s.conflicts} schedule conflict${s.conflicts > 1 ? 's' : ''} to resolve.`;
  return { id: 'stability', label: DIMENSION_LABELS.stability, score, summary };
}

function scoreFinancial(s: HouseholdSnapshot): DimensionScore {
  const covered = ratioScore(s.billsCovered, s.billsDueSoon, 100);
  const penalties = s.overspentBudgets * 12 + s.negativeBalances * 25;
  const score = clamp(covered - penalties);
  const parts: string[] = [];
  if (s.billsDueSoon > 0) parts.push(`${s.billsCovered}/${s.billsDueSoon} upcoming bills covered`);
  if (s.overspentBudgets > 0) parts.push(`${s.overspentBudgets} budget${s.overspentBudgets > 1 ? 's' : ''} over cap`);
  if (s.negativeBalances > 0) parts.push(`${s.negativeBalances} account${s.negativeBalances > 1 ? 's' : ''} below zero`);
  const summary = parts.length ? parts.join(' · ') + '.' : 'No bills or budget flags right now.';
  return { id: 'financial', label: DIMENSION_LABELS.financial, score, summary };
}

function scoreReadiness(s: HouseholdSnapshot): DimensionScore {
  const problems = s.expiringDocs + s.overdueMaintenance + s.lowInventory;
  const score = penalize(problems, 9);
  const summary = problems === 0
    ? 'Documents, home upkeep and staples all in good shape.'
    : `${s.expiringDocs} doc${s.expiringDocs === 1 ? '' : 's'} expiring · ${s.overdueMaintenance} upkeep task${s.overdueMaintenance === 1 ? '' : 's'} due · ${s.lowInventory} staple${s.lowInventory === 1 ? '' : 's'} low.`;
  return { id: 'readiness', label: DIMENSION_LABELS.readiness, score, summary };
}

function scoreCommunication(s: HouseholdSnapshot): DimensionScore {
  const problems = s.pendingApprovals + s.openVotes + s.unreadThreads;
  const score = penalize(problems, 10);
  const summary = problems === 0
    ? 'Nothing waiting on a family decision or reply.'
    : `${s.pendingApprovals} approval${s.pendingApprovals === 1 ? '' : 's'} · ${s.openVotes} open vote${s.openVotes === 1 ? '' : 's'} · ${s.unreadThreads} unread thread${s.unreadThreads === 1 ? '' : 's'}.`;
  return { id: 'communication', label: DIMENSION_LABELS.communication, score, summary };
}

function scoreRoutine(s: HouseholdSnapshot): DimensionScore {
  const done = ratioScore(s.choresCompletedRecently, s.choresAssignedRecently, 100);
  const score = clamp(done - s.overdueTasks * 7);
  const summary = s.choresAssignedRecently === 0 && s.overdueTasks === 0
    ? 'No chores or tasks outstanding.'
    : `${s.choresCompletedRecently}/${s.choresAssignedRecently} recent chores done`
      + (s.overdueTasks ? `, ${s.overdueTasks} task${s.overdueTasks > 1 ? 's' : ''} overdue.` : '.');
  return { id: 'routine', label: DIMENSION_LABELS.routine, score, summary };
}

function scoreGoals(s: HouseholdSnapshot): DimensionScore {
  const score = ratioScore(s.goalsOnTrack, s.activeGoals, 100);
  const summary = s.activeGoals === 0
    ? 'No active goals — add one when you are ready.'
    : `${s.goalsOnTrack}/${s.activeGoals} goals on track.`;
  return { id: 'goals', label: DIMENSION_LABELS.goals, score, summary };
}

export function bandFor(composite: number): Band {
  if (composite >= 85) return 'thriving';
  if (composite >= 70) return 'steady';
  if (composite >= 50) return 'stretched';
  return 'overloaded';
}

/** The most-loaded member, if meaningfully ahead of the pack. */
export function mostLoaded(loads: MemberLoad[]): MemberLoad | null {
  if (loads.length < 2) return null;
  const scored = loads
    .map((m) => ({ m, load: m.upcoming + m.openTasks }))
    .sort((a, b) => b.load - a.load);
  const top = scored[0];
  const rest = scored.slice(1);
  const avgRest = rest.reduce((sum, x) => sum + x.load, 0) / rest.length;
  // "Overloaded" = a real amount of work AND clearly above the family average.
  if (top.load >= 5 && top.load >= avgRest * 1.6) return top.m;
  return null;
}

function buildSuggestions(s: HouseholdSnapshot, dims: DimensionScore[], overloaded: MemberLoad | null): OperatingSuggestion[] {
  const out: OperatingSuggestion[] = [];
  const scoreOf = (id: DimensionId) => dims.find((d) => d.id === id)!.score;

  if (s.conflicts > 0) out.push({
    id: 'resolve-conflicts', dimension: 'stability', impact: 'high',
    title: `Resolve ${s.conflicts} schedule conflict${s.conflicts > 1 ? 's' : ''}`,
    detail: 'Two things are booked at once — decide what moves before the day arrives.',
    href: '/dashboard/conflicts',
  });
  if (s.overdueReminders > 0) out.push({
    id: 'clear-overdue-reminders', dimension: 'planning', impact: 'high',
    title: `Clear ${s.overdueReminders} overdue reminder${s.overdueReminders > 1 ? 's' : ''}`,
    detail: 'These slipped past their time — close them out or reschedule.',
    href: '/dashboard/notifications',
  });
  if (s.negativeBalances > 0) out.push({
    id: 'fix-negative-balances', dimension: 'financial', impact: 'high',
    title: `${s.negativeBalances} account${s.negativeBalances > 1 ? 's are' : ' is'} below zero`,
    detail: 'Top up or move funds before an autopay bounces.',
    href: '/wallet',
  });
  if (s.billsDueSoon > s.billsCovered) out.push({
    id: 'cover-bills', dimension: 'financial', impact: 'medium',
    title: `${s.billsDueSoon - s.billsCovered} upcoming bill${s.billsDueSoon - s.billsCovered > 1 ? 's' : ''} not covered`,
    detail: 'Turn on autopay or fund them so nothing is late.',
    href: '/dashboard/bills',
  });
  if (s.upcomingEvents - s.upcomingEventsOwned > 0) out.push({
    id: 'assign-events', dimension: 'planning', impact: 'medium',
    title: `${s.upcomingEvents - s.upcomingEventsOwned} event${s.upcomingEvents - s.upcomingEventsOwned > 1 ? 's need' : ' needs'} an owner`,
    detail: 'Assign who is responsible so nothing falls through.',
    href: '/dashboard/calendar',
  });
  if (s.expiringDocs > 0) out.push({
    id: 'renew-docs', dimension: 'readiness', impact: 'medium',
    title: `${s.expiringDocs} document${s.expiringDocs > 1 ? 's' : ''} expiring soon`,
    detail: 'Renew before they lapse to avoid a scramble.',
    href: '/dashboard/documents',
  });
  if (s.pendingApprovals > 0) out.push({
    id: 'decide-approvals', dimension: 'communication', impact: 'medium',
    title: `${s.pendingApprovals} approval${s.pendingApprovals > 1 ? 's' : ''} waiting on you`,
    detail: 'A family member is blocked until you decide.',
    href: '/dashboard/trust',
  });
  if (s.overdueTasks > 0) out.push({
    id: 'clear-overdue-tasks', dimension: 'routine', impact: 'medium',
    title: `${s.overdueTasks} task${s.overdueTasks > 1 ? 's are' : ' is'} overdue`,
    detail: 'Knock these out or push them to a realistic day.',
    href: '/dashboard/chores',
  });
  if (s.lowInventory > 0) out.push({
    id: 'restock', dimension: 'readiness', impact: 'low',
    title: `${s.lowInventory} staple${s.lowInventory > 1 ? 's are' : ' is'} running low`,
    detail: 'Add them to the grocery run so you do not run out.',
    href: '/dashboard/grocery',
  });
  if (s.openVotes > 0) out.push({
    id: 'close-votes', dimension: 'communication', impact: 'low',
    title: `${s.openVotes} family vote${s.openVotes > 1 ? 's' : ''} still open`,
    detail: 'Nudge everyone to weigh in so a decision can land.',
    href: '/dashboard/voting',
  });
  if (overloaded) out.push({
    id: 'rebalance-load', dimension: 'routine', impact: 'medium',
    title: `${overloaded.name} is carrying the most this week`,
    detail: `${overloaded.upcoming} event${overloaded.upcoming === 1 ? '' : 's'} and ${overloaded.openTasks} open task${overloaded.openTasks === 1 ? '' : 's'} — consider rebalancing.`,
    href: '/dashboard/family',
  });
  if (s.activeGoals > s.goalsOnTrack && s.activeGoals > 0) out.push({
    id: 'nudge-goals', dimension: 'goals', impact: 'low',
    title: `${s.activeGoals - s.goalsOnTrack} goal${s.activeGoals - s.goalsOnTrack > 1 ? 's are' : ' is'} behind`,
    detail: 'A small contribution or step gets them moving again.',
    href: '/dashboard/goals',
  });

  // Rank: high-impact first, then by how weak the dimension is (weakest first).
  const impactRank = { high: 0, medium: 1, low: 2 } as const;
  out.sort((a, b) =>
    impactRank[a.impact] - impactRank[b.impact] ||
    scoreOf(a.dimension) - scoreOf(b.dimension));
  return out;
}

/**
 * Compute the Family Operating Index from a normalized snapshot. Pure and
 * deterministic given the snapshot + `now`.
 */
export function computeOperatingIndex(s: HouseholdSnapshot, now: Date = new Date()): OperatingIndex {
  const dimensions: DimensionScore[] = [
    scorePlanning(s),
    scoreRoutine(s),
    scoreStability(s),
    scoreFinancial(s),
    scoreReadiness(s),
    scoreCommunication(s),
    scoreGoals(s),
  ];
  const composite = clamp(
    dimensions.reduce((sum, d) => sum + d.score * WEIGHTS[d.id], 0),
  );
  const band = bandFor(composite);
  const overloaded = mostLoaded(s.memberLoads);
  const suggestions = buildSuggestions(s, dimensions, overloaded);
  return { composite, band, dimensions, suggestions, overloaded, generatedAt: now.toISOString() };
}

/** Serialize dimensions to the {key: score} jsonb shape the snapshot table stores. */
export function dimensionsToRecord(dims: DimensionScore[]): Record<string, number> {
  return Object.fromEntries(dims.map((d) => [d.id, d.score]));
}

/** Trend delta between two composites, or null when there's no prior. */
export function compositeTrend(current: number, prior: number | null | undefined): number | null {
  if (prior == null) return null;
  return current - prior;
}
