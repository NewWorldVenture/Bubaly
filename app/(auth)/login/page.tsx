import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { Suspense } from 'react';
import { LoginForm } from '@/components/auth/login-form';
import { LoadingBlock } from '@/components/ui/states';

// The tab title is copy like any other: it was English in every locale.
// Audit C1-S9-100.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.logIn'), robots: { index: false, follow: false } };
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LoginForm />
    </Suspense>
  );
}
