'use client';

// The step-up prompt: one code from the authenticator, then back to the page
// that asked. The server decided a code is needed (lib/auth/require-aal2);
// this form only collects it. `challengeAndVerify` swaps the session for an
// `aal2` one through @supabase/ssr's cookie store, so the next server render
// of the return page sees the new level without any Bubaly state.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Button } from '@/components/ui/button';
import { OtpInput } from '@/components/ui/otp-input';
import { MfaErrorNotice } from '@/components/auth/mfa-error-copy';
import { SignOutForm } from '@/components/auth/sign-out-form';
import {
  classifyMfaError,
  isValidTotpCode,
  normalizeTotpCode,
  verifiedTotpFactors,
  type ClassifiedMfaError,
  type MfaFactor,
} from '@/lib/auth/mfa';

export function StepUpForm({ next, serverReadFailed }: { next: string; serverReadFailed: boolean }) {
  const t = useTranslations();
  const router = useRouter();

  const [factors, setFactors] = useState<MfaFactor[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<ClassifiedMfaError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClassifiedMfaError | null>(null);

  useEffect(() => {
    let active = true;
    setFactors(undefined);
    setLoadError(null);
    void createClient().auth.mfa.listFactors().then(({ data, error: readError }) => {
      if (!active) return;
      if (readError || !data) {
        console.error('[step-up] mfa factors read failed', readError ?? new Error('empty response'));
        setLoadError(classifyMfaError(readError ?? new Error('empty response')));
        return;
      }
      setFactors(data.all as MfaFactor[]);
    });
    return () => { active = false; };
  }, [reloadKey]);

  const factor = factors ? verifiedTotpFactors(factors)[0] ?? null : null;

  async function submit(raw?: string) {
    if (!factor || busy) return;
    const normalized = normalizeTotpCode(raw ?? code);
    if (!isValidTotpCode(normalized)) return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({ factorId: factor.id, code: normalized });
    if (verifyError) {
      setError(classifyMfaError(verifyError));
      setCode('');
      setBusy(false);
      return;
    }
    // A full navigation, not a client transition: the new session cookie has
    // to reach the server before the return page's guard runs again.
    window.location.assign(next);
  }

  const showError = error ?? loadError;

  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-6">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand-text"><KeyRound className="h-6 w-6" /></div>
      <h1 className="text-xl font-bold tracking-tight">{t('stepUp.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('stepUp.description')}</p>

      {serverReadFailed && (
        <p role="alert" className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600">{t('stepUp.couldNotRead')}</p>
      )}

      <div className="mt-5">
        {factors === undefined && !loadError ? (
          <p className="text-sm text-muted">{t('stepUp.loading')}</p>
        ) : loadError ? null : !factor ? (
          <p className="text-sm text-muted">{t('stepUp.noFactor')}</p>
        ) : (
          <>
            <p className="mb-2 text-xs font-medium">{t('stepUp.codeLabel')}</p>
            <OtpInput value={code} onChange={setCode} autoFocus disabled={busy} onComplete={(c) => submit(c)} ariaLabel={t('stepUp.codeLabel')} />
          </>
        )}
      </div>

      {showError && (
        <div className="mt-4">
          <MfaErrorNotice error={showError} onRetry={loadError ? () => setReloadKey((k) => k + 1) : undefined} />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {factor && (
          <Button onClick={() => submit()} loading={busy} disabled={busy || !isValidTotpCode(code)}>{t('stepUp.continue')}</Button>
        )}
        <Button variant="ghost" onClick={() => router.push('/dashboard')} disabled={busy}>{t('stepUp.back')}</Button>
        <SignOutForm className="ml-auto">
          {({ signingOut }) => <button type="submit" disabled={signingOut} className="text-xs text-muted hover:text-fg">{t('stepUp.signOut')}</button>}
        </SignOutForm>
      </div>
    </div>
  );
}
