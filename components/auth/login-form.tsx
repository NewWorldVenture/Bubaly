'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { signInSchema, fieldErrors } from '@/lib/validation';
import { Smartphone } from 'lucide-react';
import { OAuthButtons, authButtonClass } from '@/components/auth/oauth-buttons';
import { PhoneAuth } from '@/components/auth/phone-auth';
import { LegalConsent } from '@/components/auth/legal-consent';
import { resolveLandingPathAction, stitchIdentityAction } from '@/app/(auth)/actions';
import { describeDbError } from '@/lib/supabase/errors';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { useTranslations } from '@/components/i18n/locale-provider';

export function LoginForm() {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  // A same-origin ?redirect= (e.g. an invite's /join?token=…) that OAuth + phone
  // sign-in must also honor — not just the password path below.
  const redirectParam = params.get('redirect');
  const redirectDest = safeInternalRedirect(redirectParam, '') || undefined;
  // The /auth/callback route bounces failed OAuth / email-confirmation here.
  const authError = params.get('error') === 'auth';

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = new FormData(e.currentTarget);
    const input = { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') };
    const parsed = signInSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword(parsed.data);
      if (error) throw error;
      // Attribute the anonymous visitor spine to this now-known user (best-effort).
      void stitchIdentityAction();
      // Resolve server-side so super admins (DB seed OR env/code allowlist)
      // land on the admin console even before migration 0008 is applied.
      const destination = redirectDest || (await resolveLandingPathAction());
      router.push(destination);
      router.refresh();
    } catch (err) {
      toastError(describeDbError(err, t('loginForm.couldNotSignIn')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="glass-card p-7 animate-fade-in sm:p-8">
      <h1 className="text-2xl font-bold tracking-tight">{t('login.welcomeBack')}</h1>
      <p className="mt-1 text-sm text-muted">{t('login.signInToYourFamily')}</p>

      {authError && (
        <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
          {t('login.weCouldntFinishSigningYouIn')}
        </p>
      )}

      {showPhone ? (
        <div className="mt-6">
          <PhoneAuth next={redirectDest ?? '/dashboard'} onBack={() => setShowPhone(false)} />
        </div>
      ) : (
      <>
      {/* Phone-first: the number is the primary way in, then Google. */}
      <button
        type="button"
        onClick={() => setShowPhone(true)}
        className={`mt-6 ${authButtonClass}`}
      >
        <Smartphone className="h-[18px] w-[18px]" /> {t('login.continueWithPhone')}
      </button>

      <div className="mt-3">
        <OAuthButtons next={redirectDest} />
      </div>

      <div className="relative my-5 flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-muted">{t('login.orUseEmail')}</span>
        <div className="flex-1 border-t border-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label={t('login.email')} error={errors.email} required>
          {(id) => <Input id={id} name="email" type="email" autoComplete="email" placeholder="you@example.com" />}
        </Field>
        <Field label={t('login.password')} error={errors.password} required>
          {(id) => <Input id={id} name="password" type="password" autoComplete="current-password" placeholder="••••••••" />}
        </Field>
        <Button type="submit" loading={loading} className="w-full">{t('login.signIn')}</Button>
      </form>
      </>
      )}

      <LegalConsent className="mt-5 text-center text-xs leading-5 text-muted" />

      <p className="mt-5 text-center text-sm text-muted">
        {t('login.newHere')}{' '}
        <Link href="/signup" className="font-medium text-brand-text hover:underline">{t('login.createAnAccount')}</Link>
      </p>
      <p className="mt-2 text-center text-sm text-muted">
        {t('login.kidLoggingIn')}{' '}
        <Link href="/kid-login" className="font-medium text-brand-text hover:underline">{t('login.useYourUsernameAmpPin')}</Link>
      </p>
    </div>
  );
}
