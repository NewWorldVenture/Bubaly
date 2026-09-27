import type { Metadata } from 'next';
import { KidLoginForm } from '@/components/auth/kid-login-form';
import { getTranslations } from '@/lib/i18n/server';

// noindex/nofollow, matching `/login` and `/signup`. This page was the only
// sign-in form in the tree that was neither in robots.txt's DISALLOWED_PREFIXES
// nor marked noindex, so a CHILDREN'S sign-in form was the one crawlable and
// indexable login surface the product has. `/auth/*` is covered by the prefix
// list and `/login` and `/signup` declare it here; this one simply inherited
// the default. Audit C1-S9-15.
// The tab title is copy like any other: it was English in every locale.
// Audit C1-S9-100.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('kidLogin.kidSignIn'), robots: { index: false, follow: false } };
}

export default function KidLoginPage() {
  return <KidLoginForm />;
}
