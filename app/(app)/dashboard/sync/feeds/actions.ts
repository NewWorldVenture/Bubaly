'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { syncFeed } from '@/lib/server/calendar-feeds';
import { wroteNoRows } from '@/lib/supabase/errors';
import { normalizeFeedUrl, FEED_COLORS, type FeedColor } from '@/lib/calendar/feeds';
import { recordActivationServer } from '@/lib/analytics/activation-server';

type ActionResult = { ok: true; imported?: number } | { ok: false; error: string };

/** Adds a calendar subscription, then immediately syncs it once. */
export async function addCalendarFeed(input: { name: string; url: string; color?: string }): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const { familyId } = ctx.active;
  const supabase = await createServer();

  const url = normalizeFeedUrl(input.url);
  if (!url) return { ok: false, error: 'Enter a valid ICS or webcal:// URL' };
  const name = (input.name || '').trim() || 'Calendar feed';
  const color: FeedColor = FEED_COLORS.includes(input.color as FeedColor) ? (input.color as FeedColor) : 'blue';

  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .insert({ family_id: familyId, name, url, color, created_by: ctx.user.id })
    .select('id, family_id, url')
    .single();
  if (error || !feed) return { ok: false, error: error?.message ?? 'Could not save the feed' };

  const result = await syncFeed(supabase, feed);
  // TTFV: importing a calendar is a first-value milestone (recorded once).
  await recordActivationServer({ userId: ctx.user.id, familyId, milestone: 'calendar_imported', signupAtIso: ctx.active.family.created_at });
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/calendar');
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, imported: result.imported };
}

/** Manually re-syncs one feed. */
export async function syncCalendarFeed(feedId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .select('id, family_id, url')
    .eq('id', feedId)
    .eq('family_id', ctx.active.familyId)
    .single();
  if (error || !feed) return { ok: false, error: t('actions.feedNotFound') };

  const result = await syncFeed(supabase, feed);
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/calendar');
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, imported: result.imported };
}

/** Removes a feed; its imported events cascade-delete via the FK. */
export async function removeCalendarFeed(feedId: string): Promise<ActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // The imported events cascade with the row, so a delete that matched nothing
  // removed nothing at all — and the caller answers `{ ok: true }`, which the
  // settings page reads as "feed removed". The family would keep seeing a
  // stranger's calendar in theirs with no row left in the UI to unsubscribe
  // from. Audit C1-S9-59.
  const { data: removed, error } = await supabase
    .from('calendar_feeds')
    .delete()
    .eq('id', feedId)
    .eq('family_id', ctx.active.familyId)
    .select('id');
  if (error) return { ok: false, error: error.message };
  if (wroteNoRows(removed)) return { ok: false, error: t('actions.feedNotFound') };

  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/calendar');
  return { ok: true };
}
