'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

/**
 * Error boundary for one authenticated SECTION, mounted inside that section's
 * AppFrame layout.
 *
 * Without it the nearest boundary is `app/(app)/error.tsx`, which sits ABOVE
 * every `AppFrame` layout — so React unmounts the layout too and one failing
 * page takes the sidebar, top bar, and mobile nav down with it, stranding the
 * user on a bare card with nothing to navigate to. Re-exported as the `default`
 * from each section's `error.tsx` so the shell stays put and the failure
 * degrades to an inline card the user can retry or navigate away from.
 */
export function SectionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();
  useEffect(() => {
    console.error('[Bubaly] section error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-5 grid h-14 w-14 place-items-center rounded-full bg-amber-500/10">
        <AlertTriangle className="h-7 w-7 text-amber-500" />
      </div>
      <h1 className="text-xl font-semibold">{t('root.thisPageHitASnag')}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        {t('root.somethingWentWrongLoadingThisSection')}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset}>
          <RotateCw className="h-4 w-4" /> {t('root.tryAgain')}
        </Button>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-semibold transition hover:bg-elevated"
        >
          <Home className="h-4 w-4" /> {t('root.goHome')}
        </Link>
      </div>
      {error.digest && (
        <p className="mt-4 text-[11px] text-muted">Reference: {error.digest}</p>
      )}
    </div>
  );
}
