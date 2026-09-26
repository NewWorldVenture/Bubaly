// lib/finance/timeline-load.ts — server-side data loader for the Financial
// Copilot. Takes a Supabase client (so it's callable from both the page and the
// server actions) and fuses the finance + schedule + plan tables into the pure
// buildCashflowTimeline() brain. No 'server-only' import: it holds no secrets,
// just orchestrates queries on whatever client it's handed — which is also why
// the zone helpers come from lib/schedule/zoned.ts rather than the identical
// ones in lib/services/scope.ts, which do import 'server-only'.
//
// Every day key here is the FAMILY's day, which is why `tz` is a parameter
// rather than something this file reads off the server. It used to take
// `.toISOString().slice(0, 10)` of the clock — the day at GREENWICH — and then
// compare that against DATE columns (`vacations.start_date`) and hand it to
// the brain as "today". At 18:00 on a Sunday in Los Angeles that key is
// Monday's, and the forecast said so in three different places:
//
//   - a trip departing that Sunday was filtered out as already gone, so its
//     remaining budget silently left the projection;
//   - an undated subscription accrued from the 1st of the month AFTER the
//     family's, which on the 30th at 19:00 in Los Angeles is a month late;
//   - the brain reads `now` only through its UTC calendar date, so the whole
//     current week lost its bucket — a bill due that Sunday vanished from the
//     projection and the week of the 14th was never seeded at all.
//
// The DATE columns this reads — `bills.due_date` (0006), `vacations.start_date`
// (0070), `moves.move_date` (0245), `home_projects.target_start/target_end`
// (0246), `subscriptions_tracked.next_charge` (0076), `savings_goals
// .target_date` (0006) — are ALREADY the family's day. PostgREST hands them
// over as a bare `YYYY-MM-DD`, so they are compared and forwarded untouched:
// binding a zone to one of those would move it, which is the same error one
// day out in the other direction. `calendar_events.starts_at` (0002) is the
// only instant in the file, and it is the only value resolved in the zone.
//
// Read boundary: this is money. A dropped read error would project a
// reassuring-but-wrong balance (no bills, no trip, no move), so a real read
// failure is logged and THROWN — every caller renders a retryable error state
// instead of an empty forecast. A genuinely missing table (a plan module's
// migration not applied to this database) is tolerated as "no commitments
// from that module", the same way the CFO page degrades.

