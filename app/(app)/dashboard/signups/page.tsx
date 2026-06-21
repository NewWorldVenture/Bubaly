import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { SignupsModule } from '@/components/modules/signups-module';

export const metadata: Metadata = { title: 'Registrations & Signups | FamilyOS' };

export default async function SignupsPage() {
  await requirePlanLevel(1);
  return <SignupsModule />;
}
