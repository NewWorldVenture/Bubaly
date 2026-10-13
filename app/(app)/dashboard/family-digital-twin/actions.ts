'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getLocaleContext } from '@/lib/i18n/server';
import { settle } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import {
  simulateDecision, projectActivity,
  type SimResult, type SimBudget, type SimEvent, type ActivityDecision, type ProjectionResult,
} from '@/lib/twin/simulate';
import { readAllById } from '@/lib/supabase/read-all';
import { escapeLike } from '@/lib/supabase/escape-like';
import { wroteNoRows, describeActionError } from '@/lib/supabase/errors';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { readsHouseholdMoney } from '@/lib/finance/household-money';
import { budgetByCategory, periodWindow } from '@/lib/finance/budget-periods';
import { dayKeyInTz } from '@/lib/services/scope';

// Decision Simulator server action (Digital Twin, pillar #2). Assembles the real
// household context for the proposed decision and runs the pure simulator. All
// reads are family-scoped via the RLS client; nothing is written — this is a
// safe "what-if" that never touches live data.

export type SimFormInput =
  | { kind: 'commitment'; memberId: string; memberName: string; title: string; startsAt: string; durationMin: number; weeks?: number }
  | { kind: 'spend'; label: string; category: string; amountDollars: number };

type TwinClient = Awaited<ReturnType<typeof createServer>>;

/**
 * The household's budget for a category, and what has been spent against it in
 * the budget's OWN period on the FAMILY's day: Sunday to Saturday, the month or
 * the year, both ends (lib/finance/budget-periods periodWindow), as the Budget
 * Planner and the finance service judge it. This used to start each period on
 * Greenwich's day with Monday weeks, and had no end, so next month's scheduled
 * rent was this month's spending. One budget per category, the one the finance
 * service edits (budgetByCategory: the oldest row), matched however it is
 * spelled; `.find` over an unordered read took whichever duplicate came first.
 *
 * The total drives the budget the simulation is checked against, so it is read
 * whole and paged on the id (readAllById), and a read past the ceiling is an
 * error, never a smaller total. `budget: null` with no error: no such budget.
 */
async function budgetHeadroom(supabase: TwinClient, familyId: string, category: string, dayKey: string): Promise<{ budget: SimBudget | null; error: unknown }> {
  const { data: rows, error: budgetError } = await supabase
    .from('budgets').select('id, category, amount, period, created_at').eq('family_id', familyId);
  if (budgetError) return { budget: null, error: budgetError };
  const b = budgetByCategory((rows ?? []).map((x) => ({ ...x, amount: Number(x.amount) }))).get(category.trim().toLowerCase());
  if (!b) return { budget: null, error: null };
  const { from, to } = periodWindow(b.period, dayKey);
  const { rows: tx, error } = await readAllById<{ id: string; amount: number }>((after, limit) => {
    let query = supabase.from('transactions').select('id, amount').eq('family_id', familyId)
      .eq('type', 'expense').ilike('category', escapeLike(b.category)).gte('date', from).lte('date', to);
    if (after) query = query.gt('id', after);
    return query.order('id').limit(limit);
  }, { max: 2000 });
  if (error) return { budget: null, error };
  const spentCents = Math.round(tx.reduce((s, t) => s + Number(t.amount ?? 0), 0) * 100);
  return { budget: { category: b.category, limitCents: Math.round(b.amount * 100), spentCents }, error: null };
}

export async function simulateDecisionAction(input: SimFormInput): Promise<SimResult> {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  // The impact copy carries amounts, so it is formatted for whoever asked.
  const { locale } = await getLocaleContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  if (input.kind === 'commitment') {
    if (!input.title.trim() || !input.startsAt || !(input.durationMin > 0)) {
      return { verdict: 'conflict', headline: 'Fill in a title, time and duration to simulate.', impacts: [{ severity: 'blocker', title: 'Incomplete decision' }] };
    }
    const now = new Date();
    const in120 = new Date(now.getTime() + 120 * 86_400_000).toISOString();
    // Series included: a weekly commitment is in the member's load every week (lib/calendar/occurrences.ts).
    const twinTimezone = ctx.active.family.timezone || 'UTC';
    const { data } = await readCalendarOccurrences(supabase, familyId, instantCalendarBounds(now.toISOString(), in120, twinTimezone), twinTimezone,
      { columns: ['id', 'title', 'starts_at', 'ends_at', 'all_day'], assigneeId: input.memberId, limit: 500 });
    const memberEvents: SimEvent[] = (data ?? []).map((e) => ({
      id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
    }));
    return simulateDecision(
      { kind: 'commitment', memberName: input.memberName, title: input.title.trim(), startsAt: input.startsAt, durationMin: input.durationMin, weeks: input.weeks },
      { memberEvents, budgets: [], locale: locale.code },
    );
  }

  // spend
  // A purchase is checked against the household's budget and spending, which
  // are a parent's or adult's (the held 0514). Anyone else's session reads only
  // their own spending, so a simulation would understate it and say a purchase
  // fits; they are told whose the budget is instead.
  if (!readsHouseholdMoney(ctx.active.role)) {
    return { verdict: 'conflict', headline: tr('householdMoney.keptByParents'), impacts: [{ severity: 'blocker', title: tr('householdMoney.keptByParentsBody') }] };
  }
  const amountCents = Math.round((input.amountDollars || 0) * 100);
  if (!input.category || !(amountCents > 0)) {
    return { verdict: 'conflict', headline: 'Pick a budget and an amount to simulate.', impacts: [{ severity: 'blocker', title: 'Incomplete decision' }] };
  }
  const { budget, error: txError } = await budgetHeadroom(supabase, familyId, input.category, dayKeyInTz(new Date(), ctx.active.family.timezone || 'UTC'));
  // A read that failed, or stopped at the ceiling with more rows behind it,
  // understates `spentCents`, and an understated total is a simulator that says
  // a purchase fits inside a budget it does not — the single worst answer this
  // feature can give.
  if (txError) {
    console.error('[digital-twin] spend total read failed', txError);
    return {
      verdict: 'conflict',
      headline: tr('digitalTwin.couldNotReadThisCategorysSpending'),
      impacts: [{ severity: 'blocker', title: tr('digitalTwin.spendingUnavailable') }],
    };
  }
  const budgets: SimBudget[] = budget ? [budget] : [];
  return simulateDecision(
    { kind: 'spend', label: input.label.trim() || input.category, category: input.category, amountCents },
    { memberEvents: [], budgets, locale: locale.code },
  );
}

