'use client';

// Follow / Following toggle for a creator store — optimistic.

import { useState, useTransition } from 'react';
import { toggleFollowAction } from '@/app/(app)/marketplace/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

export function FollowButton({ storeId, following: initial, className }: { storeId: string; following: boolean; className?: string }) {
  const [following, setFollowing] = useState(initial);
  const [pending, startTransition] = useTransition();
  const { error: toastError } = useToast();

  const toggle = () => {
    if (pending) return;
    const next = !following;
    setFollowing(next);
    startTransition(async () => {
      const res = await toggleFollowAction(storeId);
      if (!res.ok) { setFollowing(!next); toastError(res.error); }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={following}
      aria-busy={pending}
      className={cn(
        'rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-60',
        following ? 'border-border bg-elevated text-muted' : 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/20',
        className,
      )}
    >
      {following ? 'Following' : 'Follow'}
    </button>
  );
}
