'use server';

// The family library: subscribe to a feed, refresh it, add a book by hand,
// keep your place, save and mark for offline.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { safeFeedUrl } from '@/lib/library/feed-parse';
// The ingest itself lives in lib/, not here: a 'use server' module may only
// export async functions and every export it has is callable from the browser,
// so anything the nightly cron also needs cannot live in this file.
import { ingestFeed } from '@/lib/library/ingest';
import { rateLimit } from '@/lib/server/rate-limit';

const PAGE = '/dashboard/library';

export type LibraryResult = { ok: true; message: string } | { ok: false; error: string };

const feedSchema = z.object({
  url: z.string().trim().url('Enter the feed address'),
  kind: z.enum(['podcast', 'book']),
});

const bookSchema = z.object({
  title: z.string().trim().min(1, 'Give the book a title').max(300),
  author: z.string().trim().max(200).optional(),
  pageUrl: z.string().trim().url('Enter a valid link').or(z.literal('')).optional(),
  mediaUrl: z.string().trim().url('Enter a valid audio link').or(z.literal('')).optional(),
});

export async function subscribeFeedAction(formData: FormData): Promise<LibraryResult> {
  const ctx = await requireUserContext();
  const parsed = feedSchema.safeParse({
    url: String(formData.get('url') ?? ''),
    kind: String(formData.get('kind') ?? 'podcast'),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the address.' };

  const feedUrl = safeFeedUrl(parsed.data.url);
  if (!feedUrl) return { ok: false, error: 'Only http and https addresses can be used.' };

  const supabase = await createServer();
  const { data: feed, error } = await supabase
    .from('library_feeds')
    .upsert({
      family_id: ctx.active.familyId, kind: parsed.data.kind,
      title: feedUrl, feed_url: feedUrl, created_by: ctx.user.id,
    }, { onConflict: 'family_id,feed_url' })
    .select('id')
    .single();
  if (error || !feed) {
    console.error('[library] subscribe failed', error);
    return { ok: false, error: 'Could not save that subscription.' };
  }

  const result = await ingestFeed(supabase, ctx.active.familyId, ctx.user.id, feed.id, feedUrl);
  revalidatePath(PAGE);
  if ('error' in result) {
    // The subscription row stays, carrying the reason. A feed that failed once
    // is usually worth retrying, and a row that says why is more use than one
    // that silently disappeared.
    await supabase.from('library_feeds').update({ last_error: result.error }).eq('id', feed.id);
    return { ok: false, error: result.error };
  }
  return { ok: true, message: `Subscribed. ${result.added} ${result.added === 1 ? 'item' : 'items'} added.` };
}

/**
 * Two limits, because there are two things to protect.
 *
 * Per FEED: pressing Refresh is one click and a publisher's server is somebody
 * else's. Five in ten minutes is more than any person needs and far less than
 * a held-down button sends.
 *
 * Per FAMILY: a household with thirty subscriptions could otherwise walk down
 * the list and make thirty outbound fetches as fast as it can click, which is
 * OUR egress and our reputation with every one of those publishers.
 *
 * Both are advisory — the limiter is per-instance and in memory — and that is
 * the right weight here. The cron below is what keeps a feed current, so manual
 * refresh is the exception rather than the mechanism.
 */
const REFRESH_TOO_OFTEN = 'That feed was just refreshed. Give it a few minutes.';

export async function refreshFeedAction(feedId: string): Promise<LibraryResult> {
  const ctx = await requireUserContext();
  if (!rateLimit(`library-refresh-feed:${feedId}`, { limit: 5, windowMs: 10 * 60_000 }).ok
    || !rateLimit(`library-refresh-family:${ctx.active.familyId}`, { limit: 30, windowMs: 10 * 60_000 }).ok) {
    return { ok: false, error: REFRESH_TOO_OFTEN };
  }
  const supabase = await createServer();
  const { data: feed, error } = await supabase
    .from('library_feeds').select('id, feed_url')
    .eq('id', feedId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (error || !feed) return { ok: false, error: 'That subscription could not be found.' };

  const result = await ingestFeed(supabase, ctx.active.familyId, ctx.user.id, feed.id, feed.feed_url);
  revalidatePath(PAGE);
  if ('error' in result) {
    await supabase.from('library_feeds').update({ last_error: result.error }).eq('id', feed.id);
    return { ok: false, error: result.error };
  }
  return { ok: true, message: `Refreshed. ${result.added} ${result.added === 1 ? 'item' : 'items'} up to date.` };
}

export async function unsubscribeFeedAction(feedId: string): Promise<LibraryResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('library_feeds').delete().eq('id', feedId).eq('family_id', ctx.active.familyId);
  if (error) {
    console.error('[library] unsubscribe failed', error);
    return { ok: false, error: 'Could not remove that subscription.' };
  }
  revalidatePath(PAGE);
  return { ok: true, message: 'Subscription removed.' };
}

export async function addBookAction(formData: FormData): Promise<LibraryResult> {
  const ctx = await requireUserContext();
  const parsed = bookSchema.safeParse({
    title: String(formData.get('title') ?? ''),
    author: String(formData.get('author') ?? ''),
    pageUrl: String(formData.get('pageUrl') ?? ''),
    mediaUrl: String(formData.get('mediaUrl') ?? ''),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };

  const supabase = await createServer();
  const { error } = await supabase.from('library_items').insert({
    family_id: ctx.active.familyId, feed_id: null, kind: 'book',
    // Manual books have no publisher guid, so one is minted from the title and
    // the moment — enough to keep the uniqueness index honest without pretending
    // two different people's copies are the same row.
    guid: `manual:${parsed.data.title.toLowerCase().slice(0, 120)}:${Date.now()}`,
    title: parsed.data.title,
    author: parsed.data.author || null,
    page_url: safeFeedUrl(parsed.data.pageUrl) ?? null,
    media_url: safeFeedUrl(parsed.data.mediaUrl) ?? null,
    created_by: ctx.user.id,
  });
  if (error) {
    console.error('[library] add book failed', error);
    return { ok: false, error: 'Could not add that book.' };
  }
  revalidatePath(PAGE);
  return { ok: true, message: 'Added to your library.' };
}

const progressSchema = z.object({
  itemId: z.string().uuid(),
  positionSeconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
  saved: z.boolean().optional(),
  offline: z.boolean().optional(),
  completed: z.boolean().optional(),
});

/**
 * Where this PERSON has got to.
 *
 * Keyed on (item, user): a household shares the subscription but not the
 * bookmark, and RLS on library_progress refuses a row whose user_id is not the
 * caller — so one member cannot move another's place even by id.
 */
export async function saveProgressAction(input: z.input<typeof progressSchema>): Promise<LibraryResult> {
  const ctx = await requireUserContext();
  const parsed = progressSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid progress update.' };

  const supabase = await createServer();
  const patch: Record<string, unknown> = {
    family_id: ctx.active.familyId, item_id: parsed.data.itemId, user_id: ctx.user.id,
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.positionSeconds !== undefined) patch.position_seconds = parsed.data.positionSeconds;
  if (parsed.data.saved !== undefined) patch.saved = parsed.data.saved;
  if (parsed.data.offline !== undefined) patch.offline = parsed.data.offline;
  if (parsed.data.completed !== undefined) patch.completed_at = parsed.data.completed ? new Date().toISOString() : null;

  const { error } = await supabase.from('library_progress').upsert(patch as never, { onConflict: 'item_id,user_id' });
  if (error) {
    console.error('[library] progress save failed', error);
    return { ok: false, error: 'Could not save your place.' };
  }
  revalidatePath(PAGE);
  return { ok: true, message: 'Saved.' };
}
