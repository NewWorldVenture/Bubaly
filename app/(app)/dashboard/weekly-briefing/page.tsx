import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { WeeklyBriefingModule } from '@/components/modules/weekly-briefing-module';

export const metadata: Metadata = { title: 'Weekly Briefing | Bubaly' };

export default async function WeeklyBriefingPage() {
  await requireFeature('/dashboard/weekly-briefing');
  return <WeeklyBriefingModule />;
}
