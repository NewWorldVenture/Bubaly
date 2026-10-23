import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { retireAeoQuestionsForPath } from './platform';
import { refuseInput } from '@/lib/actions/refusal';

type MarketingDb = SupabaseClient<Database>;

/**
 * A path whose page has just left the public set must not keep its generated AEO
 * answers published: the 0228 public-read policy keys on `status = 'published'`
 * alone, so those rows stay world-readable on /faq and in every sibling
 * article's FAQ block even though the page itself is now hidden.
 *
 * This lives at the bridge because the bridge — not the calling action — is what
 * actually takes the marketing_pages row down, and it has three callers. It runs
 * only after that take-down succeeded, so the missing-platform-schema
 * compatibility path never reaches it; any error here is real and is thrown.
 */
async function retirePublicAnswers(db: MarketingDb, path: string): Promise<void> {
  const { error } = await retireAeoQuestionsForPath(db, path, ['marketing_platform']);
  if (error) throw error;
}

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

function contentSource(content: Json | null | undefined): { source?: unknown; source_id?: unknown } {
  return content && typeof content === 'object' && !Array.isArray(content)
    ? content as { source?: unknown; source_id?: unknown }
    : {};
}

/**
 * The rows at /blog/<slug> that mirror the legacy blog: this publisher's own,
 * and the copies scripts/backfill-marketing-pages.mjs made of blog_posts. Any
 * of them is the article's own row, whichever content item last published it:
 * blog_posts is keyed by slug, so the article at /blog/<slug> is the one a
 * publish there replaces, and its mirror follows it.
 */
const LEGACY_BLOG_SOURCES = ['marketing_content_items', 'blog_posts'];

/**
 * Admin reach N12-S1. Refuse a blog publish whose /blog/<slug> belongs to a
 * page that is not a legacy blog mirror, such as one made in the platform
 * console, which offers page type "Blog" under the same prefix. The sync below
 * upserts on `path`, so it replaced that page's title, body, content, SEO and
 * AEO with the post's and forced it published. The caller runs this BEFORE its
 * blog_posts write, so a refusal publishes nothing.
 */
export async function assertLegacyBlogPathFree(db: MarketingDb, slug: string): Promise<void> {
  const { data, error } = await db.from('marketing_pages').select('content').eq('path', `/blog/${slug}`).maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return;
    throw error;
  }
  if (!data || LEGACY_BLOG_SOURCES.includes(String(contentSource(data.content).source))) return;
  refuseInput(`/blog/${slug} is already used by another marketing page.`, 'duplicate');
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
  // Only a legacy blog mirror (admin reach N12-S1): a console page at the path
  // is not this post's to draft. Answers are still retired below by path: the
  // public /blog/<slug> renders blog_posts alone, and the post is now down.
  const { data, error } = await db.from('marketing_pages').update({
    status: published ? 'published' : 'draft',
    published_at: published ? new Date().toISOString() : null,
    updated_by: actorId,
    deleted_at: null,
  }).eq('path', `/blog/${slug}`).in('content->>source', LEGACY_BLOG_SOURCES).select('id').maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return false;
    throw error;
  }
  // 'draft' hides the page behind marketing_pages_public_read, and this update
  // does not bump `version`, so the 0237 regeneration trigger never fires and
  // nothing else would ever take the page's answers out of the published set.
  if (!published) await retirePublicAnswers(db, `/blog/${slug}`);
  return Boolean(data?.id);
}

export async function archiveLegacyBlogOnPlatform(db: MarketingDb, slug: string, actorId: string): Promise<boolean> {
  // Scoped, and its answers retired, as in syncLegacyBlogVisibility (N12-S1).
  const { data, error } = await db.from('marketing_pages').update({
    status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId,
  }).eq('path', `/blog/${slug}`).in('content->>source', LEGACY_BLOG_SOURCES).select('id').maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return false;
    throw error;
  }
  await retirePublicAnswers(db, `/blog/${slug}`);
  return Boolean(data?.id);
}

