import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { PlaybookModule } from '@/components/modules/playbook-module';

export const metadata: Metadata = { title: 'Family Playbook | Bubaly' };

export default async function PlaybookPage() {
  await requireUserContext();
  return <PlaybookModule />;
}
