// Intelligence Network aggregation — service-callable core (no request context).
// Called by the network-aggregate cron with the service client. Three phases:
//   1. FORGET — prune the stored contribution of every family no longer
//      contributing (withdrawn, closed, no contributing scope, or a consent a
//      non-manager wrote), FIRST, so a failure anywhere later can never keep a
//      withdrawn family's row in place.
//   2. CONTRIBUTE — for every contributing family, recompute its coarse row
//      from its OWN data and upsert network_contributions. This is the only
//      place raw family data is read, and only bands leave the family row.
//   3. AGGREGATE — run the pure k-anonymity + DP + gating core over the
//      contributions, and replace network_aggregates with the publish-safe rows.
// Nothing here can bypass aggregate.ts's guarantees.

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import { readAll } from '@/lib/supabase/read-all';
import { readAllInChunks, writeInChunks } from '@/lib/supabase/chunked-in';
import type { Database } from '@/lib/database.types';
import { addDaysToDayKey, dayKeyInTz } from '@/lib/services/scope';
import { isManager } from '@/lib/constants/roles';
import {
  contributionFeatures, bedtimeToMinutes, typicalWeeklySpend, type ContributionInput,
} from './contribution';
import {
  aggregateContributions, cohortKey, contributesToNetwork, laplaceNoise, filterMetricsByScopes,
  AGG_DEFAULTS, type Contribution, type NoiseCell, type NoiseFn,
} from './aggregate';
import type { ConsentScope } from './insights';
import { describeActionError } from '@/lib/supabase/errors';

type DB = SupabaseClient<Database>;

export type AggregateResult = { ok: boolean; error?: string; contributors: number; aggregates: number };

/** Roles whose members count as children for chores-per-child and bedtime. */
export const CHILD_ROLES = new Set(['child', 'teen']);
/** Chore assignments still in play — what "open chores" means everywhere here. */
export const OPEN_CHORE_STATUSES = ['todo', 'in_progress', 'submitted'] as const;
/** Trailing window the weekly-spend band is smoothed over (four weeks → one). */
export const SPEND_WINDOW_DAYS = 28;
/**
 * family_reminders statuses that can still fire — the reminders services' own
 * reading: a snoozed reminder comes back, a completed one does not.
 */
export const OPEN_REMINDER_STATUSES = ['active', 'snoozed'] as const;

/**
 * A snoozed reminder counts for the week only when its snooze ends inside it —
 * the reminders services list a snoozed row as due once `snoozed_until` has
 * passed. An active row carries no snooze. One spelling for the nightly
 * aggregation and the consent preview, so the preview shows what is sent.
 */
export function remindersStillDueBy(weekEndIso: string): string {
  return `snoozed_until.is.null,snoozed_until.lte.${weekEndIso}`;
}

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

/** A contributing family and the zone its calendar days are read in. */
type FamilyDay = { id: string; tz: string };

/**
 * Build every contributing family's coarse contribution in NINE queries total
 * (one per source table, `.in(family_ids)`) rather than nine-per-family — so the
 * nightly cron scales past the ≥100-family launch gate without N+1 round-trips.
 * Returns a map keyed by family_id; a family with no rows still gets a valid
 * (empty-household) contribution. Returns null only on a hard read error.
 *
 * Every window is the FAMILY's: its seven days of dinners starting today,
 * [today, today + 7), and its 28 days of spending ending today, (today − 28,
 * today], on its own calendar (families.timezone). Both ends inclusive was an
 * eight-day week and a 29-day month — a household planning Monday to Friday
 * read as "most nights" five days in seven, and one spending 98 a week as
 * "100–250" — and Greenwich's day was the family's only for families in it.
 * The reads take the union of the families' windows; each family keeps only
 * its own.
 */