// ── R8: full activity projection ("if Emma joins travel soccer…") ─────────────
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export interface ActivityProjectionInput {
  memberId: string; memberName: string; activityName: string;
  startsAt: string; durationMin: number; sessionsPerWeek: number; weeks: number;
  travelMinEach?: number; costDollars?: number; costCategory?: string;
}

/** Assemble the real household context and run the pure projection. No writes. */
export async function projectActivityAction(input: ActivityProjectionInput): Promise<{ ok: true; data: ProjectionResult } | { ok: false; error: string }> {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  if (!input.activityName?.trim() || !input.startsAt || !(input.durationMin > 0)) {
    return { ok: false, error: tr('actions.fillInAnActivityTime') };
  }
  const costCents = Math.round((input.costDollars ?? 0) * 100);
  // The Cost line is checked against the household's budget and spending,
  // which are a parent's or adult's (the held 0514), as the spend simulation
  // above refuses. Anyone else's session reads only their own spending, so the
  // line read "$X of $Y used" with the household's limit beside part of it.
  const checksCost = !!input.costCategory && costCents > 0;
  if (checksCost && !readsHouseholdMoney(ctx.active.role)) {
    return { ok: false, error: tr('householdMoney.keptByParents') };
  }
  const supabase = await createServer();
  const now = new Date();
  const in180 = new Date(now.getTime() + 180 * 86_400_000).toISOString();
  const tz = ctx.active.family.timezone || 'UTC';

  // Member's upcoming events (schedule/load), the cost's budget, vacations (conflicts).
  const [{ data: evRows }, { budget, error: txError }, { data: vacRows }] = await Promise.all([
    // Series included: a weekly commitment counts every week of the six months (lib/calendar/occurrences.ts).
    settle(readCalendarOccurrences(supabase, familyId, instantCalendarBounds(now.toISOString(), in180, tz), tz,
      { columns: ['id', 'title', 'starts_at', 'ends_at', 'all_day'], assigneeId: input.memberId, limit: 500 })),
    checksCost
      ? budgetHeadroom(supabase, familyId, input.costCategory!, dayKeyInTz(now, tz))
      : Promise.resolve({ budget: null, error: null }),
    settle(supabase.from('vacations').select('title, start_date, end_date')
      .eq('family_id', familyId).not('start_date', 'is', null).not('end_date', 'is', null).limit(50)),
  ]);
  // Same total, same reason as above, same refusal to guess at it.
  if (txError) {
    console.error('[digital-twin] projection spend total read failed', txError);
    return { ok: false, error: tr('digitalTwin.couldNotReadThisCategorysSpending') };
  }

  const memberEvents: SimEvent[] = (evRows ?? []).map((e) => ({
    id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
  }));

  const budgets: SimBudget[] = budget ? [budget] : [];

  const vacationWindows = (vacRows ?? []).map((v) => ({
    start: `${v.start_date}T00:00:00.000Z`, end: `${v.end_date}T23:59:59.000Z`, label: v.title,
  }));

  const decision: ActivityDecision = {
    memberName: input.memberName, activityName: input.activityName.trim(),
    startsAt: input.startsAt, durationMin: input.durationMin,
    sessionsPerWeek: input.sessionsPerWeek, weeks: input.weeks,
    travelMinEach: input.travelMinEach, costCents: costCents > 0 ? costCents : undefined, costCategory: input.costCategory,
  };
  return { ok: true, data: projectActivity(decision, { memberEvents, budgets, vacationWindows }) };
}

/** Save a projection the family wants to keep. */
export async function saveSimulationAction(input: ActivityProjectionInput, result: ProjectionResult): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('twin_simulations').insert({
    family_id: ctx.active.familyId,
    member_id: input.memberId || null,
    activity_name: input.activityName.trim().slice(0, 200),
    verdict: result.verdict,
    weekly_hours: result.weeklyHours,
    input: input as never,
    dimensions: result.dimensions as never,
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: describeActionError(error) };
  revalidatePath('/dashboard/family-digital-twin');
  return { ok: true };
}

/** Delete a saved simulation. */
export async function deleteSimulationAction(id: string): Promise<Result> {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: deleted, error } = await supabase.from('twin_simulations')
    .delete().eq('id', id).eq('family_id', ctx.active.familyId).select('id');
  if (error) return { ok: false, error: describeActionError(error) };
  if (wroteNoRows(deleted)) return { ok: false, error: tr('actions.couldNotDeleteThatSimulation') };
  revalidatePath('/dashboard/family-digital-twin');
  return { ok: true };
}
