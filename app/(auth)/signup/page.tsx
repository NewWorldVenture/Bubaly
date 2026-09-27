import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { Suspense } from 'react';
import { SignupForm } from '@/components/auth/signup-form';
import { LoadingBlock } from '@/components/ui/states';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.signUp'), robots: { index: false, follow: false } };
}

export default function SignupPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SignupForm />
    </Suspense>
  );
}
