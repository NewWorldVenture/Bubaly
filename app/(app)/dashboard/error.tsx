'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Bubaly] dashboard error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
        <AlertTriangle className="h-7 w-7" />
      </div>
      <h1 className="mt-4 text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        We hit an unexpected error loading this page. Your data is safe.
      </p>
      <div className="mt-6 flex gap-3">
        <Button variant="outline" onClick={() => window.history.back()}>
          Go back
        </Button>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
