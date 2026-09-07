import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';
import { IntelligenceModule } from '@/components/modules/intelligence-module';
import {
  computeContribution, contributionFeatures, bedtimeToMinutes, typicalWeeklySpend, type ContributionInput,
} from '@/lib/network/contribution';
import { cohortKey, aggregatesToInsights, type NetworkAggregate } from '@/lib/network/aggregate';
import { CHILD_ROLES, OPEN_CHORE_STATUSES, SPEND_WINDOW_DAYS } from '@/lib/network/aggregate-server';
import { benchmarksPageIsPublished } from '@/lib/network/benchmarks-server';
import type { ConsentScope } from '@/lib/network/insights';

export const metadata: Metadata = { title: 'Intelligence Network | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function IntelligencePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const weekEndKey = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const weekEndIso = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const spendStartKey = new Date(now.getTime() - SPEND_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  // The family's OWN data → the coarse buckets they'd contribute (shown only to
  // them; nothing shared or stored). The same sources and the same bands as the
  // nightly aggregation, so the preview IS what would leave the household.
  const [members, mealPlans, teams, classes, chores, bedtimes, spend, reminders] = await Promise.all([
    supabase.from('family_members').select('id, birthday, role').eq('family_id', familyId).eq('is_active', true),
    supabase.from('meal_plans').select('plan_date').eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', todayKey).lte('plan_date', weekEndKey),
    supabase.from('teams').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_active', true),
    supabase.from('school_classes').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
    supabase.from('chore_assignments').select('member_id').eq('family_id', familyId).in('status', [...OPEN_CHORE_STATUSES]),
    supabase.from('bedtime_routines').select('member_id, target_bedtime').eq('family_id', familyId).eq('is_active', true),
    supabase.from('transactions').select('amount').eq('family_id', familyId).eq('type', 'expense').gte('date', spendStartKey).lte('date', todayKey),
    supabase.from('reminders').select('id', { count: 'exact', head: true }).eq('family_id', familyId).gte('remind_at', now.toISOString()).lte('remind_at', weekEndIso),
  ]);
  const previewError = [members, mealPlans, teams, classes, chores, bedtimes, spend, reminders].map((r) => r.error).find(Boolean);
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
    typicalWeeklySpend: typicalWeeklySpend((spend.data ?? []).map((t) => Number(t.amount)), SPEND_WINDOW_DAYS),
    remindersPerWeek: reminders.count ?? 0,
  };

  // Published aggregates for THIS family's cohort (RLS already restricts rows to
  // opted-in scopes). Mapped to candidates; the module re-gates via visibleInsights.
  const myCohort = cohortKey(contributionFeatures(input, now));
  const { data: aggRows, error: aggError } = await supabase
    .from('network_aggregates')
    .select('scope, cohort_key, metric, value, count, cohort_size')
    .eq('cohort_key', myCohort)
    .limit(500);
  if (aggError) {
    console.error('[intelligence] network aggregate read failed', aggError);
    return <IntelligenceReadError />;
  }
  const aggregates: NetworkAggregate[] = (aggRows ?? []).map((a) => ({
    scope: a.scope as ConsentScope, cohortKey: a.cohort_key, metric: a.metric,
    value: a.value, count: a.count, cohortSize: a.cohort_size,
  }));
  // `t` so the two insight sentences reach the reader in their own language.
  const candidates = aggregatesToInsights(aggregates, myCohort, t);

  // Does /resources/benchmarks exist right now? The public page 404s unless the
  // admin publication flag is on, and marketing_settings is admin-only, so the
  // answer has to come from the service role here rather than from the module.
  // False on any failure — the card is omitted rather than linking to a 404.
  const benchmarksPublished = await benchmarksPageIsPublished();

  return (
    <IntelligenceModule
      contribution={computeContribution(input, now)}
      candidates={candidates}
      benchmarksPublished={benchmarksPublished}
    />
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
