'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonLink } from '@/components/ui/button-link';
import { useTranslations } from '@/components/i18n/locale-provider';
import { reloadOnceForChunkFailure } from '@/lib/utils/stale-bundle-reload';

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
    // A chunk that failed to load fails again on reset(); a reload fetches it.
    reloadOnceForChunkFailure(error);
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold">{t('root.somethingWentWrong')}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">{t('error.weHitAnUnexpectedError')}</p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button onClick={reset}>{t('root.tryAgain')}</Button>
        <ButtonLink href="/dashboard" variant="outline">{t('root.goToDashboard')}</ButtonLink>
      </div>
      {error.digest && (
        <p className="mt-4 text-xs text-muted">
          Reference: <code className="rounded bg-elevated px-1.5 py-0.5">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
