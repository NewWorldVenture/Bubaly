import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SecurityModule } from '@/components/modules/security-module';

export const metadata: Metadata = { title: 'Security Alerts' };

export default async function SecurityPage() {
  await requireFeature('/dashboard/security');
  return <SecurityModule />;
}
