// lib/finance/timeline-load.ts — server-side data loader for the Financial
// Copilot. Takes a Supabase client (so it's callable from both the page and the
// server actions) and fuses the finance + schedule + plan tables into the pure
// buildCashflowTimeline() brain. No 'server-only' import: it holds no secrets,
// just orchestrates queries on whatever client it's handed.
//
// Read boundary: this is money. A dropped read error would project a
// reassuring-but-wrong balance (no bills, no trip, no move), so a real read
// failure is logged and THROWN — every caller renders a retryable error state
// instead of an empty forecast. A genuinely missing table (a plan module's
// migration not applied to this database) is tolerated as "no commitments
// from that module", the same way the CFO page degrades.

import type { SupabaseClient } from '@supabase/supabase-js';
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

type Client = SupabaseClient<Database>;

/** Statuses under which a plan still commits money the forecast must carry. */
export const OPEN_VACATION_STATUSES = ['planning', 'booked'] as const;
export const OPEN_MOVE_STATUSES = ['planning', 'packing', 'moving_day', 'settling'] as const;
export const OPEN_PROJECT_STATUSES = ['planning', 'quoting', 'scheduled', 'in_progress'] as const;
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trial'] as const;

const DAY = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dollars(cents: number | null | undefined): number {
  return Math.round(Number(cents) || 0) / 100;
}

/** First day of the month after `now` (UTC) — where an undated monthly accrual lands. */
function firstOfNextMonth(now: Date): string {
  return ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
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
 */
export function planCommitments(rows: {
  subscriptions: SubscriptionRow[];
  vacations: VacationRow[];
  vacationBudgets: VacationBudgetRow[];
  vacationExpenses: VacationExpenseRow[];
  moves: MoveRow[];
  projects: ProjectRow[];
}, now: Date): TimelinePlan[] {
  const plans: TimelinePlan[] = [];
  const today = ymd(now);

  for (const s of rows.subscriptions) {
    if (!(LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)) continue;
    const cadence = s.cadence || 'monthly';
    if (s.next_charge) {
      plans.push({ label: s.name, amount: dollars(s.cost_cents), date: s.next_charge, source: 'subscription', recurrence: cadence, category: s.category ?? 'subscriptions' });
    } else {
      plans.push({ label: s.name, amount: dollars(monthlyCostCents(s.cost_cents, cadence)), date: firstOfNextMonth(now), source: 'subscription', recurrence: 'monthly', category: s.category ?? 'subscriptions' });
    }
  }

  const planned = new Map<string, number>();
  for (const b of rows.vacationBudgets) planned.set(b.vacation_id, (planned.get(b.vacation_id) ?? 0) + (Number(b.planned_cents) || 0));
  const spent = new Map<string, number>();
  for (const e of rows.vacationExpenses) spent.set(e.vacation_id, (spent.get(e.vacation_id) ?? 0) + (Number(e.amount_cents) || 0));
  for (const v of rows.vacations) {
    if (!(OPEN_VACATION_STATUSES as readonly string[]).includes(v.status)) continue;
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
 */
export async function loadMoneyTimelineInput(
  supabase: Client,
  familyId: string,
  now: Date = new Date(),
): Promise<BuildTimelineInput> {
  const horizonEnd = new Date(now.getTime() + 13 * 7 * DAY);
  const horizonEndIso = horizonEnd.toISOString();
  const horizonEndDay = ymd(horizonEnd);
  const today = ymd(now);

  const [billsQ, goalsQ, acctQ, eventsQ, subsQ, vacQ, vacBudgetQ, vacSpendQ, movesQ, projectsQ] = await Promise.all([
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
      .gte('starts_at', now.toISOString())
      .lte('starts_at', horizonEndIso)
      .order('starts_at').limit(500),
    supabase.from('subscriptions_tracked')
      .select('name, cost_cents, cadence, status, next_charge, category')
      .eq('family_id', familyId)
      .in('status', [...LIVE_SUBSCRIPTION_STATUSES]).limit(500),
    supabase.from('vacations')
      .select('id, title, start_date, status, budget_cents')
      .eq('family_id', familyId)
      .in('status', [...OPEN_VACATION_STATUSES])
      .gte('start_date', today).lte('start_date', horizonEndDay).limit(200),
    supabase.from('vacation_budgets')
      .select('vacation_id, planned_cents')
      .eq('family_id', familyId).limit(2000),
    supabase.from('vacation_expenses')
      .select('vacation_id, amount_cents')
      .eq('family_id', familyId).limit(5000),
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
  const events = (eventsQ.data ?? []) as TimelineEvent[];
  const plans = planCommitments({
    subscriptions: (subsQ.data ?? []) as SubscriptionRow[],
    vacations: (vacQ.data ?? []) as VacationRow[],
    vacationBudgets: (vacBudgetQ.data ?? []) as VacationBudgetRow[],
    vacationExpenses: (vacSpendQ.data ?? []) as VacationExpenseRow[],
    moves: (movesQ.data ?? []) as MoveRow[],
    projects: (projectsQ.data ?? []) as ProjectRow[],
  }, now);

  // Starting balance = sum of liquid (cash/checking/savings) accounts; fall back
  // to all accounts if none are typed. Credit/loan accounts are excluded so the
  // projection reflects spendable cash, not debt lines.
  const accounts = (acctQ.data ?? []) as { balance: number; type: string | null }[];
  const liquid = accounts.filter((a) => !a.type || ['checking', 'savings', 'cash'].includes(a.type));
  const pool = liquid.length ? liquid : accounts.filter((a) => (a.type ?? '') !== 'credit');
  const startingBalance = pool.reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  return { bills, goals, events, plans, startingBalance, now };
}

/** Fetch everything and build the timeline, optionally with a what-if scenario. */
export async function loadMoneyTimeline(
  supabase: Client,
  familyId: string,
  now: Date = new Date(),
  opts: { scenario?: TimelineScenario | null } = {},
): Promise<CashflowTimeline> {
  const input = await loadMoneyTimelineInput(supabase, familyId, now);
  return buildCashflowTimeline({ ...input, scenario: opts.scenario ?? null });
}
