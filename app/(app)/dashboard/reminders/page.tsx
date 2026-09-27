import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { RemindersModule } from '@/components/modules/reminders-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('reminders.smartReminders') };
}

export default function RemindersPage() {
  return <RemindersModule />;
}
