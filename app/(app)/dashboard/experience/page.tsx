import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { ExperienceScorecardModule } from '@/components/modules/experience-scorecard-module';

export const metadata: Metadata = { title: 'Experience Scorecard | Bubaly' };

export default async function ExperiencePage() {
  await requireUserContext();
  return <ExperienceScorecardModule />;
}
