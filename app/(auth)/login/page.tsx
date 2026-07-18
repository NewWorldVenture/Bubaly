import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from '@/components/auth/login-form';
import { LoadingBlock } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Log in', robots: { index: false, follow: false } };

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LoginForm />
    </Suspense>
  );
}
