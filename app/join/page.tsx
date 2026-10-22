import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { Suspense } from 'react';
import { Logo } from '@/components/brand/logo';
import { JoinInvite } from '@/components/auth/join-invite';
import { LoadingBlock } from '@/components/ui/states';

// The tab title is copy like any other: it was English in every locale.
// Audit C1-S9-100.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  // The invite token is in this page's URL; a link followed from here must not
  // carry it to another site in its Referer header.
  return { title: t('pageTitle.joinAFamily'), robots: { index: false }, referrer: 'no-referrer' };
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
