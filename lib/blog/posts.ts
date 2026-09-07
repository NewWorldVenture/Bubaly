import { createClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import type { Database } from '@/lib/database.types';

export type BlogCategory =
  | 'Parenting'
  | 'Organization'
  | 'School & Activities'
  | 'AI & Technology'
  | 'Wellness'
  | 'Family Finances'
  | 'Recipes & Food'
  | 'Travel & Adventures'
  | 'Home & Seasonal';

export type BlogBlock = { type: 'p' | 'h2'; text: string };

export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  date: string;
  readingMinutes: number;
  tags: string[];
  category: BlogCategory;
  featured?: boolean;
  accentColor?: string;
  heroImageUrl?: string;
  heroImageAlt?: string;
  heroImageCredit?: string;
  body: BlogBlock[];
};

type Row = Database['public']['Tables']['blog_posts']['Row'];

export function isSyntheticBlogSeedSlug(slug: string): boolean {
  return /^seed-blog_posts-\d+$/i.test(slug)
    || /^Seed(?: data \d+)? [0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug);
}

const publicRows = (rows: Row[] | null): Row[] =>
  (rows ?? []).filter((row) => !isSyntheticBlogSeedSlug(row.slug));

function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

/**
 * Coerce a JSON `body` of unknown shape into a clean BlogBlock[]. The column is
 * `Json`, and seeded/imported rows have stored it as an array of blocks, an
 * array of strings, a JSON-encoded string, or plain text — all are handled here
 * so the blog page never crashes prerendering (e.g. `body.filter is not a function`).
 */
export function normalizeBody(raw: unknown): BlogBlock[] {
  let val: unknown = raw;
  if (typeof val === 'string') {
    const s = val.trim();
    try {
      const parsed = JSON.parse(s);
      // Only treat it as structured if JSON.parse yields an array/object.
      val = (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) ? parsed : s;
    } catch {
      // Not JSON → split plain text into paragraph blocks.
      return s ? s.split(/\n{2,}/).map((t) => ({ type: 'p' as const, text: t.trim() })).filter((b) => b.text) : [];
    }
  }
  if (!Array.isArray(val)) return [];
  return val
    .map((item): BlogBlock | null => {
      if (typeof item === 'string') return item.trim() ? { type: 'p', text: item } : null;
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const text = typeof o.text === 'string' ? o.text : typeof o.content === 'string' ? o.content : '';
        if (!text) return null;
        return { type: o.type === 'h2' ? 'h2' : 'p', text };
      }
      return null;
    })
    .filter((b): b is BlogBlock => b !== null);
}

// Hosts whose license we cannot verify as free-for-commercial-use. LoremFlickr
// proxies mixed-license Flickr photos, so we never render them on the public
// site — such URLs are dropped to `undefined` so the generated <BlogCover> art
// takes over (free, unique, on-brand). Free-licensed hosts (Unsplash) + owned
// uploads (*.supabase.co) pass through untouched.
const UNVERIFIED_IMAGE_HOSTS = ['loremflickr.com'];

function freeLicensedImage(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return UNVERIFIED_IMAGE_HOSTS.some((h) => url.includes(h)) ? undefined : url;
}

function toPost(r: Row): BlogPost {
  return {
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    author: r.author,
    date: r.published_at,
    readingMinutes: r.reading_minutes,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    category: r.category as BlogCategory,
    featured: r.featured,
    accentColor: r.accent_color ?? undefined,
    heroImageUrl: freeLicensedImage(r.hero_image_url),
    heroImageAlt: r.hero_image_alt ?? undefined,
    heroImageCredit: r.hero_image_credit ?? undefined,
    body: normalizeBody(r.body),
  };
}

/**
 * Fetch EVERY published `blog_posts` row, paginating past PostgREST's default
 * 1000-row cap. This matters because synthetic seed rows are filtered out
 * *client-side* (their slugs, not a column, mark them synthetic) — so a single
 * capped query can return a 1000-row window dominated by seed rows and silently
 * omit whole categories of real articles (the cause of "Recipes & Food (0)" in
 * the tab bar while the section itself listed 56). Paginating guarantees the
 * count/list see every real article regardless of how many seed rows exist.
 */
// Card/list columns — everything EXCEPT the large `body` JSONB. Only the single
// article page needs `body`, so list surfaces (the /blog grid, sitemap, related
// + adjacent posts, generateStaticParams) fetch this projection instead of `*`.
// For 1,000+ posts this cuts the payload from megabytes to kilobytes and is the
// single biggest speedup for /blog. toPost() coerces a missing body → [].
const CARD_COLUMNS =
  'slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color, hero_image_url, hero_image_alt, hero_image_credit';

