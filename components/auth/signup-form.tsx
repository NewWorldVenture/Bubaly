'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { signUpSchema, fieldErrors } from '@/lib/validation';

export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

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
      const { data, error } = await supabase.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: {
          data: { full_name: parsed.data.fullName },
          emailRedirectTo: `${origin}/auth/callback?next=/onboarding`,
        },
      });
      if (error) throw error;
      // If email confirmation is required, there's no active session yet.
      if (!data.session) {
        setCheckEmail(true);
        return;
      }
      router.push('/onboarding');
      router.refresh();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not create account');
    } finally {
      setLoading(false);
    }
  }

  if (checkEmail) {
    return (
      <div className="glass-card flex flex-col items-center p-8 text-center animate-fade-in">
        <MailCheck className="h-12 w-12 text-brand" />
        <h1 className="mt-4 text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-muted">
          We sent a confirmation link to verify your address. Click it to finish setting up your family.
        </p>
        <Link href="/login" className="mt-6 text-sm font-medium text-brand hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  const plan = params.get('plan');

  return (
    <div className="glass-card p-7 animate-fade-in">
      <h1 className="text-2xl font-semibold tracking-tight">Create your family</h1>
      <p className="mt-1 text-sm text-muted">
        Start free{plan ? ` on the ${plan} plan` : ''} — no credit card required.
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <Field label="Your name" error={errors.fullName} required>
          {(id) => <Input id={id} name="fullName" autoComplete="name" placeholder="Jordan Rivera" autoFocus />}
        </Field>
        <Field label="Email" error={errors.email} required>
          {(id) => <Input id={id} name="email" type="email" autoComplete="email" placeholder="you@example.com" />}
        </Field>
        <Field label="Password" error={errors.password} hint="At least 8 characters" required>
          {(id) => <Input id={id} name="password" type="password" autoComplete="new-password" placeholder="••••••••" />}
        </Field>
        <Button type="submit" loading={loading} className="w-full">Create account</Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">Sign in</Link>
      </p>
    </div>
  );
}
