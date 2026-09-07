// The homepage's outcome rail: six things families stop carrying, each a
// deep link into the /features card that shows the capability behind it.
//
// Server component. The `<nav aria-label="Explore family tools">` and its SIX
// links, in this order, are what tests/e2e/marketing-public.spec.ts walks —
// nothing else inside the nav may be a link, which is why the health card's
// trust chip is a plain span and the "when life gets bigger" links sit
// outside the nav.
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { Container, IconOrb, SampleBadge } from '@/components/marketing/primitives';
import { HERO_OUTCOMES, MORE_OUTCOMES, type HeroOutcome } from '@/lib/marketing/hero-outcomes';
import { trustDomainKey } from '@/lib/marketing/trust-copy';
import { ROLE_DEFAULTS } from '@/lib/trust/engine';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The "Asks first" line: the outcome's high-stakes domains through the
 * trustDomains.* keys, a role line for outcomes whose caution is about WHO
 * acts rather than WHAT (kids' rewards wait for a parent — only claimed while
 * the engine actually withholds automation from the child role), or the
 * honest "nothing — this is routine work".
 */
function asksFirstLine(outcome: HeroOutcome, t: Translate): string {
  if (outcome.asksFirst.length > 0) {
    return outcome.asksFirst.map((domain) => t(trustDomainKey(domain))).join(', ');
  }
  if (outcome.roleAsksKey && ROLE_DEFAULTS.child.automationTrusted === false) {
    return t(outcome.roleAsksKey);
  }
  return t('heroOutcomes.asksNothing');
}

export async function HeroOutcomes() {
  const t = await getTranslations();
  return (
    <Container className="max-w-[1440px] px-5 pb-4 pt-12 sm:px-8 sm:pt-16 lg:px-10">
      <h2 className="sr-only">{t('heroOutcomes.title')}</h2>
      <p className="mb-6 text-center text-xs font-semibold uppercase tracking-[0.2em] text-white/55">{t('heroOutcomes.eyebrow')}</p>
      <nav aria-label={t('root.exploreFamilyTools')} className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-6 lg:gap-5">
        {HERO_OUTCOMES.map((outcome) => (
          <Link
            key={outcome.href}
            href={outcome.href}
            className="focus-visible:focus-ring group flex flex-col items-center rounded-xl px-2 py-3 text-center transition hover:bg-white/[0.045]"
          >
            <IconOrb icon={outcome.icon} tone={outcome.tone} className="h-14 w-14 transition group-hover:scale-105 [&>svg]:h-6 [&>svg]:w-6" />
            <h3 className="mt-3 text-xs font-semibold">{t(outcome.titleKey)}</h3>
            <p className="mx-auto mt-2 max-w-[170px] text-xs leading-5 text-white/55">{t(outcome.bodyKey)}</p>
            {/* The proof chip names a made-up example, so it wears the site's
                illustrative marker rather than reading like a real run. The
                badge text itself is announced to screen readers, where the
                violet pill carries no meaning. */}
            <SampleBadge className="mt-3 normal-case tracking-normal">
              <span className="sr-only">{t('handledProof.sampleBadge')}</span>
              {t(outcome.proofKey)}
            </SampleBadge>
            {outcome.trustChipKey && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-white/80">
                <ShieldCheck className="h-3 w-3 text-emerald-400" aria-hidden />
                {t(outcome.trustChipKey)}
              </span>
            )}
            <p className="mx-auto mt-3 max-w-[170px] text-[11px] leading-4 text-white/50">
              <span className="font-semibold text-white/65">{t('heroOutcomes.asksFirst')}</span>{' '}
              {asksFirstLine(outcome, t)}
            </p>
          </Link>
        ))}
      </nav>

      <div className="mt-10 flex flex-col items-center gap-3 border-t border-white/[0.06] pt-6 text-center sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-6">
        <span className="text-sm font-semibold text-white/70">{t('heroOutcomes.moreTitle')}</span>
        {MORE_OUTCOMES.map((more) => (
          <Link key={more.outcomeId} href={more.href} className="focus-visible:focus-ring inline-flex min-h-11 items-center text-sm text-white/65 underline-offset-4 transition hover:text-white hover:underline">
            {t(more.labelKey)}
          </Link>
        ))}
        <Link href="/features" className="focus-visible:focus-ring inline-flex min-h-11 items-center text-sm font-semibold text-violet-300 underline-offset-4 transition hover:underline">
          {t('heroOutcomes.moreLink')} →
        </Link>
      </div>
    </Container>
  );
}
