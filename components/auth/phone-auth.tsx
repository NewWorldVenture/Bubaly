'use client';

// Phone sign-up / sign-in via SMS one-time code — matches the mockup's phone
// path: enter number → "Enter the code we sent you" → verified. Wired to Supabase
// phone auth (signInWithOtp → verifyOtp); shows a friendly hint until the SMS
// provider (e.g. Twilio) is enabled. New accounts land in /onboarding (the
// onboarding layout sends already-set-up users on to the dashboard).
import { useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PhoneInput } from '@/components/ui/phone-input';
import { OtpInput } from '@/components/ui/otp-input';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { isPasswordSessionCurrent, verifySmsWithOwnedSession } from '@/lib/auth/password-client';
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
  const remaining = useRef(0);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const busy = useRef<'send' | 'verify' | 'complete' | null>(null);
  const destination = safeInternalRedirect(next, '/onboarding');
  const intent = useRef({ phase: 'phone' as 'phone' | 'code', phone: '', code: '', destination });

  function stopCountdown() {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    remaining.current = 0;
  }

  function retire(clearCountdown = false) {
    attempt.current += 1;
    busy.current = null;
    setSending(false);
    setVerifying(false);
    if (clearCountdown) { stopCountdown(); setResendIn(0); }
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current += 1; stopCountdown(); };
  }, []);
  useLayoutEffect(() => {
    if (intent.current.destination !== destination) {
      intent.current.destination = destination;
      attempt.current += 1;
      busy.current = null;
      setSending(false);
      setVerifying(false);
      stopCountdown();
      setResendIn(0);
    }
  }, [destination]);

  function startCountdown() {
    stopCountdown();
    remaining.current = RESEND_SECONDS;
    setResendIn(RESEND_SECONDS);
    const number = intent.current.phone;
    const target = intent.current.destination;
    const countdown = setInterval(() => {
      if (tick.current !== countdown) return;
      if (!mounted.current || intent.current.phase !== 'code' || intent.current.phone !== number || intent.current.destination !== target) {
        stopCountdown();
        return;
      }
      remaining.current = Math.max(0, remaining.current - 1);
      setResendIn(remaining.current);
      if (!remaining.current) stopCountdown();
    }, 1000);
    tick.current = countdown;
  }

  function changePhone(value: string) {
    if (!mounted.current || intent.current.phase !== 'phone' || intent.current.destination !== destination || value === intent.current.phone) return;
    retire(true);
    intent.current.phone = value;
    intent.current.code = '';
    setPhone(value);
    setCode('');
  }

  function changeCode(value: string) {
    if (!mounted.current || intent.current.phase !== 'code' || intent.current.destination !== destination) return;
    const normalized = normalizeOtp(value);
    if (normalized === intent.current.code) return;
    retire();
    intent.current.code = normalized;
    setCode(normalized);
  }

  function differentNumber() {
    if (!mounted.current || intent.current.destination !== destination) return;
    retire(true);
    intent.current.phase = 'phone';
    intent.current.phone = '';
    intent.current.code = '';
    setPhase('phone');
    setPhone('');
    setCode('');
  }

  async function send(resend = false) {
    if (!mounted.current || busy.current || intent.current.destination !== destination
      || intent.current.phase !== (resend ? 'code' : 'phone') || (resend && remaining.current > 0)) return;
    const number = intent.current.phone;
    if (!isLikelyE164(number)) { toastError(t('phoneAuth.enterAValidPhoneNumber')); return; }
    const thisAttempt = ++attempt.current;
    const startingPhase = intent.current.phase;
    const startingCode = intent.current.code;
    const current = () => mounted.current && attempt.current === thisAttempt && intent.current.phone === number
      && intent.current.phase === startingPhase && intent.current.code === startingCode && intent.current.destination === destination;
    busy.current = 'send';
    setSending(true);
    try {
      const { error } = await createClient().auth.signInWithOtp({ phone: number });
      if (!current()) return;
      if (error) throw error;
      busy.current = null;
      setSending(false);
      if (resend) success(t('phoneAuth.codeSent'));
      else { intent.current.phase = 'code'; setPhase('code'); }
      startCountdown();
    } catch (error) {
      if (current()) toastError(providerHint(error instanceof Error ? error.message : t('loginForm.couldNotSignIn'), 'Phone'));
    } finally {
      if (mounted.current && attempt.current === thisAttempt) { busy.current = null; setSending(false); }
    }
  }

  // OtpInput publishes onChange before onComplete in the same event. Read the
  // synchronous intent so automatic and manual submission share one operation.
  async function verify(otp?: string) {
    if (!mounted.current || busy.current || intent.current.phase !== 'code' || intent.current.destination !== destination) return;
    const token = otp ?? intent.current.code;
    if (!isValidOtp(token) || token !== intent.current.code) return;
    const number = intent.current.phone;
    const thisAttempt = ++attempt.current;
    const canCommit = () => mounted.current && attempt.current === thisAttempt && intent.current.phase === 'code'
      && intent.current.phone === number && intent.current.code === token && intent.current.destination === destination;
    busy.current = 'verify';
    setVerifying(true);
    try {
      const { data, error } = await verifySmsWithOwnedSession({ phone: number, token }, canCommit);
      if (!canCommit()) return;
      if (error) throw error;
      if (!data.session || !isPasswordSessionCurrent(data.session)) return;
      busy.current = 'complete';
      stopCountdown();
      router.push(destination);
      if (canCommit() && isPasswordSessionCurrent(data.session)) router.refresh();
    } catch (error) {
      if (canCommit() && !(error instanceof Error && error.name === 'AuthSessionInterruptedError')) {
        toastError(error instanceof Error ? error.message : t('loginForm.couldNotSignIn'));
      }
    } finally {
      if (canCommit() && busy.current !== 'complete') { busy.current = null; setVerifying(false); }
    }
  }

  if (phase === 'phone') {
    return (
      <div className="space-y-4 animate-fade-in">
        <div>
          <h2 className="text-lg font-semibold">{t('phoneAuth.whatRsquoSYourPhoneNumber')}</h2>
          <p className="mt-0.5 text-sm text-muted">{t('phoneAuth.weRsquoLlTextYouA')}</p>
        </div>
        <PhoneInput defaultCountryCode="US" onChange={changePhone} />
        <Button className="w-full" loading={sending} disabled={!isLikelyE164(phone)} onClick={() => send(false)}>
          {t('phoneAuth.continue')}
        </Button>
        {onBack && (
          <button type="button" onClick={() => {
            if (!mounted.current || intent.current.destination !== destination) return;
            retire(true); onBack();
          }} className="flex w-full items-center justify-center gap-1 text-sm text-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" /> {t('phoneAuth.back')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <h2 className="text-lg font-semibold">{t('phoneAuth.codeEntryTitle')}</h2>
        <p className="mt-0.5 text-sm text-muted">{t('phoneAuth.weSentA6DigitCode')} {phone}.</p>
      </div>
      <OtpInput
        value={code}
        onChange={changeCode}
        autoFocus
        onComplete={(full) => void verify(full)}
      />
      <Button className="w-full" loading={verifying} disabled={sending || !isValidOtp(code)} onClick={() => verify()}>
        {t('phoneAuth.verifyAmpContinue')}
      </Button>
      <div className="text-center text-sm text-muted">
        {resendIn > 0 ? (
          <span>{t('phoneAuth.resendCodeIn')} {formatCountdown(resendIn)}</span>
        ) : (
          <button type="button" onClick={() => send(true)} disabled={sending || verifying} className="font-medium text-brand-text hover:underline disabled:opacity-60">
            {sending ? <Loader2 className="inline h-4 w-4 animate-spin" /> : 'Resend code'}
          </button>
        )}
      </div>
      <button type="button" onClick={differentNumber}
        className="flex w-full items-center justify-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {t('phoneAuth.useADifferentNumber')}
      </button>
    </div>
  );
}
