import { getTranslations } from '@/lib/i18n/server';
import { ArrowRight } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button-link';
import { Section } from './sections';

// The defaults were English literals in a parameter list, where the i18n gate
// does not look: every marketing page that took them (/, /faq, /privacy,
// /terms, /cookies, /acceptable-use…) closed on an English paragraph in every
// locale. Audit C1-S9-108.
export async function CTASection({
  title,
  subtitle,
}: {
  title?: string;
  subtitle?: string;
}) {
  const t = await getTranslations();
  title ??= t('root.lessManagingLifeMoreLivingIt');
  subtitle ??= t('cta.setUpYourFamilyInMinutes');
  return (
    <Section>
      <div className="glass-card p-10 text-center shadow-glow sm:p-16">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-muted">{subtitle}</p>
        <ButtonLink href="/signup" size="lg" className="mt-8">{t('cta.startYourFreeTrial')}{' '}<ArrowRight className="h-5 w-5" />
        </ButtonLink>
      </div>
    </Section>
  );
}
