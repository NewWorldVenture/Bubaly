import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, BookOpen, ChevronRight, CircleHelp, GitCompareArrows, Users } from 'lucide-react';
import { createServer } from '@/lib/supabase/server';
import { normalizeMarketingSlug, pageTypeConfig, type MarketingPageType } from './platform';
import { MarketingPageStructuredData } from '@/components/marketing/structured-data';
import { localizeAeoQuestions, readAeoQuestionsForPath } from './aeo';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

type PublicPage = {
  id: string; page_type: string; slug: string; path: string; title: string; summary: string | null; body: string | null;
  content: unknown; seo: unknown; aeo: unknown; published_at: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function getPublishedMarketingPage(type: MarketingPageType, slug: string): Promise<PublicPage | null> {
  const normalized = normalizeMarketingSlug(slug);
  if (!normalized) return null;
  const path = buildPublicPath(type, normalized);
  const supabase = await createServer();
  const { data, error } = await supabase.from('marketing_pages').select('id, page_type, slug, path, title, summary, body, content, seo, aeo, published_at').eq('path', path).eq('status', 'published').is('deleted_at', null).maybeSingle();
  // A deploy can precede the human-owned migration apply. Treat only the
  // explicit missing-relation signal as an unavailable page family; all other
  // database failures must still surface as errors instead of becoming 404s.
  if (error) {
    const message = String(error.message ?? '');
    if (error.code === 'PGRST205' || /marketing_pages.*schema cache/i.test(message)) return null;
    throw new Error(`Could not load marketing page: ${message}`);
  }
  return data as PublicPage | null;
}

export function buildPublicPath(type: MarketingPageType, slug: string): string {
  return `${pageTypeConfig(type).prefix}/${normalizeMarketingSlug(slug)}`;
}

function pageSeo(page: PublicPage) {
  const seo = record(page.seo);
  return {
    title: stringValue(seo.title) ?? page.title,
    description: stringValue(seo.description) ?? page.summary ?? undefined,
    keywords: Array.isArray(seo.keywords) ? seo.keywords.map(String).filter(Boolean) : undefined,
  };
}

export async function marketingPageMetadata(type: MarketingPageType, slug: string): Promise<Metadata> {
  const page = await getPublishedMarketingPage(type, slug);
  if (!page) {
    const t = await getTranslations();
    return { title: t('publicPages.pageNotFound'), robots: { index: false } };
  }
  const seo = pageSeo(page);
  const canonical = `${SITE_URL}${page.path}`;
  return {
    title: seo.title,
    description: seo.description,
    keywords: seo.keywords,
    alternates: { canonical },
    openGraph: { type: 'article', url: canonical, title: seo.title, description: seo.description },
    twitter: { card: 'summary_large_image', title: seo.title, description: seo.description },
  };
}

function bodyParagraphs(body: string | null): string[] {
  return (body ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

// The breadcrumb chip used to render the MarketingPageType itself — `question`,
// `comparison`, `glossary` — which is an identifier, English, and lowercase in
// every language. PAGE_TYPES.label is the admin console's label and equally
// English, so the public chip gets its own catalogue key per type.
const PAGE_TYPE_LABEL_KEY: Record<MarketingPageType, string> = {
  landing: 'publicPages.typeLanding',
  question: 'publicPages.typeQuestion',
  guide: 'publicPages.typeGuide',
  comparison: 'publicPages.typeComparison',
  alternative: 'publicPages.typeAlternative',
  audience: 'publicPages.typeAudience',
  resource: 'publicPages.typeResource',
  glossary: 'publicPages.typeGlossary',
  feature: 'publicPages.typeFeature',
  blog: 'publicPages.typeBlog',
  custom: 'publicPages.typeCustom',
};

export async function MarketingPageView({ type, slug }: { type: MarketingPageType; slug: string }) {
  const page = await getPublishedMarketingPage(type, slug);
  if (!page) notFound();
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  const aeo = await readAeoQuestionsForPath(page.path, 12);
  // Through localizeAeoQuestions, the same way MarketingAeoSection and /faq do.
  // Without it this page rendered its own title and body in the reader's
  // language over an English Knowledge Center.
  const localized = await localizeAeoQuestions(aeo.questions, locale.code);
  const questions = localized.map((item) => ({ question: item.question, answer: item.answer }));
  const paragraphs = bodyParagraphs(page.body);
  const Icon = type === 'question' ? CircleHelp : type === 'comparison' || type === 'alternative' ? GitCompareArrows : type === 'audience' ? Users : type === 'guide' || type === 'resource' ? BookOpen : BookOpen;
  return <>
    <MarketingPageStructuredData path={page.path} name={page.title} description={page.summary ?? t('publicPages.exploreWithBubaly', { title: page.title })} questions={questions.map((q) => ({ q: q.question, a: q.answer }))} />
    <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
      <nav className="mb-8 flex items-center gap-2 text-sm text-muted"><Link href="/" className="hover:text-fg">Bubaly</Link><ChevronRight className="h-4 w-4" /><span>{t(PAGE_TYPE_LABEL_KEY[type])}</span><ChevronRight className="h-4 w-4" /><span className="truncate">{page.title}</span></nav>
      <header className="max-w-4xl"><div className="mb-4 inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-brand-text"><Icon className="h-3.5 w-3.5" /> {t(PAGE_TYPE_LABEL_KEY[type])}</div><h1 className="text-balance text-4xl font-black tracking-tight sm:text-6xl">{page.title}</h1>{page.summary && <p className="mt-5 max-w-3xl text-lg leading-8 text-muted sm:text-xl">{page.summary}</p>}<Link href="/signup" className="mt-7 inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-3 font-semibold text-white hover:bg-brand/90">{t('publicPages.startWithBubaly')} <ArrowRight className="h-4 w-4" /></Link></header>
      {paragraphs.length > 0 && <article className="mt-14 max-w-3xl space-y-6 text-lg leading-8 text-fg/90">{paragraphs.map((paragraph, index) => <p key={`${page.id}-${index}`}>{paragraph}</p>)}</article>}
      {questions.length > 0 && <section className="mt-16 max-w-4xl border-t border-border pt-10"><h2 className="text-2xl font-bold">{t('publicPages.commonQuestions')}</h2><div className="mt-6 grid gap-4 md:grid-cols-2">{questions.map((question) => <div key={question.question} className="rounded-xl border border-border bg-surface/40 p-5"><h3 className="font-semibold">{question.question}</h3><p className="mt-2 text-sm leading-6 text-muted">{question.answer}</p></div>)}</div></section>}
    </main>
  </>;
}
