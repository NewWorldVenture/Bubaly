// lib/marketing/blog-publish.ts — pure helpers that turn an approved marketing
// content item (`marketing_content_items`, plain-text body) into a public blog
// post (`blog_posts`, structured BlogBlock body). No server-only imports so it's
// unit-testable; the publish action supplies the timestamp.
import type { BlogBlock, BlogCategory } from '@/lib/blog/posts';

export const BLOG_CATEGORIES: BlogCategory[] = [
  'Parenting', 'Organization', 'School & Activities', 'AI & Technology', 'Wellness', 'Family Finances',
  'Recipes & Food', 'Travel & Adventures', 'Home & Seasonal',
];

/** Coerce arbitrary input to a valid blog category, defaulting to Organization. */
export function normalizeCategory(input: string | null | undefined): BlogCategory {
  const v = (input ?? '').trim();
  return (BLOG_CATEGORIES as string[]).includes(v) ? (v as BlogCategory) : 'Organization';
}

/** lowercase kebab slug. */
export function blogSlugify(input: string): string {
  return (input ?? '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/** Split a plain-text body into BlogBlocks. Paragraphs split on blank lines;
 *  a line prefixed with `#`/`##` (or wrapped in **bold**) becomes an h2. */
export function contentBodyToBlocks(body: string | null | undefined): BlogBlock[] {
  const out: BlogBlock[] = [];
  for (const raw of (body ?? '').split(/\n{2,}/)) {
    const para = raw.trim();
    if (!para) continue;
    const heading = para.match(/^#{1,3}\s+(.*)$/);
    if (heading) { out.push({ type: 'h2', text: heading[1].trim() }); continue; }
    const bold = para.match(/^\*\*(.+)\*\*$/);
    if (bold) { out.push({ type: 'h2', text: bold[1].trim() }); continue; }
    out.push({ type: 'p', text: para.replace(/\n+/g, ' ') });
  }
  return out;
}

/** Estimate reading time at ~200 wpm, minimum 1 minute. */
export function estimateReadingMinutes(body: string | null | undefined): number {
  const words = (body ?? '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** First paragraph as an excerpt, markdown markers stripped, truncated. */
export function deriveExcerpt(body: string | null | undefined, max = 160): string {
  const first = (body ?? '').split(/\n{2,}/).map((p) => p.trim()).find(Boolean) ?? '';
  const clean = first.replace(/^#{1,3}\s+/, '').replace(/\*\*/g, '').replace(/\n+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export type ContentItemInput = { title: string; body: string | null; metadata: unknown };

export type BlogPostPayload = {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  category: BlogCategory;
  tags: string[];
  reading_minutes: number;
  featured: boolean;
  accent_color: string | null;
  body: BlogBlock[];
  published: boolean;
  published_at: string;
};

/** Build the blog_posts upsert payload from a content item. Overrides come from
 *  `item.metadata.blog` ({ slug, excerpt, author, category, tags, featured,
 *  accent_color }); everything else is derived from the title/body. */
export function buildBlogPost(item: ContentItemInput, publishedAt: string): BlogPostPayload {
  const meta = ((item.metadata as Record<string, unknown> | null)?.blog ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const body = item.body ?? '';
  return {
    slug: blogSlugify(str(meta.slug) || item.title),
    title: item.title,
    excerpt: str(meta.excerpt) || deriveExcerpt(body),
    author: str(meta.author) || 'The Bubaly Team',
    category: normalizeCategory(str(meta.category)),
    tags: Array.isArray(meta.tags) ? meta.tags.map(String).filter(Boolean) : [],
    reading_minutes: estimateReadingMinutes(body),
    featured: meta.featured === true,
    accent_color: str(meta.accent_color) || null,
    body: contentBodyToBlocks(body),
    published: true,
    published_at: publishedAt,
  };
}
