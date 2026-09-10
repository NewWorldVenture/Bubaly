import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Container, PageWrap } from '@/components/marketing/visual-mocks';
import { MarketingPageStructuredData } from '@/components/marketing/structured-data';
import { getTranslations } from '@/lib/i18n/server';
import { caseStudyPath } from '@/lib/marketing/case-study';
import { getPublishedCaseStudy } from '@/lib/marketing/case-study-server';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPublishedCaseStudy(slug);
  if (!result.ok || !result.study) return { robots: { index: false, follow: false } };
  return {
    title: result.study.title,
    description: result.study.summary ?? undefined,
    alternates: { canonical: caseStudyPath(result.study.slug) },
  };
}

export default async function CustomerStoryPage({ params }: Props) {
  const { slug } = await params;
  const result = await getPublishedCaseStudy(slug);
  const t = await getTranslations();
  if (result.ok && !result.study) notFound();
  const study = result.ok ? result.study : null;
  const structuredData = study ? await MarketingPageStructuredData({
    path: caseStudyPath(study.slug), name: study.title, description: study.summary ?? '',
  }) : null;
  return <PageWrap>
    {structuredData}
    <Container className="max-w-3xl px-5 py-16 sm:px-8 sm:py-24">
      <Link href="/" className="text-sm text-white/65 underline underline-offset-4 focus-ring">{t('notFound.backToHome')}</Link>
      {!result.ok ? <section role="alert" className="mt-8 rounded-2xl border border-white/15 p-6">
        <h1 className="text-xl font-semibold">{t('customerStories.unavailable')}</h1>
        <Link href={caseStudyPath(slug)} className="mt-4 inline-flex min-h-11 items-center underline underline-offset-4 focus-ring">{t('platform.retry')}</Link>
      </section> : study && <article className="mt-8 space-y-8">
        <header>
          <p className="text-sm font-medium text-violet-300">{t('socialProof.caseStudiesTitle')}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">{study.title}</h1>
          {study.customer_name && <p className="mt-4 text-white/65">{study.customer_name}</p>}
          {study.summary && <p className="mt-6 text-lg leading-relaxed text-white/80">{study.summary}</p>}
        </header>
        {study.result_metric && <aside className="rounded-2xl border border-violet-300/25 bg-violet-500/10 p-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white/60">{t('socialProof.resultLabel')} · {t('socialProof.customerWords')}</h2>
          <p className="mt-3 text-xl font-medium">{study.result_metric}</p>
        </aside>}
        {study.body && <div className="whitespace-pre-wrap text-base leading-8 text-white/80">{study.body}</div>}
      </article>}
    </Container>
  </PageWrap>;
}
