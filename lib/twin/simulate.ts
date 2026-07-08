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
  /** Known vacation/trip windows (for the activity projection's vacation check). */
  vacationWindows?: { start: string; end: string; label: string }[];
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

// ── Full activity projection (R8) ────────────────────────────────────────────
// The category-defining "if Emma joins travel soccer, what has to move?" — a
// multi-dimensional look-ahead across the whole household model, not just one
// calendar. Pure + deterministic: given the activity's shape + the family
// context (events, budgets, vacation windows) it projects the ripple across
// schedule · travel · cost · family time · homework · meals · vacation.

export interface ActivityDecision {
  memberName: string;
  activityName: string;
  startsAt: string;          // first session (ISO) — sets the weekly day/time
  durationMin: number;       // minutes per session
  sessionsPerWeek: number;   // e.g. 2 practices + a game = 3
  weeks: number;             // how many weeks it runs
  travelMinEach?: number;    // one-way travel to the venue
  costCents?: number;        // total (or per-period) cost, if any
  costCategory?: string;     // which budget it draws from
}

export interface ProjectionDimension {
  key: 'schedule' | 'travel' | 'cost' | 'family_time' | 'homework' | 'meals' | 'vacation';
  label: string;
  severity: 'blocker' | 'caution' | 'ok';
  headline: string;
  detail?: string;
}

export interface ProjectionResult {
  verdict: Verdict;
  headline: string;
  /** Added hours per week (sessions × (duration + round-trip travel)). */
  weeklyHours: number;
  dimensions: ProjectionDimension[];
}

const HRS = (min: number) => Math.round((min / 60) * 10) / 10;

/** Project a proposed activity across every dimension of the household model. */
export function projectActivity(d: ActivityDecision, ctx: SimContext): ProjectionResult {
  const start = Date.parse(d.startsAt);
  if (Number.isNaN(start)) {
    return { verdict: 'conflict', headline: 'That start time isn’t valid.', weeklyHours: 0,
      dimensions: [{ key: 'schedule', label: 'Schedule', severity: 'blocker', headline: 'Invalid start time' }] };
  }
  const sessions = Math.max(1, Math.round(d.sessionsPerWeek || 1));
  const travelEach = Math.max(0, d.travelMinEach ?? 0);
  const perSessionMin = d.durationMin + travelEach * 2;
  const weeklyMin = perSessionMin * sessions;
  const weeklyHours = HRS(weeklyMin);
  const startDate = new Date(start);
  const hour = startDate.getUTCHours();
  const dow = startDate.getUTCDay(); // 0=Sun
  const dims: ProjectionDimension[] = [];

  // 1. Schedule — first-session conflicts + resulting weekly load.
  const first = simulateCommitment(
    { kind: 'commitment', memberName: d.memberName, title: d.activityName, startsAt: d.startsAt, durationMin: d.durationMin },
    ctx,
  );
  const heavy = ctx.heavyWeek ?? 8;
  const sameWeek = ctx.memberEvents.filter((e) => !e.allDay && !Number.isNaN(Date.parse(e.startsAt))
    && isoWeekKey(new Date(Date.parse(e.startsAt))) === isoWeekKey(startDate)).length;
  const projected = sameWeek + sessions;
  const schedBlocker = first.impacts.some((i) => i.severity === 'blocker');
  dims.push({
    key: 'schedule', label: 'Schedule',
    severity: schedBlocker ? 'blocker' : projected >= heavy ? 'caution' : 'ok',
    headline: schedBlocker ? 'Clashes with something already booked'
      : projected >= heavy ? `${d.memberName}'s week would hit ${projected} commitments`
      : `Fits — ${sessions} session${sessions === 1 ? '' : 's'}/week added`,
    detail: schedBlocker ? first.impacts.find((i) => i.severity === 'blocker')?.title : undefined,
  });

  // 2. Travel — added driving per week.
  if (travelEach > 0) {
    const travelWeekMin = travelEach * 2 * sessions;
    dims.push({
      key: 'travel', label: 'Travel',
      severity: travelWeekMin >= 300 ? 'blocker' : travelWeekMin >= 120 ? 'caution' : 'ok',
      headline: `${HRS(travelWeekMin)}h of driving a week`,
      detail: `${sessions} round trip${sessions === 1 ? '' : 's'} × ${travelEach} min each way.`,
    });
  }

  // 3. Cost — against the named budget.
  if (d.costCents && d.costCents > 0) {
    const spend = simulateSpend({ kind: 'spend', label: d.activityName, category: d.costCategory ?? '', amountCents: d.costCents }, ctx);
    dims.push({
      key: 'cost', label: 'Cost',
      severity: spend.verdict === 'conflict' ? 'blocker' : spend.verdict === 'tight' ? 'caution' : 'ok',
      headline: spend.headline,
      detail: spend.impacts[0]?.detail,
    });
  }

  // 4. Family time — how much of the week it eats.
  dims.push({
    key: 'family_time', label: 'Family time',
    severity: weeklyHours >= 10 ? 'blocker' : weeklyHours >= 6 ? 'caution' : 'ok',
    headline: `≈ ${weeklyHours}h a week`,
    detail: weeklyHours >= 6 ? 'That’s a meaningful chunk of family time — worth a conscious yes.' : 'A modest, manageable commitment.',
  });

  // 5. Homework — weekday-evening sessions squeeze school nights.
  const schoolNight = dow >= 1 && dow <= 4; // Mon–Thu
  if (schoolNight && hour >= 17 && hour <= 20) {
    dims.push({
      key: 'homework', label: 'Homework',
      severity: 'caution',
      headline: 'Lands on school nights',
      detail: `${sessions} school-night evening${sessions === 1 ? '' : 's'} — plan homework around it.`,
    });
  }

  // 6. Meals — sessions over dinnertime disrupt family dinner.
  if (hour >= 17 && hour < 19) {
    dims.push({
      key: 'meals', label: 'Meals',
      severity: 'caution',
      headline: `Overlaps dinner ${sessions}× a week`,
      detail: 'Plan make-ahead or later dinners on those nights.',
    });
  }

  // 7. Vacation — do any sessions fall inside a known trip window?
  const clash = (ctx.vacationWindows ?? []).find((v) => {
    const vs = Date.parse(v.start), ve = Date.parse(v.end);
    if (Number.isNaN(vs) || Number.isNaN(ve)) return false;
    for (let w = 0; w < Math.max(1, d.weeks); w++) {
      const occ = start + w * 7 * 86_400_000;
      if (occ >= vs && occ <= ve) return true;
    }
    return false;
  });
  if (clash) {
    dims.push({
      key: 'vacation', label: 'Vacation',
      severity: 'caution',
      headline: `Overlaps “${clash.label}”`,
      detail: 'Some sessions fall during a planned trip — you’ll miss them or reschedule.',
    });
  }

  const verdict = verdictFrom(dims.map((x) => ({ severity: x.severity, title: x.headline })));
  const blockers = dims.filter((x) => x.severity === 'blocker').length;
  const cautions = dims.filter((x) => x.severity === 'caution').length;
  const headline = verdict === 'conflict'
    ? `“${d.activityName}” has ${blockers} hard conflict${blockers === 1 ? '' : 's'} to resolve first.`
    : verdict === 'tight'
      ? `“${d.activityName}” is doable — ${cautions} thing${cautions === 1 ? '' : 's'} to plan around (${weeklyHours}h/week).`
      : `“${d.activityName}” fits cleanly — about ${weeklyHours}h a week.`;

  return { verdict, headline, weeklyHours, dimensions: dims };
}
