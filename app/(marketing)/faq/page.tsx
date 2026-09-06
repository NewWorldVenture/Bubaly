import type { Metadata } from 'next';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { type FAQ } from '@/components/marketing/faq-accordion';
import { FaqTabs, type FaqSection } from '@/components/marketing/faq-tabs';
import { CTASection } from '@/components/marketing/cta';
import { FaqStructuredData, MarketingPageStructuredData } from '@/components/marketing/structured-data';
import { readPublishedAeoQuestions } from '@/lib/marketing/aeo';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/faq', {
  title: 'FAQ & Family Knowledge Center',
  description: 'Answers to the questions families ask about organizing family life with Bubaly, the AI Family Operating System — privacy, roles, the AI assistant, pricing, and mobile apps.',
  });
}

export const revalidate = 3600;

// Core FAQs grouped into sections — each section becomes a tab on the page.
const FAQ_SECTIONS: FaqSection[] = [
  {
    id: 'privacy-security',
    label: 'Privacy & Security',
    items: [
      { q: 'Is my family’s data private?', a: 'Yes. Every database table enforces row-level security, so no family can ever access another family’s data. Documents are stored privately and served only via short-lived signed URLs.' },
    ],
  },
  {
    id: 'roles-access',
    label: 'Roles & Access',
    items: [
      { q: 'How do roles work?', a: 'There are six roles: Parent/Admin, Adult, Teen, Child, Caregiver, and Guest. Parents manage everything; adults manage shared household data; teens manage their own items; children complete chores; caregivers see only assigned areas; guests view limited shared events.' },
      { q: 'Can I invite a babysitter or grandparent?', a: 'Absolutely. Invite them as a Caregiver (sees only assigned areas) or Guest (limited shared events). You control exactly what they can see.' },
    ],
  },
  {
    id: 'ai-assistant',
    label: 'AI Assistant',
    items: [
      { q: 'Does the AI assistant actually do things, or just chat?', a: 'It takes real action. When you ask it to add an event, create chores, set a reminder, plan meals, or build a grocery list, it creates those records in your family’s database — scoped securely to your household.' },
    ],
  },
  {
    id: 'kids-safety',
    label: 'Kids & Safety',
    items: [
      { q: 'Can children use it safely?', a: 'Yes. Children get a simple view of their assigned chores and items, with large tap targets and no access to billing, settings, or other members’ private data.' },
    ],
  },
  {
    id: 'plans-pricing',
    label: 'Plans & Pricing',
    items: [
      { q: 'What does it cost?', a: 'There’s a free Starter plan and a 5-day trial of paid plans — no credit card required to begin. See the Pricing page for details.' },
    ],
  },
  {
    id: 'mobile-notifications',
    label: 'Mobile & Alerts',
    items: [
      { q: 'Is there a mobile app?', a: 'Bubaly is an installable Progressive Web App today, and ships native iOS and Android companion apps built with Expo that share the same data and design.' },
      { q: 'How do notifications work?', a: 'Bubaly sends timely push and email reminders for due chores, medications, calendar and school/sports events, home maintenance, and expiring documents — based on each member’s preferences.' },
    ],
  },
];

export default async function FAQPage() {
  const t = await getTranslations();
  // The Knowledge Center is driven by the admin AEO console: published
  // marketing_aeo_questions render here + feed the FAQPage structured data, so
  // adding/editing an answer in /admin/marketing/aeo updates this page and its
  // rich results automatically — no duplication.
  const aeo = await readPublishedAeoQuestions(60);
  const knowledge: FAQ[] = aeo.questions.map((q) => ({ q: q.question, a: q.answer }));

  // The live Knowledge Center becomes its own tab when answers are published.
  const sections: FaqSection[] = knowledge.length > 0
    ? [...FAQ_SECTIONS, { id: 'knowledge-center', label: 'Knowledge Center', items: knowledge }]
    : FAQ_SECTIONS;

  // Everything (core + Knowledge Center) participates in the FAQPage schema.
  const schemaItems = sections.flatMap((section) => section.items).slice(0, 100);

  return (
    <>
      <FaqStructuredData items={schemaItems} />
      <MarketingPageStructuredData path="/faq" name="FAQ & Family Knowledge Center" description="Answers to common questions about Bubaly." />
      <Section className="pt-20 text-center">
        <SectionHeading eyebrow="FAQ" title={t('faq.questionsAnswered')} description="Everything you need to know to get your family started with the AI Family Operating System." />
      </Section>

      {!aeo.available && (
        <Section className="pt-0">
          <p className="mx-auto max-w-3xl rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200" role="status">
            The live Knowledge Center is temporarily unavailable. The core answers below are still available; please refresh shortly for the latest team updates.
          </p>
        </Section>
      )}

      <Section className="pt-2">
        <FaqTabs sections={sections} />
      </Section>

      <CTASection />
    </>
  );
}
