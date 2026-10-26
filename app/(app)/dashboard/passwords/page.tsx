import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { PasswordsModule } from '@/components/modules/passwords-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('passwords.wiFiPasswords') };
}

export default async function PasswordsPage() {
  // The vault is part of the Documents area (it steps up as `documents`), and
  // the catalog has no entry of its own: gated as /dashboard/files/* are.
  const ctx = await requireFeature('/dashboard/documents');
  await requireAal2(ctx, 'documents', '/dashboard/passwords');
  return <PasswordsModule />;
}
