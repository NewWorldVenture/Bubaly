// lib/finance/timeline.ts — the Financial Copilot brain (pure, tested).
//
// Fuses SCHEDULE (bills' due dates, recurring cadence, savings-goal target
// dates, calendar events, plan-linked commitments) with MONEY (amounts +
// current balances) into one forward-looking, week-bucketed cash-flow
// timeline, then reasons over it: projected running balance, "heavy weeks",
// goals at risk, coverage (which bills leave on their own), an injected
// what-if scenario, and ranked, plain-language insights with next-best
// actions. No Supabase / React — the page fetches rows and calls
// buildCashflowTimeline(); everything here is unit-tested.
//
// Amounts are DOLLARS (numeric), matching the finance tables (see hub.ts).

export interface TimelineBill {
  name: string;
  amount: number;
  due_date: string;              // ISO date or datetime
  is_recurring: boolean;
  recurrence: string | null;     // 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null
  status: string;                // 'paid' excluded from the forecast
  category: string | null;
  /** The money leaves on its own — the bill is covered, nothing to do. */
  autopay?: boolean;
}

export interface TimelineGoal {
  name: string;
  target_amount: number;
  current_amount: number;
  target_date: string | null;
}

export interface TimelineEvent {
  title: string;
  starts_at: string;
}

/** Where a plan-linked commitment comes from (the module that owns the plan). */
export type PlanSource = 'subscription' | 'vacation' | 'move' | 'project';

/**
 * A commitment the family has already made somewhere else in Bubaly — a
 * tracked subscription, a trip's remaining budget, a move's budget minus what
 * is spent, an open home project — that the forecast would otherwise miss.
 * One-offs land on `date`; a `recurrence` expands like a recurring bill.
 */
export interface TimelinePlan {
  label: string;
  amount: number;                // dollars still to find
  date: string;                  // ISO date — when the money is needed
  source: PlanSource;
  recurrence?: string | null;
  category?: string | null;
}

/** The cadences the "Can we afford it?" form offers; 'once' is a one-off. */
export const SCENARIO_RECURRENCES = ['once', 'weekly', 'monthly', 'yearly'] as const;
export type ScenarioRecurrence = (typeof SCENARIO_RECURRENCES)[number];

/** "Can we afford it?" — a one-off or recurring commitment tried against the forecast. */
export interface TimelineScenario {
  label: string;
  amount: number;
  date: string;
  recurrence?: string | null;    // null/undefined = one-off
}

export type MomentKind = 'bill' | 'recurring' | 'goal' | 'plan' | 'scenario';

export interface MoneyMoment {
  date: string;                  // YYYY-MM-DD
  label: string;
  amount: number;
  kind: MomentKind;
  category: string | null;
  /** Plan-linked moments say which plan they come from. */
  source?: PlanSource;
  /** True when the money leaves on its own (autopay) — covered, nothing to do. */
  covered?: boolean;
}

export interface WeekBucket {
  weekStart: string;             // Monday, YYYY-MM-DD
  outflow: number;
  moments: MoneyMoment[];
  events: string[];              // overlaid calendar event titles that week
  projectedBalance: number;      // running balance at the END of this week
  heavy: boolean;
}

/**
 * Which of the horizon's bills are covered. "Covered" is a bill the family
 * does not have to touch: it leaves by autopay, or it is already marked paid.
 * Everything else is "open" — someone still has to pay it by hand.
 */
export interface CoverageSummary {
  coveredCount: number;          // autopay occurrences inside the horizon
  coveredAmount: number;
  paidCount: number;             // bills marked paid whose due date is inside the horizon
  paidAmount: number;
  openCount: number;
  openAmount: number;
}

export type InsightKind =
  | 'low_balance' | 'heavy_week' | 'goal_at_risk'
  | 'recurring_creep' | 'set_aside' | 'all_clear';

export type InsightSeverity = 'info' | 'watch' | 'urgent';

export interface TimelineInsight {
  kind: InsightKind;
  title: string;
  detail: string;
  severity: InsightSeverity;
  weekStart: string | null;
  amount: number | null;
}

