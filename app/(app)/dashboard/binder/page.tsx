import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { BinderModule } from '@/components/modules/binder-module';

export const metadata: Metadata = { title: 'Household Binder' };

export default async function BinderPage() {
  await requireFeature('/dashboard/binder');
  return <BinderModule />;
}