async function fetchAllPublishedRows<K extends keyof Row>(columns: string): Promise<Pick<Row, K>[]> {
  const PAGE = 1000;
  const out: Pick<Row, K>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await anonClient()
      .from('blog_posts')
      .select(columns)
      .eq('published', true)
      .order('published_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Pick<Row, K>[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function getAllPosts(): Promise<BlogPost[]> {
  try {
    const rows = await fetchAllPublishedRows<keyof Row>(CARD_COLUMNS);
    return publicRows(rows as Row[]).map(toPost);
  } catch {
    return [];
  }
}

/**
 * Published-article count per category, computed from ALL posts (independent of
 * any active filter) so every tab can show an accurate count at all times.
 * Excludes synthetic seed rows, matching what the public pages render.
 */
export async function getCategoryCounts(): Promise<Record<string, number>> {
  try {
    const rows = await fetchAllPublishedRows<'slug' | 'category'>('slug, category');
    const counts: Record<string, number> = {};
    for (const row of publicRows(rows as Row[])) {
      const c = row.category;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

export async function getPostsByCategory(category: BlogCategory): Promise<BlogPost[]> {
  try {
    const { data } = await anonClient()
      .from('blog_posts')
      .select(CARD_COLUMNS)
      .eq('published', true)
      .eq('category', category)
      .order('published_at', { ascending: false });
    return publicRows(data as unknown as Row[]).map(toPost);
  } catch {
    return [];
  }
}

export async function getPost(slug: string): Promise<BlogPost | undefined> {
  if (isSyntheticBlogSeedSlug(slug)) return undefined;
  try {
    const { data } = await anonClient()
      .from('blog_posts')
      .select('*')
      .eq('slug', slug)
      .eq('published', true)
      .maybeSingle();
    return data ? toPost(data) : undefined;
  } catch {
    return undefined;
  }
}

export async function getFeaturedPost(): Promise<BlogPost | undefined> {
  try {
    const { data } = await anonClient()
      .from('blog_posts')
      .select(CARD_COLUMNS)
      .eq('published', true)
      .eq('featured', true)
      .order('published_at', { ascending: false })
      .limit(20);
    const featured = publicRows(data as unknown as Row[])[0];
    if (featured) return toPost(featured);
  } catch {
    /* fall through to first post */
  }
  const all = await getAllPosts();
  return all[0];
}

export async function getRelatedPosts(slug: string, category: BlogCategory, limit = 3): Promise<BlogPost[]> {
  try {
    const { data } = await anonClient()
      .from('blog_posts')
      .select(CARD_COLUMNS)
      .eq('published', true)
      .eq('category', category)
      .neq('slug', slug)
      .order('published_at', { ascending: false })
      .limit(Math.max(limit * 10, 50));
    return publicRows(data as unknown as Row[]).map(toPost).slice(0, limit);
  } catch {
    return [];
  }
}

export async function getAdjacentPosts(date: string): Promise<{ prev: BlogPost | null; next: BlogPost | null }> {
  try {
    const client = anonClient();
    const [{ data: older }, { data: newer }] = await settleAll([
      client
        .from('blog_posts')
        .select(CARD_COLUMNS)
        .eq('published', true)
        .lt('published_at', date)
        .order('published_at', { ascending: false })
        .limit(20),
      client
        .from('blog_posts')
        .select(CARD_COLUMNS)
        .eq('published', true)
        .gt('published_at', date)
        .order('published_at', { ascending: true })
        .limit(20),
    ]);
    const previous = publicRows(older as unknown as Row[])[0];
    const following = publicRows(newer as unknown as Row[])[0];
    return {
      prev: previous ? toPost(previous) : null,
      next: following ? toPost(following) : null,
    };
  } catch {
    return { prev: null, next: null };
  }
}

export function extractHeadings(body: BlogBlock[]): { id: string; text: string }[] {
  return (Array.isArray(body) ? body : [])
    .filter((b): b is BlogBlock & { type: 'h2' } => b?.type === 'h2' && typeof b?.text === 'string')
    .map((b) => ({
      id: b.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      text: b.text,
    }));
}

export function estimateReadingTime(body: BlogBlock[]): number {
  const words = (Array.isArray(body) ? body : []).reduce((acc, b) => acc + (b?.text ?? '').split(/\s+/).length, 0);
  return Math.max(1, Math.ceil(words / 200));
}

export const ALL_CATEGORIES: BlogCategory[] = [
  'Parenting', 'Organization', 'School & Activities', 'AI & Technology', 'Wellness', 'Family Finances',
  'Recipes & Food', 'Travel & Adventures', 'Home & Seasonal',
];
