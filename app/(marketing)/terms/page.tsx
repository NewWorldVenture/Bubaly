import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { LegalPage, type LegalSection } from '@/components/marketing/legal';
import { CTASection } from '@/components/marketing/cta';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';

export async function generateMetadata(): Promise<Metadata> {
  // The browser tab title is copy too — a French visitor should not get an
  // English <title> above a French page.
  const t = await getTranslations();
  return resolveMarketingMetadata('/terms', {
  title: t('terms.termsOfService'),
  description: t('terms.theTermsThatGovernYour'),
  });
}

const SECTIONS: LegalSection[] = [
  {
    id: 'acceptance',
    heading: 'terms.acceptanceOfTheseTerms',
    body: [
      'terms.theseTermsOfServiceTerms',
      'terms.ifYouAreAgreeingOn',
    ],
  },
  {
    id: 'accounts',
    heading: 'terms.yourAccountAndFamily',
    body: [
      'terms.youNeedAnAccountTo',
      'terms.asThePersonWhoCreates',
      'terms.youMustBeOldEnough',
    ],
  },
  {
    id: 'acceptable-use',
    heading: 'terms.acceptableUse',
    body: [
      'terms.bubalyIsForOrganizingYour',
      [
        'terms.useTheServiceForAnything',
        'terms.uploadContentThatInfringesOthers',
        'terms.attemptToAccessAnotherFamily',
        'terms.reverseEngineerResellOrMisuse',
        'terms.useTheServiceToSend',
      ],
      'terms.ourFullExpectationsAreDescribed',
    ],
  },
  {
    id: 'your-content',
    heading: 'terms.yourContent',
    body: [
      'terms.everythingYouAddToBubaly',
      'terms.youGrantUsALimited',
      'terms.youAreResponsibleForYour',
    ],
  },
  {
    id: 'ai',
    heading: 'terms.aiFeatures',
    body: [
      'terms.bubalyIncludesAnAiAssistant',
    ],
  },
  {
    id: 'plans',
    heading: 'terms.plansBillingAndTrials',
    body: [
      'terms.bubalyOffersAFreePlan',
      'terms.youCanChangeOrCancel',
    ],
  },
  {
    id: 'termination',
    heading: 'terms.termination',
    body: [
      'terms.youMayStopUsingBubaly',
      'terms.whenAnAccountIsDeleted',
    ],
  },
  {
    id: 'disclaimers',
    heading: 'terms.disclaimersAndLimitationOfLiability',
    body: [
      'terms.theServiceIsProvidedAs',
      'terms.toTheMaximumExtentPermitted',
    ],
  },
  {
    id: 'changes',
    heading: 'terms.changesToTheseTerms',
    body: [
      'terms.weMayUpdateTheseTerms',
    ],
  },
  {
    id: 'contact',
    heading: 'terms.contactUs',
    body: [
      'terms.questionsAboutTheseTermsEmail',
    ],
  },
];

export default async function TermsPage() {
  const t = await getTranslations();
  return (
    <>
      <LegalPage
        title={t('terms.termsOfService')}
        summary={t('terms.theAgreementThatGovernsYour')}
        lastUpdated="2026-06-24"
        path="/terms"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
