import type { Metadata } from 'next';
import Link from 'next/link';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { Mail, MessageCircle, Shield, Gift, Sparkles } from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { ContactForm } from '@/components/marketing/contact-form';
import { getUser } from '@/lib/supabase/auth';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/contact', {
    title: 'Contact',
    description: 'Get in touch with the Bubaly team. We’d love to hear from your family.',
  });
}

export default async function ContactPage() {
  const t = await getTranslations();
  const user = await getUser().catch(() => null);
  const loggedIn = !!user;

  return (
    <>
    <Section className="pt-20">
      <SectionHeading eyebrow="Contact" title={t('contact.wedLoveToHearFromYou')} description={t('contact.questionsFeedbackOrJustSaying')} />
      <div className="mx-auto mt-12 grid max-w-4xl gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          {[
            { icon: Mail, title: 'Email us', body: 'support@bubaly.com — we reply within one business day.' },
            { icon: MessageCircle, title: 'Support', body: 'Logged in? Use the in-app assistant or settings to reach support.' },
            { icon: Shield, title: 'Privacy', body: 'Your message is sent securely and never shared.' },
          ].map((i) => (
            <div key={i.title} className="flex gap-4">
              <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
                <i.icon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">{i.title}</h3>
                <p className="mt-1 text-sm text-muted">{i.body}</p>
              </div>
            </div>
          ))}

          {/* Feedback is a gift 🎁 — warm CTA to submit enhancement requests.
              The gift icon appears once you're logged in. */}
          <div className="mt-2 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 via-brand/5 to-transparent p-6">
            <div className="flex items-center gap-3">
              <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-text">
                {loggedIn ? <Gift className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
              </div>
              <h3 className="text-lg font-bold">{t('contact.feedbackIsAGift')}{loggedIn ? ' 🎁' : ''}</h3>
            </div>

            {loggedIn ? (
              <>
                <p className="mt-3 text-sm leading-6 text-muted">{t('contact.youReInSoUnwrapping')}{' '}<span className="font-semibold text-fg">{t('contact.everySingleOne')}</span>.
                </p>
                <Link
                  href="/feedback"
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:bg-brand/90"
                >
                  <Gift className="h-4 w-4" /> {t('contact.shareAnIdeaOrRequest')}
                </Link>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm leading-6 text-muted">{t('contact.bigIdeaTinyNitpickOr')}</p>
                {/* Same primary CTA as the logged-in state, but gated: logged-out
                    visitors are sent to log in first and returned to /feedback
                    afterwards (login-form honours ?redirect=). */}
                <Link
                  href="/login?redirect=%2Ffeedback"
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg transition hover:bg-brand/90"
                >
                  <Gift className="h-4 w-4" /> {t('contact.shareAnIdeaOrRequest')}
                </Link>
                <p className="mt-2 text-xs text-muted">{t('contact.youllSignInFirstThenLand')}</p>
              </>
            )}
          </div>
        </div>
        <ContactForm />
      </div>
    </Section>
    <MarketingAeoSection path="/contact" name={t('contact.contactBubaly')} description={t('contact.getInTouchWithThe')} />
    </>
  );
}
