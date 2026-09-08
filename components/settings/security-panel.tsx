'use client';

// Settings › Security › Two-step sign-in. Enrol, verify and remove a TOTP
// authenticator through Supabase Auth's own MFA API — there is no Bubaly
// table behind this card, so every state on it is read back from
// `listFactors()` / `getAuthenticatorAssuranceLevel()` after each change.
//
// Honesty rules this card keeps:
//   • a read that fails renders a retryable error, never "Not set up";
//   • a Supabase refusal (most often: the project has TOTP switched off) is
//     shown with Supabase's own words, never as a fake "enabled";
//   • "on" appears only once `challengeAndVerify` has succeeded AND the
//     re-read lists a verified factor.
import { useEffect, useState } from 'react';
import { Copy, KeyRound, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { OtpInput } from '@/components/ui/otp-input';
import { MfaErrorNotice } from '@/components/auth/mfa-error-copy';
import { fmtDate } from '@/lib/utils/format';
import {
  classifyMfaError,
  hasVerifiedTotp,
  isValidTotpCode,
  mfaUiState,
  normalizeTotpCode,
  pendingTotpFactors,
  sessionStrength,
  verifiedTotpFactors,
  type Assurance,
  type ClassifiedMfaError,
  type MfaFactor,
} from '@/lib/auth/mfa';

type Snapshot = { factors: MfaFactor[]; assurance: Assurance };

type Enrolment = { factorId: string; qrCode: string; secret: string; uri: string };

const FRIENDLY_NAME_PREFIX = 'Bubaly';

export function SecurityPanel() {
  const t = useTranslations();
  const { success } = useToast();
  const supabase = createClient();

  // undefined = loading. A failed read leaves `snapshot` undefined and sets
  // `loadError`, so nothing below can claim a state it never read.
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined);
  const [loadError, setLoadError] = useState<ClassifiedMfaError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [enrolError, setEnrolError] = useState<ClassifiedMfaError | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const [removing, setRemoving] = useState<MfaFactor | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [factorsRes, aalRes] = await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
      if (!active) return;
      const error = factorsRes.error ?? aalRes.error;
      if (error || !factorsRes.data || !aalRes.data) {
        console.error('[security-panel] mfa factors read failed', error ?? new Error('empty response'));
        setLoadError(classifyMfaError(error ?? new Error('empty response')));
        setSnapshot(undefined);
        return;
      }
      setLoadError(null);
      setSnapshot({
        factors: factorsRes.data.all as MfaFactor[],
        assurance: { currentLevel: aalRes.data.currentLevel, nextLevel: aalRes.data.nextLevel },
      });
    })();
    return () => { active = false; };
    // The client is created per render; the reload key is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const reload = () => { setLoadError(null); setSnapshot(undefined); setReloadKey((k) => k + 1); };

  /** Drop every unfinished enrolment so a fresh `enroll` cannot hit a name conflict. */
  async function discardPending(factors: MfaFactor[]) {
    for (const f of pendingTotpFactors(factors)) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (error) return classifyMfaError(error);
    }
    return null;
  }

  async function startEnrolment() {
    if (!snapshot || busy) return;
    setBusy(true);
    setEnrolError(null);
    const cleanup = await discardPending(snapshot.factors);
    if (cleanup) { setEnrolError(cleanup); setBusy(false); return; }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `${FRIENDLY_NAME_PREFIX} ${new Date().toISOString().slice(0, 10)}`,
      issuer: 'Bubaly',
    });
    setBusy(false);
    if (error || !data) {
      console.error('[security-panel] mfa enrol failed', error ?? new Error('empty response'));
      setEnrolError(classifyMfaError(error ?? new Error('empty response')));
      return;
    }
    setCode('');
    setEnrolment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri });
  }

  async function verifyEnrolment(raw: string) {
    if (!enrolment || busy) return;
    const normalized = normalizeTotpCode(raw);
    if (!isValidTotpCode(normalized)) return;
    setBusy(true);
    setEnrolError(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolment.factorId, code: normalized });
    setBusy(false);
    if (error) {
      setEnrolError(classifyMfaError(error));
      setCode('');
      return;
    }
    setEnrolment(null);
    setCode('');
    success(t('securityPanel.verified'));
    reload();
  }

  async function cancelEnrolment() {
    if (!enrolment || busy) return;
    setBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: enrolment.factorId });
    setBusy(false);
    // A failed cleanup is not a failed cancel: the pending factor stays listed
    // and the next "Set up" discards it first.
    if (error) console.error('[security-panel] pending factor cleanup failed', error);
    setEnrolment(null);
    setEnrolError(null);
    setCode('');
    reload();
  }

  async function copySecret() {
    if (!enrolment) return;
    try {
      await navigator.clipboard.writeText(enrolment.secret);
      success(t('securityPanel.secretCopied'));
    } catch {
      /* clipboard blocked: the key is still on screen */
    }
  }

  const state = snapshot ? mfaUiState(snapshot.factors) : null;
  const strength = snapshot ? sessionStrength(snapshot.assurance) : null;

  return (
    <div id="two-step" className="scroll-mt-20 rounded-2xl border border-border bg-surface/40 p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand-text">
          <Smartphone className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t('securityPanel.title')}</h3>
          <p className="mt-0.5 max-w-lg text-xs text-muted">{t('securityPanel.description')}</p>
          <p className="mt-1 max-w-lg text-xs text-muted">{t('securityPanel.enforcementNote')}</p>

          {loadError ? (
            <div className="mt-3">
              <MfaErrorNotice error={loadError} onRetry={reload} />
              <p className="mt-2 text-xs text-muted">{t('securityPanel.couldNotLoad')}</p>
            </div>
          ) : !snapshot ? (
            <p className="mt-3 text-xs text-muted">{t('securityPanel.loading')}</p>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                {state === 'enrolled' ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-400"><ShieldCheck className="h-3.5 w-3.5" /> {t('securityPanel.statusEnrolled')}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-muted"><ShieldOff className="h-3.5 w-3.5" /> {t('securityPanel.statusNotEnrolled')}</span>
                )}
                <span className="text-muted">·</span>
                <span className="text-muted">
                  {strength === 'stepped_up'
                    ? t('securityPanel.sessionSteppedUp')
                    : strength === 'needs_step_up'
                      ? t('securityPanel.sessionNeedsStepUp')
                      : t('securityPanel.sessionPasswordOnly')}
                </span>
              </div>

              {state === 'pending_verification' && !enrolment && (
                <p className="mt-2 text-xs text-amber-500">{t('securityPanel.pendingCleanup')}</p>
              )}

              {state === 'enrolled' && (
                <ul className="mt-3 space-y-2">
                  {verifiedTotpFactors(snapshot.factors).map((f) => (
                    <li key={f.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/60 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{f.friendly_name || t('securityPanel.authenticatorApp')}</p>
                        <p className="text-xs text-muted">{t('securityPanel.factorAdded', { date: fmtDate(f.created_at, 'MMM d, yyyy') })}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setRemoving(f)} disabled={busy}>{t('securityPanel.remove')}</Button>
                    </li>
                  ))}
                </ul>
              )}

              {enrolError && !enrolment && (
                <div className="mt-3"><MfaErrorNotice error={enrolError} onRetry={startEnrolment} /></div>
              )}

              {!enrolment && state !== 'enrolled' && (
                <div className="mt-3">
                  <Button size="sm" onClick={startEnrolment} loading={busy} disabled={busy}>
                    <KeyRound className="h-4 w-4" /> {state === 'pending_verification' ? t('securityPanel.startOver') : t('securityPanel.setUp')}
                  </Button>
                </div>
              )}

              {enrolment && (
                <div className="mt-4 rounded-2xl border border-border bg-surface/60 p-4">
                  <h4 className="text-sm font-semibold">{t('securityPanel.scanTitle')}</h4>
                  <p className="mt-1 text-xs text-muted">{t('securityPanel.scanHelp')}</p>
                  <div className="mt-3 flex flex-col items-start gap-4 sm:flex-row">
                    {/* Supabase returns the QR as an SVG document; it is rendered as an
                        image so nothing in it can run, and never logged. */}
                    {/* eslint-disable-next-line @next/next/no-img-element -- a device-local data: URI holding the TOTP secret; it must never pass through an image loader */}
                    <img
                      src={`data:image/svg+xml;utf-8,${encodeURIComponent(enrolment.qrCode)}`}
                      alt={t('securityPanel.qrAlt')}
                      width={176}
                      height={176}
                      className="h-44 w-44 shrink-0 rounded-xl bg-white p-2"
                    />
                    <div className="min-w-0 flex-1 space-y-3">
                      <div>
                        <p className="text-xs text-muted">{t('securityPanel.cantScan')}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all rounded-lg bg-elevated px-2 py-1 text-xs">{enrolment.secret}</code>
                          <button type="button" onClick={copySecret} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-elevated" aria-label={t('securityPanel.copySecret')}>
                            <Copy className="h-3.5 w-3.5" /> {t('securityPanel.copySecret')}
                          </button>
                        </div>
                      </div>
                      <div>
                        <p className="mb-2 text-xs font-medium">{t('securityPanel.codeLabel')}</p>
                        <OtpInput value={code} onChange={setCode} autoFocus disabled={busy} onComplete={verifyEnrolment} ariaLabel={t('securityPanel.codeLabel')} />
                      </div>
                      {enrolError && <MfaErrorNotice error={enrolError} />}
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => verifyEnrolment(code)} loading={busy} disabled={busy || !isValidTotpCode(code)}>{t('securityPanel.verify')}</Button>
                        <Button size="sm" variant="ghost" onClick={cancelEnrolment} disabled={busy}>{t('securityPanel.cancelSetup')}</Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {removing && snapshot && (
        <RemoveFactorModal
          factor={removing}
          needsCode={snapshot.assurance.currentLevel !== 'aal2' && hasVerifiedTotp(snapshot.factors)}
          onClose={() => setRemoving(null)}
          onRemoved={() => { setRemoving(null); success(t('securityPanel.removed')); reload(); }}
        />
      )}
    </div>
  );
}

