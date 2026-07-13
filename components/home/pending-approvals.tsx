'use client';

// Chief-of-Staff front door — the "Waiting on you" list with ONE-TAP decisions.
// Approve / Decline act right here on Home (no trip to the inbox) via the
// canonical decideApprovalAction (multi-approver aware, audit-logged, and the
// approved payload auto-executes). Optimistic: a decided row leaves the list
// immediately; router.refresh() re-syncs the counts. Kids/guests see the list
// read-only (canDecide=false) — the server action re-enforces manager-only too.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, ChevronRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useToast } from '@/components/ui/toast';
import { decideApprovalAction } from '@/app/(app)/dashboard/trust/actions';
import type { FrontDoorPending } from '@/lib/home/front-door';

export function PendingApprovals({
  items, totalCount, canDecide,
}: {
  items: FrontDoorPending[];
  totalCount: number;
  canDecide: boolean;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [rows, setRows] = useState(items);
  const [decided, setDecided] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const remaining = Math.max(totalCount - decided, rows.length);

  const decide = (id: string, decision: 'approved' | 'rejected') => {
    if (busyId) return;
    setBusyId(id);
    startTransition(async () => {
      const res = await decideApprovalAction({ id, decision });
      setBusyId(null);
      if (!res.ok) { toastError(res.error ?? 'Could not record your decision.'); return; }
      setRows((r) => r.filter((p) => p.id !== id));
      setDecided((d) => d + 1);
      success(decision === 'approved' ? 'Approved — on it.' : 'Declined.');
      router.refresh();
    });
  };

  if (rows.length === 0) {
    return <p className="text-sm text-muted">All caught up — every request is decided. ✅</p>;
  }

  return (
    <>
      <ul className="space-y-1.5">
        {rows.slice(0, 3).map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-fg">
              {p.title}
              {p.agent && <span className="ml-1 text-xs text-muted">· {p.agent}</span>}
            </span>
            {canDecide && (
              <span className="flex shrink-0 items-center gap-1">
                {busyId === p.id ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted" />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => decide(p.id, 'approved')}
                      disabled={busyId !== null}
                      aria-label={`Approve: ${p.title}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-500 transition hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => decide(p.id, 'rejected')}
                      disabled={busyId !== null}
                      aria-label={`Decline: ${p.title}`}
                      className="inline-flex items-center rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs font-semibold text-muted transition hover:text-fg disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <Link href="/dashboard/inbox" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-text hover:underline">
        Review all{remaining > 3 ? ` (+${remaining - 3} more)` : ''} <ChevronRight className="h-3 w-3" />
      </Link>
    </>
  );
}
