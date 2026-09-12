'use server';

// Super Admin · Marketing · Social · Recurring — the standing instructions.
//
// Every action re-checks isSuperAdmin itself. The page already gates, but a
// server action is its own endpoint: a gate in the page that renders the form
// does not protect the function the form posts to.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin, getUser } from '@/lib/supabase/auth';
import { PLATFORMS } from '@/lib/social/capabilities';
import {
  CADENCES, isValidTimezone, nextRunAt, parseTimesOfDay, parseVariants,
  type RecurringAdSchedule,
} from '@/lib/marketing/recurring-ads';
import {
  firstRunFor, publishOccurrence, scheduleFromRow, validPlatforms, type AdRow,
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
  if (endsAt && firstRun.getTime() > endsAt.getTime()) {
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
  const nextRun = status === 'active'
    ? firstRunFor(scheduleFromRow(ad), new Date(ad.starts_at), new Date())
    : null;
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
  const gate = await requireAdmin();
  if ('error' in gate) return { ok: false, error: gate.error };
  const supabase = createServiceClient();

  const { data: row, error: readError } = await supabase
    .from('marketing_recurring_ads').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError || !row) return { ok: false, error: 'That campaign could not be found.' };
  const ad = row as unknown as AdRow;

  if (ad.max_occurrences != null && ad.occurrences >= ad.max_occurrences) {
    return { ok: false, error: 'This campaign has already run its full number of posts.' };
  }
  const { variantForOccurrence } = await import('@/lib/marketing/recurring-ads');
  const body = variantForOccurrence(ad.body_variants ?? [], ad.occurrences);
  if (!body) return { ok: false, error: 'This campaign has no message to post.' };
  if (validPlatforms(ad.platforms).length === 0) return { ok: false, error: 'This campaign has no platforms selected.' };

  const now = new Date();
  const schedule = scheduleFromRow(ad);
  const { error: claimError } = await supabase
    .from('marketing_recurring_ads')
    .update({
      occurrences: ad.occurrences + 1,
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt(schedule, now, new Date(ad.starts_at))?.toISOString() ?? null,
      updated_by: gate.userId,
    })
    .eq('id', id)
    .eq('occurrences', ad.occurrences);
  if (claimError) return { ok: false, error: 'Could not start this run.' };

  const result = await publishOccurrence(supabase, ad, ad.occurrences, now, body);
  revalidatePath(PAGE);
  if (result.posted === 0) {
    return { ok: false, error: 'No platform confirmed the post. See the run history for each platform’s reason.' };
  }
  return { ok: true, message: `Posted to ${result.posted} platform${result.posted === 1 ? '' : 's'}.` };
}
