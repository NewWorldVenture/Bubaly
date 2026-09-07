'use server';

// Social Feed — server actions. Family-scoped (RLS via createServer). Sources +
// items live in Supabase; live per-platform ingestion is integration-gated, so
// these cover connect/disconnect a source, favorite/read state, and adding items
// (manual now; the same insert path a future ingestion worker uses).
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isPlatform, platformLabel, type Platform } from '@/lib/social/feed';
import { buildItemFromHtml, isSafePublicUrl } from '@/lib/social/unfurl';
import { fetchPublicText } from '@/lib/server/public-calendar-fetch';

type Result = { ok: boolean; error?: string };
type Category = 'family' | 'friends' | 'groups' | 'other';

const PATH = '/dashboard/social-feed';
const asCategory = (v: unknown): Category =>
  v === 'family' || v === 'friends' || v === 'groups' ? v : 'other';

/** Connect a source ("Add Source" / "Add More Sources"). */
export async function addSourceAction(input: {
  platform: string; displayName?: string; handle?: string; category?: string; accountCount?: number;
}): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isPlatform(input.platform)) return { ok: false, error: t('actions.pickASupportedPlatform') };
  const platform = input.platform as Platform;
  const supabase = await createServer();
  const { error } = await supabase.from('social_reader_sources').insert({
    family_id: ctx.active.familyId,
    platform,
    display_name: input.displayName?.trim() || platformLabel(platform),
    handle: input.handle?.trim() || null,
    account_count: Math.max(1, Math.trunc(input.accountCount ?? 1)),
    category: asCategory(input.category),
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

/** Disconnect a source (does not delete already-collected items). */
export async function removeSourceAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('social_reader_sources')
    .delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

/** Bookmark / un-bookmark an item. */
export async function toggleFavoriteAction(input: { id: string; favorite: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('social_reader_items')
    .update({ is_favorite: input.favorite }).eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

/** Mark a single item read/unread. */
export async function markReadAction(input: { id: string; read: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('social_reader_items')
    .update({ is_read: input.read }).eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

/** Mark every item read ("clear" the unread state). */
export async function markAllReadAction(): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('social_reader_items')
    .update({ is_read: true }).eq('family_id', ctx.active.familyId).eq('is_read', false);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Add to the feed by pasting a URL. Fetches the link server-side, reads its
 * OpenGraph/Twitter-card metadata, and stores a real feed item — the ungated
 * ingestion path that works today (no per-platform OAuth needed). Idempotent:
 * the canonical URL is the `external_id`, so re-adding the same link is a no-op.
 */
export async function addByUrlAction(input: { url: string; category?: string; sourceId?: string | null }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const raw = (input.url ?? '').trim();
  if (!raw) return { ok: false, error: t('actions.pasteALinkToAdd') };
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (!isSafePublicUrl(url)) return { ok: false, error: t('actions.enterAValidPublicWeb') };

  let html: string;
  try {
    const boundedFetch = async (target: string, _init: RequestInit): Promise<Response> => {
      const fetched = await fetchPublicText(target, {
        maxBytes: 600_000,
        label: 'Web page',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Bubaly-SocialFeed/1.0; +https://www.bubaly.com)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      if (!fetched.ok) return new Response(null, { status: fetched.status });
      return new Response(fetched.text, {
        status: 200,
        headers: fetched.contentType ? { 'content-type': fetched.contentType } : undefined,
      });
    };
    const res = await boundedFetch(url, {
      headers: {
        // A real UA + HTML Accept so sites return their OpenGraph <head>.
        'User-Agent': 'Mozilla/5.0 (compatible; Bubaly-SocialFeed/1.0; +https://www.bubaly.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) return { ok: false, error: `Couldn’t fetch that link (HTTP ${res.status}).` };
    const type = res.headers.get('content-type') ?? '';
    if (type && !/text\/html|application\/xhtml|text\/xml|application\/xml/i.test(type)) {
      return { ok: false, error: t('actions.thatLinkIsnTA') };
    }
    // Cap the body we parse — the <head> is all we need.
    html = await res.text();
  } catch {
    return { ok: false, error: t('actions.couldnTReachThatLink') };
  }

  const draft = buildItemFromHtml(url, html);
  const supabase = await createServer();

  // Idempotent: skip if this canonical link is already in the family's feed.
  const { data: existing } = await supabase.from('social_reader_items')
    .select('id').eq('family_id', ctx.active.familyId).eq('platform', draft.platform)
    .eq('external_id', draft.externalId).limit(1).maybeSingle();
  if (existing) { revalidatePath(PATH); return { ok: true }; }

  const { error } = await supabase.from('social_reader_items').insert({
    family_id: ctx.active.familyId,
    source_id: input.sourceId ?? null,
    platform: draft.platform,
    author_name: draft.authorName,
    author_handle: draft.authorHandle,
    content: draft.content,
    media_urls: draft.mediaUrls,
    thumbnail_url: draft.thumbnailUrl,
    permalink: draft.permalink,
    kind: draft.kind,
    duration_label: draft.durationLabel,
    category: asCategory(input.category),
    external_id: draft.externalId,
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

/** Add a feed item — manual now; the same path a future ingestion worker uses. */
export async function addFeedItemAction(input: {
  sourceId?: string | null; platform: string; authorName: string; authorHandle?: string;
  content?: string; mediaUrls?: string[]; thumbnailUrl?: string; permalink?: string;
  kind?: 'post' | 'video' | 'photo' | 'link'; durationLabel?: string; category?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isPlatform(input.platform)) return { ok: false, error: t('actions.pickASupportedPlatform') };
  if (!input.authorName?.trim()) return { ok: false, error: t('actions.addWhoPostedIt') };
  const supabase = await createServer();
  const { error } = await supabase.from('social_reader_items').insert({
    family_id: ctx.active.familyId,
    source_id: input.sourceId ?? null,
    platform: input.platform,
    author_name: input.authorName.trim(),
    author_handle: input.authorHandle?.trim() || null,
    content: input.content?.trim() || null,
    media_urls: input.mediaUrls ?? [],
    thumbnail_url: input.thumbnailUrl ?? null,
    permalink: input.permalink?.trim() || null,
    kind: input.kind ?? 'post',
    duration_label: input.durationLabel ?? null,
    category: asCategory(input.category),
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}
