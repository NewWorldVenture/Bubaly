// lib/intelligence/hard-signals.ts — the "hard signal" family-intelligence engines
// (R10). These mine the harder-to-copy behavioral patterns the strategy calls out —
// not "your favorite dinner" but "which reminders keep getting ignored, when the
// family is most stressed, which chores create friction, which routines don't
// stick." Pure + deterministic: the server maps real DB rows to these simple
// shapes and this decides what's a signal. DOM-free + fully unit-tested. Output is
// transparent + editable — each signal carries its evidence and is acknowledged /
// dismissed by the family (family_signals table).

import { periodWindowStart, type BudgetRow, type ExpenseRow } from '@/lib/operating-index/inputs';

export type SignalKind = 'ignored_reminder' | 'stress_window' | 'chore_conflict' | 'routine_adherence' | 'budget_drift';

export interface FamilySignal {
  kind: SignalKind;
  subjectKey: string;                     // stable id → idempotent upsert
  title: string;
  detail: string;
  score: number;                          // 0..100 severity/confidence
  evidence: Record<string, unknown>;
  memberId: string | null;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

// ── 1. Ignored reminders ─────────────────────────────────────────────────────
export interface ReminderRow {
  id: string; title: string; remindAt: string | null; status: string;
  completedAt: string | null; memberId: string | null;
}

/** Strip a trailing "#123"/serial + collapse whitespace so repeats group together. */
function normalizeTitle(title: string): string {
  return (title ?? '').toLowerCase().replace(/#?\d+\s*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * A reminder is "ignored" when its time has passed and it was never completed
 * (still active, or dismissed without doing it). When the SAME reminder keeps
 * getting ignored, that's a signal worth surfacing.
 */
export function detectIgnoredReminders(rows: ReminderRow[], now: Date): FamilySignal[] {
  const nowMs = now.getTime();
  const ignored = (rows ?? []).filter((r) =>
    r.remindAt && Number.isFinite(Date.parse(r.remindAt)) && Date.parse(r.remindAt) < nowMs
    && r.status !== 'done' && !r.completedAt);

  const groups = new Map<string, { display: string; count: number; lastAt: number; members: Set<string> }>();
  for (const r of ignored) {
    const key = normalizeTitle(r.title);
    if (!key) continue;
    const g = groups.get(key) ?? { display: r.title.replace(/#?\d+\s*$/, '').trim() || r.title, count: 0, lastAt: 0, members: new Set<string>() };
    g.count += 1;
    g.lastAt = Math.max(g.lastAt, Date.parse(r.remindAt as string));
    if (r.memberId) g.members.add(r.memberId);
    groups.set(key, g);
  }

  const out: FamilySignal[] = [];
  for (const [key, g] of groups) {
    if (g.count < 3) continue;                          // needs a real pattern
    out.push({
      kind: 'ignored_reminder',
      subjectKey: `ignored_reminder:${key}`,
      title: `“${g.display}” keeps getting missed`,
      detail: `It’s gone overdue ${g.count} times without being done — maybe it needs a different time, owner, or to be automated.`,
      score: clamp(40 + g.count * 10),
      evidence: { count: g.count, lastAt: new Date(g.lastAt).toISOString() },
      memberId: g.members.size === 1 ? [...g.members][0] : null,
    });
  }
  return out;
}

// ── 2. Stress windows ────────────────────────────────────────────────────────
export interface TimedRow { at: string }

function bucketOf(iso: string): { dayType: 'weekday' | 'weekend'; part: 'morning' | 'afternoon' | 'evening' } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();
  return {
    dayType: dow === 0 || dow === 6 ? 'weekend' : 'weekday',
    part: h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening',
  };
}

const PART_LABEL = { morning: 'mornings', afternoon: 'afternoons', evening: 'evenings' };
const DAY_LABEL = { weekday: 'Weekday', weekend: 'Weekend' };

/**
 * When is the family most stretched? Bucket events, schedule clashes and overdue
 * items by day-type × part-of-day; the highest-pressure bucket (clashes weigh
 * most, then overdue, then raw density) is the stress window.
 */
export function detectStressWindows(events: TimedRow[], conflicts: TimedRow[], overdue: TimedRow[], _now: Date): FamilySignal[] {
  const acc = new Map<string, { ev: number; cf: number; od: number; dayType: string; part: string }>();
  const add = (rows: TimedRow[], field: 'ev' | 'cf' | 'od') => {
    for (const r of rows ?? []) {
      const b = bucketOf(r.at);
      if (!b) continue;
      const key = `${b.dayType}:${b.part}`;
      const cur = acc.get(key) ?? { ev: 0, cf: 0, od: 0, dayType: b.dayType, part: b.part };
      cur[field] += 1;
      acc.set(key, cur);
    }
  };
  add(events, 'ev'); add(conflicts, 'cf'); add(overdue, 'od');

  let best: { key: string; score: number; b: { ev: number; cf: number; od: number; dayType: string; part: string } } | null = null;
  for (const [key, b] of acc) {
    const raw = b.ev * 4 + b.cf * 12 + b.od * 6;
    if (!best || raw > best.score) best = { key, score: raw, b };
  }
  if (!best || best.score < 20) return [];             // not enough pressure to flag
  const { b } = best;
  return [{
    kind: 'stress_window',
    subjectKey: `stress_window:${best.key}`,
    title: `${DAY_LABEL[b.dayType as 'weekday' | 'weekend']} ${PART_LABEL[b.part as 'morning' | 'afternoon' | 'evening']} are your crunch time`,
    detail: `${b.ev} event${b.ev === 1 ? '' : 's'}${b.cf > 0 ? `, ${b.cf} clash${b.cf === 1 ? '' : 'es'}` : ''}${b.od > 0 ? `, ${b.od} overdue` : ''} pile up then. Protect that window or shift something.`,
    score: clamp(Math.min(100, best.score)),
    evidence: { events: b.ev, conflicts: b.cf, overdue: b.od },
    memberId: null,
  }];
}

// ── 3. Chore friction ────────────────────────────────────────────────────────
export interface ChoreRow {
  choreId: string; choreTitle: string; status: string; disputed: boolean; memberId: string | null;
}

/**
 * Which chores create conflict? A chore that gets rejected, disputed, or passed
 * between several people is a friction point — worth rethinking (rotate it,
 * re-price it, or drop it).
 */
export function detectChoreConflicts(rows: ChoreRow[]): FamilySignal[] {
  const groups = new Map<string, { title: string; rejected: number; disputed: number; members: Set<string>; total: number }>();
  for (const r of rows ?? []) {
    if (!r.choreId) continue;
    const g = groups.get(r.choreId) ?? { title: r.choreTitle || 'A chore', rejected: 0, disputed: 0, members: new Set<string>(), total: 0 };
    g.total += 1;
    if (r.status === 'rejected') g.rejected += 1;
    if (r.disputed) g.disputed += 1;
    if (r.memberId) g.members.add(r.memberId);
    groups.set(r.choreId, g);
  }

  const out: FamilySignal[] = [];
  for (const [choreId, g] of groups) {
    const friction = g.rejected * 2 + g.disputed * 3 + Math.max(0, g.members.size - 1);
    if (friction < 3) continue;
    out.push({
      kind: 'chore_conflict',
      subjectKey: `chore_conflict:${choreId}`,
      title: `“${g.title}” causes friction`,
      detail: `${g.rejected} rejected · ${g.disputed} disputed · passed between ${g.members.size} ${g.members.size === 1 ? 'person' : 'people'}. Rotate it or rethink it.`,
      score: clamp(30 + friction * 10),
      evidence: { rejected: g.rejected, disputed: g.disputed, members: g.members.size, total: g.total },
      memberId: null,
    });
  }
  return out;
}

// ── 4. Routine adherence ─────────────────────────────────────────────────────
export interface RoutineRow { id: string; name: string; weekdayMask: number }
export interface RoutineCompletion { routineId: string; occurredAt: string }

function countBits(mask: number): number {
  let n = 0, m = mask & 0x7f;
  while (m) { n += m & 1; m >>= 1; }
  return n;
}

/**
 * Which routines actually stick? Compare each routine's expected occurrences
 * (its weekdays over the recent window) against how often it actually happened.
 * Low adherence is a signal: the routine as designed isn't working.
 */
export function detectRoutineAdherence(routines: RoutineRow[], completions: RoutineCompletion[], _now: Date, weeks = 4): FamilySignal[] {
  const doneByRoutine = new Map<string, number>();
  for (const c of completions ?? []) doneByRoutine.set(c.routineId, (doneByRoutine.get(c.routineId) ?? 0) + 1);

  const out: FamilySignal[] = [];
  for (const r of routines ?? []) {
    const perWeek = countBits(r.weekdayMask);
    const expected = perWeek * weeks;
    if (expected < 4) continue;                          // too infrequent to judge
    const actual = doneByRoutine.get(r.id) ?? 0;
    const adherence = Math.min(1, actual / expected);
    if (adherence >= 0.6) continue;                      // sticking well enough
    out.push({
      kind: 'routine_adherence',
      subjectKey: `routine_adherence:${r.id}`,
      title: `“${r.name}” only sticks ${Math.round(adherence * 100)}% of the time`,
      detail: `Done ${actual} of ~${expected} expected times in the last ${weeks} weeks. Simplify it, move it, or drop a day.`,
      score: clamp(Math.round((1 - adherence) * 100)),
      evidence: { actual, expected, adherencePct: Math.round(adherence * 100) },
      memberId: null,
    });
  }
  return out;
}

// ── 5. Budget drift (recurring overspend) ────────────────────────────────────
const norm = (c: string | null | undefined) => (c ?? '').trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;
function money(n: number): string {
  const v = round2(Math.max(0, n));
  return v % 1 === 0 ? `$${v.toLocaleString('en-US')}` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A budget "drifts" when a category is over its cap for the CURRENT period —
 * and it's a harder signal (not just a number in the operating index) when the
 * PRIOR period was over too, i.e. the overspend is a pattern, not a one-off.
 * Complements FOI's overspent-budget count with a transparent, dismissable,
 * evidence-carrying signal the family can act on. Pure + deterministic.
 */
export function detectBudgetDrift(budgets: BudgetRow[], expenses: ExpenseRow[], now: Date): FamilySignal[] {
  const out: FamilySignal[] = [];
  for (const b of budgets) {
    if (!b.amount || b.amount <= 0) continue;
    const cat = norm(b.category);
    if (!cat) continue;

    const curStart = periodWindowStart(b.period, now);
    const prevStart = periodWindowStart(b.period, new Date(Date.parse(curStart) - 86_400_000));

    let spentNow = 0;
    let spentPrev = 0;
    for (const e of expenses) {
      if (norm(e.category) !== cat) continue;
      const amt = Number(e.amount) || 0;
      if (e.date >= curStart) spentNow += amt;
      else if (e.date >= prevStart) spentPrev += amt;
    }

    if (spentNow <= b.amount) continue; // only flag when currently over cap
    const overBy = spentNow - b.amount;
    const recurring = spentPrev > b.amount; // over last period too → real drift
    let score = clamp(45 + (overBy / b.amount) * 120);
    if (recurring) score = clamp(score + 25);

    out.push({
      kind: 'budget_drift',
      subjectKey: `budget:${cat}`,
      title: `Over budget on ${b.category}`,
      detail: recurring
        ? `Spent ${money(spentNow)} of your ${money(b.amount)} ${b.period} ${b.category} budget — over two ${b.period} periods running.`
        : `Spent ${money(spentNow)} of your ${money(b.amount)} ${b.period} ${b.category} budget this period.`,
      score,
      evidence: {
        category: b.category, period: b.period, limit: round2(b.amount),
        spent: round2(spentNow), priorSpent: round2(spentPrev), overBy: round2(overBy), recurring,
      },
      memberId: null,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── Unifier ──────────────────────────────────────────────────────────────────
export interface HardSignalInputs {
  reminders: ReminderRow[];
  events: TimedRow[];
  conflicts: TimedRow[];
  overdue: TimedRow[];
  chores: ChoreRow[];
  routines: RoutineRow[];
  routineCompletions: RoutineCompletion[];
  budgets?: BudgetRow[];
  expenses?: ExpenseRow[];
}

/** Run every detector and return the signals ranked by severity (highest first). */
export function buildHardSignals(inp: HardSignalInputs, now: Date): FamilySignal[] {
  return [
    ...detectIgnoredReminders(inp.reminders ?? [], now),
    ...detectStressWindows(inp.events ?? [], inp.conflicts ?? [], inp.overdue ?? [], now),
    ...detectChoreConflicts(inp.chores ?? []),
    ...detectRoutineAdherence(inp.routines ?? [], inp.routineCompletions ?? [], now),
    ...detectBudgetDrift(inp.budgets ?? [], inp.expenses ?? [], now),
  ].sort((a, b) => b.score - a.score);
}