async function buildContributionsBatch(sb: DB, families: FamilyDay[], now: Date): Promise<Map<string, Contribution> | null> {
  if (families.length === 0) return new Map();
  const familyIds = families.map((f) => f.id);
  const todayOf = new Map(families.map((f) => [f.id, dayKeyInTz(now, f.tz)]));
  const todays = [...new Set(todayOf.values())].sort();
  const earliestToday = todays[0];
  const latestToday = todays[todays.length - 1];
  const nowIso = now.toISOString();
  const weekEndIso = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  // Nine reads, each chunked by family AND paged inside the chunk.
  //
  // One `.in()` over every opted-in family is short on both counts. The URL
  // outgrows the gateway's request line, and — the one that bites first — the
  // ROW count outgrows PostgREST's db-max-rows: these tables hold many rows per
  // family, so a few hundred households is already more than a thousand
  // members, chores or transactions. A short answer arrives with no error.
  //
  // And here a short answer cannot be noticed downstream, by construction: the
  // docstring above promises a family with no rows still gets a valid
  // empty-household contribution, so truncated data and a genuinely empty
  // household are the same input. The family is published into the network
  // aggregates with a childCount of zero, no bedtimes and no spend — wrong
  // bands, in the benchmarks every other family reads.
  //
  // Each read orders by `id` rather than `family_id`: paging needs a unique
  // order, and the column being filtered on is the least unique one there is.
  //
  // Reminders are the Reminders module's: `family_reminders` is canonical (the
  // reminders services' D4), and a household with ten reminders due this week
  // there read as "none" while only the legacy table was counted. The legacy
  // table still has writers, so its OPEN rows count too.
  const [members, dinners, teams, classes, chores, bedtimes, spend, reminders, legacyReminders] = await settleAll([
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('family_members').select('id, family_id, birthday, role').in('family_id', chunk).eq('is_active', true).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('meal_plans').select('family_id, plan_date').in('family_id', chunk).eq('meal_type', 'dinner').gte('plan_date', earliestToday).lt('plan_date', addDaysToDayKey(latestToday, 7)).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('teams').select('family_id').in('family_id', chunk).eq('is_active', true).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('school_classes').select('family_id').in('family_id', chunk).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('chore_assignments').select('family_id, member_id').in('family_id', chunk).in('status', [...OPEN_CHORE_STATUSES]).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('bedtime_routines').select('family_id, member_id, target_bedtime').in('family_id', chunk).eq('is_active', true).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('transactions').select('family_id, amount, date').in('family_id', chunk).eq('type', 'expense').gt('date', addDaysToDayKey(earliestToday, -SPEND_WINDOW_DAYS)).lte('date', latestToday).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('family_reminders').select('family_id').in('family_id', chunk).in('status', [...OPEN_REMINDER_STATUSES]).gte('remind_at', nowIso).lte('remind_at', weekEndIso).or(remindersStillDueBy(weekEndIso)).order('id').range(from, to)),
    readAllInChunks(familyIds, (chunk, from, to) => sb.from('reminders').select('family_id').in('family_id', chunk).eq('is_done', false).gte('remind_at', nowIso).lte('remind_at', weekEndIso).order('id').range(from, to)),
  ]);
  const readError = [members, dinners, teams, classes, chores, bedtimes, spend, reminders, legacyReminders].map((r) => r.error).find(Boolean);
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
    const today = todayOf.get(d.family_id);
    if (!today || !d.plan_date || d.plan_date < today || d.plan_date >= addDaysToDayKey(today, 7)) continue;
    const set = dinnerDatesByFam.get(d.family_id) ?? new Set<string>();
    set.add(d.plan_date); dinnerDatesByFam.set(d.family_id, set);
  }
  const countBy = (rows: { family_id: string }[] | null): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.family_id, (m.get(r.family_id) ?? 0) + 1);
    return m;
  };
  const teamsByFam = countBy(teams.data);
  const classesByFam = countBy(classes.data);
  const remindersByFam = countBy([...(reminders.data ?? []), ...(legacyReminders.data ?? [])]);
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
    const today = todayOf.get(t.family_id);
    if (!today || !t.date || t.date <= addDaysToDayKey(today, -SPEND_WINDOW_DAYS) || t.date > today) continue;
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

type ConsentRow = {
  family_id: string;
  enabled: boolean;
  scopes: Database['public']['Tables']['network_consent']['Row']['scopes'];
  consented_by: string | null;
  /** The `families!inner(closed_at, timezone)` embed; the generated types do not model the relation. */
  family: unknown;
};

