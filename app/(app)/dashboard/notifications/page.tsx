import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { NotificationsModule } from '@/components/modules/notifications-module';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  await requirePlanLevel(1);
  return <NotificationsModule />;
}
