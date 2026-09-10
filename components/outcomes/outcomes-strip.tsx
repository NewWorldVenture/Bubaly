import Link from 'next/link';
import { ArrowRight, Target } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { discoverOutcomes, type DiscoverySnapshot } from '@/lib/outcomes/discovery';
import { outcomePath } from '@/lib/outcomes/launcher';

export async function OutcomesStrip({ href, snapshot }: { href: '/home' | '/dashboard/command-center'; snapshot: DiscoverySnapshot }) {
  const t = await getTranslations();
  const { suggestions, unavailable } = discoverOutcomes(href, snapshot);
  return <section className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 font-semibold"><Target className="h-4 w-4 text-brand-text" />{t('outcomeDiscovery.title')}</h2>
      <Link href="/dashboard/outcomes" className="inline-flex min-h-11 items-center text-sm text-brand-text hover:underline">{t('outcomeDiscovery.all')}</Link>
    </div>
    {unavailable && <p role="status" className="text-sm text-muted">{t('outcomeDiscovery.unavailable')}{' '}<Link href={href} className="underline">{t('outcomeDiscovery.refresh')}</Link></p>}
    <div className="grid gap-3 sm:grid-cols-3">
      {suggestions.map(({ outcome, evidence, stepCount }) => <Link key={outcome.id} href={outcomePath(outcome.id)} className="group flex min-h-28 flex-col justify-between gap-3 rounded-xl border border-border bg-surface p-4 transition hover:border-brand/50">
        <span className="font-semibold">{t(outcome.titleKey)}</span>
        {evidence.length > 0 && <span className="space-y-1 text-xs text-muted">{evidence.map((item) => <span key={item.labelKey} className="block">{t(item.labelKey, { count: item.count })}</span>)}</span>}
        <span className="flex items-center justify-between gap-2 text-sm text-brand-text">{t('outcomeDiscovery.viewSteps', { count: stepCount })}<ArrowRight className="h-4 w-4 shrink-0" /></span>
      </Link>)}
    </div>
  </section>;
}
