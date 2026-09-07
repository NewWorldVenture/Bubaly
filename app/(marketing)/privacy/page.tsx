import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { LegalPage, type LegalSection } from '@/components/marketing/legal';
import { CTASection } from '@/components/marketing/cta';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';

export async function generateMetadata(): Promise<Metadata> {
  // The browser tab title is copy too — a French visitor should not get an
  // English <title> above a French page.
  const t = await getTranslations();
  return resolveMarketingMetadata('/privacy', {
  title: t('privacy.privacyPolicy'),
  description:
    "How Bubaly collects, uses, and protects your family's information — including children's data, calendars, and the AI assistant.",
  });
}

const SECTIONS: LegalSection[] = [
  {
    id: 'overview',
    heading: 'privacy.ourCommitmentToYourFamily',
    body: [
      'privacy.bubalyIsAFamilyOrganizer',
      'privacy.theShortVersionWeCollect',
    ],
  },
  {
    id: 'information-we-collect',
    heading: 'privacy.informationWeCollect',
    body: [
      'privacy.weCollectInformationInThree',
      'privacy.informationYouProvide',
      [
        'privacy.accountDetailsYourNameEmail',
        'privacy.familyContentCalendarEventsTo',
        'Family member profiles — names, roles (parent, adult, teen, child, caregiver, guest), and optional details like birthdays and colors. Profiles for children are created and managed by a parent or guardian.',
        'privacy.paymentInformationIfYouSubscribe',
      ],
      'Information created through use: the records you create, your in‑app activity (such as completing a chore), and your notification and display preferences.',
      'privacy.informationCollectedAutomaticallyBasicDevice',
    ],
  },
  {
    id: 'children',
    heading: 'Children\'s privacy',
    body: [
      'privacy.bubalyIsDesignedForFamilies',
      'privacy.weCollectChildrenSInformation',
      'privacy.aParentOrGuardianCan',
    ],
  },
  {
    id: 'how-we-use',
    heading: 'privacy.howWeUseInformation',
    body: [
      'privacy.weUseTheInformationWe',
      [
        'privacy.provideAndOperateBubalyStore',
        'privacy.powerFeaturesYouAskFor',
        'privacy.sendNotificationsAndRemindersYou',
        'privacy.keepBubalySecureDetectAnd',
        'privacy.improveTheProductUnderstandWhich',
        'privacy.communicateWithYouRespondTo',
      ],
    ],
  },
  {
    id: 'ai',
    heading: 'privacy.howTheAiAssistantUses',
    body: [
      'privacy.whenYouUseTheAi',
      'privacy.weDoNotAllowYour',
    ],
  },
  {
    id: 'sharing',
    heading: 'privacy.howInformationIsShared',
    body: [
      'privacy.weDoNotSellYour',
      [
        'privacy.withinYourFamilyContentYou',
        'privacy.serviceProvidersTrustedVendorsWho',
        'privacy.legalReasonsWhenRequiredBy',
        'privacy.businessTransfersIfBubalyIs',
      ],
    ],
  },
  {
    id: 'security',
    heading: 'privacy.howWeProtectYourInformation',
    body: [
      'privacy.securityIsBuiltIntoBubaly',
      [
        'privacy.rowLevelSecurityEveryDatabase',
        'privacy.encryptionDataIsEncryptedIn',
        'privacy.privateDocumentsFilesAreStored',
        'privacy.accessControlsInternalAccessTo',
      ],
      'privacy.noSystemIsPerfectlySecure',
    ],
  },
  {
    id: 'your-rights',
    heading: 'privacy.yourRightsAndChoices',
    body: [
      'privacy.youAreInControlOf',
      [
        'privacy.accessAndEditViewAnd',
        'privacy.exportRequestACopyOf',
        'privacy.deleteDeleteIndividualItemsA',
        'privacy.manageNotificationsChangeOrTurn',
      ],
      'privacy.dependingOnWhereYouLive',
    ],
  },
  {
    id: 'retention',
    heading: 'privacy.dataRetention',
    body: [
      'privacy.weKeepYourInformationFor',
    ],
  },
  {
    id: 'changes',
    heading: 'privacy.changesToThisPolicy',
    body: [
      'privacy.weMayUpdateThisPrivacy',
    ],
  },
];

export default async function PrivacyPage() {
  const t = await getTranslations();
  return (
    <>
      <LegalPage
        title={t('privacy.privacyPolicy')}
        summary={t('privacy.whatWeCollectWhyAnd')}
        lastUpdated="2026-06-24"
        path="/privacy"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
