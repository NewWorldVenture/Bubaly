import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTranslations } from '@/lib/i18n/server';
import { Section } from './sections';

/**
 * The closing call to action on every marketing page.
 *
 * `title`/`subtitle` are optional overrides. They default to catalogue keys
 * rather than English literals: a page that passes nothing gets the visitor's
 * language, and a page that passes its own copy is responsible for translating
 * it — the default is not a place where English can hide.
 */
export async function CTASection({
  title,
  subtitle,
}: {
  title?: string;
  subtitle?: string;
} = {}) {
  const t = await getTranslations();

  return (
    <Section>
      <div className="glass-card p-10 text-center shadow-glow sm:p-16">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {title ?? t('marketing.cta.title')}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-muted">
          {subtitle ?? t('marketing.cta.subtitle')}
        </p>
        <Link href="/signup" className="mt-8 inline-block">
          <Button size="lg">
            {t('marketing.cta.startFreeTrial')} <ArrowRight className="h-5 w-5" />
          </Button>
        </Link>
      </div>
    </Section>
  );
}
