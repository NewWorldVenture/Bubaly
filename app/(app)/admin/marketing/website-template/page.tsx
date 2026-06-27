import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables, type SeoPageTemplateRow, type SeoPageRow } from '@/lib/supabase/seo-tables';
import { WebsiteTemplateClient, type TemplateView, type PageView } from './website-template-client';

export const metadata: Metadata = { title: 'Marketing · Website Template', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function WebsiteTemplateAdmin() {
  const supabase = withSeoTables(createServiceClient());

  const [{ data: templates }, { data: pages }] = await Promise.all([
    supabase.from('seo_page_templates').select('*').order('created_at', { ascending: false }),
    supabase.from('seo_pages').select('*').order('slug', { ascending: true }),
  ]);

  const tplRows = (templates ?? []) as SeoPageTemplateRow[];
  const pageRows = (pages ?? []) as SeoPageRow[];

  // ── Analytics ──
  const publishedCount = pageRows.filter((p) => p.status === 'published').length;
  const totalViews = pageRows.reduce((s, p) => s + (p.views ?? 0), 0);
  const topPages = [...pageRows]
    .filter((p) => (p.views ?? 0) > 0)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, 8)
    .map((p) => ({ slug: p.slug, views: p.views ?? 0, status: p.status, label: p.variables.state || p.variables.city || p.slug }));

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
      <div>
        <h1 className="text-xl font-bold text-fg">Website Template</h1>
        <p className="text-sm text-muted">Programmatic SEO &amp; AEO landing pages, generated from one template.</p>
      </div>
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        Build a single page <strong className="text-fg">template</strong> for a topic, then generate
        SEO + AEO landing pages across every U.S. state in one click. Pages share the exact Bubaly
        look &amp; feel, include FAQ structured data for answer engines, and are managed centrally —
        editing the template instantly updates every page it produced.
      </div>

      {/* Analytics summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Templates', value: tplRows.length },
          { label: 'Total pages', value: pageRows.length },
          { label: 'Published', value: publishedCount },
          { label: 'Total views', value: totalViews.toLocaleString() },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface/40 p-4">
            <p className="text-xs text-muted">{s.label}</p>
            <p className="mt-1 text-2xl font-bold text-fg">{s.value}</p>
          </div>
        ))}
      </div>

      {topPages.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">Top performing pages</h2>
          </div>
          <div className="divide-y divide-border">
            {topPages.map((p) => (
              <div key={p.slug} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{p.label}</span>
                  <a href={`/${p.slug}`} target="_blank" rel="noreferrer" className="ml-2 font-mono text-xs text-muted hover:text-brand">/{p.slug}</a>
                </span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${p.status === 'published' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-surface text-muted'}`}>{p.status}</span>
                <span className="w-16 text-right font-semibold tabular-nums">{p.views.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <WebsiteTemplateClient templates={templateViews} />
    </div>
  );
}
