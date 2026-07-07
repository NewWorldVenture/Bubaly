// Intelligence Network aggregation — service-callable core (no request context).
// Called by the network-aggregate cron with the service client. Two phases:
//   1. CONTRIBUTE — for every consenting family, recompute its coarse feature row
//      from its OWN data and upsert network_contributions (opted-out families are
//      deleted). This is the only place raw family data is read, and only banded
//      features leave the family row.
//   2. AGGREGATE — read all contributions, run the pure k-anonymity + DP + gating
//      core, and replace network_aggregates with the publish-safe rows.
// Nothing here can bypass aggregate.ts's guarantees.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { contributionFeatures, type ContributionInput } from './contribution';
import {
  aggregateContributions, cohortKey, laplaceNoise, filterMetricsByScopes,
  AGG_DEFAULTS, type Contribution,
} from './aggregate';
import type { ConsentScope } from './insights';

type DB = SupabaseClient<Database>;

export type AggregateResult = { ok: boolean; error?: string; contributors: number; aggregates: number };

function dinnerBandToMetric(band: string): string { return band; } // already banded

/** Build one family's coarse contribution from its own real data. */
async function buildContribution(sb: DB, familyId: string, now: Date): Promise<Contribution | null> {
  const todayKey = now.toISOString().slice(0, 10);
  const weekEndKey = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const [members, dinners, teams, classes] = await Promise.all([
    sb.from('family_members').select('birthday').eq('family_id', familyId).eq('is_active', true),
    sb.from('meal_plans').select('plan_date').eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', todayKey).lte('plan_date', weekEndKey),
    sb.from('teams').select('id').eq('family_id', familyId).eq('is_active', true),
    sb.from('school_classes').select('id').eq('family_id', familyId),
  ]);
  if (members.error) return null;
  const birthdays = (members.data ?? []).map((m) => m.birthday);
  const input: ContributionInput = {
    memberBirthdays: birthdays,
    householdSize: birthdays.length,
    plannedDinnersPerWeek: new Set((dinners.data ?? []).map((d) => d.plan_date)).size,
    activeActivities: (teams.data?.length ?? 0) + (classes.data?.length ?? 0),
  };
  const features = contributionFeatures(input, now);
  return {
    familyId,
    features,
    metrics: {
      dinner_habit: dinnerBandToMetric(features.dinnerBand),
      activities: features.activityBand,
    },
  };
}

export async function runNetworkAggregation(sb: DB, now: Date = new Date()): Promise<AggregateResult> {
  // 1. Which families are opted in (master toggle on)?
  const { data: consents, error: cErr } = await sb.from('network_consent')
    .select('family_id, enabled, scopes').eq('enabled', true);
  if (cErr) return { ok: false, error: cErr.message, contributors: 0, aggregates: 0 };

  const optedIn = consents ?? [];

  // 2. CONTRIBUTE — refresh each opted-in family's coarse row; drop everyone else's.
  // Granular consent is enforced HERE: only metrics whose scope the family
  // toggled on are kept, so an opt-in to (say) 'timing' alone never feeds the
  // 'benchmarks' aggregates.
  const contributions: Contribution[] = [];
  for (const c of optedIn) {
    // Per-family isolation: one family's bad data or a transient read error must
    // never abort the whole nightly aggregation for everyone else.
    try {
      const contrib = await buildContribution(sb, c.family_id, now);
      if (!contrib) continue;
      const scopes = (c.scopes ?? {}) as Partial<Record<ConsentScope, boolean>>;
      contrib.metrics = filterMetricsByScopes(contrib.metrics, scopes);
      contributions.push(contrib);
      const { error: upErr } = await sb.from('network_contributions').upsert({
        family_id: c.family_id,
        cohort_key: cohortKey(contrib.features),
        features: contrib.features as unknown as Database['public']['Tables']['network_contributions']['Insert']['features'],
        metrics: contrib.metrics,
        scopes: c.scopes,
      }, { onConflict: 'family_id' });
      if (upErr) console.error(`network_contributions upsert failed for ${c.family_id}:`, upErr.message);
    } catch (err) {
      console.error(`network contribution failed for family ${c.family_id}:`, err);
    }
  }
  // Right-to-be-forgotten: remove contributions for families no longer opted in.
  const keepIds = new Set(optedIn.map((c) => c.family_id));
  const { data: existing } = await sb.from('network_contributions').select('family_id');
  for (const row of existing ?? []) {
    if (!keepIds.has(row.family_id)) await sb.from('network_contributions').delete().eq('family_id', row.family_id);
  }

  // 3. AGGREGATE — pure k-anonymity + DP noise + launch gate.
  const aggregates = aggregateContributions(contributions, {
    minCohort: AGG_DEFAULTS.minCohort,
    globalMinFamilies: AGG_DEFAULTS.globalMinFamilies,
    noise: (scale) => laplaceNoise(scale),
  });

  // 4. Republish: upsert the new set on the natural key, THEN prune rows this run
  //    didn't touch (stale computed_at). Avoids the delete-all-then-insert window
  //    where a failed insert would leave the table silently empty.
  if (aggregates.length) {
    const { error: upsertErr } = await sb.from('network_aggregates').upsert(
      aggregates.map((a) => ({
        scope: a.scope, cohort_key: a.cohortKey, metric: a.metric, value: a.value,
        count: a.count, cohort_size: a.cohortSize, computed_at: now.toISOString(),
      })),
      { onConflict: 'scope,cohort_key,metric,value' },
    );
    if (upsertErr) return { ok: false, error: upsertErr.message, contributors: contributions.length, aggregates: 0 };
  }
  const { error: pruneErr } = await sb.from('network_aggregates').delete().lt('computed_at', now.toISOString());
  if (pruneErr) return { ok: false, error: pruneErr.message, contributors: contributions.length, aggregates: aggregates.length };

  return { ok: true, contributors: contributions.length, aggregates: aggregates.length };
}
