'use client';

// Danger-zone control for a parent to close the family account. Soft close —
// nothing is deleted; the account locks and can be reopened anytime. Reachable
// from the billing/finances manager; the paywall + closed overlays also expose
// close/reopen for locked accounts.
import { useState } from 'react';
import { Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { closeAccountAction } from '@/app/(app)/account/actions';

export function CloseAccountCard() {
  const [busy, setBusy] = useState(false);
  const { error: toastError, success } = useToast();

  async function close() {
    if (busy) return;
    if (!window.confirm('Close your account? Nothing is deleted — you can reopen anytime and everything will be exactly where you left it.')) return;
    setBusy(true);
    const res = await closeAccountAction();
    setBusy(false);
    if (res.ok) { success('Your account is closed. Your data is safe.'); window.location.reload(); }
    else toastError(res.error);
  }

  return (
    <section className="mt-6 rounded-2xl border border-danger/30 bg-danger/[0.04] p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger">
          <Archive className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-fg">Close account</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Take a break anytime. Closing locks your account but <strong>keeps all your data</strong> — reopen
            whenever you like and pick up right where you left off. Only a parent can close the account.
          </p>
          <Button variant="outline" size="sm" onClick={close} disabled={busy} aria-busy={busy}
            className="mt-3 border-danger/40 text-danger hover:bg-danger/10">
            {busy ? 'Closing…' : 'Close my account'}
          </Button>
        </div>
      </div>
    </section>
  );
}
