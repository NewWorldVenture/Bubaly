'use client';

// ♥ Save toggle for a listing — optimistic, family-scoped via the server action.

import { useState, useTransition } from 'react';
import { Heart } from 'lucide-react';
import { toggleSaveAction } from '@/app/(app)/marketplace/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

export function SaveButton({ listingId, saved: initial, className }: { listingId: string; saved: boolean; className?: string }) {
  const [saved, setSaved] = useState(initial);
  const [pending, startTransition] = useTransition();
  const { error: toastError } = useToast();

  const toggle = () => {
    if (pending) return;
    const next = !saved;
    setSaved(next);
    startTransition(async () => {
      const res = await toggleSaveAction(listingId);
      if (!res.ok) { setSaved(!next); toastError(res.error); }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-label={saved ? 'Remove from saved' : 'Save this listing'}
      aria-pressed={saved}
      aria-busy={pending}
      className={cn(
        'disabled:opacity-60',
        'inline-flex h-7 w-7 items-center justify-center rounded-full border transition',
        saved ? 'border-rose-500/40 bg-rose-500/15 text-rose-500' : 'border-border bg-surface/70 text-muted hover:text-rose-500',
        className,
      )}
    >
      <Heart className={cn('h-3.5 w-3.5', saved && 'fill-current')} />
    </button>
  );
}
