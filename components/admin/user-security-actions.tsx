'use client';

import { useEffect, useRef, useState } from 'react';
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
  const [resetState, setResetState] = useState<'idle' | 'pending' | 'accepted' | 'uncertain'>('idle');
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const owner = `${userId}:${email ?? ''}`;
  const currentOwner = useRef({ owner, revision: 0 });
  if (currentOwner.current.owner !== owner) currentOwner.current = { owner, revision: currentOwner.current.revision + 1 };
  const ownerRevision = currentOwner.current.revision;
  const mounted = useRef(false);
  const attempt = useRef<{ owner: string; state: 'pending' | 'accepted' | 'uncertain' } | null>(null);
  const resetOutcomes = useRef(new Map<string, { state: 'accepted' | 'uncertain'; message: string }>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    attempt.current = null;
    setBusy(false);
    const saved = resetOutcomes.current.get(owner);
    setResetState(saved?.state ?? 'idle');
    setResetMessage(saved?.message ?? null);
  }, [owner]);

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
    if (!mounted.current || currentOwner.current.owner !== owner || currentOwner.current.revision !== ownerRevision
      || attempt.current || resetOutcomes.current.has(owner) || busy) return;
    if (!email) return toastError(t('userSecurityActions.noEmailOnFile'));
    const currentAttempt = { owner, state: 'pending' as 'pending' | 'accepted' | 'uncertain' };
    attempt.current = currentAttempt;
    // Returning to a prior target cannot erase an already dispatched request.
    resetOutcomes.current.set(owner, { state: 'uncertain', message: t('userSecurityActions.resetUncertain') });
    const current = () => mounted.current && currentOwner.current.owner === owner && currentOwner.current.revision === ownerRevision && attempt.current === currentAttempt;
    setBusy(true);
    setResetState('pending');
    setResetMessage(null);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // A server action cannot be cancelled from this control. A waiting
      // deadline therefore requires review, and never permits a blind resend.
      const res = await Promise.race([
        adminSendPasswordResetAction(email),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Reset response deadline exceeded')), 15_000); }),
      ]);
      if (!current()) return;
      if (res.ok && res.outcome === 'accepted') {
        currentAttempt.state = 'accepted';
        setResetState('accepted');
        const message = res.audit === 'unconfirmed' ? t('userSecurityActions.resetAuditUnconfirmed') : t('userSecurityActions.resetAccepted');
        resetOutcomes.current.set(owner, { state: 'accepted', message });
        setResetMessage(message);
        success(message);
      } else if (!res.ok && res.outcome === 'failed') {
        attempt.current = null;
        resetOutcomes.current.delete(owner);
        setResetState('idle');
        toastError(res.error);
      } else {
        currentAttempt.state = 'uncertain';
        setResetState('uncertain');
        setResetMessage(t('userSecurityActions.resetUncertain'));
        toastError(t('userSecurityActions.resetUncertain'));
      }
    } catch {
      if (!current()) return;
      currentAttempt.state = 'uncertain';
      setResetState('uncertain');
      setResetMessage(t('userSecurityActions.resetUncertain'));
      toastError(t('userSecurityActions.resetUncertain'));
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      if (mounted.current && currentOwner.current.owner === owner && currentOwner.current.revision === ownerRevision
        && (attempt.current === currentAttempt || attempt.current === null)) setBusy(false);
    }
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
            <button onClick={sendReset} disabled={busy || resetState !== 'idle'} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated disabled:opacity-50">
              <KeyRound className="h-4 w-4" /> {t('userSecurityActions.sendPasswordReset')}
            </button>
            <button onClick={toggleBan} disabled={busy} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-elevated disabled:opacity-50 ${banned ? 'text-success' : 'text-danger'}`}>
              {banned ? <><ShieldCheck className="h-4 w-4" /> {t('userSecurityActions.liftBan')}</> : <><Ban className="h-4 w-4" /> {t('userSecurityActions.banAccount')}</>}
            </button>
          </div>
        </>
      )}
      {resetMessage && <p role="status" aria-label={resetState === 'uncertain' ? t('userSecurityActions.resetReview') : undefined} className="mt-2 max-w-xs text-xs text-muted">{resetMessage}</p>}
    </div>
  );
}