/**
 * Supabase refuses to unenrol a verified factor from an `aal1` session
 * (`insufficient_aal`), so removal asks for a current code first when the
 * session has not stepped up yet.
 */
function RemoveFactorModal({ factor, needsCode, onClose, onRemoved }: {
  factor: MfaFactor; needsCode: boolean; onClose: () => void; onRemoved: () => void;
}) {
  const t = useTranslations();
  const supabase = createClient();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClassifiedMfaError | null>(null);

  async function remove(raw?: string) {
    if (busy) return;
    const normalized = normalizeTotpCode(raw ?? code);
    if (needsCode && !isValidTotpCode(normalized)) return;
    setBusy(true);
    setError(null);
    if (needsCode) {
      const verify = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: normalized });
      if (verify.error) { setError(classifyMfaError(verify.error)); setCode(''); setBusy(false); return; }
    }
    const { error: unenrolError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    setBusy(false);
    if (unenrolError) {
      console.error('[security-panel] mfa unenrol failed', unenrolError);
      setError(classifyMfaError(unenrolError));
      return;
    }
    onRemoved();
  }

  return (
    <Modal open onClose={onClose} title={t('securityPanel.removeTitle')} description={t('securityPanel.removeHelp')}>
      <div className="space-y-4">
        {needsCode && (
          <div>
            <p className="mb-2 text-xs font-medium">{t('securityPanel.codeLabel')}</p>
            <OtpInput value={code} onChange={setCode} autoFocus disabled={busy} onComplete={(c) => remove(c)} ariaLabel={t('securityPanel.codeLabel')} />
          </div>
        )}
        {error && <MfaErrorNotice error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>{t('securityPanel.cancelSetup')}</Button>
          <Button type="button" variant="danger" size="sm" onClick={() => remove()} loading={busy} disabled={busy || (needsCode && !isValidTotpCode(code))}>
            {t('securityPanel.removeConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
