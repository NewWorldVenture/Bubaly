import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { AnnouncementsModule } from '@/components/modules/announcements-module';

export const metadata: Metadata = { title: 'Announcements' };

export default async function AnnouncementsPage() {
  await requireUserContext();
  return <AnnouncementsModule />;
}
