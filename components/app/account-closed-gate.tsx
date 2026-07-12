'use client';

// Shown over the whole app when the family's account is soft-closed. Nothing was
// deleted — reopening restores everything. Parent-only reopen; anyone can log out.
import { useState } from 'react';
import { Archive, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { reopenAccountAction } from '@/app/(app)/account/actions';

export function AccountClosedGate() {
  const [busy, setBusy] = useState(false);
  const { error: toastError, success } = useToast();

  async function reopen() {
    if (busy) return;
    setBusy(true);
    const res = await reopenAccountAction();
    setBusy(false);
    if (res.ok) { success('Welcome back! Your account is open again.'); window.location.reload(); }
    else toastError(res.error);
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="closed-title"
      className="fixed inset-0 z-[200] grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-surface p-6 text-center shadow-2xl sm:p-8">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-elevated text-muted ring-1 ring-border">
          <Archive className="h-6 w-6" />
        </div>
        <h1 id="closed-title" className="mt-4 text-2xl font-black text-fg">Your account is closed</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          Everything is safe — we haven’t deleted a thing. Reopen anytime to pick up right where you left off.
        </p>
        <Button onClick={reopen} disabled={busy} aria-busy={busy} className="mt-6 w-full gap-1.5">
          <RotateCcw className="h-4 w-4" /> {busy ? 'Reopening…' : 'Reopen my account'}
        </Button>
        <a href="/auth/signout" className="mt-4 inline-block text-sm text-muted hover:text-fg">Log out</a>
      </div>
    </div>
  );
}
