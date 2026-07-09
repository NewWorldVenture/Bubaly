'use client';

// The primary call-to-action on a listing detail page — express interest (sell/
// rent) or claim (borrow/free/etc.). Family-scoped via the server action.

import { useState, useTransition } from 'react';
import { HandHeart, Check } from 'lucide-react';
import { makeOfferAction } from '@/app/(app)/marketplace/actions';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';

export function InterestButton({
  listingId, label, sentLabel, alreadySent = false,
}: {
  listingId: string;
  label: string;
  sentLabel: string;
  alreadySent?: boolean;
}) {
  const [sent, setSent] = useState(alreadySent);
  const [pending, startTransition] = useTransition();
  const { success, error: toastError } = useToast();

  if (sent) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="h-4 w-4" /> {sentLabel}
      </span>
    );
  }

  return (
    <Button
      className="gap-1.5"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await makeOfferAction(listingId);
          if (res.ok) { setSent(true); success(sentLabel); }
          else toastError(res.error);
        })
      }
    >
      <HandHeart className="h-4 w-4" /> {pending ? 'Sending…' : label}
    </Button>
  );
}