export interface CashflowTimeline {
  weeks: WeekBucket[];
  startingBalance: number;
  totalOutflow: number;
  monthlyRecurring: number;
  heaviestWeek: WeekBucket | null;
  lowestBalance: number;
  lowestBalanceWeek: string | null;
  insights: TimelineInsight[];
  /** Dollars inside the horizon that come from plan-linked commitments. */
  planOutflow: number;
  /** Dollars inside the horizon that the injected scenario adds (0 without one). */
  scenarioOutflow: number;
  coverage: CoverageSummary;
}

const DAY = 86_400_000;

/** The low-balance alarm line when the caller does not set one. */
export const DEFAULT_BUFFER = 200;

// ── Date helpers (UTC-stable so tests are deterministic) ─────────────────────
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseDate(iso: string): Date {
  // Accept both 'YYYY-MM-DD' and full datetimes; anchor bare dates at UTC midnight.
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
}

/** Monday (UTC) of the ISO week containing `d`, as YYYY-MM-DD. */
export function isoWeekStart(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dow);
  return ymd(t);
}

function addMonthsUTC(d: Date, n: number): Date {
  const t = new Date(d.getTime());
  const targetMonth = t.getUTCMonth() + n;
  t.setUTCMonth(targetMonth);
  return t;
}

const RECURRENCE_STEP_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, fortnightly: 14 };

/** The dates a (possibly recurring) commitment lands on inside [now, horizonEnd]. */
function expandDates(first: Date, recurrence: string | null | undefined, now: Date, horizonEnd: Date): string[] {
  const out: string[] = [];

  if (!recurrence) {
    if (first >= startOfDay(now) && first <= horizonEnd) out.push(ymd(first));
    return out;
  }

  const rec = recurrence.toLowerCase();
  const monthly = rec === 'monthly';
  const quarterly = rec === 'quarterly';
  const yearly = rec === 'yearly' || rec === 'annually';
  const stepDays = RECURRENCE_STEP_DAYS[rec];

  // Walk from the stored date forward until we pass the horizon, emitting
  // any occurrence that lands inside [today, horizonEnd].
  let cursor = new Date(first.getTime());

  // A long-stale start date (a subscription entered years ago, a bill whose
  // first due date predates the account) would otherwise be eaten by the walk
  // guard below before the cursor ever reached today — the commitment would
  // silently vanish from the forecast. Jump straight to the last occurrence
  // on or before today, then walk normally.
  const from = startOfDay(now);
  if (cursor < from) {
    if (stepDays) {
      const steps = Math.floor((from.getTime() - cursor.getTime()) / (stepDays * DAY));
      if (steps > 0) cursor = new Date(cursor.getTime() + steps * stepDays * DAY);
    } else if (monthly || quarterly || yearly) {
      const per = monthly ? 1 : quarterly ? 3 : 12;
      const months = (from.getUTCFullYear() - cursor.getUTCFullYear()) * 12 + (from.getUTCMonth() - cursor.getUTCMonth());
      const steps = Math.floor(months / per);
      if (steps > 0) cursor = addMonthsUTC(cursor, steps * per);
    }
  }

  let guard = 0;
  while (cursor <= horizonEnd && guard++ < 400) {
    if (cursor >= startOfDay(now)) out.push(ymd(cursor));
    if (monthly) cursor = addMonthsUTC(cursor, 1);
    else if (quarterly) cursor = addMonthsUTC(cursor, 3);
    else if (yearly) cursor = addMonthsUTC(cursor, 12);
    else if (stepDays) cursor = new Date(cursor.getTime() + stepDays * DAY);
    else break; // unknown cadence → treat as single
  }
  return out;
}

/** Expand a recurring bill's occurrences within [now, horizonEnd]. */
function expandOccurrences(bill: TimelineBill, now: Date, horizonEnd: Date): string[] {
  return expandDates(parseDate(bill.due_date), bill.is_recurring ? bill.recurrence : null, now, horizonEnd);
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Approx monthly cost of a recurring bill (0 for one-offs). */
export function monthlyEquivalent(bill: TimelineBill): number {
  if (!bill.is_recurring || !bill.recurrence) return 0;
  return monthlyEquivalentOf(bill.amount, bill.recurrence);
}

function monthlyEquivalentOf(amount: number, recurrence: string): number {
  const rec = recurrence.toLowerCase();
  if (rec === 'weekly') return amount * 52 / 12;
  if (rec === 'biweekly' || rec === 'fortnightly') return amount * 26 / 12;
  if (rec === 'monthly') return amount;
  if (rec === 'quarterly') return amount / 3;
  if (rec === 'yearly' || rec === 'annually') return amount / 12;
  return 0;
}

/** Case/whitespace-insensitive name so "Netflix " and "netflix" dedupe. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface BuildTimelineInput {
  bills: TimelineBill[];
  goals: TimelineGoal[];
  events: TimelineEvent[];
  startingBalance: number;
  /** Plan-linked commitments (subscriptions, trips, moves, projects). Optional so older callers keep working. */
  plans?: TimelinePlan[];
  /** A what-if commitment to try against the forecast. */
  scenario?: TimelineScenario | null;
  horizonWeeks?: number;         // default 12
  buffer?: number;               // low-balance alarm threshold (default 200)
  now?: Date;
}

