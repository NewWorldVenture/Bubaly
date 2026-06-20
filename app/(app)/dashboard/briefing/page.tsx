import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { BriefingModule } from '@/components/modules/briefing-module';

export const metadata: Metadata = { title: 'Daily Briefing | FamilyOS' };

export default async function BriefingPage() {
  await requirePlanLevel(1);
  return <BriefingModule />;
}
