import type { Metadata } from 'next';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { FAQAccordion, type FAQ } from '@/components/marketing/faq-accordion';
import { CTASection } from '@/components/marketing/cta';
import { FaqStructuredData } from '@/components/marketing/structured-data';

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Common questions about Bubaly — privacy, roles, the AI assistant, pricing, and mobile apps.',
};

const FAQS: FAQ[] = [
  { q: 'Is my family’s data private?', a: 'Yes. Every database table enforces row-level security, so no family can ever access another family’s data. Documents are stored privately and served only via short-lived signed URLs.' },
  { q: 'How do roles work?', a: 'There are six roles: Parent/Admin, Adult, Teen, Child, Caregiver, and Guest. Parents manage everything; adults manage shared household data; teens manage their own items; children complete chores; caregivers see only assigned areas; guests view limited shared events.' },
  { q: 'Does the AI assistant actually do things, or just chat?', a: 'It takes real action. When you ask it to add an event, create chores, set a reminder, plan meals, or build a grocery list, it creates those records in your family’s database — scoped securely to your household.' },
  { q: 'Can children use it safely?', a: 'Yes. Children get a simple view of their assigned chores and items, with large tap targets and no access to billing, settings, or other members’ private data.' },
  { q: 'Is there a mobile app?', a: 'Bubaly is an installable Progressive Web App today, and ships native iOS and Android companion apps built with Expo that share the same data and design.' },
  { q: 'What does it cost?', a: 'There’s a free Starter plan and a 14-day trial of paid plans — no credit card required to begin. See the Pricing page for details.' },
  { q: 'Can I invite a babysitter or grandparent?', a: 'Absolutely. Invite them as a Caregiver (sees only assigned areas) or Guest (limited shared events). You control exactly what they can see.' },
  { q: 'How do notifications work?', a: 'Bubaly sends timely push and email reminders for due chores, medications, calendar and school/sports events, home maintenance, and expiring documents — based on each member’s preferences.' },
];

export default function FAQPage() {
  return (
    <>
      <FaqStructuredData items={FAQS} />
      <Section className="pt-20 text-center">
        <SectionHeading eyebrow="FAQ" title="Questions, answered" description="Everything you need to know to get your family started." />
      </Section>
      <Section className="pt-0">
        <FAQAccordion items={FAQS} />
      </Section>
      <CTASection />
    </>
  );
}
