import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { outcomePath, outcomesForRoute } from '@/lib/outcomes/launcher';

export async function RelatedOutcomes({ href }: { href: string }) {
  const outcomes = outcomesForRoute(href);
  if (!outcomes.length) return null;
  const t = await getTranslations();
  return <section className="mb-4 flex flex-wrap items-center gap-2 px-1" aria-label={t('outcomeDiscovery.related')}>
    <span className="text-xs font-medium text-muted">{t('outcomeDiscovery.related')}</span>
    {outcomes.map((outcome) => <Link key={outcome.id} href={outcomePath(outcome.id)} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm hover:border-brand/50">
      {t(outcome.titleKey)}<ArrowRight className="h-3.5 w-3.5" />
    </Link>)}
  </section>;
}
