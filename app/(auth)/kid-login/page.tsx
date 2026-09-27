import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { KidLoginForm } from '@/components/auth/kid-login-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('kidLogin.kidSignIn') };
}

export default function KidLoginPage() {
  return <KidLoginForm />;
}
