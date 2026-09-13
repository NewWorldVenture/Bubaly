import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RecoveryForm } from '@/components/auth/recovery-form';
import { LoadingBlock } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Password recovery', robots: { index: false, follow: false } };

export default function RecoveryPage() {
  return <Suspense fallback={<LoadingBlock />}><RecoveryForm /></Suspense>;
}
