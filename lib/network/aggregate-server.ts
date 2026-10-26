// Intelligence Network aggregation — service-callable core (no request context).
// Called by the network-aggregate cron with the service client. Three phases:
//   1. FORGET — prune the stored contribution of every family no longer
//      contributing (withdrawn, closed, no contributing scope, or a consent a
//      non-manager wrote), FIRST, so a failure anywhere later can never keep a
//      withdrawn family's row in place.
//   2. CONTRIBUTE — for every contributing family, recompute its coarse row
//      from its OWN data and upsert network_contributions. This is the only
//      place raw family data is read, and only bands leave the family row.
//   3. AGGREGATE — once per publication epoch (aggregate.ts, PUBLICATION_EPOCH):
//      run the pure k-anonymity + DP + gating core over the contributions and
//      replace network_aggregates with the publish-safe rows. Every other night
//      of the epoch holds that snapshot unchanged. One run at a time does
//      this (NETWORK_PUBLICATION_LEASE_KEY), however many overlap, and a
//      family's leave or scope switch-off takes the same claim
//      (withdrawal-server.ts), so consent is re-read under it before anything
//      is published.
// Nothing here can bypass aggregate.ts's guarantees.

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import { readAll } from '@/lib/supabase/read-all';
import { readAllInChunks, writeInChunks } from '@/lib/supabase/chunked-in';
import type { Database } from '@/lib/database.types';
import { addDaysToDayKey, dayKeyInTz } from '@/lib/services/scope';
import { isManager } from '@/lib/constants/roles';
import { claimLease, releaseLease, type LeaseClaim } from '@/lib/server/app-settings-lease';
import {
  contributionFeatures, bedtimeToMinutes, typicalWeeklySpend, type ContributionInput,
} from './contribution';
import {
  aggregateContributions, cohortKey, contributesToNetwork, laplaceNoise, filterMetricsByScopes, publicationEpoch,
  AGG_DEFAULTS, type Contribution, type NoiseCell, type NoiseFn, type PublicationEpoch,
} from './aggregate';
import type { ConsentScope } from './insights';
import { describeActionError } from '@/lib/supabase/errors';

type DB = SupabaseClient<Database>;

export type AggregateResult = {
  ok: boolean; error?: string; contributors: number;
  /** Rows published by this run, or standing from earlier in its epoch when `held`. */
  aggregates: number;
  /** The publication epoch the run published or held (on success). */
  epoch?: string;
  /** True when the epoch's snapshot was already published and the run left it unchanged. */
  held?: boolean;
  /** True when another run held the publication: this one refreshed the contributions and left the figures to it. */
  deferred?: boolean;
};

/**
 * The claim a run takes before it holds or publishes the figures, in
 * app_settings (lib/server/app-settings-lease.ts). See step 4 of
 * runNetworkAggregation.
 */
export const NETWORK_PUBLICATION_LEASE_KEY = 'network_aggregate_publication:v1';
/**
 * Ten times the cron route's 60-second maxDuration: a holder is gone long
 * before its claim expires, so no two runs are ever inside the publication at
 * once. A holder that died frees it after this.
 */
export const NETWORK_PUBLICATION_LEASE_MS = 10 * 60_000;
/**
 * How far apart a caller's tries for the publication claim are. A family's
 * leave holds the claim for two writes, so a run that finds it taken tries a
 * few times before it defers: deferring to a leave would leave the night's
 * figures unwritten. Another run that keeps it past the tries is deferred to,
 * as before. A leave waits longer (withdrawal-server.ts).
 */
export const PUBLICATION_CLAIM_RETRY_MS = 250;
const RUN_CLAIM_ATTEMPTS = 6;

/**
 * Claim the publication, trying `attempts` times while another holder has it.
 * Each try reads its own `now()`, so a wait is measured on the caller's clock.
 * A claim that cannot be read or written is not retried: the caller decides.
 */
