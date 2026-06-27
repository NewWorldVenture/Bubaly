import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, MapPin } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { withSeoTables } from '@/lib/supabase/seo-tables';
import { renderPage, hubSlug, type SeoTemplate, type RenderedPage } from '@/lib/seo/template';
import { resolveIcon } from '@/lib/seo/icons';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { FAQAccordion } from '@/components/marketing/faq-accordion';

export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';
// Generic variables for a hub/index page (no single location).
const HUB_VARS = { state: 'the United States', state_abbr: 'US', state_slug: 'us' };

type LocationLink = { slug: string; label: string };

// Catch-all for programmatic SEO pages. Explicit marketing routes (/features,
// /pricing, /blog/*, …) take precedence in Next.js, so this only handles paths
// that resolve to a published `seo_pages` row or a template's hub/index page.
async function loadPage(slug: string) {
  const supabase = withSeoTables(createServiceClient());
  const { data: page } = await supabase
    .from('seo_pages').select('*').eq('slug', slug).eq('status', 'published').maybeSingle();
  if (!page) return null;
  const { data: template } = await supabase
    .from('seo_page_templates').select('*').eq('id', (page as { template_id: string }).template_id).maybeSingle();
  if (!template || !(template as { is_active: boolean }).is_active) return null;
  const typedPage = page as { id: string; slug: string; variables: Record<string, string>; template_id: string };

  // Sibling published pages — internal links for crawl discovery + link equity.
  const { data: siblingRows } = await supabase
    .from('seo_pages').select('slug, variables')
    .eq('template_id', typedPage.template_id).eq('status', 'published').neq('id', typedPage.id).limit(60);
  const siblings = locationLinks(siblingRows);
  const hub = hubSlug((template as { slug_pattern: string }).slug_pattern);

  return {
    page: typedPage,
    rendered: renderPage(template as unknown as SeoTemplate, typedPage.variables),
    siblings,
    hubSlug: hub && hub !== slug ? hub : null,
  };
}

// A hub/index page lives at a pattern's static prefix (e.g. /family-organizer)
// and lists every published page from that template — a crawl hub + landing page.
async function loadHub(slug: string) {
  if (!slug) return null;
  const supabase = withSeoTables(createServiceClient());
  const { data: templates } = await supabase.from('seo_page_templates').select('*').eq('is_active', true);
  const match = (templates ?? []).find(
    (t: { slug_pattern: string }) => hubSlug(t.slug_pattern) === slug,
  );
  if (!match) return null;
  const { data: pageRows } = await supabase
    .from('seo_pages').select('slug, variables')
    .eq('template_id', (match as { id: string }).id).eq('status', 'published').limit(200);
  const locations = locationLinks(pageRows);
  if (locations.length === 0) return null;
  return { rendered: renderPage(match as unknown as SeoTemplate, HUB_VARS), locations, slug };
}