/**
 * Build the forward cash-flow timeline + insights. Deterministic given `now`.
 */
export function buildCashflowTimeline(input: BuildTimelineInput): CashflowTimeline {
  const now = input.now ?? new Date();
  const horizonWeeks = input.horizonWeeks ?? 12;
  const buffer = input.buffer ?? DEFAULT_BUFFER;
  const startingBalance = round2(input.startingBalance);
  const today = startOfDay(now);

  const firstWeek = isoWeekStart(now);
  // The LAST day the horizon covers — the final week's Sunday, not the Monday
  // after it. An exclusive end emits a moment for a day with no bucket to land
  // in: push() drops it from the weeks and from totalOutflow, while coverage,
  // planOutflow and scenarioOutflow would still count the money.
  const horizonEnd = new Date(parseDate(firstWeek).getTime() + (horizonWeeks * 7 - 1) * DAY);

  // Seed empty week buckets so the timeline is contiguous.
  const buckets = new Map<string, WeekBucket>();
  const weekOrder: string[] = [];
  for (let i = 0; i < horizonWeeks; i++) {
    const ws = ymd(new Date(parseDate(firstWeek).getTime() + i * 7 * DAY));
    buckets.set(ws, { weekStart: ws, outflow: 0, moments: [], events: [], projectedBalance: 0, heavy: false });
    weekOrder.push(ws);
  }

  /** Land a moment in its week. False when the week is outside the horizon —
   *  the caller must not count money the timeline does not carry. */
  const push = (m: MoneyMoment): boolean => {
    const ws = isoWeekStart(parseDate(m.date));
    const b = buckets.get(ws);
    if (!b) return false;
    b.moments.push(m);
    b.outflow = round2(b.outflow + m.amount);
    return true;
  };

  // 1) Bills (recurring expanded across the horizon; paid ones skipped) and
  //    coverage: an autopay occurrence is covered, a paid bill was covered, and
  //    the rest is what someone still has to pay by hand.
  let monthlyRecurring = 0;
  const coverage: CoverageSummary = { coveredCount: 0, coveredAmount: 0, paidCount: 0, paidAmount: 0, openCount: 0, openAmount: 0 };
  const recurringBillNames = new Set<string>();
  for (const bill of input.bills) {
    const amount = round2(bill.amount);
    if (bill.status === 'paid') {
      // Paid means the money already left, so it never hits the projection —
      // but a bill paid ahead of its date is still a covered bill of this horizon.
      const due = parseDate(bill.due_date);
      if (due >= today && due <= horizonEnd) { coverage.paidCount += 1; coverage.paidAmount = round2(coverage.paidAmount + amount); }
      continue;
    }
    if (bill.is_recurring && bill.recurrence) recurringBillNames.add(normalizeName(bill.name));
    monthlyRecurring += monthlyEquivalent(bill);
    const covered = bill.autopay === true;
    for (const date of expandOccurrences(bill, now, horizonEnd)) {
      const landed = push({ date, label: bill.name, amount, kind: bill.is_recurring ? 'recurring' : 'bill', category: bill.category, ...(covered ? { covered: true } : {}) });
      if (!landed) continue;
      if (covered) { coverage.coveredCount += 1; coverage.coveredAmount = round2(coverage.coveredAmount + amount); }
      else { coverage.openCount += 1; coverage.openAmount = round2(coverage.openAmount + amount); }
    }
  }

  // 2) Plan-linked commitments. A subscription the family also entered as a
  //    recurring bill is the same money twice, so the bill wins. A one-off
  //    commitment whose date has slipped into the past is still owed: it lands
  //    today rather than vanishing from the forecast.
  let planOutflow = 0;
  for (const p of input.plans ?? []) {
    const amount = round2(p.amount);
    if (!(amount > 0)) continue;
    if (p.source === 'subscription' && recurringBillNames.has(normalizeName(p.label))) continue;
    const first = parseDate(p.date);
    if (Number.isNaN(first.getTime())) continue;
    const anchor = !p.recurrence && first < today ? today : first;
    if (p.recurrence) monthlyRecurring += monthlyEquivalentOf(amount, p.recurrence);
    for (const date of expandDates(anchor, p.recurrence, now, horizonEnd)) {
      if (push({ date, label: p.label, amount, kind: 'plan', category: p.category ?? p.source, source: p.source })) {
        planOutflow = round2(planOutflow + amount);
      }
    }
  }
  monthlyRecurring = round2(monthlyRecurring);

  // 3) Savings goals with a target date inside the horizon → the remaining need
  //    lands as a money moment at the target date (what you must have set aside).
  const goalRisks: { name: string; remaining: number; weeksLeft: number; perWeek: number; date: string }[] = [];
  for (const g of input.goals) {
    const remaining = Math.max(0, round2((g.target_amount ?? 0) - (g.current_amount ?? 0)));
    if (remaining <= 0 || !g.target_date) continue;
    const target = parseDate(g.target_date);
    if (target < today || target > horizonEnd) continue;
    if (!push({ date: ymd(target), label: `${g.name} goal`, amount: remaining, kind: 'goal', category: 'savings' })) continue;
    const weeksLeft = Math.max(1, Math.ceil((target.getTime() - today.getTime()) / (7 * DAY)));
    goalRisks.push({ name: g.name, remaining, weeksLeft, perWeek: round2(remaining / weeksLeft), date: ymd(target) });
  }

  // 4) The what-if scenario, if any — tried exactly like a commitment would land.
  let scenarioOutflow = 0;
  const scenario = input.scenario;
  if (scenario && scenario.amount > 0) {
    const first = parseDate(scenario.date);
    if (!Number.isNaN(first.getTime())) {
      const amount = round2(scenario.amount);
      const anchor = !scenario.recurrence && first < today ? today : first;
      if (scenario.recurrence) monthlyRecurring = round2(monthlyRecurring + monthlyEquivalentOf(amount, scenario.recurrence));
      for (const date of expandDates(anchor, scenario.recurrence, now, horizonEnd)) {
        if (push({ date, label: scenario.label, amount, kind: 'scenario', category: 'scenario' })) {
          scenarioOutflow = round2(scenarioOutflow + amount);
        }
      }
    }
  }

  // 5) Overlay calendar events onto their week (schedule ↔ money context).
  for (const e of input.events) {
    const ws = isoWeekStart(parseDate(e.starts_at));
    const b = buckets.get(ws);
    if (b && !b.events.includes(e.title)) b.events.push(e.title);
  }

  // 6) Running projected balance + heavy-week detection.
  const weeks = weekOrder.map((ws) => buckets.get(ws)!);
  const outflows = weeks.map((w) => w.outflow);
  const totalOutflow = round2(outflows.reduce((a, b) => a + b, 0));
  const nonZero = outflows.filter((o) => o > 0);
  const avgWeekly = nonZero.length ? totalOutflow / nonZero.length : 0;

  let running = startingBalance;
  let lowestBalance = startingBalance;
  let lowestBalanceWeek: string | null = null;
  for (const w of weeks) {
    running = round2(running - w.outflow);
    w.projectedBalance = running;
    // A "spike" needs a baseline to stand out against: ≥2 weeks with outflow,
    // and this week ≥1.5× the average non-zero week.
    w.heavy = w.outflow > 0 && nonZero.length >= 2 && w.outflow >= avgWeekly * 1.5;
    if (running < lowestBalance) { lowestBalance = running; lowestBalanceWeek = w.weekStart; }
    w.moments.sort((a, b) => a.date.localeCompare(b.date));
  }

  const heaviestWeek = weeks.reduce<WeekBucket | null>((max, w) => (!max || w.outflow > max.outflow ? w : max), null);

  // 7) Insights — ranked most-urgent first.
  const insights: TimelineInsight[] = [];

  if (lowestBalanceWeek && lowestBalance < buffer) {
    const negative = lowestBalance < 0;
    insights.push({
      kind: 'low_balance',
      severity: negative ? 'urgent' : 'watch',
      weekStart: lowestBalanceWeek,
      amount: round2(lowestBalance),
      title: negative ? 'Projected shortfall ahead' : 'Balance runs thin',
      detail: negative
        ? `At the current pace your balance dips to ${money(lowestBalance)} the week of ${pretty(lowestBalanceWeek)}. Move money in or shift a bill before then.`
        : `Your balance drops to ${money(lowestBalance)} the week of ${pretty(lowestBalanceWeek)} — below your ${money(buffer)} buffer. Keep a cushion or delay a non-urgent expense.`,
    });
  }

  if (heaviestWeek && heaviestWeek.outflow > 0 && heaviestWeek.heavy) {
    const withEvents = heaviestWeek.events.length
      ? ` It lands the same week as ${listPhrase(heaviestWeek.events)}.`
      : '';
    insights.push({
      kind: 'heavy_week',
      severity: 'watch',
      weekStart: heaviestWeek.weekStart,
      amount: heaviestWeek.outflow,
      title: 'A heavy money week is coming',
      detail: `${money(heaviestWeek.outflow)} is due the week of ${pretty(heaviestWeek.weekStart)} across ${heaviestWeek.moments.length} item${heaviestWeek.moments.length === 1 ? '' : 's'}.${withEvents} Spreading a set-aside now smooths it.`,
    });
  }

  for (const g of goalRisks.sort((a, b) => b.perWeek - a.perWeek).slice(0, 1)) {
    insights.push({
      kind: 'goal_at_risk',
      severity: g.perWeek > avgWeekly && avgWeekly > 0 ? 'watch' : 'info',
      weekStart: isoWeekStart(parseDate(g.date)),
      amount: g.remaining,
      title: `“${g.name}” needs ${money(g.perWeek)}/wk`,
      detail: `To hit ${g.name} by ${pretty(g.date)} you need ${money(g.remaining)} more — about ${money(g.perWeek)} a week for ${g.weeksLeft} week${g.weeksLeft === 1 ? '' : 's'}. Automating it makes the goal quietly happen.`,
    });
  }

  if (monthlyRecurring > 0) {
    insights.push({
      kind: 'recurring_creep',
      severity: 'info',
      weekStart: null,
      amount: monthlyRecurring,
      title: `${money(monthlyRecurring)}/mo in recurring bills`,
      detail: `Recurring commitments run about ${money(monthlyRecurring)} a month (${money(round2(monthlyRecurring * 12))}/yr). Review anything you no longer use to free up cash for goals.`,
    });
  }

  if (heaviestWeek && heaviestWeek.heavy && avgWeekly > 0) {
    // Smooth the spike over the weeks between now and it: (spike − average) / lead weeks.
    const leadWeeks = Math.max(1, weekIndex(weekOrder, heaviestWeek.weekStart));
    const setAside = round2(Math.max(0, heaviestWeek.outflow - avgWeekly) / leadWeeks);
    if (setAside > 0) {
      insights.push({
        kind: 'set_aside',
        severity: 'info',
        weekStart: heaviestWeek.weekStart,
        amount: setAside,
        title: `Set aside ${money(setAside)}/wk to smooth it`,
        detail: `Putting ${money(setAside)} aside each week until ${pretty(heaviestWeek.weekStart)} covers the spike without a scramble.`,
      });
    }
  }

  if (insights.length === 0) {
    insights.push({
      kind: 'all_clear',
      severity: 'info',
      weekStart: null,
      amount: null,
      title: 'You’re on smooth water',
      detail: `No heavy weeks or shortfalls in the next ${horizonWeeks} weeks. Your projected balance stays above your buffer the whole way.`,
    });
  }

  return {
    weeks,
    startingBalance,
    totalOutflow,
    monthlyRecurring,
    heaviestWeek,
    lowestBalance: round2(lowestBalance),
    lowestBalanceWeek,
    insights,
    planOutflow,
    scenarioOutflow,
    coverage,
  };
}

