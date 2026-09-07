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
  description: 'The rules for using Bubaly responsibly and keeping every family safe.',
  });
}

const SECTIONS: LegalSection[] = [
  {
    id: 'purpose',
    heading: 'Purpose',
    body: [
      'Bubaly exists to help families organize their lives together. This Acceptable Use Policy describes what you can and can\'t do with the Service so that it stays safe, reliable, and welcoming for everyone. It is part of our Terms of Service.',
    ],
  },
  {
    id: 'respect-families',
    heading: 'Respect other families and members',
    body: [
      'Bubaly is built so that each family\'s data is private and isolated. You agree not to:',
      [
        'Attempt to access, probe, or interfere with another family\'s account or data.',
        'Harass, threaten, or harm other members of your family or anyone else through the Service.',
        'Impersonate another person or misrepresent who you are.',
      ],
    ],
  },
  {
    id: 'content',
    heading: 'Content standards',
    body: [
      'You are responsible for the content you add. Do not upload, store, or share content that:',
      [
        'Is illegal, or that infringes someone else\'s intellectual property or privacy rights.',
        'Sexually exploits or endangers children in any way.',
        'Promotes violence, self‑harm, or hatred against people based on who they are.',
        'Contains malware, or is designed to deceive or defraud.',
      ],
      'We may remove content that violates this policy and take action on accounts involved.',
    ],
  },
  {
    id: 'security',
    heading: 'Protect the Service',
    body: [
      'To keep Bubaly dependable for everyone, you agree not to:',
      [
        'Break, disable, or overload the Service, its infrastructure, or its AI features.',
        'Reverse engineer the Service or attempt to extract source code, except where the law allows.',
        'Use bots, scrapers, or automated means to access the Service in ways that burden it or evade limits.',
        'Resell, sublicense, or commercially exploit the Service without our permission.',
      ],
    ],
  },
  {
    id: 'ai',
    heading: 'Responsible use of AI',
    body: [
      'The AI assistant is there to help you run your household. Do not use it to generate unlawful content, to attempt to access data that isn\'t yours, or to produce harmful, deceptive, or abusive material. Always review AI output before acting on anything important.',
    ],
  },
  {
    id: 'enforcement',
    heading: 'Enforcement',
    body: [
      'If you violate this policy, we may warn you, remove content, limit features, or suspend or terminate your account, depending on the severity. Serious violations — especially anything that endangers a child — may be reported to the appropriate authorities.',
      'To report misuse, email support@bubaly.com.',
    ],
  },
];

export default async function AcceptableUsePage() {
  const t = await getTranslations();
  return (
    <>
      <LegalPage
        title={t('acceptableUse.acceptableUsePolicy')}
        summary="Simple rules that keep Bubaly safe, reliable, and welcoming for every family."
        lastUpdated="June 24, 2026"
        path="/acceptable-use"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
