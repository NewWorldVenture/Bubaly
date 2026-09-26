'use server';

// Super Admin · Marketing · Social · Recurring — the standing instructions.
//
// Every action re-checks isSuperAdmin itself. The page already gates, but a
// server action is its own endpoint: a gate in the page that renders the form
// does not protect the function the form posts to.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin, getUser } from '@/lib/supabase/auth';
import { PLATFORMS } from '@/lib/social/capabilities';
import {
  CADENCES, isValidTimezone, nextRunAfterClaim, parseTimesOfDay, parseVariants, stoppingCondition, withinWindow,
  type RecurringAdSchedule,
} from '@/lib/marketing/recurring-ads';
import {
  firstRunFor, publishOccurrence, resumeRunFor, scheduleFromRow, validPlatforms, windowFromRow, type AdRow,
} from '@/lib/marketing/recurring-ads-runner';

const PAGE = '/admin/marketing/social/recurring';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const createSchema = z.object({
  name: z.string().trim().min(2, 'Give this campaign a name').max(120),
  variants: z.string().trim().min(1, 'Add at least one message'),
  link: z.string().trim().url('Enter a valid link').or(z.literal('')).optional(),
  platforms: z.array(z.enum(PLATFORMS as [string, ...string[]])).min(1, 'Choose at least one platform'),
  cadence: z.enum(CADENCES as [string, ...string[]]),
  times: z.string().trim().min(1, 'Add at least one time of day'),
  daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)).default([]),
  dayOfMonth: z.coerce.number().int().min(1).max(31).nullable().optional(),
  timezone: z.string().trim().min(1).refine(isValidTimezone, 'Unknown timezone'),
  startsAt: z.string().trim().optional(),
  endsAt: z.string().trim().optional(),
  maxOccurrences: z.coerce.number().int().positive().nullable().optional(),
});

function readForm(formData: FormData) {
  const raw = Object.fromEntries(formData.entries());
  return createSchema.safeParse({
    ...raw,
    platforms: formData.getAll('platforms').map(String),
    daysOfWeek: formData.getAll('daysOfWeek').map(String).filter(Boolean),
    dayOfMonth: raw.dayOfMonth ? Number(raw.dayOfMonth) : null,
    maxOccurrences: raw.maxOccurrences ? Number(raw.maxOccurrences) : null,
  });
}

async function requireAdmin(): Promise<{ userId: string } | { error: string }> {
  if (!await isSuperAdmin()) return { error: 'Not authorized.' };
  const user = await getUser();
  if (!user) return { error: 'Not signed in.' };
  return { userId: user.id };
}

export async function createRecurringAdAction(formData: FormData): Promise<ActionResult> {
  const gate = await requireAdmin();
  if ('error' in gate) return { ok: false, error: gate.error };

  const parsed = readForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  const input = parsed.data;

  const timesOfDay = parseTimesOfDay(input.times);
  if (timesOfDay.length === 0) return { ok: false, error: 'Times must look like 09:00 or 17:30.' };
  const variants = parseVariants(input.variants);
  if (variants.length === 0) return { ok: false, error: 'Add at least one message.' };
  if ((input.cadence === 'weekly' || input.cadence === 'biweekly') && input.daysOfWeek.length === 0) {
    return { ok: false, error: 'Choose at least one day of the week.' };
  }

  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: 'Start date is not a real date.' };
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (endsAt && Number.isNaN(endsAt.getTime())) return { ok: false, error: 'End date is not a real date.' };
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: 'The end date must be after the start date.' };

  const schedule: RecurringAdSchedule = {
    cadence: input.cadence as RecurringAdSchedule['cadence'],
    timesOfDay,
    daysOfWeek: input.daysOfWeek,
    dayOfMonth: input.dayOfMonth ?? null,
    timezone: input.timezone,
  };
  const firstRun = firstRunFor(schedule, startsAt, new Date());
  // Refusing here rather than storing a campaign that can never fire: an ad
  // sitting in the list marked active while nothing happens is worse than a
  // form error, because nobody goes looking for it.
  if (!firstRun) return { ok: false, error: 'That schedule never comes round. Check the days and times.' };
  if (!withinWindow(firstRun, endsAt)) {
    return { ok: false, error: 'The first run would fall after the end date.' };
  }

  const supabase = createServiceClient();
  const { error } = await supabase.from('marketing_recurring_ads').insert({
    name: input.name,
    body_variants: variants,
    link: input.link || null,
    platforms: validPlatforms(input.platforms),
    cadence: input.cadence,
    times_of_day: timesOfDay,
    days_of_week: input.daysOfWeek,
    day_of_month: input.dayOfMonth ?? null,
    timezone: input.timezone,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt?.toISOString() ?? null,
    max_occurrences: input.maxOccurrences ?? null,
    next_run_at: firstRun.toISOString(),
    created_by: gate.userId,
  });
  if (error) {
    console.error('[recurring-ads] create failed', error);
    return { ok: false, error: 'Could not save this campaign.' };
  }
  revalidatePath(PAGE);
  return { ok: true, message: 'Campaign scheduled.' };
}

