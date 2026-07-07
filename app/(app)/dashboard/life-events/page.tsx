import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { LifeEventsModule } from '@/components/modules/life-events-module';

export const metadata: Metadata = { title: 'Life & Milestones | Bubaly' };

export default async function LifeEventsPage() {
  await requireUserContext();
  return <LifeEventsModule />;
}
