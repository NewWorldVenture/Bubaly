import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { LegalPage, type LegalSection } from '@/components/marketing/legal';
import { CTASection } from '@/components/marketing/cta';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';

export async function generateMetadata(): Promise<Metadata> {
  // The browser tab title is copy too — a French visitor should not get an
  // English <title> above a French page.
  const t = await getTranslations();
  return resolveMarketingMetadata('/acceptable-use', {
  title: t('acceptableUse.acceptableUsePolicy'),
  description: t('acceptableUse.theRulesForUsingBubaly'),
  });
}

const SECTIONS: LegalSection[] = [
  {
    id: 'purpose',
    heading: 'acceptableUse.purpose',
    body: [
      'acceptableUse.bubalyExistsToHelpFamilies',
    ],
  },
  {
    id: 'respect-families',
    heading: 'acceptableUse.respectOtherFamiliesAndMembers',
    body: [
      'acceptableUse.bubalyIsBuiltSoThat',
      [
        'acceptableUse.attemptToAccessProbeOr',
        'acceptableUse.harassThreatenOrHarmOther',
        'acceptableUse.impersonateAnotherPersonOrMisrepresent',
      ],
    ],
  },
  {
    id: 'content',
    heading: 'acceptableUse.contentStandards',
    body: [
      'acceptableUse.youAreResponsibleForThe',
      [
        'acceptableUse.isIllegalOrThatInfringes',
        'acceptableUse.sexuallyExploitsOrEndangersChildren',
        'acceptableUse.promotesViolenceSelfHarmOr',
        'acceptableUse.containsMalwareOrIsDesigned',
      ],
      'acceptableUse.weMayRemoveContentThat',
    ],
  },
  {
    id: 'security',
    heading: 'acceptableUse.protectTheService',
    body: [
      'acceptableUse.toKeepBubalyDependableFor',
      [
        'acceptableUse.breakDisableOrOverloadThe',
        'acceptableUse.reverseEngineerTheServiceOr',
        'acceptableUse.useBotsScrapersOrAutomated',
        'acceptableUse.resellSublicenseOrCommerciallyExploit',
      ],
    ],
  },
  {
    id: 'ai',
    heading: 'acceptableUse.responsibleUseOfAi',
    body: [
      'acceptableUse.theAiAssistantIsThere',
    ],
  },
  {
    id: 'enforcement',
    heading: 'acceptableUse.enforcement',
    body: [
      'acceptableUse.ifYouViolateThisPolicy',
      'acceptableUse.toReportMisuseEmailSupport',
    ],
  },
];

export default async function AcceptableUsePage() {
  const t = await getTranslations();
  return (
    <>
      <LegalPage
        title={t('acceptableUse.acceptableUsePolicy')}
        summary={t('acceptableUse.simpleRulesThatKeepBubaly')}
        lastUpdated="2026-06-24"
        path="/acceptable-use"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
