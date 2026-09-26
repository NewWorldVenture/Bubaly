import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { ServicesHub } from '@/components/services/services-hub';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('freeTierSidebar.allServices') };
}

export default function ServicesPage() {
  return <ServicesHub />;
}
