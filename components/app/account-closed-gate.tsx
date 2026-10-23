'use client';

// Shown over the whole app when the family's account is soft-closed. Nothing was
// deleted — reopening restores everything. Parent-only reopen; anyone can log out.
//
// A member of MORE THAN ONE household is offered their other, open families.
// The gate replaces every (app) route, and the family switcher lives in
// AppShell, below it, so a caregiver or adult whose active family a parent
// closed used to lose the open household too until the closed one reopened or
// removed them. `canReopen` is false for a non-parent, whose click the action
// would only refuse; they are told to ask a parent instead.
//
// Reopening resumes the billing, so a password-only session of a parent who
// enrolled an authenticator is asked for the code first — HERE, in the gate.
// /auth/step-up is an (app) route, and this gate replaces every one of them,
// so sending the parent there drew this gate again and the reopen looped.
import { useState, useRef } from 'react';
import { Archive, ArrowRightLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { reopenAccountAction } from '@/app/(app)/account/actions';
import { setActiveFamilyAction } from '@/app/(app)/actions';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';
import { useTranslations } from '@/components/i18n/locale-provider';
import { SignOutForm } from '@/components/auth/sign-out-form';
import { StepUpForm } from '@/components/auth/step-up-form';
import { useDialogBehavior } from '@/lib/a11y/use-dialog-behavior';
import { reportRefusal } from '@/lib/auth/step-up-client';

export type OpenFamily = { id: string; name: string };

export function AccountClosedGate({ canReopen = true, otherFamilies = [] }: { canReopen?: boolean; otherFamilies?: OpenFamily[] }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(dialogRef, true, { lockScroll: false });
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  // The reopen was refused for want of the two-step code: the code is asked
  // for in place of the gate's card, and the reopen retried once it is in.
  const [needsCode, setNeedsCode] = useState(false);
  const { error: toastError, success, toast } = useToast();

  // Blocking full-screen gate: lock the page behind it (mobile scroll-bleed).
  useLockBodyScroll(true);

  async function reopen() {
    if (busy || switching) return;
    setBusy(true);
    const res = await reopenAccountAction();
    setBusy(false);
    // Reopening resumes the billing, so a password-only session of a parent
    // with an authenticator is asked for the code first — in place (see the
    // header), not on /auth/step-up, which this gate would cover.
    if (!res.ok) { reportRefusal(res, toastError, () => setNeedsCode(true)); return; }
    success(t('accountClosedGate.welcomeBackYourAccountIs'));
    // Reopened, but a subscription is still set to end at its period end: say
    // so, and land on billing, where it is resumed.
    if (res.notice) { toast(res.notice, 'info'); window.location.assign('/dashboard/billing'); }
    else window.location.reload();
  }

  async function switchTo(familyId: string) {
    if (busy || switching) return;
    setSwitching(familyId);
    const res = await setActiveFamilyAction(familyId).catch(() => null);
    if (!res?.ok) {
      setSwitching(null);
      toastError(res?.error || t('accountClosedGate.couldNotSwitchFamilies'));
      return;
    }
    window.location.assign('/home');
  }

  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={needsCode ? 'closed-step-up-title' : 'closed-title'}
      className="fixed inset-0 z-[200] grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      {needsCode ? (
        <div className="w-full max-w-md rounded-3xl bg-surface shadow-2xl">
          <StepUpForm serverReadFailed={false} titleId="closed-step-up-title" description={t('stepUp.billingDescription')}
            onVerified={() => { setNeedsCode(false); void reopen(); }} onBack={() => setNeedsCode(false)} />
        </div>
      ) : (
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-surface p-6 text-center shadow-2xl sm:p-8">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-elevated text-muted ring-1 ring-border">
            <Archive className="h-6 w-6" />
          </div>
          <h1 id="closed-title" className="mt-4 text-2xl font-black text-fg">{t('accountClosedGate.yourAccountIsClosed')}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            {t('accountClosedGate.everythingIsSafeWeHaventDeleted')}
          </p>
          {otherFamilies.length > 0 && (
            <div className="mt-6 space-y-2">
              <p className="text-sm text-muted">{t('accountClosedGate.yourOtherFamiliesAreOpen')}</p>
              {otherFamilies.map((family) => (
                <Button key={family.id} variant="outline" onClick={() => switchTo(family.id)} disabled={busy || !!switching}
                  aria-busy={switching === family.id} className="w-full gap-1.5">
                  <ArrowRightLeft className="h-4 w-4" /> {t('accountClosedGate.switchToFamily', { name: family.name })}
                </Button>
              ))}
            </div>
          )}
          {canReopen ? (
            <Button onClick={reopen} disabled={busy || !!switching} aria-busy={busy} className="mt-6 w-full gap-1.5">
              <RotateCcw className="h-4 w-4" /> {busy ? t('accountClosedGate.reopening') : t('accountClosedGate.reopenMyAccount')}
            </Button>
          ) : (
            <p className="mt-6 text-sm text-muted">{t('accountClosedGate.askAParentToReopen')}</p>
          )}
          <SignOutForm className="mt-4">
            {({ signingOut }) => <button type="submit" disabled={signingOut} className="text-sm text-muted hover:text-fg">{t('accountClosedGate.logOut')}</button>}
          </SignOutForm>
        </div>
      )}
    </div>
  );
}
