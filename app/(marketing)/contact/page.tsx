import type { Metadata } from 'next';
import { Mail, MessageCircle, Shield } from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { ContactForm } from '@/components/marketing/contact-form';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with the Bubaly team. We’d love to hear from your family.',
};

export default function ContactPage() {
  return (
    <Section className="pt-20">
      <SectionHeading eyebrow="Contact" title="We’d love to hear from you" description="Questions, feedback, or just saying hi — send us a note." />
      <div className="mx-auto mt-12 grid max-w-4xl gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          {[
            { icon: Mail, title: 'Email us', body: 'support@bubaly.com — we reply within one business day.' },
            { icon: MessageCircle, title: 'Support', body: 'Logged in? Use the in-app assistant or settings to reach support.' },
            { icon: Shield, title: 'Privacy', body: 'Your message is sent securely and never shared.' },
          ].map((i) => (
            <div key={i.title} className="flex gap-4">
              <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                <i.icon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">{i.title}</h3>
                <p className="mt-1 text-sm text-muted">{i.body}</p>
              </div>
            </div>
          ))}
        </div>
        <ContactForm />
      </div>
    </Section>
  );
}
