import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { MessagesModule } from '@/components/modules/messages-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('home.familyMessages') };
}

export default function MessagesPage() {
  return <MessagesModule />;
}
