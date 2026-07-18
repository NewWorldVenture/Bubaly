import type { MetadataRoute } from 'next';
import { getAllPosts, ALL_CATEGORIES } from '@/lib/blog/posts';

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

  return [...staticEntries, ...categoryEntries, ...postEntries];
}