/** The family's zone from the consent read's embed, UTC when it has none. */
function familyZone(c: ConsentRow): string {
  const zone = (c.family as { timezone?: unknown } | null)?.timezone;
  return typeof zone === 'string' && zone.trim() !== '' ? zone : 'UTC';
}

/**
 * Families whose consent was written by a member who may not give it.
 *
 * Joining shares the household's data, so it is a manager's decision — the
 * database has refused anyone else's write since 0353. But 0353 changed the
 * policies and left the rows: a consent a child, teen, guest or caregiver
 * switched on before it is still `enabled`, and nothing here asked who wrote
 * it. A consent whose author is an ACTIVE member of that family in a
 * non-manager role is not honoured. An author who is no longer a member (or
 * whose account is gone, `consented_by` null) cannot be judged from here and is
 * left to the owner's re-consent sweep, as are scope switches, which record no
 * author at all.
 */
async function consentsByNonManagers(sb: DB, consents: ConsentRow[]): Promise<{ error: unknown; families: Set<string> }> {
  const authorOf = new Map(consents.filter((c) => c.consented_by).map((c) => [c.family_id, c.consented_by as string]));
  // Chunked by family with the author ids beside them: both lists travel in the
  // URL, so fifty of each keeps the request line near the one a hundred ids make.
  const { data, error } = await readAllInChunks<{ id: string; family_id: string; user_id: string | null; role: string }>(
    [...authorOf.keys()],
    (chunk, from, to) => sb.from('family_members').select('id, family_id, user_id, role')
      .in('family_id', chunk).in('user_id', chunk.map((familyId) => authorOf.get(familyId) as string))
      .eq('is_active', true).order('id').range(from, to),
    { chunkSize: 50 },
  );
  if (error || !data) return { error: error ?? { message: 'consent author read returned no rows' }, families: new Set() };
  const families = new Set<string>();
  for (const m of data) {
    if (m.user_id && authorOf.get(m.family_id) === m.user_id && !isManager(m.role)) families.add(m.family_id);
  }
  return { error: null, families };
}

/** Domain separation for the one HMAC this module computes. */
const NOISE_DOMAIN = 'network-aggregate-noise\0';
const DEV_NOISE_KEY = 'bubaly-dev-network-noise';

/**
 * The secret the sticky noise is keyed on: the server's internal secret, or
 * the service-role key the cron already needs. Production without either is
 * refused (null) rather than keyed on a constant anyone can read here — with a
 * public key the draws could be recomputed and subtracted.
 */
