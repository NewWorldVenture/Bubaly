import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { IntelligenceModule } from '@/components/modules/intelligence-module';
import { computeContribution, contributionFeatures, type ContributionInput } from '@/lib/network/contribution';
import { cohortKey, aggregatesToInsights, type NetworkAggregate } from '@/lib/network/aggregate';
import type { ConsentScope } from '@/lib/network/insights';

export const metadata: Metadata = { title: 'Intelligence Network | Bubaly' };
export const dynamic = 'force-dynamic';

async function cnt(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count: n, error } = await q; return error ? 0 : (n ?? 0);
}

export default async function IntelligencePage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const weekEndKey = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  // The family's OWN data → the coarse buckets they'd contribute (shown only to
  // them; nothing shared or stored). Best-effort: a missing table yields 0/empty.
  const [members, mealPlans, teams, classes] = await Promise.all([
    supabase.from('family_members').select('birthday').eq('family_id', familyId).eq('is_active', true),
    supabase.from('meal_plans').select('plan_date').eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', todayKey).lte('plan_date', weekEndKey),
    cnt(supabase.from('teams').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_active', true)),
    cnt(supabase.from('school_classes').select('id', { count: 'exact', head: true }).eq('family_id', familyId)),
  ]);

  const birthdays = (members.data ?? []).map((m) => m.birthday);
  const input: ContributionInput = {
    memberBirthdays: birthdays,
    householdSize: birthdays.length,
    plannedDinnersPerWeek: new Set((mealPlans.data ?? []).map((m) => m.plan_date)).size,
    activeActivities: teams + classes,
  };

  // Published aggregates for THIS family's cohort (RLS already restricts rows to
  // opted-in scopes). Mapped to candidates; the module re-gates via visibleInsights.
  const myCohort = cohortKey(contributionFeatures(input, now));
  const { data: aggRows } = await supabase
    .from('network_aggregates')
    .select('scope, cohort_key, metric, value, count, cohort_size')
    .eq('cohort_key', myCohort)
    .limit(500);
  const aggregates: NetworkAggregate[] = (aggRows ?? []).map((a) => ({
    scope: a.scope as ConsentScope, cohortKey: a.cohort_key, metric: a.metric,
    value: a.value, count: a.count, cohortSize: a.cohort_size,
  }));
  const candidates = aggregatesToInsights(aggregates, myCohort);

  return <IntelligenceModule contribution={computeContribution(input, now)} candidates={candidates} />;
}
