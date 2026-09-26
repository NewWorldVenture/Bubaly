'use server';

// Server actions for the Financial Copilot's insight cards (/dashboard/money-timeline).
//
// TWO THINGS THIS FILE HAS TO GET RIGHT, both of which it used to get wrong.
//
// 1. WHOSE CALL IT IS. `money_timeline_insights` carries `unique (family_id,
//    dedupe_key)` (0168), so there is one status row per family per advisory and
//    a single write decides what the WHOLE household sees: dismissing the
//    `urgent` low_balance card removes it from the parents' page too, Refresh
//    deliberately never rewrites `status`, and there is no dismissed-items view
//    to undo it from. Until 0352 both layers were role-blind — 0168 gated all
//    four commands on `is_family_member`, and this file checked nothing — so a
//    child on a kid login or an invited 'guest' could clear the family's
//    shortfall warning for good. RLS is the boundary (0352); `isManager` here
//    only turns a bare policy error into a sentence, the way
//    app/(app)/wallet/hub-actions.ts does for the same reason.
//
// 2. SAYING SO WHEN THE WRITE DOES NOT LAND. Both upserts used to be a bare
//    `await` with the `{ error }` discarded, and both actions returned `void`,
//    so a rejected write — a deactivated member, an expired session, a
//    transient PostgREST failure, or a database where 0168 has not been applied
//    — was followed by an unconditional `revalidatePath` and nothing else. The
//    caller had no result channel to check, so the card stayed gone for the rest
//    of the page session and came back on the next load. Every sibling action in
//    this app returns `{ ok, error }` (app/(app)/dashboard/insight-actions.ts,
//    dashboard/moments/actions.ts); these two now do as well, and they
//    revalidate only when a write actually landed, so the page is never
//    revalidated as though something changed when nothing did.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { loadMoneyTimeline } from '@/lib/finance/timeline-load';
import {
  insightDedupeKey,
  type InsightKind,
  type InsightSeverity,
  type TimelineInsight,
} from '@/lib/finance/timeline';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { isManager } from '@/lib/constants/roles';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/money-timeline';

export type MoneyInsightResult = { ok: boolean; error?: string };

/** The check constraints 0168 puts on the row, so a rejected payload is a
 *  sentence here instead of a 23514 from Postgres. */
const KINDS: readonly InsightKind[] = [
  'low_balance', 'heavy_week', 'goal_at_risk', 'recurring_creep', 'set_aside', 'all_clear',
];
const SEVERITIES: readonly InsightSeverity[] = ['info', 'watch', 'urgent'];
const STATUSES = ['active', 'acknowledged', 'dismissed'] as const;
type InsightStatus = (typeof STATUSES)[number];

/** `week_start` is a DATE column; anything else is a client that made it up. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The payload arrives from a client component, so it is untrusted input, not a
 * value this server derived. Without this a crafted call could pre-dismiss a
 * warning for a week that has not surfaced yet, under any `kind` it liked.
 */
function isTimelineInsight(value: unknown): value is TimelineInsight {
  if (!value || typeof value !== 'object') return false;
  const i = value as Record<string, unknown>;
  if (typeof i.kind !== 'string' || !KINDS.includes(i.kind as InsightKind)) return false;
  if (typeof i.severity !== 'string' || !SEVERITIES.includes(i.severity as InsightSeverity)) return false;
  if (typeof i.title !== 'string' || !i.title.trim()) return false;
  if (typeof i.detail !== 'string') return false;
  if (i.weekStart !== null && !(typeof i.weekStart === 'string' && YMD.test(i.weekStart))) return false;
  if (i.amount !== null && !(typeof i.amount === 'number' && Number.isFinite(i.amount))) return false;
  return true;
}

/**
 * A refusal message belongs to the REQUEST, not to module load: the locale is
 * resolved per request, so a constant evaluated once would freeze whichever
 * language happened to be first.
 */
async function notYours(): Promise<MoneyInsightResult> {
  const t = await getTranslations();
  return { ok: false, error: t('moneyTimeline.onlyAParentOrAnotherAdult') };
}

