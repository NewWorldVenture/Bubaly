import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { NotificationsModule } from '@/components/modules/notifications-module';
import { EnablePushButton } from '@/components/native/enable-push-button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.notifications') };
}

export default async function NotificationsPage() {
  await requireFeature('/dashboard/notifications');
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <EnablePushButton />
      </div>
      <NotificationsModule />
    </div>
  );
}
