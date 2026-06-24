import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { JournalModule } from '@/components/modules/journal-module';

export const metadata: Metadata = { title: 'Journal' };

export default async function JournalPage() {
  await requireFeature('/dashboard/journal');
  return <JournalModule />;
}
