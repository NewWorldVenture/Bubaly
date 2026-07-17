import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { landingCta, bodyParagraphs } from '@/lib/marketing/landing';
import { LandingTracker } from './tracker';

export const dynamic = 'force-dynamic';

// Marketing landing pages have no client RLS policies, so we read them with the
// service-role client. Only published, non-deleted pages are servable.
async function getPage(slug: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('marketing_landing_pages')
    .select('*')
    .eq('slug', slug.toLowerCase())
    .eq('published', true)
    .is('deleted_at', null)
    .maybeSingle();
  // Distinguish "genuinely not found" (→ 404) from a transient read failure. If we
  // swallow the error and return null, a real published page 404s on a DB blip —
  // a permanent-gone signal that de-indexes the page. Throw so it renders a
  // retryable 5xx instead, and reserve notFound() for a truly missing slug.
  if (error) throw new Error(`Failed to load landing page "${slug}": ${error.message}`);
  return data;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPage(slug);
  if (!page) return { title: 'Not found', robots: { index: false } };
  return {
    title: page.headline || page.title,
    description: page.subhead || undefined,
  };
}

export default async function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await getPage(slug);
  if (!page) notFound();

  const cta = landingCta(page.metadata);
  const paragraphs = bodyParagraphs(page.body);

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
      {/* Records a view on mount + a conversion when the CTA is clicked. */}
      <LandingTracker slug={page.slug} />

      <section className="text-center">
        <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          {page.headline || page.title}
        </h1>
        {page.subhead && (
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted">{page.subhead}</p>
        )}
        <div className="mt-8">
          <Link
            href={cta.href}
            data-lp-cta
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-base font-semibold text-white transition hover:bg-brand/90"
          >
            {cta.label} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {paragraphs.length > 0 && (
        <article className="mx-auto mt-14 max-w-2xl space-y-5 text-lg leading-relaxed text-fg/90">
          {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
        </article>
      )}
    </div>
  );
}
