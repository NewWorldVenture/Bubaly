import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type BlogCategory =
  | 'Parenting'
  | 'Organization'
  | 'School & Activities'
  | 'AI & Technology'
  | 'Wellness'
  | 'Family Finances';

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
  body: BlogBlock[];
};

type Row = Database['public']['Tables']['blog_posts']['Row'];

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
    body: normalizeBody(r.body),
  };
}

export async function getAllPosts(): Promise<BlogPost[]> {
  try {
    const { data } = await anonClient()
      .from('blog_posts')
      .select('*')
      .eq('published', true)
      .order('published_at', { ascending: false });
    return (data ?? []).map(toPost);
  } catch {
    return [];
  }
}

export async function getPostsByCategory(category: BlogCategory): Promise<BlogPost[]> {
  try {
    const { data } = await anonClient()
      .from('blog_posts')
      .select('*')
      .eq('published', true)
      .eq('category', category)
      .order('published_at', { ascending: false });
    return (data ?? []).map(toPost);
  } catch {
    return [];
  }
}

export async function getPost(slug: string): Promise<BlogPost | undefined> {
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
      .select('*')
      .eq('published', true)
      .eq('featured', true)
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return toPost(data);
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
      .select('*')
      .eq('published', true)
      .eq('category', category)
      .neq('slug', slug)
      .order('published_at', { ascending: false })
      .limit(limit);
    return (data ?? []).map(toPost);
  } catch {
    return [];
  }
}

export async function getAdjacentPosts(date: string): Promise<{ prev: BlogPost | null; next: BlogPost | null }> {
  try {
    const client = anonClient();
    const [{ data: older }, { data: newer }] = await Promise.all([
      client
        .from('blog_posts')
        .select('*')
        .eq('published', true)
        .lt('published_at', date)
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from('blog_posts')
        .select('*')
        .eq('published', true)
        .gt('published_at', date)
        .order('published_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);
    return {
      prev: older ? toPost(older) : null,
      next: newer ? toPost(newer) : null,
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
];
