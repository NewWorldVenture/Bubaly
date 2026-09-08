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
import { settleAll } from '@/lib/supabase/settle';
import type { Database } from '@/lib/database.types';
import {
  contributionFeatures, bedtimeToMinutes, typicalWeeklySpend, type ContributionInput,
} from './contribution';
import {
  aggregateContributions, cohortKey, laplaceNoise, filterMetricsByScopes,
  AGG_DEFAULTS, type Contribution,
} from './aggregate';
import type { ConsentScope } from './insights';

type DB = SupabaseClient<Database>;

export type AggregateResult = { ok: boolean; error?: string; contributors: number; aggregates: number };

/** Roles whose members count as children for chores-per-child and bedtime. */
export const CHILD_ROLES = new Set(['child', 'teen']);
/** Chore assignments still in play — what "open chores" means everywhere here. */
export const OPEN_CHORE_STATUSES = ['todo', 'in_progress', 'submitted'] as const;
/** Trailing window the weekly-spend band is smoothed over (four weeks → one). */
export const SPEND_WINDOW_DAYS = 28;

/**
 * A family's banded features → the metric row it contributes. Only bands leave
 * the household: a metric whose band is null (no children, no tracked spend) is
 * simply absent, so it cannot skew a cohort with a fake "0".
 */
export const featuresToContribution = (familyId: string, input: ContributionInput, now: Date): Contribution => {
  const features = contributionFeatures(input, now);
  const metrics: Record<string, string> = {
    dinner_habit: features.dinnerBand,
    activities: features.activityBand,
  };
  if (features.remindersBand !== null) metrics.reminders_per_week = features.remindersBand;
  if (features.choresPerChildBand !== null) metrics.chores_per_child = features.choresPerChildBand;
  if (features.bedtimeBand !== null) metrics.bedtime_band = features.bedtimeBand;
  if (features.weeklySpendBand !== null) metrics.weekly_spend_band = features.weeklySpendBand;
  return { familyId, features, metrics };
};

/**
 * Build every opted-in family's coarse contribution in EIGHT queries total (one
 * per source table, `.in(family_ids)`) rather than eight-per-family — so the
 * nightly cron scales past the ≥100-family launch gate without N+1 round-trips.
 * Returns a map keyed by family_id; a family with no rows still gets a valid
 * (empty-household) contribution. Returns null only on a hard read error.
 */
