import type { Metadata } from 'next';
import { NotificationsModule } from '@/components/modules/notifications-module';

export const metadata: Metadata = { title: 'Notifications' };

export default function NotificationsPage() {
  return <NotificationsModule />;
}