export async function setRecurringAdStatusAction(id: string, status: 'active' | 'paused'): Promise<ActionResult> {
  const gate = await requireAdmin();
  if ('error' in gate) return { ok: false, error: gate.error };
  const supabase = createServiceClient();

  const { data: row, error: readError } = await supabase
    .from('marketing_recurring_ads').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError || !row) return { ok: false, error: 'That campaign could not be found.' };

  // Resuming recomputes the next run from NOW. Keeping the stored one would
  // make a campaign paused over a holiday fire the moment it came back, for a
  // slot that passed days ago.
  const ad = row as unknown as AdRow;
  // resumeRunFor applies the end date too — firstRunFor alone has no end-date
  // parameter, which is why the create path above asks withinWindow. Without it
  // resuming an ended campaign succeeded and stored a next_run_at past the
  // window, and the error message below already claimed it had looked.
  const nextRun = status === 'active' ? resumeRunFor(ad, new Date()) : null;
  if (status === 'active' && !nextRun) {
    return { ok: false, error: 'This campaign has no future run left. Edit its schedule or end date.' };
  }

  const { error } = await supabase
    .from('marketing_recurring_ads')
    .update({ status, next_run_at: nextRun?.toISOString() ?? null, updated_by: gate.userId })
    .eq('id', id);
  if (error) {
    console.error('[recurring-ads] status change failed', error);
    return { ok: false, error: 'Could not change this campaign.' };
  }
  revalidatePath(PAGE);
  return { ok: true, message: status === 'active' ? 'Campaign resumed.' : 'Campaign paused.' };
}

export async function deleteRecurringAdAction(id: string): Promise<ActionResult> {
  const gate = await requireAdmin();
  if ('error' in gate) return { ok: false, error: gate.error };
  const supabase = createServiceClient();
  // Soft delete + cleared next run: the run ledger stays readable as history,
  // and the due index stops seeing it.
  const { error } = await supabase
    .from('marketing_recurring_ads')
    .update({ deleted_at: new Date().toISOString(), next_run_at: null, status: 'paused', updated_by: gate.userId })
    .eq('id', id);
  if (error) {
    console.error('[recurring-ads] delete failed', error);
    return { ok: false, error: 'Could not remove this campaign.' };
  }
  revalidatePath(PAGE);
  return { ok: true, message: 'Campaign removed.' };
}

/**
 * Post one occurrence right now, without waiting for the cadence.
 *
 * Counts as an occurrence and moves the schedule on, so "Run now" cannot be
 * used to sneak past an occurrence cap or an end date — the same accounting the
 * cron runner uses.
 */
