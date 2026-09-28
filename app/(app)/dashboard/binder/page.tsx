import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { BinderModule } from '@/components/modules/binder-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.householdBinder') };
}

export default async function BinderPage() {
  const ctx = await requireFeature('/dashboard/binder');
  await requireAal2(ctx, 'documents', '/dashboard/binder');
  return <BinderModule />;
}
