import type { Metadata } from 'next';
import { KidLoginForm } from '@/components/auth/kid-login-form';

// noindex/nofollow, matching `/login` and `/signup`. This page was the only
// sign-in form in the tree that was neither in robots.txt's DISALLOWED_PREFIXES
// nor marked noindex, so a CHILDREN'S sign-in form was the one crawlable and
// indexable login surface the product has. `/auth/*` is covered by the prefix
// list and `/login` and `/signup` declare it here; this one simply inherited
// the default. Audit C1-S9-15.
export const metadata: Metadata = { title: 'Kid sign in', robots: { index: false, follow: false } };

export default function KidLoginPage() {
  return <KidLoginForm />;
}