function weekIndex(order: string[], ws: string): number {
  const i = order.indexOf(ws);
  return i < 0 ? 1 : i + 1;
}

// ── "Can we afford it?" ──────────────────────────────────────────────────────

export type AffordabilityVerdict = 'ok' | 'tight' | 'breaches';

export interface AffordabilityResult {
  verdict: AffordabilityVerdict;
  buffer: number;
  /** Echoes back what was actually tried, so a surface never labels the answer
   *  with a date the person has since edited in the form. */
  scenario: { label: string; date: string; total: number; occurrences: number; recurring: boolean };
  before: { lowestBalance: number; lowestBalanceWeek: string | null };
  after: { lowestBalance: number; lowestBalanceWeek: string | null };
  /** Dollars left above the buffer at the lowest point once the scenario is in (negative = below it). */
  headroom: number;
  /**
   * The most the family could commit per occurrence on that date/cadence and
   * still keep the buffer everywhere in the horizon. 0 when the forecast already
   * dips under the buffer without the scenario; null when the scenario lands
   * outside the horizon (nothing to measure).
   */
  maxAffordable: number | null;
}

/**
 * Try a commitment against the whole forward forecast — every bill, goal
 * set-aside and plan-linked commitment, not one budget category — and answer
 * with the lowest balance before/after and a verdict:
 *   breaches — the lowest balance with it falls under the buffer;
 *   tight    — it stays above, but the headroom is under one buffer or a
 *              quarter of the commitment, whichever is larger;
 *   ok       — otherwise.
 * Pure and deterministic given `now`.
 */
