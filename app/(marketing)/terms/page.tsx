import type { Metadata } from 'next';
import { LegalPage, type LegalSection } from '@/components/marketing/legal';
import { CTASection } from '@/components/marketing/cta';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern your use of Bubaly, the family organizer.',
};

const SECTIONS: LegalSection[] = [
  {
    id: 'acceptance',
    heading: 'Acceptance of these terms',
    body: [
      'These Terms of Service ("Terms") are an agreement between you and Bubaly ("we," "us," or "our") that governs your use of the Bubaly apps, websites, and services (together, the "Service"). By creating an account or using the Service, you agree to these Terms and to our Privacy Policy.',
      'If you are agreeing on behalf of your family, you confirm you are an adult with authority to accept these Terms for your household.',
    ],
  },
  {
    id: 'accounts',
    heading: 'Your account and family',
    body: [
      'You need an account to use Bubaly. You are responsible for keeping your login credentials secure and for the activity that happens under your account.',
      'As the person who creates a family, you act as its administrator. You may add family members, including managed profiles for children who do not have their own login. You are responsible for obtaining any necessary consent from the adults you invite and for managing children\'s profiles appropriately.',
      'You must be old enough to form a binding contract to hold an account. Children participate only through profiles created and managed by a parent or guardian.',
    ],
  },
  {
    id: 'acceptable-use',
    heading: 'Acceptable use',
    body: [
      'Bubaly is for organizing your household. You agree not to:',
      [
        'Use the Service for anything unlawful, harmful, or abusive.',
        'Upload content that infringes others\' rights or that is illegal to possess or share.',
        'Attempt to access another family\'s data or to break, probe, or overload the Service.',
        'Reverse engineer, resell, or misuse the Service or its AI features.',
        'Use the Service to send spam or to harass others.',
      ],
      'Our full expectations are described in the Acceptable Use Policy, which is incorporated into these Terms.',
    ],
  },
  {
    id: 'your-content',
    heading: 'Your content',
    body: [
      'Everything you add to Bubaly — events, lists, notes, photos, documents, and more — is your content. You keep ownership of it.',
      'You grant us a limited license to host, store, process, and display your content solely to operate and improve the Service for you and your family — including processing it through the AI assistant when you use that feature. We do not claim ownership of your content and we do not sell it.',
      'You are responsible for your content and for having the rights to share it with your family through Bubaly.',
    ],
  },
  {
    id: 'ai',
    heading: 'AI features',
    body: [
      'Bubaly includes an AI assistant that can answer questions and take actions on your family\'s data, such as adding events or building lists. AI output can be wrong or incomplete — please review important results before relying on them. The assistant is a helpful tool, not a substitute for professional advice (medical, legal, financial, or otherwise).',
    ],
  },
  {
    id: 'plans',
    heading: 'Plans, billing, and trials',
    body: [
      'Bubaly offers a free plan and paid plans. Paid plans are billed in advance on a recurring basis (monthly or annually) through our payment processor. Trials, if offered, convert to a paid plan unless you cancel before the trial ends.',
      'You can change or cancel your plan at any time in the app. Cancellation takes effect at the end of your current billing period, and you keep paid features until then. Except where required by law, payments are non‑refundable.',
    ],
  },
  {
    id: 'termination',
    heading: 'Termination',
    body: [
      'You may stop using Bubaly and delete your account at any time. We may suspend or terminate access if you violate these Terms or use the Service in a way that risks harm to others or to the Service.',
      'When an account is deleted, we remove the associated family data from active systems as described in our Privacy Policy.',
    ],
  },
  {
    id: 'disclaimers',
    heading: 'Disclaimers and limitation of liability',
    body: [
      'The Service is provided "as is" without warranties of any kind, to the fullest extent permitted by law. We do not guarantee the Service will be uninterrupted, error‑free, or that AI output will be accurate.',
      'To the maximum extent permitted by law, Bubaly will not be liable for indirect, incidental, or consequential damages, and our total liability for any claim relating to the Service is limited to the amount you paid us in the twelve months before the claim.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to these terms',
    body: [
      'We may update these Terms as Bubaly grows. When changes are material, we\'ll update the date above and notify you where appropriate. Continuing to use the Service after an update means you accept the revised Terms.',
    ],
  },
  {
    id: 'contact',
    heading: 'Contact us',
    body: [
      'Questions about these Terms? Email support@bubaly.com. These Terms are governed by the laws of the jurisdiction in which Bubaly operates, without regard to conflict‑of‑laws rules.',
    ],
  },
];

export default function TermsPage() {
  return (
    <>
      <LegalPage
        title="Terms of Service"
        summary="The agreement that governs your use of Bubaly. Plain language, no surprises."
        lastUpdated="June 24, 2026"
        path="/terms"
        sections={SECTIONS}
      />
      <CTASection />
    </>
  );
}
