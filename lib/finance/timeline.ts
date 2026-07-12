// lib/finance/timeline.ts — the Financial Copilot brain (pure, tested).
//
// Fuses SCHEDULE (bills' due dates, recurring cadence, savings-goal target
// dates, calendar events) with MONEY (amounts + current balances) into one
// forward-looking, week-bucketed cash-flow timeline, then reasons over it:
// projected running balance, "heavy weeks", goals at risk, and ranked,
// plain-language insights with next-best actions. No Supabase / React — the page
// fetches rows and calls buildCashflowTimeline(); everything here is unit-tested.
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

export type MomentKind = 'bill' | 'recurring' | 'goal';

export interface MoneyMoment {
  date: string;                  // YYYY-MM-DD
  label: string;
  amount: number;
  kind: MomentKind;
  category: string | null;
}

export interface WeekBucket {
  weekStart: string;             // Monday, YYYY-MM-DD
  outflow: number;
  moments: MoneyMoment[];
  events: string[];              // overlaid calendar event titles that week
  projectedBalance: number;      // running balance at the END of this week
  heavy: boolean;
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
}

const DAY = 86_400_000;

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

/** Expand a recurring bill's occurrences within [now, horizonEnd]. */
function expandOccurrences(bill: TimelineBill, now: Date, horizonEnd: Date): string[] {
  const first = parseDate(bill.due_date);
  const out: string[] = [];

  if (!bill.is_recurring || !bill.recurrence) {
    if (first >= startOfDay(now) && first <= horizonEnd) out.push(ymd(first));
    return out;
  }

  const rec = bill.recurrence.toLowerCase();
  const monthly = rec === 'monthly';
  const quarterly = rec === 'quarterly';
  const yearly = rec === 'yearly' || rec === 'annually';
  const stepDays = RECURRENCE_STEP_DAYS[rec];

  // Walk from the stored due date forward until we pass the horizon, emitting
  // any occurrence that lands inside [today, horizonEnd].
  let cursor = new Date(first.getTime());
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

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Approx monthly cost of a recurring bill (0 for one-offs). */
export function monthlyEquivalent(bill: TimelineBill): number {
  if (!bill.is_recurring || !bill.recurrence) return 0;
  const rec = bill.recurrence.toLowerCase();
  if (rec === 'weekly') return bill.amount * 52 / 12;
  if (rec === 'biweekly' || rec === 'fortnightly') return bill.amount * 26 / 12;
  if (rec === 'monthly') return bill.amount;
  if (rec === 'quarterly') return bill.amount / 3;
  if (rec === 'yearly' || rec === 'annually') return bill.amount / 12;
  return 0;
}

export interface BuildTimelineInput {
  bills: TimelineBill[];
  goals: TimelineGoal[];
  events: TimelineEvent[];
  startingBalance: number;
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
  const buffer = input.buffer ?? 200;
  const startingBalance = round2(input.startingBalance);

  const firstWeek = isoWeekStart(now);
  const horizonEnd = new Date(startOfDay(new Date(parseDate(firstWeek).getTime() + horizonWeeks * 7 * DAY)));

  // Seed empty week buckets so the timeline is contiguous.
  const buckets = new Map<string, WeekBucket>();
  const weekOrder: string[] = [];
  for (let i = 0; i < horizonWeeks; i++) {
    const ws = ymd(new Date(parseDate(firstWeek).getTime() + i * 7 * DAY));
    buckets.set(ws, { weekStart: ws, outflow: 0, moments: [], events: [], projectedBalance: 0, heavy: false });
    weekOrder.push(ws);
  }

  const push = (m: MoneyMoment) => {
    const ws = isoWeekStart(parseDate(m.date));
    const b = buckets.get(ws);
    if (!b) return;
    b.moments.push(m);
    b.outflow = round2(b.outflow + m.amount);
  };

  // 1) Bills (recurring expanded across the horizon; paid ones skipped).
  let monthlyRecurring = 0;
  for (const bill of input.bills) {
    if (bill.status === 'paid') continue;
    monthlyRecurring += monthlyEquivalent(bill);
    for (const date of expandOccurrences(bill, now, horizonEnd)) {
      push({ date, label: bill.name, amount: round2(bill.amount), kind: bill.is_recurring ? 'recurring' : 'bill', category: bill.category });
    }
  }
  monthlyRecurring = round2(monthlyRecurring);

  // 2) Savings goals with a target date inside the horizon → the remaining need
  //    lands as a money moment at the target date (what you must have set aside).
  const goalRisks: { name: string; remaining: number; weeksLeft: number; perWeek: number; date: string }[] = [];
  for (const g of input.goals) {
    const remaining = Math.max(0, round2((g.target_amount ?? 0) - (g.current_amount ?? 0)));
    if (remaining <= 0 || !g.target_date) continue;
    const target = parseDate(g.target_date);
    if (target < startOfDay(now) || target > horizonEnd) continue;
    push({ date: ymd(target), label: `${g.name} goal`, amount: remaining, kind: 'goal', category: 'savings' });
    const weeksLeft = Math.max(1, Math.ceil((target.getTime() - startOfDay(now).getTime()) / (7 * DAY)));
    goalRisks.push({ name: g.name, remaining, weeksLeft, perWeek: round2(remaining / weeksLeft), date: ymd(target) });
  }

  // 3) Overlay calendar events onto their week (schedule ↔ money context).
  for (const e of input.events) {
    const ws = isoWeekStart(parseDate(e.starts_at));
    const b = buckets.get(ws);
    if (b && !b.events.includes(e.title)) b.events.push(e.title);
  }

  // 4) Running projected balance + heavy-week detection.
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

  // 5) Insights — ranked most-urgent first.
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
  };
}

function weekIndex(order: string[], ws: string): number {
  const i = order.indexOf(ws);
  return i < 0 ? 1 : i + 1;
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
