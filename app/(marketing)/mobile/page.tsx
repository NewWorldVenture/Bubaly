import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { Smartphone, Bell, WifiOff, RefreshCw } from 'lucide-react';
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
      <CTASection title={t('mobile.takeBubalyWithYou')} subtitle={t('mobile.signUpAndInstallOnEvery')} />
      <MarketingAeoSection path="/mobile" name={t('mobile.bubalyMobileApp')} description={t('mobile.bubalyGoesEverywhereYourFamily')} />
    </>
  );
}
