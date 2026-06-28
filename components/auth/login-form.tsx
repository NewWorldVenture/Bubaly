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
import { resolveLandingPathAction } from '@/app/(auth)/actions';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [showPhone, setShowPhone] = useState(false);

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
      const redirectParam = params.get('redirect');
      // Resolve server-side so super admins (DB seed OR env/code allowlist)
      // land on the admin console even before migration 0008 is applied.
      const destination = redirectParam || (await resolveLandingPathAction());
      router.push(destination);
      router.refresh();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="glass-card p-7 animate-fade-in sm:p-8">
      <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your family.</p>

      {showPhone ? (
        <div className="mt-6">
          <PhoneAuth next="/dashboard" onBack={() => setShowPhone(false)} />
        </div>
      ) : (
      <>
      <div className="mt-6">
        <OAuthButtons />
      </div>

      <button
        type="button"
        onClick={() => setShowPhone(true)}
        className={`mt-3 ${authButtonClass}`}
      >
        <Smartphone className="h-[18px] w-[18px]" /> Continue with phone
      </button>

      <div className="relative my-5 flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-muted">or</span>
        <div className="flex-1 border-t border-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" error={errors.email} required>
          {(id) => <Input id={id} name="email" type="email" autoComplete="email" placeholder="you@example.com" />}
        </Field>
        <Field label="Password" error={errors.password} required>
          {(id) => <Input id={id} name="password" type="password" autoComplete="current-password" placeholder="••••••••" />}
        </Field>
        <Button type="submit" loading={loading} className="w-full">Sign in</Button>
      </form>
      </>
      )}

      <LegalConsent className="mt-5 text-center text-xs leading-5 text-muted" />

      <p className="mt-5 text-center text-sm text-muted">
        New here?{' '}
        <Link href="/signup" className="font-medium text-brand hover:underline">Create an account</Link>
      </p>
    </div>
  );
}