function writeFailed(operation: string, message: string, error: unknown): MoneyInsightResult {
  console.error(`[dashboard/money-timeline] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/** Acknowledge or dismiss a copilot insight (upserts by stable dedupe key). */
export async function setMoneyInsightStatusAction(input: {
  insight: TimelineInsight;
  status: InsightStatus;
}): Promise<MoneyInsightResult> {
  const t = await getTranslations();
  if (!input || !STATUSES.includes(input.status)) {
    return { ok: false, error: t('moneyTimeline.thatIsNotAChoiceWeCanSave') };
  }
  if (!isTimelineInsight(input.insight)) {
    return { ok: false, error: t('moneyTimeline.weCouldNotReadThatInsight') };
  }

  const ctx = await requireUserContext();
  // One row serves the whole family, so clearing it is a manager's call. 0352
  // is what enforces it; this is the sentence a person gets instead of a policy
  // error.
  if (!isManager(ctx.active.role)) return notYours();

  const supabase = await createServer();
  const i = input.insight;
  const { error } = await supabase.from('money_timeline_insights').upsert(
    {
      family_id: ctx.active.familyId,
      kind: i.kind,
      title: i.title,
      detail: i.detail,
      severity: i.severity,
      week_start: i.weekStart,
      amount: i.amount,
      status: input.status,
      dedupe_key: insightDedupeKey(i),
    },
    { onConflict: 'family_id,dedupe_key' },
  );
  // Return BEFORE revalidating. Revalidating a page whose write was rejected
  // re-renders the same state and tells the reader their tap took effect.
  if (error) {
    return writeFailed('insight status write', t('moneyTimeline.weCouldNotSaveThatChoice'), error);
  }

  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Recompute the timeline and refresh the persisted insights' content. Status is
 * intentionally omitted from the payload so any existing acknowledge/dismiss the
 * family set survives the refresh (only new insights insert as 'active').
 */
export async function syncMoneyInsightsAction(): Promise<MoneyInsightResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // Refresh writes the same family-wide rows as a dismiss does, so it takes the
  // same role.
  if (!isManager(ctx.active.role)) return notYours();

  const supabase = await createServer();
  // The persisted title/detail are a record of what was surfaced, not what the
  // page renders — money-timeline/page.tsx reads back only dedupe_key and
  // status and re-derives the copy for its own reader. So this formats in the
  // language of whoever pressed Refresh, which is the right owner for a record
  // and deliberately not a per-member choice: one row serves the whole family.
  const { locale } = await getLocaleContext();
  let timeline;
  try {
    timeline = await loadMoneyTimeline(supabase, ctx.active.familyId, ctx.active.family.timezone || 'UTC', new Date(), { locale: locale.code });
  } catch (error) {
    // The loader throws on a real money read failure rather than forecasting
    // from half the bills, so a refresh built on it fails closed too.
    return writeFailed('forecast read for refresh', t('moneyTimeline.weCouldNotRefreshTheseInsights'), error);
  }

  // Every row is attempted: one refused row is no reason to leave the others
  // stale. But a partial refresh is still a failed refresh, so the first
  // rejection is what the caller is told — never a clean result.
  let firstFailure: MoneyInsightResult | null = null;
  let landed = 0;
  for (const i of timeline.insights) {
    const key = insightDedupeKey(i);
    const { error } = await supabase.from('money_timeline_insights').upsert(
      {
        family_id: ctx.active.familyId,
        kind: i.kind,
        title: i.title,
        detail: i.detail,
        severity: i.severity,
        week_start: i.weekStart,
        amount: i.amount,
        dedupe_key: key,
      },
      { onConflict: 'family_id,dedupe_key' },
    );
    if (error) {
      const failed = writeFailed(
        `insight refresh (${key})`,
        t('moneyTimeline.weCouldNotRefreshTheseInsights'),
        error,
      );
      firstFailure ??= failed;
    } else {
      landed += 1;
    }
  }

  // Revalidate whenever something actually changed — including the rows that
  // landed beside a refusal, which would otherwise stay unseen until some later
  // navigation — and on a clean refresh even with nothing to write, because the
  // forecast itself is recomputed on render. Never when every write was refused.
  if (!firstFailure || landed > 0) revalidatePath(PATH);
  return firstFailure ?? { ok: true };
}
