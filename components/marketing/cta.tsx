import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section } from './sections';

export async function CTASection({
  title = 'Less Managing Life. More Living It.',
  subtitle = 'Set up your family in minutes, invite everyone, and let Bubaly handle the logistics — so you get your time, attention, and peace of mind back.',
}: {
  title?: string;
  subtitle?: string;
}) {
  const t = await getTranslations();
  return (
    <Section>
      <div className="glass-card p-10 text-center shadow-glow sm:p-16">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-muted">{subtitle}</p>
        <Link href="/signup" className="mt-8 inline-block">
          <Button size="lg">{t('cta.startYourFreeTrial')}{' '}<ArrowRight className="h-5 w-5" />
          </Button>
        </Link>
      </div>
    </Section>
  );
}
