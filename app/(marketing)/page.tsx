import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import {
  Container,
  DeviceShowcase,
  FamilyMomentsBand,
  FEATURE_RAIL,
  FamilyAiPanel,
  GradientText,
  HeroPhoneMockup,
  IconOrb,
  ManifestoBand,
  PageWrap,
  Pill,
  PlatformBadges,
  PrimaryLink,
  WatchDemoLink,
} from '@/components/marketing/visual-mocks';
import { SiteStructuredData } from '@/components/marketing/structured-data';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/', {
    title: t('app.bubalyTheAiOperatingSystem'),
    description: t('app.bubalyQuietlyHandlesTheLogistics'),
  });
}

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

            <h1 className="mt-6 text-[clamp(3rem,11vw,4.1rem)] font-extrabold leading-[1.03] tracking-[-0.038em] lg:text-[4.25rem]">
              {t('root.theAiOperating')}<br />
              {t('root.systemFor')}<br />
              <GradientText>{t('root.familyLife')}</GradientText>
            </h1>

            <p className="mx-auto mt-5 max-w-[540px] text-[15px] leading-6 text-white/70 sm:text-base sm:leading-7 lg:mx-0">{t('app.bubalyQuietlyHandlesTheLogistics')}</p>

            <div className="mt-7 flex flex-col items-stretch gap-3 xs:flex-row xs:items-center xs:justify-center lg:justify-start">
              <PrimaryLink href="/signup">{t('root.startFreeTrial')}</PrimaryLink>
              <WatchDemoLink href="/how-it-works">{t('root.seeHowItWorks')}</WatchDemoLink>
            </div>
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

      {/* ── Tagline divider ── */}
      <div className="mt-12 border-y border-white/[0.06] bg-white/[0.012] py-5 text-center lg:mt-2">
        <p className="text-lg font-semibold text-white/80 sm:text-xl">
          {t('root.lessStressLessMentalLoadMore')}
        </p>
      </div>

      {/* ── Feature rail ── */}
      <Container className="max-w-[1440px] px-5 pb-4 pt-10 sm:px-8 sm:pt-12 lg:px-10">
        <h2 className="sr-only">{t('root.toolsForEverydayFamilyLife')}</h2>
        <nav aria-label={t('root.exploreFamilyTools')} className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-6 lg:gap-5">
          {FEATURE_RAIL.map(({ icon, title, body, tone, href }) => (
            <Link key={title} href={href} className="focus-visible:focus-ring group flex flex-col items-center rounded-xl px-2 py-3 text-center transition hover:bg-white/[0.045]">
              <IconOrb icon={icon} tone={tone} className="h-14 w-14 transition group-hover:scale-105 [&>svg]:h-6 [&>svg]:w-6" />
              <h3 className="mt-3 text-xs font-semibold">{t(title)}</h3>
              <p className="mx-auto mt-2 max-w-[160px] text-xs leading-5 text-white/55">{t(body)}</p>
            </Link>
          ))}
        </nav>
      </Container>

      {/* ── AI Family Assistant ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-8 sm:px-8 lg:px-10">
        <FamilyAiPanel />
      </Container>

      {/* ── Family workflows ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-4 sm:px-8 lg:px-10">
        <FamilyMomentsBand />
      </Container>

      {/* ── Brand manifesto ── */}
      <Container className="max-w-[1440px] px-5 pb-3 pt-10 sm:px-8 sm:pt-12 lg:px-10">
        <ManifestoBand />
      </Container>

      {/* ── Device showcase ── */}
      <Container className="max-w-[1440px] px-5 pb-12 pt-0 sm:px-8 sm:pb-16 lg:px-10">
        <DeviceShowcase />
      </Container>

      <MarketingAeoSection
        path="/"
        name="Bubaly"
        description={t('app.theAiOperatingSystemFor')}
      />
    </PageWrap>
  );
}
