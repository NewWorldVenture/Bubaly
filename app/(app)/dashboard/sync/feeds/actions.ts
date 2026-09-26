'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { syncFeed } from '@/lib/server/calendar-feeds';
import { normalizeFeedUrl, FEED_COLORS, type FeedColor } from '@/lib/calendar/feeds';
import { recordActivationServer } from '@/lib/analytics/activation-server';

/**
 * `alreadySubscribedAs` is set when "Add & Sync Now" re-synced a subscription
 * the family already had instead of adding one — it carries that row's name,
 * because the name and colour typed on this add were not applied to it.
 */
type ActionResult = { ok: true; imported?: number; alreadySubscribedAs?: string } | { ok: false; error: string };

type FeedRef = { id: string; family_id: string; url: string; name: string };

/**
 * Longest (normalized) URL a family can subscribe to. uq_calendar_feeds_family_url
 * (0363) is a btree over the url, and a btree entry over ~2.7 KB is refused with
 * 54000 — a raw Postgres message the family could do nothing with. A normalized
 * URL is ASCII (URL percent-encodes the rest), so this many characters is this
 * many bytes, well inside the limit; no real calendar link comes near it.
 */
const MAX_FEED_URL_LENGTH = 2048;

/**
 * The family's existing subscription to this (already normalized) URL, if any.
 * `limit(1)` rather than `maybeSingle()`: until migration 0363 is applied a
 * family can still hold duplicates from before this fix, and a lookup that
 * errors on two rows would refuse the very re-add that should reuse one.
 */
async function findFeedByUrl(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
  url: string,
): Promise<{ ok: true; feed: FeedRef | null } | { ok: false }> {
  const { data, error } = await supabase
    .from('calendar_feeds')
    .select('id, family_id, url, name')
    .eq('family_id', familyId)
    .eq('url', url)
    .order('created_at')
    .limit(1);
  if (error) {
    console.error('Calendar feed lookup failed:', error);
    return { ok: false };
  }
  return { ok: true, feed: (data ?? [])[0] ?? null };
}

/**
 * Adds a calendar subscription, then immediately syncs it once.
 *
 * All or nothing, and once per URL. The panel keeps the form open with the URL
 * still typed in when this fails, so the family's next act is to press "Add &
 * Sync Now" again. Two things used to make that press a second subscription:
 * the row inserted here stayed behind when its first sync failed (a school
 * calendar behind a login, a timeout, an oversized file), and nothing stopped
 * a second row for the same URL. Every retry left one more red entry in the
 * list, and once the URL did answer, every one of them imported the same
 * events under its own feed_id — 0285's uq_calendar_events_feed_uid is per
 * feed, so nothing collapsed them. So:
 *   • a URL the family already subscribes to is re-synced, not added again,
 *     and the result names that subscription (alreadySubscribedAs) so the
 *     panel does not say "Added" for a row whose name this add did not set;
 *   • a row this call created is removed again if its first sync fails and no
 *     concurrent add of the same URL has synced it since (its partial events
 *     cascade with it); if that removal does not happen the family is told the
 *     calendar WAS saved rather than shown a plain failure that invites
 *     another add;
 *   • the unique index in migration 0363 closes the window between the lookup
 *     and the insert, and a 23505 here means another add won that race.
 */
export async function addCalendarFeed(input: { name: string; url: string; color?: string }): Promise<ActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const { familyId } = ctx.active;
  const supabase = await createServer();

  const url = normalizeFeedUrl(input.url);
  if (!url) return { ok: false, error: 'Enter a valid ICS or webcal:// URL' };
  if (url.length > MAX_FEED_URL_LENGTH) {
    return { ok: false, error: t('calendarSync.feedUrlTooLong', { max: MAX_FEED_URL_LENGTH }) };
  }
  const name = (input.name || '').trim() || 'Calendar feed';
  const color: FeedColor = FEED_COLORS.includes(input.color as FeedColor) ? (input.color as FeedColor) : 'blue';

  const existing = await findFeedByUrl(supabase, familyId, url);
  if (!existing.ok) return { ok: false, error: t('calendarSync.couldNotCheckExistingFeeds') };

  let feed: FeedRef | null = existing.feed;
  let createdHere = false;
  if (!feed) {
    const { data, error } = await supabase
      .from('calendar_feeds')
      .insert({ family_id: familyId, name, url, color, created_by: ctx.user.id })
      .select('id, family_id, url, name')
      .single();
    if (error?.code === '23505') {
      // Another add of this URL landed between the lookup and the insert.
      // Sync that subscription instead of reporting a failure for one that exists.
      const winner = await findFeedByUrl(supabase, familyId, url);
      if (!winner.ok || !winner.feed) return { ok: false, error: t('calendarSync.couldNotCheckExistingFeeds') };
      feed = winner.feed;
    } else if (error || !data) {
      return { ok: false, error: error?.message ?? 'Could not save the feed' };
    } else {
      feed = data;
      createdHere = true;
    }
  }

  const result = await syncFeed(supabase, feed);
  if (!result.ok) {
    // A subscription the family already had stays — syncFeed has stamped its
    // error on it, and removing it would take its imported events too. Only
    // the row this call created, and could not fill, is undone.
    //
    // "Could not fill" is checked by the delete itself, not assumed from
    // createdHere. From the insert until here — the whole first fetch, up to
    // its 15 s timeout — the row is visible, and another member's add of the
    // same URL finds it and syncs it (the lookup above, or the 23505 re-read).
    // If that sync succeeded, that member has been told so and last_synced_at
    // is set, which only a successful sync does; `is('last_synced_at', null)`
    // then matches nothing, the row and its events stay, and this add answers
    // feedSavedButNotSynced — true: the calendar is in the list and this
    // attempt to sync it failed.
    // Not closed: the other add's events upserted but its final stamp not yet
    // landed. This delete then takes the row and those events, the stamp
    // updates nothing without an error (stampFeed does not count rows), and
    // that member is told it synced. That window is one round trip wide.
    let leftBehind = false;
    if (createdHere) {
      const { data: removed, error: removeError } = await supabase
        .from('calendar_feeds')
        .delete()
        .eq('id', feed.id)
        .eq('family_id', familyId)
        .is('last_synced_at', null)
        .select('id');
      if (removeError || (removed ?? []).length !== 1) {
        console.error(
          `Did not remove calendar feed ${feed.id} after its first sync failed (a concurrent add of the same URL may have synced it):`,
          removeError ?? 'no unsynced row deleted',
        );
        leftBehind = true;
      }
    }
    revalidatePath('/dashboard/settings');
    revalidatePath('/dashboard/calendar');
    if (leftBehind) return { ok: false, error: t('calendarSync.feedSavedButNotSynced', { error: result.error }) };
    return { ok: false, error: result.error };
  }

  // TTFV: importing a calendar is a first-value milestone (recorded once) — and
  // only once something was actually imported, not when the import failed.
  await recordActivationServer({ userId: ctx.user.id, familyId, milestone: 'calendar_imported', signupAtIso: ctx.active.family.created_at });
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/calendar');
  if (!createdHere) return { ok: true, imported: result.imported, alreadySubscribedAs: feed.name };
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
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { error } = await supabase
    .from('calendar_feeds')
    .delete()
    .eq('id', feedId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/calendar');
  return { ok: true };
}
