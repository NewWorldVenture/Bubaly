'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { simulateDecision, type SimResult, type SimBudget, type SimEvent } from '@/lib/twin/simulate';

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
