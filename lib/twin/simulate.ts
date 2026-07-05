// lib/twin/simulate.ts — the Household Digital Twin's decision simulator
// (Operating Layer pillar #2). Pure, deterministic "what-if" reasoning: given a
// snapshot of the household (a member's upcoming events + the family budgets)
// and a PROPOSED decision, it computes the ripple BEFORE anything is committed —
// so a family can see "if we accept this tournament, what has to move?" or
// "can we add two nights and stay in budget?" without touching real data.
//
// No Supabase, no DOM — the server assembles the context, this decides the
// outcome. Fully unit-testable. Honest: a decision with no downside reads as
// "clear", and it never invents a conflict that isn't there.

/** A timed event on a member's calendar (subset of calendar_events). */
export interface SimEvent {
  id: string;
  title: string;
  startsAt: string;       // ISO
  endsAt: string | null;  // ISO
  allDay: boolean;
}

export interface SimBudget {
  category: string;
  limitCents: number;   // the budget cap for the period
  spentCents: number;   // committed so far this period
}

/** The two decisions the twin can simulate today. */
export type SimDecision =
  | {
      kind: 'commitment';
      memberName: string;
      title: string;
      startsAt: string;     // ISO — when the new commitment starts
      durationMin: number;  // how long it runs
      /** How many weeks it recurs (1 = one-off). Drives the weekly-load estimate. */
      weeks?: number;
    }
  | {
      kind: 'spend';
      label: string;
      category: string;
      amountCents: number;
    };

export interface SimImpact {
  severity: 'blocker' | 'caution' | 'ok';
  title: string;
  detail?: string;
}

export type Verdict = 'clear' | 'tight' | 'conflict';

export interface SimResult {
  verdict: Verdict;
  /** One-line plain-language answer. */
  headline: string;
  impacts: SimImpact[];
}

export interface SimContext {
  /** The member's upcoming timed events (for conflict + load math). */
  memberEvents: SimEvent[];
  /** Family budgets (for spend simulation). */
  budgets: SimBudget[];
  /** Events/week for this member that counts as a heavy week. Default 8. */
  heavyWeek?: number;
}

const MIN = 60_000;
const TIGHT_GAP_MIN = 15;

function money(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** ISO week key so "this week" load is counted per distinct week. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function verdictFrom(impacts: SimImpact[]): Verdict {
  if (impacts.some((i) => i.severity === 'blocker')) return 'conflict';
  if (impacts.some((i) => i.severity === 'caution')) return 'tight';
  return 'clear';
}

function simulateCommitment(d: Extract<SimDecision, { kind: 'commitment' }>, ctx: SimContext): SimResult {
  const start = Date.parse(d.startsAt);
  const end = start + d.durationMin * MIN;
  const impacts: SimImpact[] = [];

  if (Number.isNaN(start)) {
    return { verdict: 'conflict', headline: 'That start time isn’t valid.', impacts: [{ severity: 'blocker', title: 'Invalid start time' }] };
  }

  const timed = ctx.memberEvents.filter((e) => !e.allDay && !Number.isNaN(Date.parse(e.startsAt)));

  // Direct overlaps → these are what "has to move".
  for (const e of timed) {
    const es = Date.parse(e.startsAt);
    const ee = e.endsAt ? Date.parse(e.endsAt) : es + 60 * MIN;
    if (start < ee && es < end) {
      impacts.push({ severity: 'blocker', title: `Overlaps “${e.title}”`, detail: 'One of these would have to move.' });
    }
  }

  // Tight turnarounds (back-to-back with < 15 min gap either side).
  for (const e of timed) {
    const es = Date.parse(e.startsAt);
    const ee = e.endsAt ? Date.parse(e.endsAt) : es + 60 * MIN;
    const gapAfter = (es - end) / MIN;      // new ends, existing starts
    const gapBefore = (start - ee) / MIN;   // existing ends, new starts
    if (gapAfter >= 0 && gapAfter < TIGHT_GAP_MIN) impacts.push({ severity: 'caution', title: `Only ${Math.round(gapAfter)} min before “${e.title}”` });
    else if (gapBefore >= 0 && gapBefore < TIGHT_GAP_MIN) impacts.push({ severity: 'caution', title: `Only ${Math.round(gapBefore)} min after “${e.title}”` });
  }

  // Weekly load: how full is that member's week already?
  const heavy = ctx.heavyWeek ?? 8;
  const wk = isoWeekKey(new Date(start));
  const sameWeek = timed.filter((e) => isoWeekKey(new Date(Date.parse(e.startsAt))) === wk).length;
  const after = sameWeek + 1;
  if (after >= heavy) {
    impacts.push({ severity: 'caution', title: `${d.memberName}'s week would hit ${after} commitments`, detail: 'That’s a heavy week — consider what to trim.' });
  }
  if ((d.weeks ?? 1) > 1) {
    impacts.push({ severity: 'ok', title: `Repeats for ${d.weeks} weeks`, detail: `Adds ~${d.weeks} sessions to ${d.memberName}'s schedule.` });
  }

  if (impacts.length === 0 || impacts.every((i) => i.severity === 'ok')) {
    impacts.unshift({ severity: 'ok', title: 'No conflicts', detail: `“${d.title}” fits ${d.memberName}'s schedule.` });
  }

  const verdict = verdictFrom(impacts);
  const headline = verdict === 'conflict'
    ? `“${d.title}” collides with something — you’d need to move ${impacts.filter((i) => i.severity === 'blocker').length} thing(s).`
    : verdict === 'tight'
      ? `“${d.title}” fits, but it’ll be a tight squeeze.`
      : `“${d.title}” fits cleanly into ${d.memberName}'s schedule.`;
  return { verdict, headline, impacts };
}

function simulateSpend(d: Extract<SimDecision, { kind: 'spend' }>, ctx: SimContext): SimResult {
  const budget = ctx.budgets.find((b) => b.category.toLowerCase() === d.category.toLowerCase());
  const impacts: SimImpact[] = [];

  if (!budget) {
    impacts.push({ severity: 'caution', title: `No budget set for “${d.category}”`, detail: `Can’t check headroom — ${money(d.amountCents)} would be unbudgeted.` });
    return { verdict: 'tight', headline: `No “${d.category}” budget to check against.`, impacts };
  }

  const remainingBefore = budget.limitCents - budget.spentCents;
  const remainingAfter = remainingBefore - d.amountCents;

  if (remainingAfter < 0) {
    impacts.push({ severity: 'blocker', title: `Over budget by ${money(-remainingAfter)}`, detail: `${money(budget.spentCents + d.amountCents)} of a ${money(budget.limitCents)} “${d.category}” budget.` });
    return { verdict: 'conflict', headline: `That would blow the “${d.category}” budget by ${money(-remainingAfter)}.`, impacts };
  }

  const tight = remainingAfter < budget.limitCents * 0.1; // < 10% headroom left
  impacts.push({
    severity: tight ? 'caution' : 'ok',
    title: `${money(remainingAfter)} left after`,
    detail: `${money(budget.spentCents + d.amountCents)} of ${money(budget.limitCents)} used.`,
  });
  return {
    verdict: tight ? 'tight' : 'clear',
    headline: tight
      ? `Doable — but only ${money(remainingAfter)} would be left in “${d.category}”.`
      : `Yes — ${money(remainingAfter)} would remain in “${d.category}”.`,
    impacts,
  };
}

/** Simulate a proposed decision against the household context. Pure. */
export function simulateDecision(decision: SimDecision, ctx: SimContext): SimResult {
  return decision.kind === 'commitment' ? simulateCommitment(decision, ctx) : simulateSpend(decision, ctx);
}
