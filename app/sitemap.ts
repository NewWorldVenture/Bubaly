import type { MetadataRoute } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables } from '@/lib/supabase/seo-tables';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

const ROUTES = [
  '', '/features', '/how-it-works', '/pricing', '/security',
  '/ai', '/mobile', '/faq', '/blog', '/contact', '/login', '/signup',
];

// Pull published programmatic-SEO pages so they get indexed.
async function seoPagePaths(): Promise<{ slug: string; updated: string }[]> {
  try {
    const supabase = withSeoTables(createServiceClient());
    const { data } = await supabase
      .from('seo_pages')
      .select('slug, updated_at')
      .eq('status', 'published')
      .order('updated_at', { ascending: false })
      .limit(5000);
    return (data ?? []).map((r: { slug: string; updated_at: string }) => ({
      slug: r.slug,
      updated: r.updated_at,
    }));
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const base: MetadataRoute.Sitemap = ROUTES.map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.7,
  }));

  const seoPages: MetadataRoute.Sitemap = (await seoPagePaths()).map(({ slug, updated }) => ({
    url: `${SITE_URL}/${slug}`,
    lastModified: updated ? new Date(updated) : now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...base, ...seoPages];
}