async function buildContributionsBatch(sb: DB, familyIds: string[], now: Date): Promise<Map<string, Contribution> | null> {
  if (familyIds.length === 0) return new Map();
  const todayKey = now.toISOString().slice(0, 10);
  const weekEndKey = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const spendStartKey = new Date(now.getTime() - SPEND_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const weekEndIso = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const [members, dinners, teams, classes, chores, bedtimes, spend, reminders] = await settleAll([
    sb.from('family_members').select('id, family_id, birthday, role').in('family_id', familyIds).eq('is_active', true),
    sb.from('meal_plans').select('family_id, plan_date').in('family_id', familyIds).eq('meal_type', 'dinner').gte('plan_date', todayKey).lte('plan_date', weekEndKey),
    sb.from('teams').select('family_id').in('family_id', familyIds).eq('is_active', true),
    sb.from('school_classes').select('family_id').in('family_id', familyIds),
    sb.from('chore_assignments').select('family_id, member_id').in('family_id', familyIds).in('status', [...OPEN_CHORE_STATUSES]),
    sb.from('bedtime_routines').select('family_id, member_id, target_bedtime').in('family_id', familyIds).eq('is_active', true),
    sb.from('transactions').select('family_id, amount').in('family_id', familyIds).eq('type', 'expense').gte('date', spendStartKey).lte('date', todayKey),
    sb.from('reminders').select('family_id').in('family_id', familyIds).gte('remind_at', now.toISOString()).lte('remind_at', weekEndIso),
  ]);
  const readError = [members, dinners, teams, classes, chores, bedtimes, spend, reminders].map((r) => r.error).find(Boolean);
  if (readError) {
    console.error('[network] family contribution source read failed', readError);
    return null;
  }

  const birthdaysByFam = new Map<string, (string | null)[]>();
  const childMemberIds = new Set<string>();
  const childCountByFam = new Map<string, number>();
  for (const m of members.data ?? []) {
    const arr = birthdaysByFam.get(m.family_id) ?? [];
    arr.push(m.birthday); birthdaysByFam.set(m.family_id, arr);
    if (CHILD_ROLES.has(m.role)) {
      childMemberIds.add(m.id);
      childCountByFam.set(m.family_id, (childCountByFam.get(m.family_id) ?? 0) + 1);
    }
  }
  const dinnerDatesByFam = new Map<string, Set<string>>();
  for (const d of dinners.data ?? []) {
    const set = dinnerDatesByFam.get(d.family_id) ?? new Set<string>();
    if (d.plan_date) set.add(d.plan_date); dinnerDatesByFam.set(d.family_id, set);
  }
  const countBy = (rows: { family_id: string }[] | null): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.family_id, (m.get(r.family_id) ?? 0) + 1);
    return m;
  };
  const teamsByFam = countBy(teams.data);
  const classesByFam = countBy(classes.data);
  const remindersByFam = countBy(reminders.data);
  // Only chores and bedtimes that belong to a CHILD member count — an adult's
  // own to-do or wind-down routine is not a "chores per child" or "kids' bedtime" signal.
  const openChoresByFam = countBy((chores.data ?? []).filter((c) => childMemberIds.has(c.member_id)));
  const bedtimesByFam = new Map<string, number[]>();
  for (const b of bedtimes.data ?? []) {
    if (!childMemberIds.has(b.member_id)) continue;
    const minutes = bedtimeToMinutes(b.target_bedtime);
    if (minutes === null) continue;
    const arr = bedtimesByFam.get(b.family_id) ?? [];
    arr.push(minutes); bedtimesByFam.set(b.family_id, arr);
  }
  const expensesByFam = new Map<string, number[]>();
  for (const t of spend.data ?? []) {
    const arr = expensesByFam.get(t.family_id) ?? [];
    arr.push(Number(t.amount)); expensesByFam.set(t.family_id, arr);
  }

  const out = new Map<string, Contribution>();
  for (const familyId of familyIds) {
    const birthdays = birthdaysByFam.get(familyId) ?? [];
    const input: ContributionInput = {
      memberBirthdays: birthdays,
      householdSize: birthdays.length,
      plannedDinnersPerWeek: dinnerDatesByFam.get(familyId)?.size ?? 0,
      activeActivities: (teamsByFam.get(familyId) ?? 0) + (classesByFam.get(familyId) ?? 0),
      childCount: childCountByFam.get(familyId) ?? 0,
      openChoreAssignments: openChoresByFam.get(familyId) ?? 0,
      childBedtimeMinutes: bedtimesByFam.get(familyId) ?? [],
      typicalWeeklySpend: typicalWeeklySpend(expensesByFam.get(familyId) ?? [], SPEND_WINDOW_DAYS),
      remindersPerWeek: remindersByFam.get(familyId) ?? 0,
    };
    out.set(familyId, featuresToContribution(familyId, input, now));
  }
  return out;
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
  const built = await buildContributionsBatch(sb, optedIn.map((c) => c.family_id), now);
  if (built === null) return { ok: false, error: 'failed to read family data', contributors: 0, aggregates: 0 };

  const contributions: Contribution[] = [];
  let contributionFailures = 0;
  for (const c of optedIn) {
    // Per-family isolation: one family's bad data or a transient write error must
    // never abort the whole nightly aggregation for everyone else.
    try {
      const contrib = built.get(c.family_id);
      if (!contrib) continue;
      const scopes = (c.scopes ?? {}) as Partial<Record<ConsentScope, boolean>>;
      contrib.metrics = filterMetricsByScopes(contrib.metrics, scopes);
      const { error: upErr } = await sb.from('network_contributions').upsert({
        family_id: c.family_id,
        cohort_key: cohortKey(contrib.features),
        features: contrib.features as unknown as Database['public']['Tables']['network_contributions']['Insert']['features'],
        metrics: contrib.metrics,
        scopes: c.scopes,
      }, { onConflict: 'family_id' });
      if (upErr) {
        contributionFailures++;
        console.error(`network_contributions upsert failed for ${c.family_id}:`, upErr.message);
        continue;
      }
      contributions.push(contrib);
    } catch (err) {
      contributionFailures++;
      console.error(`network contribution failed for family ${c.family_id}:`, err);
    }
  }
  // Right-to-be-forgotten: remove contributions for families no longer opted in —
  // in ONE delete rather than a read + N per-row deletes.
  const keepIds = optedIn.map((c) => c.family_id);
  let contributionDeleteError;
  if (keepIds.length > 0) {
    ({ error: contributionDeleteError } = await sb.from('network_contributions').delete().not('family_id', 'in', `(${keepIds.join(',')})`));
  } else {
    // No one opted in → clear every contribution (family_id is NOT NULL).
    ({ error: contributionDeleteError } = await sb.from('network_contributions').delete().not('family_id', 'is', null));
  }
  if (contributionDeleteError) return { ok: false, error: 'failed to prune contributions', contributors: contributions.length, aggregates: 0 };
  if (contributionFailures > 0) return { ok: false, error: 'failed to persist family contributions', contributors: contributions.length, aggregates: 0 };

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
