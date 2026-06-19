import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignupForm } from '@/components/auth/signup-form';
import { LoadingBlock } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Sign up' };

export default function SignupPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SignupForm />
    </Suspense>
  );
}
