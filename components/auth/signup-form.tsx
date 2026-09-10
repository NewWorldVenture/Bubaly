'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { MailCheck, Sparkles, Smartphone, Mail, Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { signUpSchema, fieldErrors } from '@/lib/validation';
import { OAuthButtons, authButtonClass } from '@/components/auth/oauth-buttons';
import { stitchIdentityAction } from '@/app/(auth)/actions';
import { PhoneAuth } from '@/components/auth/phone-auth';
import { LegalConsent } from '@/components/auth/legal-consent';
import { describeDbError } from '@/lib/supabase/errors';
import { authScreenHref, resolveAuthSelection } from '@/lib/billing/review-selection';
import { isPlausibleReferralCode, normalizeCode } from '@/lib/referrals/core';
import { rememberReferralCodeAction } from '@/app/(auth)/signup/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function SignupForm() {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  // Explicit safe destinations (including invitations) take precedence. A
  // selected price only continues to review after setup; auth never buys it.
  const selection = resolveAuthSelection(params);
  const nextDest = selection.next ?? '/onboarding';
  const loginHref = authScreenHref('/login', selection);

  // A `/signup?ref=CODE` visit: keep the code (an httpOnly cookie, and the auth
  // metadata on the email path) so it survives confirmation and every signup
  // avenue, and the onboarding wizard can attribute the new family.
  const rawRef = params.get('ref');
  const referralCode = rawRef && isPlausibleReferralCode(rawRef) ? normalizeCode(rawRef) : null;
  useEffect(() => {
    if (referralCode) void rememberReferralCodeAction(referralCode);
  }, [referralCode]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = new FormData(e.currentTarget);
    const input = {
      fullName: String(form.get('fullName') ?? ''),
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    };
    const parsed = signUpSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const origin = window.location.origin;
      const next = nextDest;
      const { data, error } = await supabase.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: {
          data: { full_name: parsed.data.fullName, ...(referralCode ? { referral_code: referralCode } : {}) },
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw error;
      if (!data.session) {
        // Email confirmation required — the stitch runs in the auth callback
        // once the session is established.
        setCheckEmail(true);
        return;
      }
      // Auto-confirmed: attribute the anonymous visitor spine now (best-effort).
      void stitchIdentityAction();
      router.push(next);
      router.refresh();
    } catch (err) {
      toastError(describeDbError(err, t('signupForm.couldNotCreateAccount')));
    } finally {
      setLoading(false);
    }
  }

  if (checkEmail) {
    return (
      <div className="glass-card flex flex-col items-center p-8 text-center animate-fade-in">
        <MailCheck className="h-12 w-12 text-brand-text" />
        <h1 className="mt-4 text-xl font-semibold">{t('signup.checkEmailTitle')}</h1>
        <p className="mt-2 text-sm text-muted">
          {t('signup.weSentAConfirmationLinkTo')}
        </p>
        <Link href={loginHref} className="mt-6 text-sm font-medium text-brand-text hover:underline">
          {t('signup.backToSignIn')}
        </Link>
      </div>
    );
  }

  return (
    <div className="glass-card p-7 animate-fade-in sm:p-8">
      {/* Hero */}
      <div className="text-center">
        <span className="ai-orb mx-auto flex h-16 w-16 items-center justify-center">
          <Sparkles className="h-7 w-7 text-brand-text" />
        </span>
        <h1 className="mt-5 text-2xl font-bold tracking-tight sm:text-3xl">{t('signup.familyHomeTitle')}</h1>
        <p className="mt-2 text-sm text-muted">
          {t('signup.oneCalmHomeForYourCalendar')}.
          {' '}{selection.reviewPlan ? t('signup.reviewSelectedPlanAfterSetup') : t('signup.freeToStartNoCreditCard')}
        </p>
        {referralCode && (
          <p className="mx-auto mt-3 inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3 py-1.5 text-xs font-medium text-brand-text" data-testid="signup-referral">
            <Gift className="h-3.5 w-3.5" aria-hidden />
            {t('signup.referralCodeNoted', { code: referralCode })}
          </p>
        )}
      </div>

      {showPhone ? (
        <div className="mt-7">
          <PhoneAuth next={nextDest} onBack={() => setShowPhone(false)} />
        </div>
      ) : (
      <>
      {/* Primary options */}
      <div className="mt-7">
        <OAuthButtons next={nextDest} />
      </div>

      <div className="relative my-5 flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-muted">{t('signup.or')}</span>
        <div className="flex-1 border-t border-border" />
      </div>

      {!showEmail ? (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowPhone(true)}
            className={authButtonClass}
          >
            <Smartphone className="h-[18px] w-[18px]" /> {t('signup.continueWithPhone')}
          </button>
          <button
            type="button"
            onClick={() => setShowEmail(true)}
            className={authButtonClass}
          >
            <Mail className="h-[18px] w-[18px]" /> {t('signup.continueWithEmail')}
          </button>
          <button
            type="button"
            onClick={() => setShowPhone(true)}
            className="mx-auto block pt-1 text-center text-sm font-medium text-muted underline-offset-4 hover:text-fg hover:underline"
          >
            {t('signup.continueWithoutEmail')}
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4 animate-fade-in" noValidate>
          <Field label={t('signup.nameLabel')} error={errors.fullName} required>
            {(id) => <Input id={id} name="fullName" autoComplete="name" placeholder={t('signupForm.jordanRivera')} autoFocus />}
          </Field>
          <Field label={t('signup.email')} error={errors.email} required>
            {(id) => <Input id={id} name="email" type="email" autoComplete="email" placeholder="you@example.com" />}
          </Field>
          <Field label={t('signup.password')} error={errors.password} hint={t('signupForm.atLeast8Characters')} required>
            {(id) => <Input id={id} name="password" type="password" autoComplete="new-password" placeholder="••••••••" />}
          </Field>
          <Button type="submit" loading={loading} className="w-full">{t('signup.createAccount')}</Button>
        </form>
      )}
      </>
      )}

      <LegalConsent />

      <p className="mt-5 text-center text-sm text-muted">
        {t('signup.existingAccountPrompt')}{' '}
        <Link href={loginHref} className="font-medium text-brand-text hover:underline">{t('signup.signIn')}</Link>
      </p>
    </div>
  );
}
