// lib/marketing/recurring-ads-runner.ts
//
// The loop that turns a standing instruction into posts. Called by
// /api/cron/marketing-social; all the date arithmetic lives in the pure
// lib/marketing/recurring-ads module, so this file is claim → publish → record.
//
// Two properties matter more than anything else here, because this runs
// unattended against real brand accounts:
//
//   1. NEVER POST THE SAME OCCURRENCE TWICE. The claim is a compare-and-set on
//      the ad row: we only proceed if `next_run_at` is still the value we read.
//      Two workers racing on the same due ad means one update matches and the
//      other does not, so only one publishes. The unique index on
//      (ad_id, occurrence, platform) is the second line of defence.
//
//   2. NEVER CLAIM SUCCESS THE PROVIDER DID NOT CONFIRM. Every outcome is
//      whatever the connector returned. A platform with no credentials records
//      'requires_setup' — which is the truth and is visible in the admin list,
//      rather than a green tick over a post that does not exist.
//
// The claim happens BEFORE publishing, which means a crash in between loses
// that one occurrence. That is the correct trade: a missed post is a gap, a
// duplicated post is a visible mistake on a public account that cannot be
// taken back.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getConnector } from '@/lib/social/connectors';
import { PLATFORMS, type SocialPlatform } from '@/lib/social/capabilities';
import {
  decideRun, nextRunAt, variantForOccurrence,
  type Cadence, type RecurringAdSchedule,
} from './recurring-ads';

type Client = SupabaseClient<Database>;

/** Mirrors the ledger's CHECK constraint in 0282. */
export type RunStatus = 'published' | 'requires_setup' | 'not_implemented' | 'failed' | 'skipped';

export type AdRow = {
  id: string;
  name: string;
  status: string;
  body_variants: string[] | null;
  link: string | null;
  media_urls: string[] | null;
  platforms: string[] | null;
  cadence: string;
  times_of_day: number[] | null;
  days_of_week: number[] | null;
  day_of_month: number | null;
  timezone: string;
  starts_at: string;
  ends_at: string | null;
  max_occurrences: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  occurrences: number;
};

export type RunSummary = {
  considered: number;
  posted: number;
  skipped: number;
  failures: number;
  /** Why each ad that did NOT post was passed over, for the cron response. */
  reasons: Record<string, number>;
};

/** Only platforms the app actually knows about. A stale row cannot smuggle one in. */
export function validPlatforms(input: readonly string[] | null | undefined): SocialPlatform[] {
  const known = new Set<string>(PLATFORMS);
  return [...new Set(input ?? [])].filter((p): p is SocialPlatform => known.has(p));
}

export function scheduleFromRow(ad: AdRow): RecurringAdSchedule {
  return {
    cadence: ad.cadence as Cadence,
    timesOfDay: ad.times_of_day ?? [],
    daysOfWeek: ad.days_of_week ?? [],
    dayOfMonth: ad.day_of_month,
    timezone: ad.timezone,
  };
}

/** The connector's two-value answer, widened back into the reason it gave. */
export function classifyOutcome(ok: boolean, errorCode: string | null | undefined): RunStatus {
  if (ok) return 'published';
  if (errorCode === 'requires_setup') return 'requires_setup';
  if (errorCode === 'not_implemented') return 'not_implemented';
  return 'failed';
}

/**
 * Take ownership of this occurrence, or report that someone else already has.
 *
 * The `.eq('next_run_at', …)` is the whole point: it makes the read-then-write
 * a compare-and-set. `select` returns the rows actually updated, so an empty
 * result means another worker moved the ad on between our read and our write.
 */