function isMissingLandingRegistry(error: { code?: string; message?: string }): boolean {
  return (error.code === 'PGRST205' && /could not find the table ['"](?:public\.)?marketing_pages['"] in the schema cache/i.test(error.message ?? '')) ||
    (error.code === '42P01' && /^relation ["']?(?:public\.)?marketing_pages["']? does not exist$/i.test(error.message ?? ''));
}

/**
 * Refuse a legacy landing page whose /lp/<slug> already belongs to another page
 * in the platform registry. The sync below upserts on `path`, and the legacy
 * slug is unique only in its own table, so a draft created (or renamed) onto a
 * platform page's slug replaced that live page's content and took it down.
 * Callers run this BEFORE writing the legacy row: once a published legacy row
 * holds the slug, /lp/<slug> serves it in place of the platform page anyway.
 *
 * The path is free when nothing is there, when the row is this legacy page's
 * own mirror, or when it is an archived mirror of a legacy page (a renamed
 * page's retired alias), which no live page holds.
 */
export async function assertLegacyLandingPathFree(db: MarketingDb, slug: string, landingId: string | null): Promise<void> {
  if (await legacyLandingPathTaken(db, slug, landingId)) refuseInput(`/lp/${slug} is already used by another marketing page.`, 'duplicate');
}

/** The same rule as a yes/no, for a caller that can go on without writing the mirror (setLandingPublished, N12-R1). */
export async function legacyLandingPathTaken(db: MarketingDb, slug: string, landingId: string | null): Promise<boolean> {
  const { data, error } = await db.from('marketing_pages')
    .select('id, content, deleted_at').eq('path', `/lp/${slug}`).maybeSingle();
  if (error) {
    if (isMissingLandingRegistry(error)) return false;
    throw error;
  }
  if (!data) return false;
  const content = contentSource(data.content);
  const legacy = content.source === 'marketing_landing_pages';
  if (legacy && landingId !== null && content.source_id === landingId) return false;
  if (legacy && data.deleted_at != null) return false;
  return true;
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
    // A missing trigger dependency must not masquerade as an absent registry.
    // Keep this compatibility check specific to the landing table being synced.
    if (isMissingLandingRegistry(error)) {
      console.warn('[marketing-legacy-bridge] marketing platform migration is not applied; legacy landing page remains active');
      return { available: false, pageId: null };
    }
    throw error;
  }
  return { available: true, pageId: data?.id ?? null };
}

/**
 * Retire only noncurrent URLs belonging to this legacy landing page. Run after
 * a confirmed current-page sync, including retries whose legacy slug already
 * changed before an earlier retirement failed. Ownership stays in the UPDATE
 * predicates so reassigned canonical rows cannot be archived by a stale read.
 *
 * This repairs canonical URL visibility only. AEO withdrawal needs a database
 * retirement guarantee; a separate path-only answer update can affect a new
 * owner at that path and is deliberately not performed here.
 */
export async function retireLegacyLandingAliases(db: MarketingDb, page: Pick<LegacyLanding, 'id' | 'slug' | 'actorId'>): Promise<string[]> {
  const { data, error } = await db.from('marketing_pages').update({
    status: 'archived', deleted_at: new Date().toISOString(), updated_by: page.actorId,
  }).eq('page_type', 'landing')
    .contains('content', { source: 'marketing_landing_pages', source_id: page.id })
    .like('path', '/lp/%').neq('path', `/lp/${page.slug}`).is('deleted_at', null)
    .select('path');
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Could not confirm landing page alias retirement.');
  return data.map(row => row.path);
}

/**
 * Admin reach N12-R1: this page's own mirror and its answers only. By path
 * alone this archived whatever page held /lp/<slug> (such as a platform page
 * made there after the console renamed the mirror off it) and retired that
 * page's answers, though it is what /lp/<slug> serves once the legacy page goes.
 */
export async function archiveLegacyLandingOnPlatform(db: MarketingDb, page: Pick<LegacyLanding, 'id' | 'slug' | 'actorId'>): Promise<boolean> {
  const { data, error } = await db.from('marketing_pages').update({
    status: 'archived', deleted_at: new Date().toISOString(), updated_by: page.actorId,
  }).eq('path', `/lp/${page.slug}`).contains('content', { source: 'marketing_landing_pages', source_id: page.id })
    .select('id').maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return false;
    throw error;
  }
  if (!data?.id) return false;
  await retirePublicAnswers(db, `/lp/${page.slug}`);
  return true;
}
