'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, UserMinus } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { adminRemoveMemberAction } from '@/app/(app)/admin/actions';

export function MemberRowActions({ memberId }: { memberId: string }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function removeFromFamily() {
    if (!confirm('Remove this person from the family? This is reversible — they can be re-invited.')) return;
    setBusy(true);
    const res = await adminRemoveMemberAction(memberId);
    setBusy(false);
    setOpen(false);
    if (!res.ok) return toastError(res.error);
    success('Removed from family');
    router.refresh();
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-muted hover:bg-elevated" aria-label="Row actions">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl glass-card p-1 shadow-glass animate-fade-in">
            <button onClick={removeFromFamily} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-elevated disabled:opacity-50">
              <UserMinus className="h-4 w-4" /> Remove from family
            </button>
          </div>
        </>
      )}
    </div>
  );
}
