import type { Metadata } from 'next';
import Link from 'next/link';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { Smartphone, Bell, WifiOff, RefreshCw, Tablet, ArrowRight } from 'lucide-react';
import { Section, SectionHeading, FeatureCard } from '@/components/marketing/sections';
import { CTASection } from '@/components/marketing/cta';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/mobile', {
    title: t('mobile.mobileApp'),
    description: t('mobile.bubalyGoesEverywhereYourFamilyDoes'),
  });
}

// Catalogue keys, resolved in the component: `t` does not exist at module scope.
const POINTS = [
  { icon: Smartphone, title: 'mobile.iosAndAndroid', description: 'mobile.nativeCompanionAppsBuiltWith' },
  { icon: Bell, title: 'mobile.pushNotifications', description: 'mobile.getNudgedOnYourPhone' },
  { icon: WifiOff, title: 'mobile.offlineFriendly', description: 'mobile.recentlyViewedScreensKeepWorking' },
  { icon: RefreshCw, title: 'mobile.realTimeSync', description: 'mobile.checkOffAGroceryItem' },
];

export default async function MobilePage() {
  const t = await getTranslations();
  // One whole sentence with a {action} placeholder rather than three fragments
  // around the bold span: a translator needs the sentence to reorder it, and
  // several of these languages put the verb somewhere English does not.
  const install = t('mobile.bubalyIsAProgressiveWebApp').split(/(\{action\})/g);

  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading
          eyebrow={t('mobile.mobile')}
          title={t('mobile.bubalyInYourPocket')}
          description={t('mobile.installTheWebAppToday')}
        />
      </Section>
      <Section className="pt-0">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {POINTS.map((p) => (
            <FeatureCard key={p.title} icon={p.icon} title={t(p.title)} description={t(p.description)} />
          ))}
        </div>
        <div className="glass-card mx-auto mt-10 max-w-2xl p-7 text-center">
          <h3 className="text-lg font-semibold">{t('mobile.installTheWebAppRightNow')}</h3>
          <p className="mt-2 text-sm text-muted">
            {install.map((part, i) => (part === '{action}'
              ? <span key={i} className="font-medium text-fg">{t('mobile.addToHomeScreen')}</span>
              : part))}
          </p>
        </div>
      </Section>

      {/* Tablets: Kitchen Mode — the same software on the tablet a family
          already owns. Copy claims only what lib/display and components/display
          ship (arranged widgets, timers, weather, photos, full-screen via Add to
          Home Screen); the /features card holds the illustration. */}
      <Section className="pt-0">
        <div className="glass-card mx-auto flex max-w-3xl flex-col items-center gap-5 p-7 text-center sm:flex-row sm:text-left">
          <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand-text">
            <Tablet className="h-7 w-7" aria-hidden />
          </span>
          <div className="flex-1">
            <h2 className="text-2xl font-bold tracking-tight">{t('mobile.kitchenModeTitle')}</h2>
            <p className="mt-2 text-sm text-muted">{t('mobile.kitchenModeBody')}</p>
            <p className="mt-2 text-xs font-medium text-muted">{t('kitchenMode.tier')}</p>
          </div>
          <Link
            href="/features#kitchen-mode"
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-border bg-surface/50 px-5 py-2.5 text-sm font-semibold transition hover:border-brand/40 hover:bg-surface/80"
          >
            {t('mobile.kitchenModeLink')}{' '}<ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </Section>
      <CTASection title={t('mobile.takeBubalyWithYou')} subtitle={t('mobile.signUpAndInstallOnEvery')} />
      <MarketingAeoSection path="/mobile" name={t('mobile.bubalyMobileApp')} description={t('mobile.bubalyGoesEverywhereYourFamily')} />
    </>
  );
}
