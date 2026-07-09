'use client';

// Order lifecycle controls + the two-sided review form. The server action
// enforces the legal transitions; this just offers the right next steps.

import { useState, useTransition } from 'react';
import { Star, Check, X } from 'lucide-react';
import { setOrderStatusAction, leaveReviewAction } from '@/app/(app)/marketplace/actions';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';

const NEXT_STEPS: Record<string, { status: string; label: string; tone: 'go' | 'stop' }[]> = {
  requested: [{ status: 'confirmed', label: 'Confirm', tone: 'go' }, { status: 'cancelled', label: 'Cancel', tone: 'stop' }],
  confirmed: [{ status: 'active', label: 'Start', tone: 'go' }, { status: 'cancelled', label: 'Cancel', tone: 'stop' }],
  active: [{ status: 'returned', label: 'Mark returned', tone: 'go' }, { status: 'completed', label: 'Complete', tone: 'go' }],
  returned: [{ status: 'completed', label: 'Complete', tone: 'go' }],
};

export function OrderControls({ orderId, status }: { orderId: string; status: string }) {
  const [pending, startTransition] = useTransition();
  const { success, error: toastError } = useToast();
  const steps = NEXT_STEPS[status] ?? [];
  if (steps.length === 0) return null;

  const advance = (next: string, label: string) => {
    startTransition(async () => {
      const res = await setOrderStatusAction(orderId, next);
      if (res.ok) success(`${label} ✓`);
      else toastError(res.error);
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      {steps.map((s) => (
        <button
          key={s.status}
          type="button"
          disabled={pending}
          onClick={() => advance(s.status, s.label)}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition disabled:opacity-50',
            s.tone === 'go'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400'
              : 'border-border text-muted hover:bg-elevated',
          )}
        >
          {s.tone === 'go' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {s.label}
        </button>
      ))}
    </div>
  );
}

export function ReviewForm({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const { success, error: toastError } = useToast();

  if (done) return <p className="text-xs text-emerald-600 dark:text-emerald-400">Review sent — thanks!</p>;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-lg border border-brand/40 bg-brand/10 px-2 py-1 text-xs font-medium text-brand hover:bg-brand/20"
      >
        <Star className="h-3 w-3" /> Leave a review
      </button>
    );
  }

  const submit = () => {
    startTransition(async () => {
      const res = await leaveReviewAction({ orderId, rating, comment });
      if (res.ok) { setDone(true); success('Review posted'); }
      else toastError(res.error);
    });
  };

  return (
    <div className="w-full space-y-2 rounded-xl border border-border bg-surface/60 p-3">
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            onClick={() => setRating(n)}
            className={cn('rounded p-0.5', n <= rating ? 'text-amber-500' : 'text-muted')}
          >
            <Star className={cn('h-4 w-4', n <= rating && 'fill-current')} />
          </button>
        ))}
      </div>
      <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="How did it go?" />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>Post review</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
