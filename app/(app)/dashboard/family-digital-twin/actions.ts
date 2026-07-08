'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  simulateDecision, projectActivity,
  type SimResult, type SimBudget, type SimEvent, type ActivityDecision, type ProjectionResult,
} from '@/lib/twin/simulate';

// Decision Simulator server action (Digital Twin, pillar #2). Assembles the real
// household context for the proposed decision and runs the pure simulator. All
// reads are family-scoped via the RLS client; nothing is written — this is a
// safe "what-if" that never touches live data.

export type SimFormInput =
  | { kind: 'commitment'; memberId: string; memberName: string; title: string; startsAt: string; durationMin: number; weeks?: number }
  | { kind: 'spend'; label: string; category: string; amountDollars: number };

/** First day of the budget's current period (UTC), as a YYYY-MM-DD string. */
function periodStart(period: string, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'weekly') {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow);
  } else if (period === 'yearly') {
    d.setUTCMonth(0, 1);
  } else {
    d.setUTCDate(1); // monthly (default)
  }
  return d.toISOString().slice(0, 10);
}

export async function simulateDecisionAction(input: SimFormInput): Promise<SimResult> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  if (input.kind === 'commitment') {
    if (!input.title.trim() || !input.startsAt || !(input.durationMin > 0)) {
      return { verdict: 'conflict', headline: 'Fill in a title, time and duration to simulate.', impacts: [{ severity: 'blocker', title: 'Incomplete decision' }] };
    }
    const now = new Date();
    const in120 = new Date(now.getTime() + 120 * 86_400_000).toISOString();
    const { data } = await supabase
      .from('calendar_events')
      .select('id, title, starts_at, ends_at, all_day')
      .eq('family_id', familyId)
      .eq('assignee_id', input.memberId)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', in120)
      .limit(500);
    const memberEvents: SimEvent[] = (data ?? []).map((e) => ({
      id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
    }));
    return simulateDecision(
      { kind: 'commitment', memberName: input.memberName, title: input.title.trim(), startsAt: input.startsAt, durationMin: input.durationMin, weeks: input.weeks },
      { memberEvents, budgets: [] },
    );
  }

  // spend
  const amountCents = Math.round((input.amountDollars || 0) * 100);
  if (!input.category || !(amountCents > 0)) {
    return { verdict: 'conflict', headline: 'Pick a budget and an amount to simulate.', impacts: [{ severity: 'blocker', title: 'Incomplete decision' }] };
  }
  const { data: budgetRows } = await supabase
    .from('budgets').select('category, amount, period').eq('family_id', familyId);
  const b = (budgetRows ?? []).find((x) => x.category.toLowerCase() === input.category.toLowerCase());
  let budgets: SimBudget[] = [];
  if (b) {
    const start = periodStart(b.period, new Date());
    const { data: tx } = await supabase
      .from('transactions').select('amount').eq('family_id', familyId)
      .eq('type', 'expense').ilike('category', b.category).gte('date', start).limit(2000);
    const spentCents = Math.round((tx ?? []).reduce((s, t) => s + Number(t.amount ?? 0), 0) * 100);
    budgets = [{ category: b.category, limitCents: Math.round(Number(b.amount) * 100), spentCents }];
  }
  return simulateDecision(
    { kind: 'spend', label: input.label.trim() || input.category, category: input.category, amountCents },
    { memberEvents: [], budgets },
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
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  if (!input.activityName?.trim() || !input.startsAt || !(input.durationMin > 0)) {
    return { ok: false, error: 'Fill in an activity, time and duration to project.' };
  }
  const supabase = await createServer();
  const now = new Date();
  const in180 = new Date(now.getTime() + 180 * 86_400_000).toISOString();

  // Member's upcoming events (schedule/load), budgets (cost), vacations (conflicts).
  const costCents = Math.round((input.costDollars ?? 0) * 100);
  const [{ data: evRows }, { data: budgetRows }, { data: vacRows }] = await Promise.all([
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day')
      .eq('family_id', familyId).eq('assignee_id', input.memberId)
      .gte('starts_at', now.toISOString()).lte('starts_at', in180).limit(500),
    input.costCategory
      ? supabase.from('budgets').select('category, amount, period').eq('family_id', familyId)
      : Promise.resolve({ data: [] as { category: string; amount: number; period: string }[] }),
    supabase.from('vacations').select('title, start_date, end_date')
      .eq('family_id', familyId).not('start_date', 'is', null).not('end_date', 'is', null).limit(50),
  ]);

  const memberEvents: SimEvent[] = (evRows ?? []).map((e) => ({
    id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
  }));

  let budgets: SimBudget[] = [];
  if (input.costCategory && costCents > 0) {
    const b = (budgetRows ?? []).find((x) => x.category.toLowerCase() === input.costCategory!.toLowerCase());
    if (b) {
      const start = periodStart(b.period, now);
      const { data: tx } = await supabase.from('transactions').select('amount')
        .eq('family_id', familyId).eq('type', 'expense').ilike('category', b.category).gte('date', start).limit(2000);
      const spentCents = Math.round((tx ?? []).reduce((s, t) => s + Number(t.amount ?? 0), 0) * 100);
      budgets = [{ category: b.category, limitCents: Math.round(Number(b.amount) * 100), spentCents }];
    }
  }

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
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/family-digital-twin');
  return { ok: true };
}

/** Delete a saved simulation. */
export async function deleteSimulationAction(id: string): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('twin_simulations').delete().eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/family-digital-twin');
  return { ok: true };
}