export async function claimNetworkPublication(sb: DB, opts: { attempts: number; now: () => Date }): Promise<LeaseClaim> {
  for (let attempt = 1; ; attempt++) {
    const claim = await claimLease(sb, NETWORK_PUBLICATION_LEASE_KEY, { ttlMs: NETWORK_PUBLICATION_LEASE_MS, now: opts.now() });
    if (claim.claimed || claim.reason === 'error' || attempt >= opts.attempts) return claim;
    await new Promise((resolve) => setTimeout(resolve, PUBLICATION_CLAIM_RETRY_MS));
  }
}

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
 * left to the owner's re-consent sweep. A scope switch records its author: the
 * module writes the manager who made it to `consented_by` and `consented_at`
 * (intelligence-module.tsx, toggleScope), so a manager's switch takes over a
 * consent a non-manager wrote, and this check then honours it. Only switches
 * made before that change recorded no author, and those are the sweep's too.
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
 * STICKY Laplace noise, drawn once per band per publication EPOCH: the draw is
 * a keyed hash of the epoch, the band, and the TRUE counts of its whole
 * (cohort, metric) — `cell.bandVector`, every band of the metric withheld ones
 * included.
 *
 * Two attacks pull opposite ways, and neither key alone answers both.
 *  - Averaging. `Math.random()` drew afresh for every cell on every nightly
 *    run, so an unchanged band published a new sample of the same number each
 *    night; at scale 1.5 (sd ≈ 2.1) the mean of a month of scrapes is within
 *    0.4 of the true count, and one family leaving shows as a step of 1.
 *  - Differencing. Keyed on the band's OWN count, a figure moved only when that
 *    band's count moved, so two nights compared named the bands a family that
 *    joined or left occupies (a cohort of 70 and one household leaving, over
 *    2000 keys: only its cells ever changed). Keyed on the whole metric's
 *    vector, a diff no longer named the band — but these vectors change almost
 *    nightly (dinners and reminders are the coming seven days; the network
 *    grows), and every change was a fresh sample of every band, so the
 *    averaging came back, slower: 0.955 accuracy at telling whether a known
 *    leaver was in a stable band after 90 nights each side.
 *
 * The epoch bounds both, and defeats neither outright. Inside an epoch the
 * cron does not republish at all (runNetworkAggregation holds the snapshot,
 * and overlapping runs take the publication one at a time), so no published
 * figure changes and two nights have nothing to difference.
 * The epoch is in the key, so the next epoch draws every band afresh, whether
 * or not its counts moved, and the diff across a boundary says neither which
 * bands nor which cohorts did.
 *
 * The BUDGET is one fresh sample per published band per epoch: 12 a year at
 * the default monthly epoch, 52 at a weekly one. Each sample is a new draw of
 * the same noise, so averaging epochs still converges on the true count; the
 * budget only sets how fast. The reviewer's averaging probe, run per epoch on
 * this sampler over 400 keys (a stable band of 25 whose siblings change every
 * epoch, a household that left at a known boundary, the mean of E epochs
 * before against the mean of E after), tells whether that household was in
 * the band with accuracy 0.581 after 1 epoch each side, 0.613 after 4, 0.710
 * after 12 and 0.889 after 52 (tests/network-noise-is-drawn-once-per-epoch.test.ts
 * pins these). That is close to Φ(0.5·√E / 3.0), 3.0 being the spread of the
 * difference of two rounded Laplace(1.5) draws. At the monthly epoch, 12 a
 * side means watching for a year before and a year after, with the band's
 * true count moved by nothing else in those two years; 52 a side is more than
 * eight years. Republished nightly on the whole-metric key, the reviewer's
 * nightly version of the probe reached 0.955 after 90 nights a side. Going
 * further takes a larger scale, coarser rounding or a longer epoch, and that
 * is the owner's call, not this function's.
 *
 * The vector stays in the key for the one case neither the hold nor the claim
 * can rule out: a second publish in one epoch because this epoch's rows were
 * removed from outside the run (an operator clearing the table). With the same
 * state it publishes the same figures. With a changed state every band of the
 * metric draws afresh (one extra sample), never the same noise on a different
 * count, which would subtract to the exact change. Overlapping runs are not
 * that case: one holds the publication (NETWORK_PUBLICATION_LEASE_KEY) and
 * the other leaves the figures to it, and the prune never reaches this
 * epoch's rows.
 */
