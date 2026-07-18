'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { buildBlogPost } from '@/lib/marketing/blog-publish';
import { deriveArticleAeoQuestions } from '@/lib/marketing/aeo-generate';
import type { Json } from '@/lib/database.types';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

const STATUSES = ['idea', 'brief', 'drafting', 'review', 'approved', 'published'];

function blogMetadata(metadata: unknown): Record<string, unknown> {
  const root = (metadata ?? {}) as Record<string, unknown>;
  const nested = root.blog;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : root;
}

/** Edit a content item: its draft body, workflow status, and the blog metadata
 *  (category/author/excerpt/featured/tags/slug) used when publishing to the blog. */
export async function updateContentAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  if (!id) return;

  const { data: existing, error: readError } = await supabase
    .from('marketing_content_items').select('metadata').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError || !existing) marketingActionFailure('find the marketing content item', readError ?? new Error('Marketing content item not found.'));
  const meta = (existing?.metadata ?? {}) as Record<string, unknown>;
  const blog = blogMetadata(meta);

  const next = {
    ...meta,
    blog: {
      ...blog,
      slug: s(formData, 'slug'),
      category: s(formData, 'category'),
      author: s(formData, 'author'),
      excerpt: s(formData, 'excerpt'),
      featured: formData.get('featured') === 'on',
      tags: (s(formData, 'tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    },
  };

  const status = s(formData, 'status');
  const { data, error } = await supabase.from('marketing_content_items').update({
    body: s(formData, 'body'),
    status: status && STATUSES.includes(status) ? status : undefined,
    metadata: next as unknown as Json,
    updated_by: actorId,
  }).eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the marketing content item', error ?? new Error('Marketing content item not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'marketing_content_item', resourceId: id });
  revalidatePath('/admin/marketing/content');
}

/** Publish an approved content item to the public blog: upsert a blog_posts row
 *  (keyed by slug, so re-publishing updates), mark the item published, and stamp
 *  the resolved slug back onto its metadata. */
export async function publishContentToBlogAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  if (!id) return;

  const { data: item, error: readError } = await supabase
    .from('marketing_content_items')
    .select('id, title, body, metadata, status')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (readError) marketingActionFailure('load the marketing content item', readError);
  if (!item) marketingActionFailure('load the marketing content item', new Error('Marketing content item not found.'));
  if (!item.body) marketingActionFailure('publish the blog post', new Error('A blog post needs body copy before it can be published.'));
  if (!['approved', 'published'].includes(item.status)) {
    marketingActionFailure('publish the blog post', new Error('Approve the content item before publishing it.'));
  }

  const payload = buildBlogPost(item, new Date().toISOString());
  const { data: post, error } = await supabase
    .from('blog_posts')
    .upsert({ ...payload, body: payload.body as unknown as Json }, { onConflict: 'slug' }).select('slug').single();
  if (error || !post) marketingActionFailure('publish the blog post', error ?? new Error('The blog post row was not returned.'));

  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const blog = blogMetadata(meta);
  const { data: updated, error: updateError } = await supabase.from('marketing_content_items').update({
    status: 'published',
    publish_at: payload.published_at,
    metadata: { ...meta, blog: { ...blog, slug: payload.slug } } as unknown as Json,
    updated_by: actorId,
  }).eq('id', id).select('id').maybeSingle();
  if (updateError || !updated) marketingActionFailure('mark the content item as published', updateError ?? new Error('Marketing content item not found.'));

  // Closed loop: auto-generate this post's AEO Knowledge-Center questions so it
  // becomes a citable answer (its own FAQPage) the moment it's published.
  try {
    const aeo = deriveArticleAeoQuestions({
      slug: payload.slug,
      title: payload.title,
      category: payload.category,
      excerpt: payload.excerpt,
    });
    await supabase.from('marketing_aeo_questions').delete().eq('source_path', `/blog/${payload.slug}`).eq('metadata->>seed', 'blog_aeo_v1');
    await supabase.from('marketing_aeo_questions').insert(
      aeo.map((q) => ({
        question: q.question, answer: q.answer, entity: q.entity, source_path: q.source_path,
        pattern: q.pattern, status: q.status, clarity_score: q.clarity_score,
        last_reviewed: new Date().toISOString(), metadata: q.metadata as unknown as Json,
      })),
    );
  } catch {
    /* AEO generation is best-effort — never block a publish on it */
  }

  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'publish', resource: 'blog_post', resourceId: payload.slug, metadata: { fromContentItem: id } });
  revalidatePath('/admin/marketing/content');
  revalidatePath('/admin/marketing/aeo');
  revalidatePath('/blog');
  revalidatePath(`/blog/${payload.slug}`);
  revalidatePath('/faq');
}

/** Pull a published post from the public blog without deleting it. */
export async function unpublishBlogPostAction(slug: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('blog_posts').update({ published: false }).eq('slug', slug)
    .select('slug').maybeSingle();
  if (error || !data) marketingActionFailure('unpublish the blog post', error ?? new Error('Blog post not found.'));

  // Keep the admin pipeline honest when a public post is pulled down. The
  // registry migration stores source slugs at metadata.slug, while the admin
  // publisher stores metadata.blog.slug; support both shapes during migration.
  const { data: items, error: itemsError } = await supabase
    .from('marketing_content_items')
    .select('id, metadata, status')
    .eq('kind', 'blog')
    .is('deleted_at', null);
  if (itemsError) marketingActionFailure('sync the unpublished blog item', itemsError);
  const matching = (items ?? []).filter((item) => {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const nested = blogMetadata(meta);
    return nested.slug === slug || meta.slug === slug;
  });
  for (const item of matching) {
    const { data: updated, error: updateError } = await supabase.from('marketing_content_items').update({
      status: 'approved',
      publish_at: null,
    }).eq('id', item.id).is('deleted_at', null).select('id').maybeSingle();
    if (updateError || !updated) marketingActionFailure('sync the unpublished blog item', updateError ?? new Error('Marketing content item not found.'));
  }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'unpublish', resource: 'blog_post', resourceId: slug });
  revalidatePath('/admin/marketing/content');
  revalidatePath('/blog');
  revalidatePath(`/blog/${slug}`);
}

export async function archiveContentAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  if (!id) return;
  const { data: item, error: readError } = await supabase.from('marketing_content_items')
    .select('id, metadata, kind').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError || !item) marketingActionFailure('find the marketing content item', readError ?? new Error('Marketing content item not found.'));

  const { data, error } = await supabase.from('marketing_content_items').update({
    status: 'approved',
    deleted_at: new Date().toISOString(),
    updated_by: actorId,
  }).eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('archive the marketing content item', error ?? new Error('Marketing content item not found.'));

  if (item.kind === 'blog') {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const nestedSlug = blogMetadata(meta).slug;
    const slug: string | null = typeof nestedSlug === 'string'
      ? nestedSlug
      : typeof meta.slug === 'string' ? meta.slug : null;
    if (slug) {
      const { error: unpublishError } = await supabase.from('blog_posts').update({ published: false }).eq('slug', slug);
      if (unpublishError) marketingActionFailure('unpublish the archived blog post', unpublishError);
      revalidatePath(`/blog/${slug}`);
    }
  }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'archive', resource: 'marketing_content_item', resourceId: id });
  revalidatePath('/admin/marketing/content');
  revalidatePath('/blog');
}