import type { SupabaseClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import type { Database } from '@/lib/database.types';
import { isMissingTableError } from '@/lib/supabase/errors';
import { monthlyCostCents } from './subscriptions';
import {
  buildCashflowTimeline,
  type BuildTimelineInput,
  type CashflowTimeline,
  type TimelineBill,
  type TimelineGoal,
  type TimelineEvent,
  type TimelinePlan,
  type TimelineScenario,
} from './timeline';
import type { LocaleCode } from '@/lib/i18n/locales';
import { dayKeyInZone, zonedTimeMs } from '@/lib/schedule/zoned';
import { readAllAsQuery } from '@/lib/supabase/read-all';

type Client = SupabaseClient<Database>;

/** Statuses under which a plan still commits money the forecast must carry. */
export const OPEN_VACATION_STATUSES = ['planning', 'booked'] as const;
export const OPEN_MOVE_STATUSES = ['planning', 'packing', 'moving_day', 'settling'] as const;
export const OPEN_PROJECT_STATUSES = ['planning', 'quoting', 'scheduled', 'in_progress'] as const;
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trial'] as const;

/** One week wider than the brain's 12-week horizon, so the last week is whole. */
const HORIZON_DAYS = 13 * 7;

/**
 * The family's calendar day for an instant, as `YYYY-MM-DD`.
 *
 * Throws on an unusable clock rather than falling back to Greenwich: this is
 * money, and a forecast built on the wrong day is the reassuring-but-wrong
 * answer the rest of this file exists to refuse.
 */
function familyDayKey(at: Date, tz: string): string {
  const key = dayKeyInZone(at.getTime(), tz);
  if (!key) throw new TypeError('[finance/timeline] no family day for an invalid clock');
  return key;
}

/**
 * The day key `days` after `dayKey` on the family's wall.
 *
 * Walks through LOCAL NOON, the same way lib/ai/context/render.ts does: a local
 * day is 23 or 25 hours twice a year, so `localMidnight + days * 86_400_000`
 * lands at 23:00 the evening before across a fall-back and formats as the day
 * before. From noon, an hour either way cannot cross a date boundary.
 */
function shiftFamilyDay(dayKey: string, days: number, tz: string): string {
  return dayKeyInZone(zonedTimeMs(dayKey, 12, 0, tz) + days * 86_400_000, tz) ?? dayKey;
}

function dollars(cents: number | null | undefined): number {
  return Math.round(Number(cents) || 0) / 100;
}

/**
 * The 1st of the month after `dayKey` on the family's calendar — where an
 * undated monthly accrual lands. String in, string out: a day key carries no
 * instant, so no zone and no DST can knock this off.
 */
function firstOfNextMonth(dayKey: string): string {
  const year = Number.parseInt(dayKey.slice(0, 4), 10);
  const month = Number.parseInt(dayKey.slice(5, 7), 10);   // 1-12
  if (!Number.isFinite(year) || !Number.isFinite(month)) return dayKey;
  const rollsOver = month === 12;
  return `${rollsOver ? year + 1 : year}-${String(rollsOver ? 1 : month + 1).padStart(2, '0')}-01`;
}

type SubscriptionRow = { name: string; cost_cents: number; cadence: string; status: string; next_charge: string | null; category: string | null };
type VacationRow = { id: string; title: string; start_date: string | null; status: string; budget_cents: number | null };
type VacationBudgetRow = { vacation_id: string; planned_cents: number };
type VacationExpenseRow = { vacation_id: string; amount_cents: number };
type MoveRow = { title: string; move_date: string; status: string; budget_cents: number | null; spent_cents: number };
type ProjectRow = { title: string; status: string; budget_cents: number | null; target_start: string | null; target_end: string | null };

/**
 * Turn the plan tables' rows into forecast commitments. Exported so the
 * mapping is unit-testable without a client:
 *   subscription — the real cost on its real cadence from `next_charge`; with
 *                  no next charge, the monthly-equivalent accrues from the 1st;
 *   vacation     — planned budget lines (or the trip's own budget) minus what
 *                  is already spent, needed by departure;
 *   move         — budget minus spent, needed on moving day;
 *   project      — the open budget on its target start (or end); a project
 *                  already in progress with no date is spending now.
 *
 * `tz` is the family's IANA zone — `ctx.active.family.timezone` on a page,
 * `scope.tz` in a service. Required rather than defaulted: every date below is
 * a day on this household's calendar, and a silent 'UTC' default would put the
 * mapping back to answering Greenwich's question. Every `date` it emits is a
 * family day key, which is what the columns it reads already hold.
 */
export function planCommitments(rows: {
  subscriptions: SubscriptionRow[];
  vacations: VacationRow[];
  vacationBudgets: VacationBudgetRow[];
  vacationExpenses: VacationExpenseRow[];
  moves: MoveRow[];
  projects: ProjectRow[];
}, tz: string, now: Date): TimelinePlan[] {
  const plans: TimelinePlan[] = [];
  const today = familyDayKey(now, tz);

  for (const s of rows.subscriptions) {
    if (!(LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)) continue;
    const cadence = s.cadence || 'monthly';
    if (s.next_charge) {
      plans.push({ label: s.name, amount: dollars(s.cost_cents), date: s.next_charge, source: 'subscription', recurrence: cadence, category: s.category ?? 'subscriptions' });
    } else {
      plans.push({ label: s.name, amount: dollars(monthlyCostCents(s.cost_cents, cadence)), date: firstOfNextMonth(today), source: 'subscription', recurrence: 'monthly', category: s.category ?? 'subscriptions' });
    }
  }

  const planned = new Map<string, number>();
  for (const b of rows.vacationBudgets) planned.set(b.vacation_id, (planned.get(b.vacation_id) ?? 0) + (Number(b.planned_cents) || 0));
  const spent = new Map<string, number>();
  for (const e of rows.vacationExpenses) spent.set(e.vacation_id, (spent.get(e.vacation_id) ?? 0) + (Number(e.amount_cents) || 0));
  for (const v of rows.vacations) {
    if (!(OPEN_VACATION_STATUSES as readonly string[]).includes(v.status)) continue;
    // `start_date` is a DATE column — the day on the family's wall already, so
    // it is compared against the family's today as it arrives. Reading it as an
    // instant and binding a zone to it would move the departure by a day.
    if (!v.start_date || v.start_date < today) continue;
    const budget = planned.has(v.id) ? planned.get(v.id)! : (Number(v.budget_cents) || 0);
    const remaining = budget - (spent.get(v.id) ?? 0);
    if (remaining <= 0) continue;
    plans.push({ label: v.title, amount: dollars(remaining), date: v.start_date, source: 'vacation', category: 'travel' });
  }

  for (const m of rows.moves) {
    if (!(OPEN_MOVE_STATUSES as readonly string[]).includes(m.status)) continue;
    const remaining = (Number(m.budget_cents) || 0) - (Number(m.spent_cents) || 0);
    if (remaining <= 0 || !m.move_date) continue;
    plans.push({ label: m.title, amount: dollars(remaining), date: m.move_date, source: 'move', category: 'moving' });
  }

  for (const p of rows.projects) {
    if (!(OPEN_PROJECT_STATUSES as readonly string[]).includes(p.status)) continue;
    const budget = Number(p.budget_cents) || 0;
    if (budget <= 0) continue;
    const date = p.target_start ?? p.target_end ?? (p.status === 'in_progress' ? today : null);
    if (!date) continue;
    plans.push({ label: p.title, amount: dollars(budget), date, source: 'project', category: 'home' });
  }

  return plans;
}

/**
 * Fetch bills + goals + upcoming events + balances + plan-linked commitments
 * and return the pure brain's input, so a caller can build the timeline as-is
 * or try a scenario against the same reads. Throws on a real read failure.
 *
 * `tz` is the family's IANA zone — `ctx.active.family.timezone` on a page,
 * `scope.tz` in a service. Every caller has a family in hand, so it is threaded
 * rather than read again here, and it is required rather than defaulted: a
 * silent 'UTC' would hand a Los Angeles household Greenwich's week.
 */
export async function loadMoneyTimelineInput(
  supabase: Client,
  familyId: string,
  tz: string,
  now: Date = new Date(),
): Promise<BuildTimelineInput> {
  // The window, on the family's calendar. `todayKey` and `horizonEndKey` bound
  // the DATE columns (which hold family days), `todayStartIso`/`horizonEndIso`
  // bound the one timestamptz column (which holds instants).
  const todayKey = familyDayKey(now, tz);
  const horizonEndKey = shiftFamilyDay(todayKey, HORIZON_DAYS, tz);
  const todayStartIso = new Date(zonedTimeMs(todayKey, 0, 0, tz)).toISOString();
  // Exclusive: local midnight the morning after the horizon's last family day.
  const horizonEndIso = new Date(zonedTimeMs(shiftFamilyDay(horizonEndKey, 1, tz), 0, 0, tz)).toISOString();

  const [billsQ, goalsQ, acctQ, eventsQ, subsQ, vacQ, vacBudgetQ, vacSpendQ, movesQ, projectsQ] = await settleAll([
    supabase.from('bills')
      .select('name, amount, due_date, is_recurring, recurrence, status, category, autopay')
      .eq('family_id', familyId).limit(1000),
    supabase.from('savings_goals')
      .select('name, target_amount, current_amount, target_date')
      .eq('family_id', familyId).limit(500),
    supabase.from('financial_accounts')
      .select('balance, type')
      .eq('family_id', familyId).limit(200),
    supabase.from('calendar_events')
      .select('title, starts_at')
      .eq('family_id', familyId)
      .gte('starts_at', todayStartIso)
      .lt('starts_at', horizonEndIso)
      .order('starts_at').limit(500),
    supabase.from('subscriptions_tracked')
      .select('name, cost_cents, cadence, status, next_charge, category')
      .eq('family_id', familyId)
      .in('status', [...LIVE_SUBSCRIPTION_STATUSES]).limit(500),
    supabase.from('vacations')
      .select('id, title, start_date, status, budget_cents')
      .eq('family_id', familyId)
      .in('status', [...OPEN_VACATION_STATUSES])
      .gte('start_date', todayKey).lte('start_date', horizonEndKey).limit(200),
    // A ceiling above 1,000 is not a ceiling on its own: PostgREST caps the
    // response at db-max-rows whatever `.limit()` says. These total a household's
    // vacation money, so a quietly truncated read understates every total.
    readAllAsQuery((from, to) => supabase.from('vacation_budgets')
      .select('vacation_id, planned_cents')
      .eq('family_id', familyId).order('id').range(from, to), { max: 2000 }),
    readAllAsQuery((from, to) => supabase.from('vacation_expenses')
      .select('vacation_id, amount_cents')
      .eq('family_id', familyId).order('id').range(from, to), { max: 5000 }),
    supabase.from('moves')
      .select('title, move_date, status, budget_cents, spent_cents')
      .eq('family_id', familyId)
      .in('status', [...OPEN_MOVE_STATUSES]).limit(100),
    supabase.from('home_projects')
      .select('title, status, budget_cents, target_start, target_end')
      .eq('family_id', familyId)
      .in('status', [...OPEN_PROJECT_STATUSES]).limit(500),
  ]);

  const reads: [string, { error: unknown }][] = [
    ['bills', billsQ], ['savings_goals', goalsQ], ['financial_accounts', acctQ], ['calendar_events', eventsQ],
    ['subscriptions_tracked', subsQ], ['vacations', vacQ], ['vacation_budgets', vacBudgetQ], ['vacation_expenses', vacSpendQ],
    ['moves', movesQ], ['home_projects', projectsQ],
  ];
  const failed = reads.find(([, q]) => q.error && !isMissingTableError(q.error));
  if (failed) {
    console.error('[finance/timeline] money timeline read failed', { table: failed[0], error: failed[1].error });
    throw failed[1].error;
  }

  const bills = (billsQ.data ?? []) as TimelineBill[];
  const goals = (goalsQ.data ?? []) as TimelineGoal[];
  // The brain buckets an event into a week by the UTC calendar date of whatever
  // it is handed — `isoWeekStart(parseDate(starts_at))` — which is exactly how
  // it reads the bare `YYYY-MM-DD` of a DATE column. So each event is handed
  // the family day it falls on rather than its raw instant: a Sunday-evening
  // game in Los Angeles is 00:00Z on Monday, and the instant would overlay it
  // onto the NEXT week — the week a family is told its heavy money week "lands
  // the same week as". A row with an unparseable instant keeps its own value
  // rather than taking a whole forecast down for an overlay title.
  const events: TimelineEvent[] = ((eventsQ.data ?? []) as TimelineEvent[]).map((e) => ({
    title: e.title,
    starts_at: dayKeyInZone(Date.parse(e.starts_at), tz) ?? e.starts_at,
  }));
  const plans = planCommitments({
    subscriptions: (subsQ.data ?? []) as SubscriptionRow[],
    vacations: (vacQ.data ?? []) as VacationRow[],
    vacationBudgets: (vacBudgetQ.data ?? []) as VacationBudgetRow[],
    vacationExpenses: (vacSpendQ.data ?? []) as VacationExpenseRow[],
    moves: (movesQ.data ?? []) as MoveRow[],
    projects: (projectsQ.data ?? []) as ProjectRow[],
  }, tz, now);

  // Starting balance = sum of liquid (cash/checking/savings) accounts; fall back
  // to all accounts if none are typed. Credit/loan accounts are excluded so the
  // projection reflects spendable cash, not debt lines.
  const accounts = (acctQ.data ?? []) as { balance: number; type: string | null }[];
  const liquid = accounts.filter((a) => !a.type || ['checking', 'savings', 'cash'].includes(a.type));
  const pool = liquid.length ? liquid : accounts.filter((a) => (a.type ?? '') !== 'credit');
  const startingBalance = pool.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  // The brain reads `now` ONLY through its UTC calendar date (`startOfDay` and
  // `isoWeekStart` both do), which is the same convention it uses for the bare
  // `YYYY-MM-DD` a DATE column gives it. Handing it the raw instant makes the
  // forecast's "today" Greenwich's: at 18:00 on a Sunday in Los Angeles the
  // brain would seed its buckets from the week of the 21st, so the week of the
  // 14th never exists and a bill due that Sunday is dropped as already past.
  // So it gets the family's today, anchored the way it anchors every other day.
  const familyToday = new Date(`${todayKey}T00:00:00Z`);

  return { bills, goals, events, plans, startingBalance, now: familyToday };
}

/** Fetch everything and build the timeline, optionally with a what-if scenario.
 *  `tz` is the family's zone; see loadMoneyTimelineInput. */
export async function loadMoneyTimeline(
  supabase: Client,
  familyId: string,
  tz: string,
  now: Date = new Date(),
  opts: { scenario?: TimelineScenario | null; locale?: LocaleCode } = {},
): Promise<CashflowTimeline> {
  const input = await loadMoneyTimelineInput(supabase, familyId, tz, now);
  return buildCashflowTimeline({ ...input, scenario: opts.scenario ?? null, locale: opts.locale });
}
