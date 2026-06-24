import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SignupsModule } from '@/components/modules/signups-module';

export const metadata: Metadata = { title: 'Registrations & Signups | Bubaly' };

export default async function SignupsPage() {
  await requireFeature('/dashboard/signups');
  return <SignupsModule />;
}
