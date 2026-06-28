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

const RESEND_SECONDS = 30;

export function PhoneAuth({ next = '/onboarding', onBack }: { next?: string; onBack?: () => void }) {
  const router = useRouter();
  const { error: toastError, success } = useToast();
  const [phase, setPhase] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

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
    if (!isLikelyE164(phone)) { toastError('Enter a valid phone number.'); return; }
    setSending(true);
    const { error } = await createClient().auth.signInWithOtp({ phone });
    setSending(false);
    if (error) { toastError(providerHint(error.message, 'Phone')); return; }
    if (resend) success('Code sent'); else setPhase('code');
    startCountdown();
  }

  async function verify() {
    if (!isValidOtp(code)) return;
    setVerifying(true);
    const { error } = await createClient().auth.verifyOtp({ phone, token: code, type: 'sms' });
    setVerifying(false);
    if (error) { toastError(error.message); return; }
    router.push(next);
    router.refresh();
  }

  if (phase === 'phone') {
    return (
      <div className="space-y-4 animate-fade-in">
        <div>
          <h2 className="text-lg font-semibold">What&rsquo;s your phone number?</h2>
          <p className="mt-0.5 text-sm text-muted">We&rsquo;ll text you a verification code to confirm.</p>
        </div>
        <PhoneInput defaultCountryCode="US" onChange={(e164) => setPhone(e164)} />
        <Button className="w-full" loading={sending} disabled={!isLikelyE164(phone)} onClick={() => send(false)}>
          Continue
        </Button>
        {onBack && (
          <button type="button" onClick={onBack} className="flex w-full items-center justify-center gap-1 text-sm text-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <h2 className="text-lg font-semibold">Enter the code we sent you</h2>
        <p className="mt-0.5 text-sm text-muted">We sent a 6-digit code to {phone}.</p>
      </div>
      <OtpInput
        value={code}
        onChange={(next) => setCode(normalizeOtp(next))}
        autoFocus
        onComplete={() => void verify()}
      />
      <Button className="w-full" loading={verifying} disabled={!isValidOtp(code)} onClick={verify}>
        Verify &amp; continue
      </Button>
      <div className="text-center text-sm text-muted">
        {resendIn > 0 ? (
          <span>Resend code in {formatCountdown(resendIn)}</span>
        ) : (
          <button type="button" onClick={() => send(true)} disabled={sending} className="font-medium text-brand hover:underline disabled:opacity-60">
            {sending ? <Loader2 className="inline h-4 w-4 animate-spin" /> : 'Resend code'}
          </button>
        )}
      </div>
      <button type="button" onClick={() => { setPhase('phone'); setCode(''); }}
        className="flex w-full items-center justify-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Use a different number
      </button>
    </div>
  );
}
