import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';

type MarketingDb = SupabaseClient<Database>;

type LegacyBlog = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  category: string;
  tags: string[];
  blocks: Json;
  publishedAt: string;
  actorId: string;
};

type LegacyLanding = {
  id: string;
  slug: string;
  title: string;
  headline: string | null;
  subhead: string | null;
  body: string | null;
  metadata: Json;
  published: boolean;
  publishedAt: string | null;
  actorId: string;
};

function isMissingPlatformSchema(error: { code?: string; message?: string } | null): boolean {
  return error?.code === 'PGRST205' || /marketing_pages|schema cache|relation .* does not exist/i.test(error?.message ?? '');
}

/**
 * Keep the established blog publisher compatible while making the canonical
 * platform registry the source for new SEO/AEO/vector work. Missing migration
 * 0231 is treated as a compatibility state; every other error is surfaced so
 * production cannot silently drift between the two public systems.
 */
export async function syncLegacyBlogToPlatform(db: MarketingDb, post: LegacyBlog): Promise<{ available: boolean; pageId: string | null }> {
  const path = `/blog/${post.slug}`;
  const { data, error } = await db.from('marketing_pages').upsert({
    page_type: 'blog',
    slug: post.slug,
    path,
    title: post.title,
    summary: post.excerpt,
    body: post.body,
    content: { source: 'marketing_content_items', source_id: post.id, category: post.category, tags: post.tags, blocks: post.blocks } as Json,
    seo: { title: post.title, description: post.excerpt, keywords: post.tags, canonical: path } as Json,
    aeo: {},
    status: 'published',
    published_at: post.publishedAt,
    created_by: post.actorId,
    updated_by: post.actorId,
    deleted_at: null,
  }, { onConflict: 'path' }).select('id').single();
  if (error) {
    if (isMissingPlatformSchema(error)) {
      console.warn('[marketing-legacy-bridge] marketing platform migration is not applied; legacy blog publish remains active');
      return { available: false, pageId: null };
    }
    throw error;
  }
  return { available: true, pageId: data?.id ?? null };
}

export async function syncLegacyBlogVisibility(db: MarketingDb, slug: string, actorId: string, published: boolean): Promise<boolean> {
  const { data, error } = await db.from('marketing_pages').update({
    status: published ? 'published' : 'draft',
    published_at: published ? new Date().toISOString() : null,
    updated_by: actorId,
    deleted_at: null,
  }).eq('path', `/blog/${slug}`).select('id').maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return false;
    throw error;
  }
  return Boolean(data?.id);
}

export async function archiveLegacyBlogOnPlatform(db: MarketingDb, slug: string, actorId: string): Promise<boolean> {
  const { data, error } = await db.from('marketing_pages').update({
    status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId,
  }).eq('path', `/blog/${slug}`).select('id').maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return false;
    throw error;
  }
  return Boolean(data?.id);
}

export async function syncLegacyLandingToPlatform(db: MarketingDb, page: LegacyLanding): Promise<{ available: boolean; pageId: string | null }> {
  const path = `/lp/${page.slug}`;
  const { data, error } = await db.from('marketing_pages').upsert({
    page_type: 'landing',
    slug: page.slug,
    path,
    title: page.headline || page.title,
    summary: page.subhead,
    body: page.body,
    content: { source: 'marketing_landing_pages', source_id: page.id, metadata: page.metadata } as Json,
    seo: { title: page.headline || page.title, description: page.subhead, canonical: path } as Json,
    aeo: {},
    status: page.published ? 'published' : 'draft',
    published_at: page.published ? page.publishedAt ?? new Date().toISOString() : null,
    created_by: page.actorId,
    updated_by: page.actorId,
    deleted_at: null,
  }, { onConflict: 'path' }).select('id').single();
  if (error) {
    if (isMissingPlatformSchema(error)) {
      console.warn('[marketing-legacy-bridge] marketing platform migration is not applied; legacy landing page remains active');
      return { available: false, pageId: null };
    }
    throw error;
  }
  return { available: true, pageId: data?.id ?? null };
}

export async function archiveLegacyLandingOnPlatform(db: MarketingDb, slug: string, actorId: string): Promise<boolean> {
  const { data, error } = await db.from('marketing_pages').update({
    status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId,
  }).eq('path', `/lp/${slug}`).select('id').maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return false;
    throw error;
  }
  return Boolean(data?.id);
}
