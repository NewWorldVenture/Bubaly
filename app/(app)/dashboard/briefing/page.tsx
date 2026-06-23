import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { BriefingModule } from '@/components/modules/briefing-module';

export const metadata: Metadata = { title: 'Daily Briefing | Bubaly' };

export default async function BriefingPage() {
  await requireFeature('/dashboard/briefing');
  return <BriefingModule />;
}
