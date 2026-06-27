import type { MetadataRoute } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables } from '@/lib/supabase/seo-tables';
import { hubSlug } from '@/lib/seo/template';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

const ROUTES = [
  '', '/features', '/how-it-works', '/pricing', '/security',
  '/ai', '/mobile', '/faq', '/blog', '/contact', '/login', '/signup',
];

// Pull published programmatic-SEO pages + their template hub pages so they index.
async function seoPagePaths(): Promise<{ slug: string; updated: string }[]> {
  try {
    const supabase = withSeoTables(createServiceClient());
    const [{ data: pages }, { data: templates }] = await Promise.all([
      supabase.from('seo_pages').select('slug, updated_at, template_id, status')
        .eq('status', 'published').order('updated_at', { ascending: false }).limit(5000),
      supabase.from('seo_page_templates').select('id, slug_pattern, is_active').eq('is_active', true),
    ]);

    const out = (pages ?? []).map((r: { slug: string; updated_at: string }) => ({ slug: r.slug, updated: r.updated_at }));

    // Add one hub URL per active template that has at least one published page.
    const templatesWithPages = new Set((pages ?? []).map((p: { template_id: string }) => p.template_id));
    const seen = new Set(out.map((o: { slug: string }) => o.slug));
    for (const t of (templates ?? []) as { id: string; slug_pattern: string }[]) {
      if (!templatesWithPages.has(t.id)) continue;
      const hub = hubSlug(t.slug_pattern);
      if (hub && !seen.has(hub)) { out.push({ slug: hub, updated: new Date().toISOString() }); seen.add(hub); }
    }
    return out;
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
