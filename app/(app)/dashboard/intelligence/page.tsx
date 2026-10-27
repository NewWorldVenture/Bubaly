import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';
import { IntelligenceModule } from '@/components/modules/intelligence-module';
import {
  computeContribution, contributionFeatures, bedtimeToMinutes, typicalWeeklySpend, type ContributionInput,
} from '@/lib/network/contribution';
import { cohortKey, aggregatesToInsights, freshAggregatesSince, type NetworkAggregate } from '@/lib/network/aggregate';
import {
  CHILD_ROLES, OPEN_CHORE_STATUSES, OPEN_REMINDER_STATUSES, SPEND_WINDOW_DAYS, remindersStillDueBy,
} from '@/lib/network/aggregate-server';
import { benchmarksPageIsPublished, readTrueCohortSizes } from '@/lib/network/benchmarks-server';
import { publishableInsights, type ConsentScope, type NetworkInsight } from '@/lib/network/insights';
import { loadAutomaticCaptureShare } from '@/lib/metric/automatic-capture-server';
import { AutomaticCaptureCard } from '@/components/metrics/automatic-capture-card';
import { addDaysToDayKey, dayKeyInTz } from '@/lib/services/scope';
import { readsHouseholdMoney } from '@/lib/finance/household-money';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';

/** A real ceiling on the spend window the preview sums: past it, a failed read, never a smaller band. */
const SPEND_READ_MAX = 50_000;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.intelligenceNetwork') };
}
export const dynamic = 'force-dynamic';

