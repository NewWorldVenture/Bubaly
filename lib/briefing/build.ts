// The Daily Brief and the evening recap (§49), composed once so the page, the
// API route and the delivery cron all say the same thing.
//
// WHY THIS FILE EXISTS: every piece of a brief already existed — the calendar
// engine (`buildFirstBrief`), the cross-domain sweep (`buildConciergeDigest`)
// and the honest "Bubaly handled" list (`mergeCompletedByBubaly`) — but the
// composition lived inside `app/api/ai/briefing/route.ts`. A composition
// inside a route cannot be reused by a cron, cannot be tested without HTTP,
// and drifts from whatever the page renders. This is that composition, pure.
//
// THE RULE THAT MATTERS: `handled` is not a claim Bubaly makes about itself.
// It is the runs that really reached `completed` or `partially_completed`,
// carried through `mergeCompletedByBubaly` — the same function the Command
// Center renders. A brief may under-report (a run that finished after the
// window) but it can never over-report, and `tests/briefing-build.test.ts`
// pins that: handled ⊆ completed runs.
import { z } from 'zod';
import { buildConciergeDigest, type ConciergeDigest, type ConciergeSnapshot } from '@/lib/concierge/digest';
import { mergeCompletedByBubaly, type AiActivityRow, type CompletedItem, type CompletedRunRow } from '@/lib/home/today';
import { buildFirstBrief, type BriefEvent, type FirstBrief } from '@/lib/onboarding/first-brief';
import type { DinnerIdea } from '@/lib/onboarding/dinner-ideas';
import type { HomeBriefKind } from '@/lib/database.types';

export type BriefKind = HomeBriefKind;

export type BriefInput = {
  kind: BriefKind;
  now: Date;
  /** Events in the next ~7 days, already family-scoped. */
  events: BriefEvent[];
  /** What the cross-domain sweep should consider (bills, meds, maintenance…). */
  snapshot: Omit<ConciergeSnapshot, 'now'>;
  /** Runs that reached a terminal state, and the AI activity feed. */
  completedRuns: CompletedRunRow[];
  activity: AiActivityRow[];
  dinnerCandidates?: DinnerIdea[];
  /** Counts the home brief already tracks, for the stored row. */
  counts?: { choresPending?: number; openTodos?: number; groceryOpen?: number; memberCount?: number };
};

export type Brief = {
  kind: BriefKind;
  /** The family's local day this brief is for, `YYYY-MM-DD`. */
  asOfDate: string;
  headline: string;
  /** The calendar half: today's timeline, the week, conflicts, opportunities. */
  calendar: FirstBrief;
  /** The cross-domain half: bills, medications, maintenance, warranties, trips, pantry. */
  digest: ConciergeDigest;
  /** What Bubaly actually finished — runs that completed, never a claim. */
  handled: CompletedItem[];
  counts: {
    today: number;
    week: number;
    conflicts: number;
    overdue: number;
    handled: number;
    timeSavedMinutes: number;
  };
  /** True when there is genuinely nothing to say — the caller leads with getting-started. */
  isSparse: boolean;
};

/** The persisted shape, validated on the way in and out of `home_briefs.brief`. */
export const briefSchema = z.object({
  kind: z.enum(['daily', 'evening']),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  headline: z.string(),
  calendar: z.object({
    now: z.string(), headline: z.string(), todayCount: z.number(), weekCount: z.number(),
    timeline: z.array(z.object({ title: z.string(), start: z.string(), end: z.string().nullable(), allDay: z.boolean(), location: z.string().nullable(), timeLabel: z.string() })),
    conflicts: z.array(z.object({}).passthrough()),
    actions: z.array(z.object({}).passthrough()),
    opportunities: z.array(z.object({}).passthrough()),
    dinnerIdeas: z.array(z.object({}).passthrough()),
    timeSavedMinutes: z.number(),
  }).passthrough(),
  digest: z.object({
    items: z.array(z.object({}).passthrough()),
    counts: z.object({ overdue: z.number(), today: z.number(), soon: z.number(), total: z.number() }),
    byDomain: z.array(z.object({ domain: z.string(), count: z.number() })),
    headline: z.string(),
  }).passthrough(),
  handled: z.array(z.object({
    key: z.string(), kind: z.enum(['run', 'activity']), title: z.string(),
    detail: z.string().nullable(), href: z.string(), at: z.string(), partial: z.boolean(),
    // M6: the source and reason a ledger row carries. Defaulted, so a brief
    // stored before they existed still parses — as a row that says nothing
    // about who acted or why, which is what was true of it.
    sources: z.array(z.object({ tool: z.string(), domain: z.string() })).default([]),
    reason: z.string().nullable().default(null),
  })),
  counts: z.object({
    today: z.number(), week: z.number(), conflicts: z.number(),
    overdue: z.number(), handled: z.number(), timeSavedMinutes: z.number(),
  }),
  isSparse: z.boolean(),
});