export function assessAffordability(input: BuildTimelineInput, scenario: TimelineScenario): AffordabilityResult {
  const buffer = input.buffer ?? DEFAULT_BUFFER;
  const base = buildCashflowTimeline({ ...input, scenario: null });
  const tried = buildCashflowTimeline({ ...input, scenario });

  const occurrences = tried.weeks.reduce((n, w) => n + w.moments.filter((m) => m.kind === 'scenario').length, 0);
  const total = tried.scenarioOutflow;
  const headroom = round2(tried.lowestBalance - buffer);

  let verdict: AffordabilityVerdict;
  if (occurrences === 0) verdict = 'ok';
  else if (tried.lowestBalance < buffer) verdict = 'breaches';
  else if (headroom < Math.max(buffer, total * 0.25)) verdict = 'tight';
  else verdict = 'ok';

  // Per-occurrence cap: from the first week the scenario lands, the base
  // balance minus the buffer, spread over however many occurrences have
  // landed by then. The tightest week decides.
  let maxAffordable: number | null = null;
  if (occurrences > 0) {
    let landed = 0;
    let cap = Number.POSITIVE_INFINITY;
    tried.weeks.forEach((w, i) => {
      landed += w.moments.filter((m) => m.kind === 'scenario').length;
      if (landed === 0) return;
      cap = Math.min(cap, (base.weeks[i].projectedBalance - buffer) / landed);
    });
    maxAffordable = Math.max(0, round2(cap));
  }

  return {
    verdict,
    buffer,
    scenario: { label: scenario.label, date: scenario.date, total, occurrences, recurring: Boolean(scenario.recurrence) },
    before: { lowestBalance: base.lowestBalance, lowestBalanceWeek: base.lowestBalanceWeek },
    after: { lowestBalance: tried.lowestBalance, lowestBalanceWeek: tried.lowestBalanceWeek },
    headroom,
    maxAffordable,
  };
}

// ── Presentation helpers (also used by the module for consistency) ───────────
export function money(n: number): string {
  const v = Math.round(n);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

export function pretty(ymdStr: string): string {
  const d = parseDate(ymdStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function listPhrase(items: string[]): string {
  const xs = items.slice(0, 2);
  if (xs.length === 1) return xs[0];
  const more = items.length > 2 ? ` +${items.length - 2} more` : '';
  return `${xs[0]} and ${xs[1]}${more}`;
}

export const INSIGHT_SEVERITY_RANK: Record<InsightSeverity, number> = { urgent: 0, watch: 1, info: 2 };

/** Stable identity for an insight so persisted acknowledge/dismiss survives a
 *  recompute (e.g. 'heavy_week:2026-01-05', 'recurring_creep:general'). */
export function insightDedupeKey(i: Pick<TimelineInsight, 'kind' | 'weekStart'>): string {
  return `${i.kind}:${i.weekStart ?? 'general'}`;
}
