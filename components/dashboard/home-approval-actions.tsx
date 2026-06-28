'use client';

// One-tap Approve / Decline for a pending money approval, rendered inline on the
// Home "Needs you" card. Reuses the same authorized, RLS-guarded wallet server
// actions the Wallet screen uses — so a parent resolves a request in a single
// tap instead of navigating Wallet → Cards → find it → approve.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Loader2 } from 'lucide-react';
import { decideSpendRequestAction, decideAllowanceRequestAction } from '@/app/(app)/wallet/actions';
import { useToast } from '@/components/ui/toast';

export function HomeApprovalActions({ approvalId, kind }: { approvalId: string; kind: string }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<null | 'approved' | 'rejected'>(null);
  const [done, setDone] = useState(false);

  async function decide(decision: 'approved' | 'rejected') {
    if (busy || done) return;
    setBusy(decision);
    try {
      const res = kind === 'allowance_request'
        ? await decideAllowanceRequestAction({ approvalId, decision })
        : await decideSpendRequestAction({ approvalId, decision });
      if (!res.ok) { toastError(res.error ?? 'Could not update that approval.'); return; }
      setDone(true);
      success(decision === 'approved' ? 'Approved ✓' : 'Declined');
      router.refresh();
    } catch {
      toastError('Could not update that approval.');
    } finally {
      setBusy(null);
    }
  }

  if (done) return <span className="shrink-0 text-xs font-semibold text-muted">Done</span>;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button onClick={() => decide('approved')} disabled={busy !== null} aria-label="Approve"
        className="grid h-8 w-8 place-items-center rounded-lg bg-success/15 text-success transition hover:bg-success/25 disabled:opacity-50">
        {busy === 'approved' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      </button>
      <button onClick={() => decide('rejected')} disabled={busy !== null} aria-label="Decline"
        className="grid h-8 w-8 place-items-center rounded-lg bg-danger/10 text-danger transition hover:bg-danger/20 disabled:opacity-50">
        {busy === 'rejected' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
      </button>
    </div>
  );
}
