import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { retireAeoQuestionsForPath } from './platform';

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
  // 'draft' hides the page behind marketing_pages_public_read, and this update
  // does not bump `version`, so the 0237 regeneration trigger never fires and
  // nothing else would ever take the page's answers out of the published set.
  if (!published) await retirePublicAnswers(db, `/blog/${slug}`);
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
  await retirePublicAnswers(db, `/blog/${slug}`);
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
    // A missing trigger dependency must not masquerade as an absent registry.
    // Keep this compatibility check specific to the landing table being synced.
    const missingRegistry =
      (error.code === 'PGRST205' && /could not find the table ['"](?:public\.)?marketing_pages['"] in the schema cache/i.test(error.message)) ||
      (error.code === '42P01' && /^relation ["']?(?:public\.)?marketing_pages["']? does not exist$/i.test(error.message));
    if (missingRegistry) {
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

export async function archiveLegacyLandingOnPlatform(db: MarketingDb, slug: string, actorId: string): Promise<boolean> {
  const { data, error } = await db.from('marketing_pages').update({
    status: 'archived', deleted_at: new Date().toISOString(), updated_by: actorId,
  }).eq('path', `/lp/${slug}`).select('id').maybeSingle();
  if (error) {
    if (isMissingPlatformSchema(error)) return false;
    throw error;
  }
  await retirePublicAnswers(db, `/lp/${slug}`);
  return Boolean(data?.id);
}
