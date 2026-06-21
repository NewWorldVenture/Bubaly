// lib/social/queries.ts
// Server-side read helpers for the Social Command Center. All queries are
// family-scoped (RLS enforces the boundary regardless). Used by the dashboard
// pages so the UI is fully Supabase-backed — no fabricated rows anywhere.
import 'server-only';
import { createServer } from '@/lib/supabase/server';
import type { Tables } from '@/lib/database.types';
import type { SocialPostStatusEnum } from '@/lib/database.types';

export type FeedItem = Tables<'social_feed_items'>;
export type SocialAccount = Tables<'social_accounts'>;
export type SocialPost = Tables<'social_posts'>;

export async function getAccounts(familyId: string): Promise<SocialAccount[]> {
  const supabase = await createServer();
  const { data } = await supabase
    .from('social_accounts')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function getFeed(
  familyId: string,
  opts: { platform?: string; mediaType?: string; search?: string; limit?: number } = {},
): Promise<FeedItem[]> {
  const supabase = await createServer();
  let q = supabase
    .from('social_feed_items')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('posted_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.platform) q = q.eq('platform', opts.platform as FeedItem['platform']);
  if (opts.mediaType) q = q.eq('media_type', opts.mediaType);
  if (opts.search) q = q.ilike('body', `%${opts.search}%`);
  const { data } = await q;
  return data ?? [];
}

export async function getPosts(
  familyId: string,
  statuses?: SocialPostStatusEnum[],
): Promise<SocialPost[]> {
  const supabase = await createServer();
  let q = supabase
    .from('social_posts')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (statuses && statuses.length) q = q.in('status', statuses);
  const { data } = await q;
  return data ?? [];
}

export async function getPost(familyId: string, postId: string) {
  const supabase = await createServer();
  const [{ data: post }, { data: variants }, { data: targets }, { data: results }] = await Promise.all([
    supabase.from('social_posts').select('*').eq('family_id', familyId).eq('id', postId).maybeSingle(),
    supabase.from('social_post_variants').select('*').eq('family_id', familyId).eq('post_id', postId),
    supabase.from('social_post_targets').select('*').eq('family_id', familyId).eq('post_id', postId),
    supabase.from('social_publish_results').select('*').eq('family_id', familyId).eq('post_id', postId).order('attempted_at', { ascending: false }),
  ]);
  return { post: post ?? null, variants: variants ?? [], targets: targets ?? [], results: results ?? [] };
}

export async function getMediaLibrary(familyId: string): Promise<Tables<'social_media_library'>[]> {
  const supabase = await createServer();
  const { data } = await supabase
    .from('social_media_library')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function getCalendarItems(familyId: string): Promise<Tables<'social_calendar_items'>[]> {
  const supabase = await createServer();
  const { data } = await supabase
    .from('social_calendar_items')
    .select('*')
    .eq('family_id', familyId)
    .order('scheduled_for', { ascending: true });
  return data ?? [];
}

export async function getInbox(familyId: string) {
  const supabase = await createServer();
  const [{ data: comments }, { data: messages }] = await Promise.all([
    supabase.from('social_comments').select('*').eq('family_id', familyId).is('deleted_at', null).order('posted_at', { ascending: false }).limit(100),
    supabase.from('social_messages').select('*').eq('family_id', familyId).is('deleted_at', null).order('posted_at', { ascending: false }).limit(100),
  ]);
  return { comments: comments ?? [], messages: messages ?? [] };
}

export type AnalyticsTotals = {
  postsPublished: number;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  views: number;
  watchTimeSeconds: number;
  followers: number;
  snapshots: number;
};

export async function getAnalytics(familyId: string): Promise<{
  totals: AnalyticsTotals;
  byPlatform: Record<string, number>;
}> {
  const supabase = await createServer();
  const [{ data: snaps }, { count: published }] = await Promise.all([
    supabase.from('social_analytics_snapshots').select('*').eq('family_id', familyId).limit(1000),
    supabase.from('social_posts').select('id', { count: 'exact', head: true }).eq('family_id', familyId).in('status', ['published', 'partially_published']),
  ]);
  const rows = snaps ?? [];
  const totals: AnalyticsTotals = {
    postsPublished: published ?? 0,
    impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0,
    clicks: 0, views: 0, watchTimeSeconds: 0, followers: 0, snapshots: rows.length,
  };
  const byPlatform: Record<string, number> = {};
  for (const r of rows) {
    totals.impressions += Number(r.impressions);
    totals.reach += Number(r.reach);
    totals.likes += Number(r.likes);
    totals.comments += Number(r.comments);
    totals.shares += Number(r.shares);
    totals.saves += Number(r.saves);
    totals.clicks += Number(r.clicks);
    totals.views += Number(r.views);
    totals.watchTimeSeconds += Number(r.watch_time_seconds);
    totals.followers = Math.max(totals.followers, Number(r.followers));
    byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + Number(r.impressions);
  }
  return { totals, byPlatform };
}

export async function getSocialOverview(familyId: string) {
  const supabase = await createServer();
  const [accounts, feedCount, drafts, scheduled, published, failed, openInbox] = await Promise.all([
    getAccounts(familyId),
    supabase.from('social_feed_items').select('id', { count: 'exact', head: true }).eq('family_id', familyId),
    supabase.from('social_posts').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'draft'),
    supabase.from('social_posts').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'scheduled'),
    supabase.from('social_posts').select('id', { count: 'exact', head: true }).eq('family_id', familyId).in('status', ['published', 'partially_published']),
    supabase.from('social_posts').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'failed'),
    supabase.from('social_comments').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'open'),
  ]);
  return {
    accounts,
    connectedCount: accounts.filter((a) => a.status === 'connected').length,
    feedCount: feedCount.count ?? 0,
    drafts: drafts.count ?? 0,
    scheduled: scheduled.count ?? 0,
    published: published.count ?? 0,
    failed: failed.count ?? 0,
    openInbox: openInbox.count ?? 0,
  };
}
