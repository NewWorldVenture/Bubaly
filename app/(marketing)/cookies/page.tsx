import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { LegalPage, type LegalSection } from '@/components/marketing/legal';
import { CTASection } from '@/components/marketing/cta';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';

export async function generateMetadata(): Promise<Metadata> {
  // The browser tab title is copy too — a French visitor should not get an
  // English <title> above a French page.
  const t = await getTranslations();
  return resolveMarketingMetadata('/cookies', {
  title: t('cookies.cookiePolicy'),
  description: t('cookies.howBubalyUsesCookiesAnd'),
  });
}

const SECTIONS: LegalSection[] = [
  {
    id: 'what',
    heading: 'cookies.whatCookiesAre',
    body: [
      'cookies.cookiesAreSmallTextFiles',
    ],
  },
  {
    id: 'how-we-use',
    heading: 'cookies.howBubalyUsesThem',
    body: [
      'cookies.weKeepOurUseOf',
      [
        'cookies.essentialSignYouInKeep',
        'cookies.preferencesRememberChoicesSuchAs',
        'cookies.analyticsUnderstandInAggregateHow',
      ],
      'cookies.weDoNotUseCookies',
    ],
  },
  {
    id: 'managing',
    heading: 'cookies.managingCookies',
    body: [
      'cookies.youCanControlCookiesThrough',
      'cookies.becauseWeDonTUse',
    ],
  },
  {
    id: 'changes',
    heading: 'cookies.changesToThisPolicy',
    body: [
      'cookies.ifWeChangeHowWe',
    ],
  },
];

export default async function CookiesPage() {
  const t = await getTranslations();
  return (
    <>
      <LegalPage
        title={t('cookies.cookiePolicy')}
        summary={t('cookies.theSmallFilesThatKeep')}
        lastUpdated="2026-06-24"
        path="/cookies"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
