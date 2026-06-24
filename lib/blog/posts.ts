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

function toPost(r: Row): BlogPost {
  return {
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    author: r.author,
    date: r.published_at,
    readingMinutes: r.reading_minutes,
    tags: r.tags ?? [],
    category: r.category as BlogCategory,
    featured: r.featured,
    accentColor: r.accent_color ?? undefined,
    body: (r.body as unknown as BlogBlock[]) ?? [],
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
  return body
    .filter((b): b is BlogBlock & { type: 'h2' } => b.type === 'h2')
    .map((b) => ({
      id: b.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      text: b.text,
    }));
}

export function estimateReadingTime(body: BlogBlock[]): number {
  const words = body.reduce((acc, b) => acc + b.text.split(/\s+/).length, 0);
  return Math.max(1, Math.ceil(words / 200));
}

export const ALL_CATEGORIES: BlogCategory[] = [
  'Parenting', 'Organization', 'School & Activities', 'AI & Technology', 'Wellness', 'Family Finances',
];