function locationLinks(rows: unknown): LocationLink[] {
  return ((rows ?? []) as { slug: string; variables: Record<string, string> }[])
    .map((r) => ({ slug: r.slug, label: r.variables.state || r.variables.city || r.slug }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const joined = (slug ?? []).join('/');
  const content = await loadPage(joined);
  const rendered = content?.rendered ?? (await loadHub(joined))?.rendered;
  if (!rendered) return { title: 'Not found', robots: { index: false } };
  const url = `${SITE_URL}/${joined}`;
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

  const content = await loadPage(joined);
  if (content) {
    void incrementViews(content.page.id);
    return <ContentPage rendered={content.rendered} siblings={content.siblings} hubSlug={content.hubSlug} url={`${SITE_URL}/${joined}`} />;
  }

  const hub = await loadHub(joined);
  if (hub) return <HubPage rendered={hub.rendered} locations={hub.locations} url={`${SITE_URL}/${joined}`} />;

  notFound();
}

// ── Shared building blocks ───────────────────────────────────────────────────
function StructuredData({ data }: { data: Record<string, unknown>[] }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

function Hero({ rendered }: { rendered: RenderedPage }) {
  return (
    <Section className="pb-10 text-center sm:pb-12">
      {rendered.eyebrow && (
        <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-brand">
          {rendered.eyebrow}
        </span>
      )}
      <h1 className="mx-auto mt-5 max-w-4xl text-balance text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
        {rendered.h1}
      </h1>
      {rendered.subhead && <p className="mx-auto mt-5 max-w-2xl text-lg text-muted">{rendered.subhead}</p>}
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link href={rendered.ctaHref} className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-base font-semibold text-white transition hover:bg-brand/90">
          {rendered.ctaLabel} <ArrowRight className="h-4 w-4" />
        </Link>
        <Link href="/features" className="inline-flex items-center gap-2 rounded-xl border border-border px-6 py-3 text-base font-semibold transition hover:bg-elevated">
          See all features
        </Link>
      </div>
    </Section>
  );
}

function IntroAndFeatures({ rendered }: { rendered: RenderedPage }) {
  return (
    <>
      {rendered.paragraphs.length > 0 && (
        <Section className="py-0">
          <article className="mx-auto max-w-3xl space-y-5 text-lg leading-relaxed text-fg/90">
            {rendered.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          </article>
        </Section>
      )}
      {rendered.features.length > 0 && (
        <Section>
          <SectionHeading eyebrow="Everything in one place" title="Built for the whole family" />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {rendered.features.map((f, i) => (
              <FeatureCard key={i} icon={resolveIcon(f.icon)} title={f.title} description={f.description} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function ClosingCTA({ rendered }: { rendered: RenderedPage }) {
  return (
    <Section className="text-center">
      <div className="glass-card mx-auto max-w-3xl px-6 py-14">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{rendered.h1}</h2>
        <p className="mx-auto mt-4 max-w-xl text-muted">{rendered.subhead}</p>
        <div className="mt-8">
          <Link href={rendered.ctaHref} className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-base font-semibold text-white transition hover:bg-brand/90">
            {rendered.ctaLabel} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </Section>
  );
}

// ── Individual location page ─────────────────────────────────────────────────
function ContentPage({ rendered, siblings, hubSlug: hub, url }: { rendered: RenderedPage; siblings: LocationLink[]; hubSlug: string | null; url: string }) {
  const jsonLd: Record<string, unknown>[] = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: rendered.metaTitle, description: rendered.metaDescription, url, isPartOf: { '@type': 'WebSite', name: 'Bubaly', url: SITE_URL } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: rendered.h1, item: url },
    ] },
  ];
  if (rendered.faqs.length > 0) {
    jsonLd.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: rendered.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  }
  return (
    <>
      <StructuredData data={jsonLd} />
      <Hero rendered={rendered} />
      <IntroAndFeatures rendered={rendered} />
      {rendered.faqs.length > 0 && (
        <Section>
          <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />
          <div className="mt-12"><FAQAccordion items={rendered.faqs.map((f) => ({ q: f.q, a: f.a }))} /></div>
        </Section>
      )}
      {siblings.length > 0 && (
        <Section className="py-0">
          <div className="mx-auto max-w-4xl">
            <h2 className="text-center text-sm font-bold uppercase tracking-widest text-muted">Also available across the U.S.</h2>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {siblings.map((s) => (
                <Link key={s.slug} href={`/${s.slug}`} className="rounded-full border border-border px-3 py-1.5 text-sm text-muted transition hover:border-brand/40 hover:text-brand">{s.label}</Link>
              ))}
            </div>
            {hub && (
              <p className="mt-4 text-center text-sm">
                <Link href={`/${hub}`} className="font-medium text-brand hover:underline">Browse all locations →</Link>
              </p>
            )}
          </div>
        </Section>
      )}
      <ClosingCTA rendered={rendered} />
    </>
  );
}

// ── Hub / index page (directory of every location) ───────────────────────────
function HubPage({ rendered, locations, url }: { rendered: RenderedPage; locations: LocationLink[]; url: string }) {
  const jsonLd: Record<string, unknown>[] = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: rendered.metaTitle, description: rendered.metaDescription, url, isPartOf: { '@type': 'WebSite', name: 'Bubaly', url: SITE_URL } },
    { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: locations.map((l, i) => ({ '@type': 'ListItem', position: i + 1, name: l.label, url: `${SITE_URL}/${l.slug}` })) },
  ];
  if (rendered.faqs.length > 0) {
    jsonLd.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: rendered.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  }
  return (
    <>
      <StructuredData data={jsonLd} />
      <Hero rendered={rendered} />
      <IntroAndFeatures rendered={rendered} />

      {/* Location directory — the hub's core content */}
      <Section>
        <SectionHeading eyebrow="Choose your state" title={`Available in ${locations.length} location${locations.length === 1 ? '' : 's'}`} />
        <div className="mx-auto mt-10 grid max-w-4xl grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {locations.map((l) => (
            <Link key={l.slug} href={`/${l.slug}`} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm font-medium transition hover:border-brand/40 hover:bg-elevated hover:text-brand">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-muted" /> {l.label}
            </Link>
          ))}
        </div>
      </Section>

      {rendered.faqs.length > 0 && (
        <Section>
          <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />
          <div className="mt-12"><FAQAccordion items={rendered.faqs.map((f) => ({ q: f.q, a: f.a }))} /></div>
        </Section>
      )}
      <ClosingCTA rendered={rendered} />
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
