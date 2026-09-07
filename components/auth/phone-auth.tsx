'use client';

// Phone sign-up / sign-in via SMS one-time code — matches the mockup's phone
// path: enter number → "Enter the code we sent you" → verified. Wired to Supabase
// phone auth (signInWithOtp → verifyOtp); shows a friendly hint until the SMS
// provider (e.g. Twilio) is enabled. New accounts land in /onboarding (the
// onboarding layout sends already-set-up users on to the dashboard).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PhoneInput } from '@/components/ui/phone-input';
import { OtpInput } from '@/components/ui/otp-input';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { normalizeOtp, isValidOtp, isLikelyE164, formatCountdown, providerHint } from '@/lib/auth/otp';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { useTranslations } from '@/components/i18n/locale-provider';

const RESEND_SECONDS = 30;

export function PhoneAuth({ next = '/onboarding', onBack }: { next?: string; onBack?: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const { error: toastError, success } = useToast();
  const [phase, setPhase] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const destination = safeInternalRedirect(next, '/onboarding');

  useEffect(() => () => { if (tick.current) clearInterval(tick.current); }, []);

  function startCountdown() {
    setResendIn(RESEND_SECONDS);
    if (tick.current) clearInterval(tick.current);
    tick.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1 && tick.current) { clearInterval(tick.current); tick.current = null; }
        return s - 1;
      });
    }, 1000);
  }

  async function send(resend = false) {
    if (!isLikelyE164(phone)) { toastError(t('phoneAuth.enterAValidPhoneNumber')); return; }
    setSending(true);
    const { error } = await createClient().auth.signInWithOtp({ phone });
    setSending(false);
    if (error) { toastError(providerHint(error.message, 'Phone')); return; }
    if (resend) success(t('phoneAuth.codeSent')); else setPhase('code');
    startCountdown();
  }

  // `otp` is passed by OtpInput's onComplete (the full code); the manual button
  // falls back to state. Using the argument avoids a stale-closure race where
  // auto-submit on the 6th digit read the pre-update `code` and silently bailed —
  // so the code never verified until the user also clicked "Verify & continue".
  async function verify(otp?: string) {
    const token = otp ?? code;
    if (!isValidOtp(token)) return;
    setVerifying(true);
    const { error } = await createClient().auth.verifyOtp({ phone, token, type: 'sms' });
    setVerifying(false);
    if (error) { toastError(error.message); return; }
    router.push(destination);
    router.refresh();
  }

  if (phase === 'phone') {
    return (
      <div className="space-y-4 animate-fade-in">
        <div>
          <h2 className="text-lg font-semibold">{t('phoneAuth.whatRsquoSYourPhoneNumber')}</h2>
          <p className="mt-0.5 text-sm text-muted">{t('phoneAuth.weRsquoLlTextYouA')}</p>
        </div>
        <PhoneInput defaultCountryCode="US" onChange={(e164) => setPhone(e164)} />
        <Button className="w-full" loading={sending} disabled={!isLikelyE164(phone)} onClick={() => send(false)}>
          {t('phoneAuth.continue')}
        </Button>
        {onBack && (
          <button type="button" onClick={onBack} className="flex w-full items-center justify-center gap-1 text-sm text-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" /> {t('phoneAuth.back')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <h2 className="text-lg font-semibold">{t('phoneAuth.enterTheCodeWeSentYou')}</h2>
        <p className="mt-0.5 text-sm text-muted">{t('phoneAuth.weSentA6DigitCode')} {phone}.</p>
      </div>
      <OtpInput
        value={code}
        onChange={(next) => setCode(normalizeOtp(next))}
        autoFocus
        onComplete={(full) => void verify(full)}
      />
      <Button className="w-full" loading={verifying} disabled={!isValidOtp(code)} onClick={() => verify()}>
        {t('phoneAuth.verifyAmpContinue')}
      </Button>
      <div className="text-center text-sm text-muted">
        {resendIn > 0 ? (
          <span>{t('phoneAuth.resendCodeIn')} {formatCountdown(resendIn)}</span>
        ) : (
          <button type="button" onClick={() => send(true)} disabled={sending} className="font-medium text-brand-text hover:underline disabled:opacity-60">
            {sending ? <Loader2 className="inline h-4 w-4 animate-spin" /> : 'Resend code'}
          </button>
        )}
      </div>
      <button type="button" onClick={() => { setPhase('phone'); setCode(''); }}
        className="flex w-full items-center justify-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {t('phoneAuth.useADifferentNumber')}
      </button>
    </div>
  );
}
