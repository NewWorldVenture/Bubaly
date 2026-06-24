import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { VolunteerModule } from '@/components/modules/volunteer-module';

export const metadata: Metadata = { title: 'Volunteer Hub' };

export default async function VolunteerPage() {
  await requireUserContext();
  return <VolunteerModule />;
}