export function stickyNoise(key: string, epoch: string): NoiseFn {
  return (scale, cell) => laplaceNoise(scale, () => cellUniform(key, epoch, cell));
}

function cellUniform(key: string, epoch: string, cell: NoiseCell): number {
  const digest = createHmac('sha256', key).update(NOISE_DOMAIN)
    .update(JSON.stringify([epoch, cell.scope, cell.cohortKey, cell.metric, cell.value, cell.cohortSize, cell.bandVector]))
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

  // 4. CLAIM — one run at a time holds or publishes.
  //    The hold asks whether this epoch's snapshot is there, and the publish
  //    overwrites every row on its key, so two runs side by side each acted on
  //    what the other was changing. Overlap is real: vercel.json and
  //    scripts/cron-dispatch.mjs can both call the route at 03:00, and a cron
  //    event can be delivered twice. A later-started run that held first, then
  //    pruned after an earlier run had re-stamped the snapshot back to its own
  //    `now`, deleted the whole snapshot, and the next night, finding nothing
  //    to hold, published the epoch a second time from a changed state. Two
  //    first runs of an epoch both published, the second over the first. The
  //    run that holds this claim is the only one that writes
  //    network_aggregates. One that finds it held has refreshed the
  //    contributions above and leaves the figures to the holder; one that
  //    cannot read or write it fails rather than guess. A publish the database
  //    itself keys on the epoch is the owner's migration; until it lands, this
  //    claim is the fence.
  //
  //    Then RE-CHECK consent (keepStillConsenting). A family's leave or scope
  //    switch-off takes this same claim around its consent write and the
  //    delete of its row (withdrawal-server.ts), and step 1's read is long
  //    past by now. Without the re-check, a family that left while this run
  //    was building had its row deleted by the leave, written back by the
  //    upsert above, and counted in the publication below.
  //    Read under the claim, the re-check either sees a withdrawal or comes
  //    before it, and a publication that comes before it was written before
  //    the family was told it had left. A run that finds the claim taken
  //    re-checks too, after its own upserts, so a row it wrote back after a
  //    leave's delete does not stay.
  const epoch = publicationEpoch(now);
  const lease = await claimNetworkPublication(sb, { attempts: RUN_CLAIM_ATTEMPTS, now: () => now });
  try {
    const recheck = await keepStillConsenting(sb, contributions);
    if (!recheck.ok) return { ok: false, error: recheck.error, contributors: 0, aggregates: 0 };
    if (!lease.claimed) {
      if (lease.reason === 'held') return { ok: true, contributors: recheck.kept.length, aggregates: 0, epoch: epoch.key, deferred: true };
      return { ok: false, error: 'failed to claim the publication', contributors: recheck.kept.length, aggregates: 0 };
    }
    return await holdOrPublish(sb, recheck.kept, key, epoch, now);
  } finally {
    if (lease.claimed) await releaseLease(sb, NETWORK_PUBLICATION_LEASE_KEY, lease.token);
  }
}

/**
 * The contributions a run stored whose families still consent to them, read
 * after the run's own upserts (for the run that publishes, under the
 * publication claim). A family that left, closed its account, or switched off
 * a scope one of its stored metrics belongs to is dropped from what the run
 * publishes, and its row is deleted; one that only widened its consent keeps
 * the row it has, which is a subset of what it now allows.
 *
 * A withdrawal writes consent BEFORE it deletes the row (withdrawal-server.ts),
 * so an upsert of ours that lands after that delete is followed by this read,
 * and this read sees the withdrawal.
 *
 * Chunked by the families stored rather than paged over the whole table: a
 * consent switched off while pages are read moves every later row up one, and
 * the row that crossed a page boundary would read as withdrawn. A chunk is a
 * hundred rows at most, one page.
 *
 * A read that fails cannot vouch for any row this run wrote, so the run takes
 * them all back (the next good run rebuilds them) and publishes nothing.
 */
