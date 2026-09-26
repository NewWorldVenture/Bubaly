import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { PasswordsModule } from '@/components/modules/passwords-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('passwords.wiFiPasswords') };
}

export default async function PasswordsPage() {
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'documents', '/dashboard/passwords');
  return <PasswordsModule />;
}
