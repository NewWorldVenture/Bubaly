import type { Metadata } from 'next';
import { LegalPage, type LegalSection } from '@/components/marketing/legal';
import { CTASection } from '@/components/marketing/cta';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    "How Bubaly collects, uses, and protects your family's information — including children's data, calendars, and the AI assistant.",
};

const SECTIONS: LegalSection[] = [
  {
    id: 'overview',
    heading: 'Our commitment to your family',
    body: [
      'Bubaly is a family organizer. People trust us with some of their most personal information — their children\'s schedules, their household\'s plans, their photos and notes. We treat that responsibility seriously. This Privacy Policy explains what we collect, why we collect it, how we use it, and the choices you have.',
      'The short version: we collect only what we need to run Bubaly for your family, we never sell your personal information, and every family\'s data is isolated from every other family\'s by row-level security in our database.',
    ],
  },
  {
    id: 'information-we-collect',
    heading: 'Information we collect',
    body: [
      'We collect information in three ways: information you give us, information created as you use Bubaly, and a small amount of technical information collected automatically.',
      'Information you provide:',
      [
        'Account details — your name, email address, and (if you choose) a profile photo and phone number.',
        'Family content — calendar events, to‑do and shopping lists, chores, meals and recipes, reminders, notes, messages, contacts, documents, photos, and the other items you add to organize your household.',
        'Family member profiles — names, roles (parent, adult, teen, child, caregiver, guest), and optional details like birthdays and colors. Profiles for children are created and managed by a parent or guardian.',
        'Payment information — if you subscribe to a paid plan, our payment processor (Stripe) handles your card details. We never see or store full card numbers.',
      ],
      'Information created through use: the records you create, your in‑app activity (such as completing a chore), and your notification and display preferences.',
      'Information collected automatically: basic device and log data (browser type, app version, IP address, and timestamps) used to keep Bubaly secure and reliable. We use privacy‑respecting analytics and do not run third‑party advertising trackers.',
    ],
  },
  {
    id: 'children',
    heading: 'Children\'s privacy',
    body: [
      'Bubaly is designed for families, and we know that means children\'s information lives in the app. Children do not create their own accounts. A parent or guardian creates and manages each child\'s profile and decides what is stored.',
      'We collect children\'s information only to provide the family‑organizer service the parent has asked for — for example, showing a child their chores or a family calendar event. We do not use children\'s information for advertising, and we do not sell it.',
      'A parent or guardian can review, edit, or delete a child\'s profile and associated data at any time from within the app, or by emailing support@bubaly.com. We comply with applicable children\'s privacy laws, including the U.S. Children\'s Online Privacy Protection Act (COPPA).',
    ],
  },
  {
    id: 'how-we-use',
    heading: 'How we use information',
    body: [
      'We use the information we collect to:',
      [
        'Provide and operate Bubaly — store your family\'s data and sync it across everyone\'s devices.',
        'Power features you ask for — such as the AI assistant creating an event, building a grocery list, or summarizing your week. The assistant only acts on your own family\'s data, scoped securely to your household.',
        'Send notifications and reminders you\'ve enabled — for chores, medications, calendar and school/sports events, and expiring documents.',
        'Keep Bubaly secure — detect and prevent fraud, abuse, and unauthorized access.',
        'Improve the product — understand which features help families most, fix bugs, and plan what to build next.',
        'Communicate with you — respond to support requests and send important service or billing notices.',
      ],
    ],
  },
  {
    id: 'ai',
    heading: 'How the AI assistant uses your data',
    body: [
      'When you use the AI assistant, the relevant parts of your family\'s data are sent to our AI provider to generate a response or take the action you requested. This processing happens only when you use an AI feature.',
      'We do not allow your family\'s content to be used to train third‑party foundation models. AI requests are grounded strictly in your own family\'s records — the assistant cannot see any other family\'s data.',
    ],
  },
  {
    id: 'sharing',
    heading: 'How information is shared',
    body: [
      'We do not sell your personal information. We share information only in these limited cases:',
      [
        'Within your family — content you add is visible to other members of your family according to their role and your settings.',
        'Service providers — trusted vendors who help us run Bubaly (cloud hosting, our database and authentication provider, email/push delivery, payment processing, and AI). They may only use the data to perform services for us.',
        'Legal reasons — when required by law, or to protect the rights, safety, and security of our users and the public.',
        'Business transfers — if Bubaly is involved in a merger or acquisition, your information may transfer as part of that transaction, subject to this policy.',
      ],
    ],
  },
  {
    id: 'security',
    heading: 'How we protect your information',
    body: [
      'Security is built into Bubaly\'s foundation:',
      [
        'Row‑level security — every database table enforces strict isolation, so one family can never access another family\'s data.',
        'Encryption — data is encrypted in transit (TLS) and at rest.',
        'Private documents — files are stored privately and served only through short‑lived signed URLs.',
        'Access controls — internal access to production data is limited and audited.',
      ],
      'No system is perfectly secure, but we work continuously to protect your family\'s information and to respond quickly to any issue.',
    ],
  },
  {
    id: 'your-rights',
    heading: 'Your rights and choices',
    body: [
      'You are in control of your family\'s data. You can:',
      [
        'Access and edit — view and update your information directly in the app.',
        'Export — request a copy of your family\'s data.',
        'Delete — delete individual items, a member\'s profile, or your entire account and family. Deleting your account removes your family\'s data from active systems.',
        'Manage notifications — change or turn off reminders and emails at any time.',
      ],
      'Depending on where you live, you may have additional rights under laws such as the GDPR or CCPA, including the right to object to or restrict certain processing. To exercise any right, email support@bubaly.com.',
    ],
  },
  {
    id: 'retention',
    heading: 'Data retention',
    body: [
      'We keep your information for as long as your account is active or as needed to provide Bubaly. When you delete content or your account, we remove it from active systems promptly and from backups within a reasonable period. We may retain limited information where required for legal, accounting, or security purposes.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to this policy',
    body: [
      'We may update this Privacy Policy as Bubaly evolves. When we make material changes, we\'ll update the date above and, where appropriate, notify you in the app or by email. Your continued use of Bubaly after an update means you accept the revised policy.',
    ],
  },
];

export default function PrivacyPage() {
  return (
    <>
      <LegalPage
        title="Privacy Policy"
        summary="What we collect, why, and the choices you have — written for families, in plain language."
        lastUpdated="June 24, 2026"
        path="/privacy"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
