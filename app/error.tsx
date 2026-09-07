'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();
  useEffect(() => {
    // Surfaced to the browser console and any attached logging service.
    console.error('[Bubaly] route error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold">{t('root.somethingWentWrong')}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        We hit an unexpected error. Your data is safe — try again, and if it keeps happening you have
        a couple of ways forward below.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button onClick={reset}>{t('root.tryAgain')}</Button>
        <Link href="/dashboard"><Button variant="outline">{t('root.goToDashboard')}</Button></Link>
      </div>
      {error.digest && (
        <p className="mt-4 text-xs text-muted">
          Reference: <code className="rounded bg-elevated px-1.5 py-0.5">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
