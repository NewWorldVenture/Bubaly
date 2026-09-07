'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Ban, ShieldCheck, KeyRound } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { adminSetUserBanAction, adminSendPasswordResetAction } from '@/app/(app)/admin/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function UserSecurityActions({ userId, email, banned }: { userId: string; email: string | null; banned: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggleBan() {
    if (!confirm(banned ? 'Lift the ban on this account?' : 'Ban this account? They will be unable to sign in until you reverse it.')) return;
    setBusy(true);
    const res = await adminSetUserBanAction(userId, !banned);
    setBusy(false);
    setOpen(false);
    if (!res.ok) return toastError(res.error);
    success(banned ? 'Ban lifted' : 'Account banned');
    router.refresh();
  }

  async function sendReset() {
    if (!email) return toastError('No email on file');
    setBusy(true);
    const res = await adminSendPasswordResetAction(email);
    setBusy(false);
    setOpen(false);
    if (!res.ok) return toastError(res.error);
    success('Password-reset email sent');
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-muted hover:bg-elevated" aria-label={t('userSecurityActions.accountActions')}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-xl popover-surface p-1 shadow-glass animate-fade-in">
            <button onClick={sendReset} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated disabled:opacity-50">
              <KeyRound className="h-4 w-4" /> {t('userSecurityActions.sendPasswordReset')}
            </button>
            <button onClick={toggleBan} disabled={busy} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated disabled:opacity-50 ${banned ? 'text-success' : 'text-danger'}`}>
              {banned ? <><ShieldCheck className="h-4 w-4" /> {t('userSecurityActions.liftBan')}</> : <><Ban className="h-4 w-4" /> {t('userSecurityActions.banAccount')}</>}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
