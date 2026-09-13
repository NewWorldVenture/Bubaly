import { unstable_rethrow } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import { readAll } from '@/lib/supabase/read-all';
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

/**
 * A published article is not a static asset, and must never be cached as one.
 *
 * Next patches `fetch` and, for a route it PRERENDERS, stores the response in
 * the build Data Cache under the route's revalidate — for a route with no
 * revalidate that is one year, with no tag able to clear it. `app/sitemap.ts`
 * is such a route, and the entry survives in `.next/cache`, which Vercel
 * restores between deploys.
 *
 * Measured: a cache entry written 2026-09-07 held 1,000 rows with
 * `revalidate: 31536000` and `tags: []`, and a build six days later shipped a
 * sitemap from it — every article published in between was simply absent from
 * the file search engines read, and would have stayed absent for a year.
 *
 * `no-store` keeps these reads out of that cache. The blog pages themselves are
 * `force-dynamic`, so nothing there was ever cached and nothing there changes.
 */
function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
    },
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
  // `slug` breaks ties: 717 of the published rows share a `published_at` with
  // another row, and a key that is not a total order lets the boundary between
  // two separately-planned pages move — repeating one row and dropping another.
  const { rows, error } = await readAll<Pick<Row, K>>(async (from, to) => {
    const page = await anonClient()
      .from('blog_posts')
      .select(columns)
      .eq('published', true)
      .order('published_at', { ascending: false })
      .order('slug')
      .range(from, to);
    return { data: (page.data ?? []) as unknown as Pick<Row, K>[], error: page.error };
  });
  if (error) throw error;
  return rows;
}

export async function getAllPosts(): Promise<BlogPost[]> {
  try {
    const rows = await fetchAllPublishedRows<keyof Row>(CARD_COLUMNS);
    return publicRows(rows as Row[]).map(toPost);
  } catch (error) {
    // `unstable_rethrow` first: Next signals "this route cannot be static" by
    // THROWING out of the fetch, and a catch-all that swallows it would let a
    // route prerender with zero posts and ship that. Only a real read failure
    // reaches the lines below.
    unstable_rethrow(error);
    // Degrading to an empty blog is deliberate — a DB hiccup must not take the
    // page down — but doing it SILENTLY is how a broken read stays broken. The
    // stale-sitemap defect hid behind this catch for six days.
    console.error('[blog] getAllPosts failed — rendering an empty list', error);
    return [];
  }
}

/**
 * Just the slug and date of every published article.
 *
 * `app/sitemap.ts` needs nothing else, and it is now rendered per request, so
 * the projection is the difference between reading ~1 MB of excerpts, tags and
 * hero-image metadata on every crawl and reading a few tens of kilobytes.
 */
export async function getAllPostRefs(): Promise<{ slug: string; date: string }[]> {
  try {
    const rows = await fetchAllPublishedRows<'slug' | 'published_at'>('slug, published_at');
    return publicRows(rows as Row[]).map((r) => ({ slug: r.slug, date: r.published_at }));
  } catch (error) {
    unstable_rethrow(error);
    console.error('[blog] getAllPostRefs failed — sitemap will omit articles', error);
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
