import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { SocialFeedModule, type FeedSource, type FeedItem } from '@/components/modules/social-feed-module';

export const metadata: Metadata = { title: 'Social Feed' };
export const dynamic = 'force-dynamic';

export default async function SocialFeedPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: sources }, { data: items }] = await settleAll([
    supabase.from('social_reader_sources')
      .select('id, platform, display_name, handle, account_count, category, is_active')
      .eq('family_id', familyId).eq('is_active', true).order('sort_order').order('created_at'),
    supabase.from('social_reader_items')
      .select('id, source_id, platform, author_name, author_handle, avatar_url, content, media_urls, thumbnail_url, permalink, kind, duration_label, category, verified, is_favorite, is_read, posted_at')
      .eq('family_id', familyId).order('posted_at', { ascending: false }).limit(200),
  ]);

  const feedSources: FeedSource[] = (sources ?? []).map((s) => ({
    id: s.id, platform: s.platform, displayName: s.display_name, handle: s.handle,
    accountCount: s.account_count, category: s.category,
  }));
  const feedItems: FeedItem[] = (items ?? []).map((i) => ({
    id: i.id, platform: i.platform, authorName: i.author_name, authorHandle: i.author_handle,
    avatarUrl: i.avatar_url, content: i.content, mediaUrls: i.media_urls ?? [], thumbnailUrl: i.thumbnail_url,
    permalink: i.permalink, kind: i.kind, durationLabel: i.duration_label, category: i.category,
    verified: i.verified, isFavorite: i.is_favorite, isRead: i.is_read, postedAt: i.posted_at,
  }));

  return <SocialFeedModule sources={feedSources} items={feedItems} />;
}