async function keepStillConsenting(
  sb: DB, stored: Contribution[],
): Promise<{ ok: true; kept: Contribution[] } | { ok: false; error: string }> {
  const ids = stored.map((c) => c.familyId);
  const { data, error } = await readAllInChunks<Pick<ConsentRow, 'family_id' | 'scopes' | 'family'>>(ids, (chunk, from, to) => sb
    .from('network_consent').select('family_id, scopes, family:families!inner(closed_at)').is('family.closed_at', null)
    .in('family_id', chunk).eq('enabled', true).order('family_id').range(from, to));
  const unread = Boolean(error) || !data;
  if (unread) console.error('[network] consent re-check failed', error);
  const scopesNow = new Map((data ?? []).map((c) => [c.family_id, (c.scopes ?? {}) as Partial<Record<ConsentScope, boolean>>]));
  const withdrawn = unread ? ids : stored.filter((c) => {
    const scopes = scopesNow.get(c.familyId);
    return !scopes || Object.keys(filterMetricsByScopes(c.metrics, scopes)).length !== Object.keys(c.metrics).length;
  }).map((c) => c.familyId);
  const { error: forgetError } = await writeInChunks(withdrawn, (chunk) => sb
    .from('network_contributions').delete().in('family_id', chunk).select('family_id'));
  if (unread) return { ok: false, error: 'failed to re-check consent' };
  if (forgetError) {
    console.error('[network] withdrawn contribution delete failed', forgetError);
    return { ok: false, error: 'failed to forget a withdrawn family' };
  }
  const gone = new Set(withdrawn);
  return { ok: true, kept: stored.filter((c) => !gone.has(c.familyId)) };
}

/** Steps 5 to 7 of runNetworkAggregation, run only by the holder of the publication claim. */
async function holdOrPublish(
  sb: DB, contributions: Contribution[], key: string, epoch: PublicationEpoch, now: Date,
): Promise<AggregateResult> {
  // 5. HOLD — inside a publication epoch the published figures do not change.
  //    If this epoch's snapshot is already published, the run stands behind it
  //    again — `computed_at` re-stamped, so readers' 36-hour freshness rule
  //    still says the cron is alive — and changes nothing a reader can see:
  //    no join, leave or band change inside the epoch reaches a figure, so
  //    two nights of one epoch have nothing to difference. The contributions
  //    are still refreshed nightly (the prune, and each family's own compare
  //    line, depend on them); they reach the figures at the next epoch. A
  //    network that published nothing yet this epoch (the launch gate not
  //    met) has no snapshot to hold, and publishes when it first can.
  // `computed_at` is a real column (0135, timestamptz); the hand-kept Update
  // type in lib/database.types.ts lists only what the republish used to change.
  const restamp = { computed_at: now.toISOString() } as never;
  const { data: standing, error: holdError } = await sb.from('network_aggregates')
    .update(restamp)
    .gte('computed_at', epoch.start.toISOString())
    .select('id');
  if (holdError) return { ok: false, error: describeActionError(holdError), contributors: contributions.length, aggregates: 0 };
  const held = (standing ?? []).length;

  // 6. AGGREGATE (once per epoch) — pure k-anonymity + sticky DP noise (one
  //    draw per band per epoch, see stickyNoise) + launch gate.
  const aggregates = held > 0 ? [] : aggregateContributions(contributions, {
    minCohort: AGG_DEFAULTS.minCohort,
    globalMinFamilies: AGG_DEFAULTS.globalMinFamilies,
    noise: stickyNoise(key, epoch.key),
  });

  // 7. Publish: upsert the new set on the natural key, THEN prune the rows of
  //    EARLIER epochs — after a publish, every row the upsert did not replace;
  //    after a hold, the leftovers of an epoch whose own prune failed. Never
  //    this epoch's: pruned below this run's own `now`, the held snapshot went
  //    whenever another run had re-stamped it earlier than that. Avoids the
  //    delete-all-then-insert window where a failed insert would leave the
  //    table silently empty.
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
  const { error: pruneErr } = await sb.from('network_aggregates').delete().lt('computed_at', epoch.start.toISOString());
  if (pruneErr) return { ok: false, error: describeActionError(pruneErr), contributors: contributions.length, aggregates: held || aggregates.length };

  return { ok: true, contributors: contributions.length, aggregates: held || aggregates.length, epoch: epoch.key, held: held > 0 };
}
