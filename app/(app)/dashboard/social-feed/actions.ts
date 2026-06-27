'use server';

// Social Feed — server actions. Family-scoped (RLS via createServer). Sources +
// items live in Supabase; live per-platform ingestion is integration-gated, so
// these cover connect/disconnect a source, favorite/read state, and adding items
// (manual now; the same insert path a future ingestion worker uses).
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isPlatform, platformLabel, type Platform } from '@/lib/social/feed';

type Result = { ok: boolean; error?: string };
type Category = 'family' | 'friends' | 'groups' | 'other';

const PATH = '/dashboard/social-feed';
const asCategory = (v: unknown): Category =>
  v === 'family' || v === 'friends' || v === 'groups' ? v : 'other';

/** Connect a source ("Add Source" / "Add More Sources"). */
export async function addSourceAction(input: {
  platform: string; displayName?: string; handle?: string; category?: string; accountCount?: number;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isPlatform(input.platform)) return { ok: false, error: 'Pick a supported platform.' };
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

/** Add a feed item — manual now; the same path a future ingestion worker uses. */
export async function addFeedItemAction(input: {
  sourceId?: string | null; platform: string; authorName: string; authorHandle?: string;
  content?: string; mediaUrls?: string[]; thumbnailUrl?: string; permalink?: string;
  kind?: 'post' | 'video' | 'photo' | 'link'; durationLabel?: string; category?: string;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isPlatform(input.platform)) return { ok: false, error: 'Pick a supported platform.' };
  if (!input.authorName?.trim()) return { ok: false, error: 'Add who posted it.' };
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