async function claimOccurrence(
  supabase: Client, ad: AdRow, nextAfter: Date, ranAt: Date,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('marketing_recurring_ads')
    .update({
      next_run_at: nextAfter.toISOString(),
      last_run_at: ranAt.toISOString(),
      occurrences: ad.occurrences + 1,
    } as never)
    .eq('id', ad.id)
    .eq('next_run_at', ad.next_run_at as string)
    .select('id');
  if (error) {
    console.error('[recurring-ads] claim failed', ad.id, error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

async function recordFailureNote(supabase: Client, adId: string, message: string | null): Promise<void> {
  const { error } = await supabase
    .from('marketing_recurring_ads')
    .update({ last_error: message } as never)
    .eq('id', adId);
  if (error) console.error('[recurring-ads] note update failed', adId, error);
}

/**
 * Publish one occurrence of one ad across its platforms.
 *
 * Exported for the "Run now" admin action, which is the same work with the
 * schedule decision already made.
 */
export async function publishOccurrence(
  supabase: Client,
  ad: AdRow,
  occurrence: number,
  scheduledFor: Date,
  body: string,
): Promise<{ posted: number; failures: number; statuses: RunStatus[] }> {
  const platforms = validPlatforms(ad.platforms);
  const statuses: RunStatus[] = [];
  let posted = 0;
  let failures = 0;

  for (const platform of platforms) {
    const outcome = await getConnector(platform).publish({
      platform,
      providerAccountId: null,
      body,
      link: ad.link,
      mediaUrls: ad.media_urls ?? [],
    });
    const status = classifyOutcome(outcome.ok, outcome.errorCode);
    statuses.push(status);
    if (status === 'published') posted += 1;
    else failures += 1;

    // The board row is written only for a CONFIRMED post: the social board is
    // a record of what went out, and a row there for a post that never existed
    // would be the same lie the connector layer refuses to tell.
    let postId: string | null = null;
    if (status === 'published') {
      const { data: post, error: postError } = await supabase
        .from('marketing_social_posts')
        .insert({
          platform, content: body, link: ad.link,
          status: 'published', scheduled_at: scheduledFor.toISOString(),
          metadata: { recurringAdId: ad.id, occurrence },
        } as never)
        .select('id')
        .single();
      if (postError) console.error('[recurring-ads] board row failed', ad.id, postError);
      else postId = post?.id ?? null;
    }

    // The ledger insert can only fail on the idempotency index, which means
    // this (occurrence, platform) is already recorded — exactly what it is for.
    const { error: runError } = await supabase.from('marketing_recurring_ad_runs').insert({
      ad_id: ad.id, post_id: postId, occurrence, platform, status, body,
      scheduled_for: scheduledFor.toISOString(),
      provider_object_id: outcome.providerObjectId ?? null,
      permalink_url: outcome.permalinkUrl ?? null,
      error_code: outcome.errorCode ?? null,
      error_message: outcome.errorMessage ?? null,
    } as never);
    if (runError) console.error('[recurring-ads] run ledger insert failed', ad.id, platform, runError);
  }

  return { posted, failures, statuses };
}

/** Every active ad whose next run has come due. */
export async function runDueRecurringAds(supabase: Client, now = new Date()): Promise<RunSummary> {
  const summary: RunSummary = { considered: 0, posted: 0, skipped: 0, failures: 0, reasons: {} };

  const { data: ads, error } = await supabase
    .from('marketing_recurring_ads')
    .select('*')
    .eq('status', 'active')
    .is('deleted_at', null)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now.toISOString())
    .order('next_run_at')
    .limit(50);
  if (error) {
    console.error('[recurring-ads] due query failed', error);
    throw new Error('Recurring ads could not be read.');
  }

  for (const row of (ads ?? []) as unknown as AdRow[]) {
    summary.considered += 1;
    const schedule = scheduleFromRow(row);
    const decision = decideRun(
      schedule,
      {
        startsAt: new Date(row.starts_at),
        endsAt: row.ends_at ? new Date(row.ends_at) : null,
        maxOccurrences: row.max_occurrences,
        occurrences: row.occurrences,
      },
      row.next_run_at ? new Date(row.next_run_at) : null,
      now,
      row.status === 'active',
    );

    if (!decision.run) {
      summary.skipped += 1;
      summary.reasons[decision.reason] = (summary.reasons[decision.reason] ?? 0) + 1;
      // A campaign that has finished should stop being asked. Clearing
      // next_run_at takes it out of the due index instead of rescanning it on
      // every tick forever.
      if (decision.reason === 'occurrence_cap' || decision.reason === 'window_closed' || decision.reason === 'no_schedule') {
        const { error: stopError } = await supabase
          .from('marketing_recurring_ads')
          .update({ next_run_at: null, status: 'paused' } as never)
          .eq('id', row.id);
        if (stopError) console.error('[recurring-ads] retire failed', row.id, stopError);
      }
      continue;
    }

    const body = variantForOccurrence(row.body_variants ?? [], row.occurrences);
    if (!body) {
      summary.skipped += 1;
      summary.reasons.no_content = (summary.reasons.no_content ?? 0) + 1;
      await recordFailureNote(supabase, row.id, 'This ad has no message to post. Add at least one message variant.');
      continue;
    }
    if (validPlatforms(row.platforms).length === 0) {
      summary.skipped += 1;
      summary.reasons.no_platforms = (summary.reasons.no_platforms ?? 0) + 1;
      await recordFailureNote(supabase, row.id, 'This ad has no platforms selected.');
      continue;
    }

    if (!await claimOccurrence(supabase, row, decision.nextAfter, now)) {
      summary.skipped += 1;
      summary.reasons.already_claimed = (summary.reasons.already_claimed ?? 0) + 1;
      continue;
    }

    const result = await publishOccurrence(supabase, row, row.occurrences, decision.at, body);
    summary.posted += result.posted;
    summary.failures += result.failures;
    await recordFailureNote(
      supabase, row.id,
      result.posted > 0 ? null
        : 'No platform confirmed this post. Check each platform’s setup under Social · Providers.',
    );
  }

  return summary;
}

/** The first run for a newly created or resumed ad. */
export function firstRunFor(schedule: RecurringAdSchedule, startsAt: Date, now: Date): Date | null {
  // Never before the campaign's own start, and never in the past: a campaign
  // created with a start date last month begins at its next real slot, it does
  // not open by firing a month of backdated posts.
  const from = startsAt.getTime() > now.getTime() ? startsAt : now;
  return nextRunAt(schedule, from, startsAt);
}
