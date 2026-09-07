'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

// Error boundary for the authenticated app. Because it lives inside the (app)
// route group it renders within the app shell (sidebar/nav stay put), so a
// single page error degrades to a friendly inline card instead of throwing the
// user out to a bare full-screen error.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();
  useEffect(() => {
    console.error('[Bubaly] app route error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
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