/** The family's local day, from an ISO instant and an IANA zone. */
export function dayKeyInZone(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * The headline a person reads first.
 *
 * Morning looks forward ("three things today, one clash"); evening looks back
 * ("Bubaly finished four things"). Both stay honest when there is nothing:
 * "A quiet day" is a real answer, and better than a manufactured one.
 */
function headlineFor(kind: BriefKind, calendar: FirstBrief, digest: ConciergeDigest, handled: CompletedItem[]): string {
  const parts: string[] = [];
  if (kind === 'evening') {
    if (handled.length) parts.push(`Bubaly finished ${handled.length} ${handled.length === 1 ? 'thing' : 'things'} today`);
    if (digest.counts.overdue) parts.push(`${digest.counts.overdue} still overdue`);
    if (calendar.todayCount) parts.push(`${calendar.todayCount} on today's calendar`);
    return parts.length ? `${parts.join(', ')}.` : 'A quiet evening — nothing outstanding.';
  }
  if (calendar.todayCount) parts.push(`${calendar.todayCount} ${calendar.todayCount === 1 ? 'thing' : 'things'} today`);
  if (calendar.conflicts.length) parts.push(`${calendar.conflicts.length} ${calendar.conflicts.length === 1 ? 'clash' : 'clashes'} to sort`);
  if (digest.counts.overdue) parts.push(`${digest.counts.overdue} overdue`);
  else if (digest.counts.today) parts.push(`${digest.counts.today} due today`);
  if (handled.length) parts.push(`${handled.length} already handled`);
  return parts.length ? `${parts.join(', ')}.` : 'A quiet day — nothing needs you yet.';
}

/**
 * Compose a brief. Pure: every input is already-read data, so this is testable
 * without a database and identical for the page, the route and the cron.
 */
export function buildBrief(input: BriefInput, tz: string): Brief {
  const calendar = buildFirstBrief(input.events ?? [], input.now, input.dinnerCandidates ?? []);
  const digest = buildConciergeDigest({ ...input.snapshot, now: input.now });
  const handled = mergeCompletedByBubaly(input.completedRuns ?? [], input.activity ?? []);

  const counts = {
    today: calendar.todayCount,
    week: calendar.weekCount,
    conflicts: calendar.conflicts.length,
    overdue: digest.counts.overdue,
    handled: handled.length,
    timeSavedMinutes: calendar.timeSavedMinutes,
  };

  return {
    kind: input.kind,
    asOfDate: dayKeyInZone(input.now, tz),
    headline: headlineFor(input.kind, calendar, digest, handled),
    calendar,
    digest,
    handled,
    counts,
    // Nothing on the calendar, nothing due and nothing done is a genuinely
    // sparse day — the caller leads with getting-started instead of a void.
    isSparse: counts.today === 0 && counts.week === 0 && digest.counts.total === 0 && handled.length === 0,
  };
}

/** The `home_briefs` row a brief becomes: the numbers as columns, the body as jsonb. */
export function briefRow(brief: Brief, familyId: string, createdBy: string | null) {
  return {
    family_id: familyId,
    as_of_date: brief.asOfDate,
    kind: brief.kind,
    is_sparse: brief.isSparse,
    readiness_pct: readinessPct(brief),
    week_count: brief.counts.week,
    conflict_count: brief.counts.conflicts,
    dinner_count: brief.calendar.dinnerIdeas.length,
    time_saved_minutes: brief.counts.timeSavedMinutes,
    headline: brief.headline,
    brief: brief as unknown as Record<string, unknown>,
    handled: brief.handled as unknown as Record<string, unknown>[],
    created_by: createdBy,
  };
}

/**
 * How ready the week looks, 0–100. Conflicts and overdue items are what make a
 * week not ready; what Bubaly already handled pulls it back up. Deliberately
 * simple arithmetic rather than a model: a number on a home screen has to be
 * explainable, and this one is.
 */
export function readinessPct(brief: Brief): number {
  const problems = brief.counts.conflicts * 2 + brief.counts.overdue;
  const credits = brief.counts.handled;
  if (problems === 0) return 100;
  const score = Math.round(100 - (problems * 12) + Math.min(credits, 5) * 4);
  return Math.max(0, Math.min(100, score));
}
