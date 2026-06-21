import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { WeeklyBriefingModule } from '@/components/modules/weekly-briefing-module';

export const metadata: Metadata = { title: 'Weekly Briefing | FamilyOS' };

export default async function WeeklyBriefingPage() {
  await requirePlanLevel(2);
  return <WeeklyBriefingModule />;
}
