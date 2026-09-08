import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { PasswordsModule } from '@/components/modules/passwords-module';

export const metadata: Metadata = { title: 'Wi-Fi & Passwords' };

export default async function PasswordsPage() {
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'documents', '/dashboard/passwords');
  return <PasswordsModule />;
}
