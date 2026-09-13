// lib/library/ingest.ts
//
// Pulling one subscribed feed and writing what it contains.
//
// This lived inside the library's `'use server'` actions module, which made it
// unreachable from anywhere else: a 'use server' file may only export async
// functions, and every export it has becomes a server action the browser can
// call. So the only way a podcast ever gained a new episode was somebody
// pressing Refresh. Subscribe-and-it-keeps-up is most of what subscribing
// MEANS, and it was the one thing the feature could not do.
//
// Moved here so the action and the nightly cron run the same code rather than
// two copies that drift.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { fetchPublicFeed } from '@/lib/server/public-document-fetch';
import { parseFeed } from '@/lib/library/feed-parse';

type Client = SupabaseClient<Database>;

export type IngestResult = { added: number } | { error: string };

/** What a person is told when a feed will not load. Also what is stored on the row. */
export const FEED_UNREADABLE =
  'That address could not be read. Check it is a public feed and try again.';
export const FEED_NOT_A_FEED = 'That address did not return a feed Bubaly can read.';
export const FEED_SAVE_FAILED = 'The feed was read but its episodes could not be saved.';

/**
 * Pull a feed and write what it contains.
 *
 * The fetch goes through fetchPublicFeed, which is the SAME guard a document
 * fetch uses: a feed address is chosen by a user and fetched by our server,
 * which is textbook server-side request forgery unless the blocked-subnet list,
 * the DNS pinning and the redirect budget all apply. They do.
 */
export async function ingestFeed(
  supabase: Client, familyId: string, userId: string, feedId: string, feedUrl: string,
): Promise<IngestResult> {
  let parsed;
  try {
    const fetched = await fetchPublicFeed(feedUrl);
    parsed = parseFeed(fetched.text);
  } catch (err) {
    console.error('[library] feed fetch failed', err);
    return { error: FEED_UNREADABLE };
  }
  if (!parsed) return { error: FEED_NOT_A_FEED };

  await supabase.from('library_feeds').update({
    title: parsed.title,
    author: parsed.author,
    description: parsed.description,
    image_url: parsed.imageUrl,
    last_fetched_at: new Date().toISOString(),
    last_error: null,
  }).eq('id', feedId).eq('family_id', familyId);

  const rows = parsed.items
    // An entry with nothing to play and nowhere to go is not worth a row.
    .filter((item) => item.mediaUrl || item.pageUrl)
    .map((item) => ({
      family_id: familyId, feed_id: feedId,
      kind: 'episode' as const,
      guid: item.guid, title: item.title, description: item.description,
      media_url: item.mediaUrl, page_url: item.pageUrl, image_url: item.imageUrl ?? parsed.imageUrl,
      duration_seconds: item.durationSeconds, published_at: item.publishedAt,
      author: parsed.author, created_by: userId,
    }));
  if (rows.length === 0) return { added: 0 };

  // Keyed on the publisher's own guid, so a refresh updates what it already has
  // instead of duplicating the whole back catalogue every time.
  // `feed_key` (0285) is a stored generated column holding
  // `coalesce(feed_id::text, 'manual')`. 0284 put that expression straight into
  // the unique index, which reads correctly but cannot be inferred: an ON
  // CONFLICT column list only ever matches a plain, non-partial unique index, so
  // naming (family_id, feed_id, guid) raised 42P10 at planning time and every
  // ingest failed on its first row. Naming the generated column instead keeps
  // the same de-duplication and restores inference.
  const { error } = await supabase.from('library_items').upsert(rows, {
    onConflict: 'family_id,feed_key,guid',
  } as never);
  if (error) {
    console.error('[library] item upsert failed', error);
    return { error: FEED_SAVE_FAILED };
  }
  return { added: rows.length };
}

/** Record why a feed failed, so the subscription row says so rather than going quiet. */
export async function recordFeedError(
  supabase: Client, feedId: string, message: string,
): Promise<void> {
  const { error } = await supabase
    .from('library_feeds')
    .update({ last_error: message, last_fetched_at: new Date().toISOString() })
    .eq('id', feedId);
  if (error) console.error('[library] feed error write failed', error);
}