export async function runRecurringAdNowAction(id: string): Promise<ActionResult> {
  const t = await getTranslations();
  const gate = await requireAdmin();
  if ('error' in gate) return { ok: false, error: gate.error };
  const supabase = createServiceClient();

  const { data: row, error: readError } = await supabase
    .from('marketing_recurring_ads').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError || !row) return { ok: false, error: 'That campaign could not be found.' };
  const ad = row as unknown as AdRow;
  const now = new Date();

  // BOTH halves of the stopping conditions, because the docstring above promises
  // both and this function used to check only the first. The cron runner asks
  // decideRun (lib/marketing/recurring-ads.ts), which refuses `occurrence_cap`
  // AND `window_closed` and then retires the row — status 'paused',
  // next_run_at null. The admin list badges that row "Paused", which is what a
  // deliberately-paused campaign looks like too, so the inviting next move is
  // "Post now". Without the second check that published last December's holiday
  // promo to the live brand accounts in September: exactly the "visible mistake
  // on a public account that cannot be taken back" that
  // lib/marketing/recurring-ads-runner.ts opens by naming. Both halves now come
  // from the one stoppingCondition decideRun asks, so they cannot drift apart
  // again; an end date that will not parse counts as closed (see windowClosed).
  const campaignWindow = windowFromRow(ad);
  const stopped = stoppingCondition(campaignWindow, now);
  if (stopped === 'occurrence_cap') {
    return { ok: false, error: 'This campaign has already run its full number of posts.' };
  }
  if (stopped === 'window_closed') {
    return { ok: false, error: t('adminMarketingSocial.endDateHasPassed') };
  }
  const { variantForOccurrence } = await import('@/lib/marketing/recurring-ads');
  const body = variantForOccurrence(ad.body_variants ?? [], ad.occurrences);
  if (!body) return { ok: false, error: 'This campaign has no message to post.' };
  if (validPlatforms(ad.platforms).length === 0) return { ok: false, error: 'This campaign has no platforms selected.' };

  // Re-arm exactly as the cron's claim does: the next slot, or null when the
  // cap or the end date leaves none — and then the row is retired in the same
  // write, as claimOccurrence retires it. An unclamped slot would advertise a
  // "Next post" in the admin list that is never coming; a null next_run_at on a
  // row left 'active' would sit outside the due index, never retired.
  const nextRun = nextRunAfterClaim(scheduleFromRow(ad), campaignWindow, now);
  // The same compare-and-set the cron runner's claimOccurrence makes, read the
  // same way: `.select('id')` is what makes PostgREST return the rows actually
  // updated. Without it a lost race answers 204 with `data: null, error: null`,
  // which is indistinguishable from a won one — and the occurrence goes out to
  // the brand account a second time.
  const { data: claimed, error: claimError } = await supabase
    .from('marketing_recurring_ads')
    .update({
      occurrences: ad.occurrences + 1,
      last_run_at: now.toISOString(),
      next_run_at: nextRun?.toISOString() ?? null,
      ...(nextRun ? {} : { status: 'paused' as const }),
      updated_by: gate.userId,
    })
    .eq('id', id)
    .eq('occurrences', ad.occurrences)
    .select('id');
  if (claimError) {
    console.error('[recurring-ads] run now claim failed', id, claimError);
    return { ok: false, error: 'Could not start this run.' };
  }
  if ((claimed?.length ?? 0) === 0) {
    // Through the catalogue, not as a literal. This is the only NEW sentence
    // this fix adds, and tests/i18n-ungated-surface-ratchet.test.ts counts it —
    // as TWO, because the scanner splits on sentences. The ratchet's two
    // legitimate reasons to rise are a stricter scanner and a tree merge; adding
    // copy is neither, and its own message says to lift it instead.
    return { ok: false, error: t('adminMarketingSocial.thisRunWasAlreadyTaken') };
  }

  const result = await publishOccurrence(supabase, ad, ad.occurrences, now, body);
  revalidatePath(PAGE);
  if (result.posted === 0) {
    return { ok: false, error: 'No platform confirmed the post. See the run history for each platform’s reason.' };
  }
  return { ok: true, message: `Posted to ${result.posted} platform${result.posted === 1 ? '' : 's'}.` };
}
