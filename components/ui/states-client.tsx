'use client';

// The half of the shared state primitives that has WORDS IN IT.
//
// `states.tsx` is imported by 285 files, some server and some client, so it can
// use neither translator: `getTranslations()` pulls `next/headers` into the
// browser bundle and `useTranslations()` is a hook a server component cannot
// run. The first fix here was a `label` prop with an English default, which is
// honest but leaves a French family reading "Loading" and "Try again".
//
// So the split is by PROP SHAPE, which is the thing that actually decides it.
// Everything here takes only strings, numbers and callbacks — values that cross
// a server→client boundary, or that only a client component could have supplied
// in the first place. `EmptyState` stays behind in `states.tsx` because it takes
// an `icon` COMPONENT, and a component reference cannot cross that boundary at
// all.
import { Loader2 } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { cn } from '@/lib/utils/cn';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-muted', className)} />;
}

export function LoadingBlock({ label }: { label?: string }) {
  const t = useTranslations();
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner />
      {label ?? t('states.loadingEllipsis')}
    </div>
  );
}

/**
 * Skeleton primitive — a shimmering placeholder block. Prefer these over a bare
 * spinner for content areas: matching the eventual layout makes load feel faster
 * and avoids layout shift. Respects reduced-motion (the pulse is a CSS animation
 * Tailwind disables under `motion-reduce`).
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-lg bg-elevated/70 motion-reduce:animate-none', className)} />;
}

/** A few stacked text-line skeletons. */
export function SkeletonText({ lines = 3, className, label }: { lines?: number; className?: string; label?: string }) {
  const t = useTranslations();
  return (
    <div className={cn('space-y-2', className)} role="status" aria-label={label ?? t('states.loading')}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/** A card-shaped skeleton (icon + title + lines), matching the app's card rhythm. */
export function SkeletonCard({ className, label }: { className?: string; label?: string }) {
  const t = useTranslations();
  return (
    <div className={cn('rounded-2xl border border-border bg-surface/40 p-4', className)} role="status" aria-label={label ?? t('states.loading')}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    </div>
  );
}

/** A list of card skeletons for list/grid screens while data loads. */
export function SkeletonList({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {Array.from({ length: count }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTranslations();
  return (
    <div className="rounded-2xl border border-danger/30 bg-danger/5 px-5 py-6 text-center">
      <p className="text-sm text-danger">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-3 text-sm font-medium underline">{t('states.tryAgain')}</button>
      )}
    </div>
  );
}
