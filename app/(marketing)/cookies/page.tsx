import type { Metadata } from 'next';
import { LegalPage, type LegalSection } from '@/components/marketing/legal';
import { CTASection } from '@/components/marketing/cta';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/cookies', {
  title: 'Cookie Policy',
  description: 'How Bubaly uses cookies and similar technologies, and the choices you have.',
  });
}

const SECTIONS: LegalSection[] = [
  {
    id: 'what',
    heading: 'What cookies are',
    body: [
      'Cookies are small text files stored on your device when you visit a website or use an app. Similar technologies — like local storage — work in comparable ways. Together they help Bubaly remember you, keep you signed in, and run reliably.',
    ],
  },
  {
    id: 'how-we-use',
    heading: 'How Bubaly uses them',
    body: [
      'We keep our use of cookies minimal and purpose‑driven:',
      [
        'Essential — sign you in, keep your session secure, and remember your active family. Bubaly will not work without these.',
        'Preferences — remember choices such as light or dark theme and notification settings.',
        'Analytics — understand, in aggregate, how families use Bubaly so we can improve it. We use privacy‑respecting analytics and do not build advertising profiles.',
      ],
      'We do not use cookies for third‑party advertising, and we do not sell information collected through cookies.',
    ],
  },
  {
    id: 'managing',
    heading: 'Managing cookies',
    body: [
      'You can control cookies through your browser or device settings — including blocking or deleting them. Please note that blocking essential cookies will prevent you from staying signed in to Bubaly.',
      'Because we don\'t use advertising trackers, there\'s nothing extra you need to opt out of for ad targeting.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to this policy',
    body: [
      'If we change how we use cookies, we\'ll update this page and the date above. For more on how we handle your information, see our Privacy Policy.',
    ],
  },
];

export default function CookiesPage() {
  return (
    <>
      <LegalPage
        title="Cookie Policy"
        summary="The small files that keep you signed in and Bubaly running — and how to control them."
        lastUpdated="June 24, 2026"
        path="/cookies"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
