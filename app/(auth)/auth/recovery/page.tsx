import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { Suspense } from 'react';
import { RecoveryForm } from '@/components/auth/recovery-form';
import { LoadingBlock } from '@/components/ui/states';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.passwordRecovery'), robots: { index: false, follow: false } };
}

export default function RecoveryPage() {
  return <Suspense fallback={<LoadingBlock />}><RecoveryForm /></Suspense>;
}
