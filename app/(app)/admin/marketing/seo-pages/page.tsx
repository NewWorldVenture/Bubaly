import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables, type SeoPageTemplateRow, type SeoPageRow } from '@/lib/supabase/seo-tables';
import { SeoPagesClient, type TemplateView, type PageView } from './seo-pages-client';

export const metadata: Metadata = { title: 'Marketing · SEO Pages', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function SeoPagesAdmin() {
  const supabase = withSeoTables(createServiceClient());

  const [{ data: templates }, { data: pages }] = await Promise.all([
    supabase.from('seo_page_templates').select('*').order('created_at', { ascending: false }),
    supabase.from('seo_pages').select('*').order('slug', { ascending: true }),
  ]);

  const tplRows = (templates ?? []) as SeoPageTemplateRow[];
  const pageRows = (pages ?? []) as SeoPageRow[];

  const pagesByTemplate = new Map<string, PageView[]>();
  for (const p of pageRows) {
    const arr = pagesByTemplate.get(p.template_id) ?? [];
    arr.push({ id: p.id, slug: p.slug, variables: p.variables, status: p.status, views: p.views });
    pagesByTemplate.set(p.template_id, arr);
  }

  const templateViews: TemplateView[] = tplRows.map((t) => ({
    id: t.id,
    name: t.name,
    topic: t.topic,
    slugPattern: t.slug_pattern,
    eyebrow: t.eyebrow,
    h1Template: t.h1_template,
    subheadTemplate: t.subhead_template,
    metaTitleTemplate: t.meta_title_template,
    metaDescriptionTemplate: t.meta_description_template,
    introTemplate: t.intro_template,
    featureBlocks: t.feature_blocks ?? [],
    faqs: t.faqs ?? [],
    ctaLabel: t.cta_label,
    ctaHref: t.cta_href,
    staticVars: t.static_vars ?? {},
    isActive: t.is_active,
    pages: pagesByTemplate.get(t.id) ?? [],
  }));

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        Build a single page <strong className="text-fg">template</strong> for a topic, then generate
        SEO + AEO landing pages across every U.S. state in one click. Pages share the exact Bubaly
        look &amp; feel, include FAQ structured data for answer engines, and are managed centrally —
        editing the template instantly updates every page it produced.
      </div>
      <SeoPagesClient templates={templateViews} />
    </div>
  );
}
