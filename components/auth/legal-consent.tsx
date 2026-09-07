'use client';

import Link from 'next/link';
import { Fragment } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';

/**
 * The "By continuing, you agree to…" line shown under the auth options, with
 * links to the real legal pages.
 *
 * A CLIENT component, and it has to be: both callers — `login-form` and
 * `signup-form` — are client components, so `getTranslations()` here dragged
 * `next/headers` into the browser bundle and failed the build. It takes only a
 * `className`, so the boundary costs nothing.
 *
 * ONE key with three placeholders, not five slots around three links. Slots
 * were the first attempt and they cannot work: the fragment between two links
 * is ", and acknowledge our" in English — flush against the link, no leading
 * space — and "et reconnaissez notre" in French, which needs one. A leading
 * space inside a catalogue value is invisible in review and trimmed by half the
 * tooling that touches it. A placeholder string lets each language put the
 * links, the commas and the possessive wherever its grammar wants them.
 */
const LINK_CLASS = 'font-medium text-fg underline decoration-border underline-offset-2 hover:decoration-fg';

const LINKS: Record<string, { href: string; key: string }> = {
  terms: { href: '/terms', key: 'legalConsent.termsOfService' },
  acceptableUse: { href: '/acceptable-use', key: 'legalConsent.acceptableUsePolicy' },
  privacy: { href: '/privacy', key: 'legalConsent.privacyPolicy' },
};

export function LegalConsent({ className }: { className?: string }) {
  const t = useTranslations();
  // Split on the placeholders themselves, so a translation that drops one
  // renders the rest of its sentence rather than throwing, and a translation
  // that reorders them is rendered in ITS order, not English's.
  const parts = t('legalConsent.sentence').split(/(\{terms\}|\{acceptableUse\}|\{privacy\})/g);

  return (
    <p className={className ?? 'mt-6 text-center text-xs leading-5 text-muted'}>
      {parts.map((part, i) => {
        const link = LINKS[part.slice(1, -1)];
        if (!link) return <Fragment key={i}>{part}</Fragment>;
        return (
          <Link key={i} href={link.href} className={LINK_CLASS}>{t(link.key)}</Link>
        );
      })}
    </p>
  );
}
