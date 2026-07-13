'use client';

import { useState } from 'react';
import { Send, Ban } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { adminResendInviteAction, adminRevokeInviteAction } from '@/app/(app)/admin/actions';

export function InviteRowActions({ inviteId }: { inviteId: string }) {
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<'resend' | 'revoke' | null>(null);

  async function resend() {
    setBusy('resend');
    const res = await adminResendInviteAction(inviteId);
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success('Invite re-sent');
  }

  async function revoke() {
    if (!confirm('Revoke this invite? The link will stop working.')) return;
    setBusy('revoke');
    const res = await adminRevokeInviteAction(inviteId);
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success('Invite revoked');
  }

  return (
    <div className="flex items-center gap-1">
      <button onClick={resend} disabled={busy !== null} className="rounded-lg p-1.5 text-muted hover:text-brand-text disabled:opacity-50" aria-label="Resend invite" title="Resend">
        <Send className="h-4 w-4" />
      </button>
      <button onClick={revoke} disabled={busy !== null} className="rounded-lg p-1.5 text-muted hover:text-danger disabled:opacity-50" aria-label="Revoke invite" title="Revoke">
        <Ban className="h-4 w-4" />
      </button>
    </div>
  );
}
