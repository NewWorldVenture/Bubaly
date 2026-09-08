import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { BinderModule } from '@/components/modules/binder-module';

export const metadata: Metadata = { title: 'Household Binder' };

export default async function BinderPage() {
  const ctx = await requireFeature('/dashboard/binder');
  await requireAal2(ctx, 'documents', '/dashboard/binder');
  return <BinderModule />;
}
