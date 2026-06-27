import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables } from '@/lib/supabase/seo-tables';
import { renderPage, type SeoTemplate } from '@/lib/seo/template';
import { resolveIcon } from '@/lib/seo/icons';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { FAQAccordion } from '@/components/marketing/faq-accordion';

export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

// Catch-all for programmatic SEO pages. Explicit marketing routes (/features,
// /pricing, /blog/*, …) take precedence in Next.js, so this only handles paths
// that resolve to a published `seo_pages` row.
async function loadPage(slug: string) {
  const supabase = withSeoTables(createServiceClient());
  const { data: page } = await supabase
    .from('seo_pages')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();
  if (!page) return null;
  const { data: template } = await supabase
    .from('seo_page_templates')
    .select('*')
    .eq('id', (page as { template_id: string }).template_id)
    .maybeSingle();
  if (!template || !(template as { is_active: boolean }).is_active) return null;
  return {
    page: page as { id: string; slug: string; variables: Record<string, string> },
    rendered: renderPage(template as unknown as SeoTemplate, (page as { variables: Record<string, string> }).variables),
  };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const joined = (slug ?? []).join('/');
  const data = await loadPage(joined);
  if (!data) return { title: 'Not found', robots: { index: false } };
  const { rendered } = data;
  const url = `${SITE_URL}/${rendered.slug}`;
  return {
    title: rendered.metaTitle,
    description: rendered.metaDescription,
    alternates: { canonical: url },
    openGraph: { title: rendered.metaTitle, description: rendered.metaDescription, url, type: 'website' },
    twitter: { card: 'summary_large_image', title: rendered.metaTitle, description: rendered.metaDescription },
  };
}

export default async function ProgrammaticSeoPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const joined = (slug ?? []).join('/');
  const data = await loadPage(joined);
  if (!data) notFound();
  const { page, rendered } = data;

  // Best-effort view counter (non-blocking, never fails the render).
  void incrementViews(page.id);

  const url = `${SITE_URL}/${rendered.slug}`;

  // ── Structured data for SEO + AEO (answer engines cite these) ──
  const jsonLd: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: rendered.metaTitle,
      description: rendered.metaDescription,
      url,
      isPartOf: { '@type': 'WebSite', name: 'Bubaly', url: SITE_URL },
    },
  ];
  if (rendered.faqs.length > 0) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: rendered.faqs.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero */}
      <Section className="pb-10 text-center sm:pb-12">
        {rendered.eyebrow && (
          <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-brand">
            {rendered.eyebrow}
          </span>
        )}
        <h1 className="mx-auto mt-5 max-w-4xl text-balance text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
          {rendered.h1}
        </h1>
        {rendered.subhead && (
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted">{rendered.subhead}</p>
        )}
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href={rendered.ctaHref}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-base font-semibold text-white transition hover:bg-brand/90"
          >
            {rendered.ctaLabel} <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/features"
            className="inline-flex items-center gap-2 rounded-xl border border-border px-6 py-3 text-base font-semibold transition hover:bg-elevated"
          >
            See all features
          </Link>
        </div>
      </Section>

      {/* Intro body */}
      {rendered.paragraphs.length > 0 && (
        <Section className="py-0">
          <article className="mx-auto max-w-3xl space-y-5 text-lg leading-relaxed text-fg/90">
            {rendered.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          </article>
        </Section>
      )}

      {/* Feature grid */}
      {rendered.features.length > 0 && (
        <Section>
          <SectionHeading
            eyebrow="Everything in one place"
            title="Built for the whole family"
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rendered.features.map((f, i) => (
              <FeatureCard key={i} icon={resolveIcon(f.icon)} title={f.title} description={f.description} />
            ))}
          </div>
        </Section>
      )}

      {/* FAQ (AEO) */}
      {rendered.faqs.length > 0 && (
        <Section>
          <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />
          <div className="mt-12">
            <FAQAccordion items={rendered.faqs.map((f) => ({ q: f.q, a: f.a }))} />
          </div>
        </Section>
      )}

      {/* Closing CTA */}
      <Section className="text-center">
        <div className="glass-card mx-auto max-w-3xl px-6 py-14">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{rendered.h1}</h2>
          <p className="mx-auto mt-4 max-w-xl text-muted">{rendered.subhead}</p>
          <div className="mt-8">
            <Link
              href={rendered.ctaHref}
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-base font-semibold text-white transition hover:bg-brand/90"
            >
              {rendered.ctaLabel} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}

async function incrementViews(pageId: string) {
  try {
    const supabase = withSeoTables(createServiceClient());
    const { data } = await supabase.from('seo_pages').select('views').eq('id', pageId).maybeSingle();
    const current = (data as { views?: number } | null)?.views ?? 0;
    await supabase.from('seo_pages').update({ views: current + 1 }).eq('id', pageId);
  } catch {
    /* view counting is best-effort */
  }
}
