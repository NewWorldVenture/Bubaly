import type { Metadata } from 'next';
import { NotificationsModule } from '@/components/modules/notifications-module';

export const metadata: Metadata = { title: 'Family Notifications' };

export default function FamilyNotificationsPage() {
  return <NotificationsModule />;
}