export default async function IntelligencePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  // Day keys resolved in the family's zone: these are compared against DATE
  // columns, which hold the day on the family's wall rather than an instant.
  const tz = ctx.active.family.timezone || 'UTC';
  const todayKey = dayKeyInTz(now, tz);
  // End-EXCLUSIVE, as the nightly aggregation reads them: dinners on
  // [today, today + 7) and spending on (today − 28, today]. Both ends inclusive
  // was an eight-day week and a 29-day month.
  const weekEndKey = addDaysToDayKey(todayKey, 7);
  const weekEndIso = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const spendStartKey = addDaysToDayKey(todayKey, -SPEND_WINDOW_DAYS);

  // The family's OWN data → the coarse buckets they'd contribute (shown only to
  // them; nothing shared or stored). The same sources and the same bands as the
  // nightly aggregation, so the preview IS what would leave the household.
  //
  // settleAll, not Promise.all and not #423's `cnt`. Both concerns are real and
  // both are met here. #423 was right that a rejected batch must not take the
  // page down — settleAll answers a rejection with { data, count, error }, so it
  // cannot. But `cnt` returned 0 for a failed read, which is the private
  // safeCount pattern lib/metric/count.ts exists to end: on this page a 0 would
  // tell a family their household is smaller than it is, and then invite them to
  // share that. The reads settle, and `previewError` below fails the whole
  // preview closed on the first error rather than previewing a lie.
  const seesSpending = readsHouseholdMoney(ctx.active.role);
  const [members, mealPlans, teams, classes, chores, bedtimes, spend, reminders, legacyReminders] = await settleAll([
    supabase.from('family_members').select('id, birthday, role').eq('family_id', familyId).eq('is_active', true),
    supabase.from('meal_plans').select('plan_date').eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', todayKey).lt('plan_date', weekEndKey),
    supabase.from('teams').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_active', true),
    supabase.from('school_classes').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
    supabase.from('chore_assignments').select('member_id').eq('family_id', familyId).in('status', [...OPEN_CHORE_STATUSES]),
    supabase.from('bedtime_routines').select('member_id, target_bedtime').eq('family_id', familyId).eq('is_active', true),
    // The household's spending is a parent's or adult's (the held 0514): anyone
    // else's preview leaves the spend band out rather than band their own.
    // The band is a SUM of this read, so it is read whole, paged on the id as
    // the nightly aggregation reads it: one request stopped at PostgREST's
    // 1,000 rows, and a busy household was banded on part of its spending.
    seesSpending
      ? readAllByIdAsQuery<{ id: string; amount: number }>((after, limit) => {
        let query = supabase.from('transactions').select('id, amount').eq('family_id', familyId).eq('type', 'expense').gt('date', spendStartKey).lte('date', todayKey);
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: SPEND_READ_MAX })
      : Promise.resolve({ data: [] as { amount: number }[], error: null }),
    // The Reminders module's own table, open and due this week, as the nightly
    // aggregation counts it; then the legacy table's OPEN rows, which still
    // have writers. The legacy count alone banded a family whose reminders all
    // live in the module as "none".
    supabase.from('family_reminders').select('id', { count: 'exact', head: true }).eq('family_id', familyId)
      .in('status', [...OPEN_REMINDER_STATUSES]).gte('remind_at', now.toISOString()).lte('remind_at', weekEndIso).or(remindersStillDueBy(weekEndIso)),
    supabase.from('reminders').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_done', false).gte('remind_at', now.toISOString()).lte('remind_at', weekEndIso),
  ]);
  const previewError = [members, mealPlans, teams, classes, chores, bedtimes, spend, reminders, legacyReminders].map((r) => r.error).find(Boolean);
  if (previewError) {
    console.error('[intelligence] contribution preview read failed', previewError);
    return <IntelligenceReadError />;
  }

  const memberRows = members.data ?? [];
  const childIds = new Set(memberRows.filter((m) => CHILD_ROLES.has(m.role)).map((m) => m.id));
  const input: ContributionInput = {
    memberBirthdays: memberRows.map((m) => m.birthday),
    householdSize: memberRows.length,
    plannedDinnersPerWeek: new Set((mealPlans.data ?? []).map((m) => m.plan_date)).size,
    activeActivities: (teams.count ?? 0) + (classes.count ?? 0),
    childCount: childIds.size,
    openChoreAssignments: (chores.data ?? []).filter((c) => childIds.has(c.member_id)).length,
    childBedtimeMinutes: (bedtimes.data ?? [])
      .filter((b) => childIds.has(b.member_id))
      .map((b) => bedtimeToMinutes(b.target_bedtime))
      .filter((m): m is number => m !== null),
    typicalWeeklySpend: seesSpending ? typicalWeeklySpend((spend.data ?? []).map((t) => Number(t.amount)), SPEND_WINDOW_DAYS) : null,
    remindersPerWeek: (reminders.count ?? 0) + (legacyReminders.count ?? 0),
  };

  // Published aggregates for THIS family's cohort (RLS already restricts rows to
  // opted-in scopes), fresh ones only — rows a run that kept failing left
  // behind are not the network's answer. Fresh says the cron still stands
  // behind the figures, not that a family that withdrew is out of them: the
  // held snapshot keeps its share until the next epoch's (aggregate.ts,
  // AGGREGATE_MAX_AGE_MS).
  //
  // `cohort_size` is not selected here. It is the TRUE family count beside the
  // noised `count`, and through this read any member of the family — a child
  // included — could take it for every cohort. The k-floor is re-checked on the
  // server below with the service role instead, and the number stops there:
  // the module gets the noised count and a confidence derived from it.
  const myCohort = cohortKey(contributionFeatures(input, now));
  const { data: aggRows, error: aggError } = await supabase
    .from('network_aggregates')
    .select('id, scope, cohort_key, metric, value, count')
    .eq('cohort_key', myCohort)
    .gte('computed_at', freshAggregatesSince(now))
    .limit(500);
  if (aggError) {
    console.error('[intelligence] network aggregate read failed', aggError);
    return <IntelligenceReadError />;
  }
  const visibleRows = aggRows ?? [];
  // A floor that could not be checked shows no insight rather than an
  // unchecked one, and leaves the consent controls on screen.
  const trueSizes = await readTrueCohortSizes(visibleRows.map((a) => a.id));
  const aggregates: NetworkAggregate[] = trueSizes.ok
    ? visibleRows.flatMap((a) => {
      const cohortSize = trueSizes.sizes.get(a.id);
      return cohortSize === undefined ? [] : [{
        scope: a.scope as ConsentScope, cohortKey: a.cohort_key, metric: a.metric,
        value: a.value, count: a.count, cohortSize,
      }];
    })
    : [];
  // `t` so the two insight sentences reach the reader in their own language.
  const candidates: NetworkInsight[] = publishableInsights(aggregatesToInsights(aggregates, myCohort, t));

  // Does /resources/benchmarks exist right now? The public page 404s unless the
  // admin publication flag is on, and marketing_settings is admin-only, so the
  // answer has to come from the service role here rather than from the module.
  // False on any failure — the card is omitted rather than linking to a 404.
  const capturePromise = loadAutomaticCaptureShare(supabase, familyId, now);
  const benchmarksPublished = await benchmarksPageIsPublished();
  const automaticCapture = await capturePromise;

  return (
    <div className="space-y-6">
      <AutomaticCaptureCard result={automaticCapture} />
      <IntelligenceModule
        contribution={computeContribution(input, now)}
        candidates={candidates}
        benchmarksPublished={benchmarksPublished}
      />
    </div>
  );
}

async function IntelligenceReadError() {
  const t = await getTranslations();
  return (
    <div className="space-y-4">
      <ErrorState message={t('intelligence.couldNotLoadContributionPreview')} />
      <a href="/dashboard/intelligence" className="text-sm font-medium text-brand-text underline">{t('intelligence.refreshIntelligence')}</a>
    </div>
  );
}
