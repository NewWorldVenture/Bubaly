import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import {
  Container,
  GradientText,
  HeroPhoneMockup,
  ManifestoBand,
  PageWrap,
  Pill,
  PlatformBadges,
  PrimaryLink,
  WatchDemoLink,
} from '@/components/marketing/visual-mocks';
import { SiteStructuredData } from '@/components/marketing/structured-data';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { HandledLedger } from '@/components/marketing/handled-ledger';
import { HeroOutcomes } from '@/components/marketing/hero-outcomes';
import { FirstBriefBand } from '@/components/marketing/first-brief-band';
import { DecisionsBand } from '@/components/marketing/decisions-band';
import { KitchenModeBand } from '@/components/marketing/kitchen-mode-band';
import { SwitchingBand } from '@/components/marketing/switching-band';
import { SocialProofBand } from '@/components/marketing/social-proof-band';
import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/', {
    title: t('root.metaTitleOutcomes'),
    description: t('root.metaDescriptionOutcomes'),
  });
}

// Section order is the strategy's: outcome-first hero → proof of a handled
// week → the six outcomes → the first two minutes → what it asks about →
// Kitchen Mode → switching → real families (hidden until something is
// published) → manifesto → pricing teaser → answers. The assistant panel,
// moments band and device showcase still live in visual-mocks.tsx for the
// pages that use them; the homepage no longer leads with any of them.
export default async function HomePage() {
  const t = await getTranslations();
  return (
    <PageWrap>
      <SiteStructuredData />
      {/* ── Hero ── */}
      <Container className="max-w-[1440px] px-5 pb-0 pt-10 sm:px-8 sm:pt-12 lg:px-10 lg:pt-5">
        <section className="grid items-center gap-12 lg:min-h-[650px] lg:grid-cols-[1.05fr_.95fr] lg:gap-8">

          {/* Left */}
          <div className="order-1 text-center lg:text-left">
            <Pill icon={Sparkles}>{t('root.lessManagingLifeMoreLivingIt')}</Pill>

            <h1 className="mt-6 text-[clamp(2.6rem,10vw,4.1rem)] font-extrabold leading-[1.03] tracking-[-0.038em] lg:text-[4.25rem]">
              {t('homeHero.titleLine1')}<br />
              {t('homeHero.titleLine2')}<br />
              <GradientText>{t('homeHero.titleAccent')}</GradientText>
            </h1>

            <p className="mx-auto mt-5 max-w-[540px] text-[15px] leading-6 text-white/70 sm:text-base sm:leading-7 lg:mx-0">{t('homeHero.body')}</p>

            <div className="mt-7 flex flex-col items-stretch gap-3 xs:flex-row xs:items-center xs:justify-center lg:justify-start">
              <PrimaryLink href="/signup">{t('root.startFreeTrial')}</PrimaryLink>
              <WatchDemoLink href="#handled">{t('homeHero.seeAHandledWeek')}</WatchDemoLink>
            </div>
            <p className="mx-auto mt-4 max-w-[540px] text-xs leading-5 text-white/55 lg:mx-0">{t('homeHero.firstBriefPromise')}</p>
            <div className="mt-6 flex justify-center lg:justify-start">
              <PlatformBadges />
            </div>
          </div>

          {/* Right — phone mockup */}
          <div className="order-2 flex justify-center overflow-hidden py-4 lg:justify-end lg:overflow-visible lg:py-0">
            <HeroPhoneMockup className="w-full max-w-[278px] sm:max-w-[306px] lg:max-w-[320px]" />
          </div>
        </section>
      </Container>

      {/* ── 2. Bubaly Handled — proof band ── */}
      <HandledLedger />

      {/* ── 3. Six outcomes ── */}
      <HeroOutcomes />

      {/* ── 4. Your first two minutes ── */}
      <FirstBriefBand />

      {/* ── 5. Handles the routine, asks about the rest ── */}
      <DecisionsBand />

      {/* ── 6. Kitchen Mode ── */}
      <KitchenModeBand />

      {/* ── 7. Switching ── */}
      <SwitchingBand />

      {/* ── 8. Real families (renders nothing until something is published) ── */}
      <SocialProofBand />

      {/* ── 9. Brand manifesto ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-14 sm:px-8 sm:pt-16 lg:px-10">
        <ManifestoBand />
      </Container>

      {/* ── 10. Pricing teaser ── */}
      <Container className="max-w-[1440px] px-5 pb-14 pt-8 text-center sm:px-8 sm:pb-16 lg:px-10">
        <p className="text-lg font-semibold text-white/80 sm:text-xl">{t('homeHero.pricingTeaser')}</p>
        <Link href="/pricing" className="focus-visible:focus-ring mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-violet-300 underline-offset-4 transition hover:underline">
          {t('homeHero.seePricing')} →
        </Link>
      </Container>

      {/* ── 11. Answers + structured data ── */}
      <MarketingAeoSection
        path="/"
        name="Bubaly"
        description={t('root.metaDescriptionOutcomes')}
      />
    </PageWrap>
  );
}
