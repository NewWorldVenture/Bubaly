'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced to the browser console and any attached logging service.
    console.error('[FamilyOS] route error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        We hit an unexpected error. Your data is safe — try again, and if it keeps happening let us
        know.
      </p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
