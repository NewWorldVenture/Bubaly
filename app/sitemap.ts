import type { MetadataRoute } from 'next';
import { getAllPosts, ALL_CATEGORIES } from '@/lib/blog/posts';
import { createServiceClient } from '@/lib/supabase/server';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

// Static public routes. Legal pages are included so they're crawlable and
// discoverable (required for a production site). Authenticated app surfaces
// stay out of the sitemap and are disallowed in robots.ts.
const STATIC_ROUTES: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }[] = [
  { path: '', priority: 1, changeFrequency: 'weekly' },
  { path: '/features', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/how-it-works', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/pricing', priority: 0.9, changeFrequency: 'monthly' },
  { path: '/ai', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/mobile', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/security', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/faq', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/blog', priority: 0.7, changeFrequency: 'weekly' },
  { path: '/contact', priority: 0.5, changeFrequency: 'yearly' },
  { path: '/login', priority: 0.5, changeFrequency: 'yearly' },
  { path: '/signup', priority: 0.6, changeFrequency: 'yearly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/cookies', priority: 0.3, changeFrequency: 'yearly' },
  { path: '/acceptable-use', priority: 0.3, changeFrequency: 'yearly' },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: `${SITE_URL}${r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  // Published blog posts (best-effort — getAllPosts degrades to [] on any error,
  // so a DB hiccup can never break the sitemap or the build).
  const posts = await getAllPosts();
  const postEntries: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${SITE_URL}/blog/${p.slug}`,
    lastModified: p.date ? new Date(p.date) : now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  // Blog category tabs — crawlable landing pages for each topic.
  const categoryEntries: MetadataRoute.Sitemap = ALL_CATEGORIES.map((c) => ({
    url: `${SITE_URL}/blog?category=${encodeURIComponent(c)}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.5,
  }));

  // Landing pages are published from Super Admin and use a service-role read
  // because their table is intentionally private to the admin control plane.
  // A failed admin read must not take down the public sitemap.
  let landingEntries: MetadataRoute.Sitemap = [];
  let platformEntries: MetadataRoute.Sitemap = [];
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from('marketing_landing_pages')
        .select('slug, updated_at')
        .eq('published', true)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false });

      if (error) {
        console.error('[sitemap] published landing-page read failed', error);
      } else {
        landingEntries = (data ?? [])
          .filter((page) => typeof page.slug === 'string' && page.slug.length > 0)
          .map((page) => ({
            url: `${SITE_URL}/lp/${encodeURIComponent(page.slug)}`,
            lastModified: page.updated_at ? new Date(page.updated_at) : now,
            changeFrequency: 'weekly' as const,
            priority: 0.7,
          }));
      }

      const { data: platformPages, error: platformError } = await supabase
        .from('marketing_pages')
        .select('path, updated_at, published_at')
        .eq('status', 'published')
        .is('deleted_at', null)
        .order('updated_at', { ascending: false });
      if (platformError) {
        console.error('[sitemap] published platform-page read failed', platformError);
      } else {
        platformEntries = (platformPages ?? [])
          .filter((page) => typeof page.path === 'string' && page.path.startsWith('/'))
          .map((page) => ({
            url: `${SITE_URL}${page.path}`,
            lastModified: page.updated_at ? new Date(page.updated_at) : now,
            changeFrequency: 'weekly' as const,
            priority: 0.7,
          }));
      }
    } catch (error) {
      console.error('[sitemap] published landing-page read failed', error);
    }
  }

  return [...staticEntries, ...categoryEntries, ...postEntries, ...landingEntries, ...platformEntries];
}
