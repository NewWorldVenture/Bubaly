import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { Suspense } from 'react';
import { Logo } from '@/components/brand/logo';
import { JoinInvite } from '@/components/auth/join-invite';
import { LoadingBlock } from '@/components/ui/states';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.joinAFamily'), robots: { index: false } };
}

export default function JoinPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-8">
      <div className="mb-8"><Logo /></div>
      <div className="w-full max-w-md">
        <Suspense fallback={<div className="glass-card p-8"><LoadingBlock /></div>}>
          <JoinInvite />
        </Suspense>
      </div>
    </div>
  );
}
