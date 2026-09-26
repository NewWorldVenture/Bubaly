import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { NotificationsModule } from '@/components/modules/notifications-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.familyNotifications') };
}

export default function FamilyNotificationsPage() {
  return <NotificationsModule />;
}