function noiseKey(): string | null {
  const configured = [process.env.INTERNAL_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  if (configured) return configured;
  return process.env.NODE_ENV === 'production' ? null : DEV_NOISE_KEY;
}

/**
 * STICKY Laplace noise: the draw is a keyed hash of the band and the TRUE
 * counts of its whole (cohort, metric) — `cell.bandVector`, every band of the
 * metric withheld ones included.
 *
 * `Math.random()` drew afresh for every cell on every nightly run, so an
 * unchanged band published a new sample of the same number each night; at
 * scale 1.5 (sd ≈ 2.1) the mean of a month of /resources/benchmarks scrapes is
 * within 0.4 of the true count, and one family joining shows as a step of 1 in
 * it. Keyed on the metric's state, a night that changed nothing republishes the
 * same figures, and a metric that returns to an earlier state returns to that
 * state's figures: repetition adds nothing.
 *
 * Keyed on the band's OWN count instead, a figure moved only when that band's
 * count moved, so the diff of two nights was a change detector: every figure
 * that differed was a band the family that joined or left occupies, and every
 * one that did not was a band it is not in (the probe — a cohort of 70 and one
 * household leaving, over 2000 keys: only its cells ever changed). Now any
 * change inside a (cohort, metric) redraws all of its bands at once, each
 * independent of its last draw, so a diff says that the metric changed in that
 * cohort — and neither which band, nor by how much.
 */
export function stickyNoise(key: string): NoiseFn {
  return (scale, cell) => laplaceNoise(scale, () => cellUniform(key, cell));
}

function cellUniform(key: string, cell: NoiseCell): number {
  const digest = createHmac('sha256', key).update(NOISE_DOMAIN)
    .update(JSON.stringify([cell.scope, cell.cohortKey, cell.metric, cell.value, cell.cohortSize, cell.bandVector]))
    .digest();
  // 48 bits, strictly inside (0, 1): the Laplace inverse never meets log(0).
  return (digest.readUIntBE(0, 6) + 0.5) / 2 ** 48;
}

export async function runNetworkAggregation(sb: DB, now: Date = new Date()): Promise<AggregateResult> {
  // 1. Which families are opted in (master toggle on)?
  // Read whole, by paging. A short read here is not just a smaller
  // aggregation: `keep` below is built from this list and drives the prune, so
  // an opted-in family beyond PostgREST's db-max-rows would have its
  // contribution DELETED as if it had opted out — and then be missing from the
  // aggregates it consented to feed.
  const { rows: consents, error: cErr } = await readAll<ConsentRow>((from, to) => sb.from('network_consent')
    // OPEN families only (families.closed_at): a closed account stops feeding
    // the network, and the prune below removes its stored contribution as it
    // does a withdrawn consent's. Reopening contributes again the next night.
    .select('family_id, enabled, scopes, consented_by, family:families!inner(closed_at, timezone)').is('family.closed_at', null)
    .eq('enabled', true).order('family_id').range(from, to));
  if (cErr) return { ok: false, error: describeActionError(cErr), contributors: 0, aggregates: 0 };

  // Granular consent decides who contributes at all. A family with no scope a
  // metric belongs to is not read, not stored and not counted toward the
  // launch gate: switched on with every scope off, it was the 70 of "30
  // benchmark families plus 70 who only flipped the master switch" that
  // opened publication for the other 30.
  const optedIn = consents.filter((c) => contributesToNetwork(c.scopes as Partial<Record<ConsentScope, boolean>> | null));
  const unauthorised = await consentsByNonManagers(sb, optedIn);
  const contributing = optedIn.filter((c) => !unauthorised.families.has(c.family_id));

  // 2. FORGET, before anything else can fail.
  //
  // The prune used to run after the eight source reads and the per-family
  // upserts, so a run that failed in either returned with the withdrawn
  // family's row still stored — and the previous aggregates, with that family
  // inside them, still published — for as long as the failures repeated. It
  // depends on nothing but the consent read now. (When the author read above
  // fails, `contributing` is every opted-in family: the prune is then no
  // narrower than it was, and the run reports the failure after it.)
  //
  // The natural spelling is one `not in (keepIds)` delete, and it is the wrong
  // one at this scale. A PostgREST filter travels in the query string, so that
  // list costs about 40 bytes per family (chunked-in.ts measures it), and it is
  // the list of everyone STILL opted in — deliberately uncapped, because the
  // consent read above pages precisely so that no consenting family is missed.
  // Past the gateway's request-line limit the delete answers `URI too long`,
  // the run reports 'failed to prune contributions', and nothing is written
  // before it, so the next night selects the identical set and fails
  // identically. At the common 8 KB limit that begins at roughly two hundred
  // consenting families: paging the read to keep the list complete is exactly
  // what removed the list's ceiling.
  //
  // Chunking cannot rescue `not in` — `family_id not in (chunk)` deletes every
  // row outside that chunk, which is every other chunk's rows. So invert the
  // set: read which families the table actually holds, subtract the ones still
  // opted in, and delete that remainder by `.in()` a hundred at a time. The
  // remainder is also the far smaller list — the families who withdrew since
  // the last run, not the whole network — and it subsumes the old empty-keep
  // branch, since nobody opted in makes every stored row stale.
  const keep = new Set(contributing.map((c) => c.family_id));
  const { rows: stored, error: storedError } = await readAll<{ family_id: string }>((from, to) => sb
    .from('network_contributions').select('family_id').order('family_id').range(from, to));
  // A short read here would leave a withdrawn family's contribution in place,
  // which is the one failure this block exists to prevent, so it fails the run
  // rather than pruning what it happened to see.
  if (storedError) return { ok: false, error: 'failed to prune contributions', contributors: 0, aggregates: 0 };
  const staleIds = [...new Set(stored.map((r) => r.family_id))].filter((id) => !keep.has(id));
  // A family that withdraws between this read and the delete is pruned by the
  // next run — the old delete had the same window, one statement narrower.
  // Rows deliberately not checked: the ERROR fails the run below, and
  // zero rows means nobody opted out since the last one. Audit C1-S9-69.
  const { error: contributionDeleteError } = await writeInChunks(staleIds, (chunk) => sb
    .from('network_contributions').delete().in('family_id', chunk));
  if (contributionDeleteError) return { ok: false, error: 'failed to prune contributions', contributors: 0, aggregates: 0 };
  if (unauthorised.error) {
    console.error('[network] consent author read failed', unauthorised.error);
    return { ok: false, error: 'failed to read who consented', contributors: 0, aggregates: 0 };
  }

  const key = noiseKey();
  if (!key) {
    console.error('[network] no INTERNAL_SECRET or SUPABASE_SERVICE_ROLE_KEY: refusing to publish with noise keyed on a public constant');
    return { ok: false, error: 'network noise key is not configured', contributors: 0, aggregates: 0 };
  }

  // 3. CONTRIBUTE — refresh each contributing family's coarse row.
  // Granular consent is enforced HERE as well: only metrics whose scope the
  // family toggled on are kept, so an opt-in to (say) 'timing' alone never
  // feeds the 'benchmarks' aggregates.
  const built = await buildContributionsBatch(
    sb, contributing.map((c) => ({ id: c.family_id, tz: familyZone(c) })), now,
  );
  if (built === null) return { ok: false, error: 'failed to read family data', contributors: 0, aggregates: 0 };

  const contributions: Contribution[] = [];
  let contributionFailures = 0;
  for (const c of contributing) {
    // Per-family isolation: one family's bad data or a transient write error must
    // never abort the whole nightly aggregation for everyone else.
    try {
      const contrib = built.get(c.family_id);
      if (!contrib) continue;
      const scopes = (c.scopes ?? {}) as Partial<Record<ConsentScope, boolean>>;
      contrib.metrics = filterMetricsByScopes(contrib.metrics, scopes);
      // Unreachable while dinner and activities are always banded, and kept
      // that way: a family whose consent leaves it no metric contributes no row.
      if (Object.keys(contrib.metrics).length === 0) continue;
      const { error: upErr } = await sb.from('network_contributions').upsert({
        family_id: c.family_id,
        cohort_key: cohortKey(contrib.features),
        // The cohort's two dimensions and nothing else: every band the family
        // consented to share is in `metrics`, and one it did not is nowhere.
        features: { childBands: contrib.features.childBands, sizeBand: contrib.features.sizeBand },
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
  if (contributionFailures > 0) return { ok: false, error: 'failed to persist family contributions', contributors: contributions.length, aggregates: 0 };

  // 4. AGGREGATE — pure k-anonymity + sticky DP noise (one draw per band per
  //    state of its whole cohort-metric) + launch gate.
  const aggregates = aggregateContributions(contributions, {
    minCohort: AGG_DEFAULTS.minCohort,
    globalMinFamilies: AGG_DEFAULTS.globalMinFamilies,
    noise: stickyNoise(key),
  });

  // 5. Republish: upsert the new set on the natural key, THEN prune rows this run
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
    if (upsertErr) return { ok: false, error: describeActionError(upsertErr), contributors: contributions.length, aggregates: 0 };
  }
  // Rows deliberately not checked: zero is the ordinary "nothing older" run.
  // Audit C1-S9-69.
  const { error: pruneErr } = await sb.from('network_aggregates').delete().lt('computed_at', now.toISOString());
  if (pruneErr) return { ok: false, error: describeActionError(pruneErr), contributors: contributions.length, aggregates: aggregates.length };

  return { ok: true, contributors: contributions.length, aggregates: aggregates.length };
}
