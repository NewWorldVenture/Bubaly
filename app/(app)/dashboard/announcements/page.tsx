import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { AnnouncementsModule } from '@/components/modules/announcements-module';

export const metadata: Metadata = { title: 'Announcements' };

export default async function AnnouncementsPage() {
  await requireFeature('/dashboard/announcements');
  return <AnnouncementsModule />;
}
