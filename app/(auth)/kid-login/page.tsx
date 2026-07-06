import type { Metadata } from 'next';
import { KidLoginForm } from '@/components/auth/kid-login-form';

export const metadata: Metadata = { title: 'Kid sign in' };

export default function KidLoginPage() {
  return <KidLoginForm />;
}
