import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { CreateMemory } from '@/components/memories/create-memory';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('createMemory.createMemory') };
}

export default function CreateMemoryPage() {
  return <CreateMemory />;
}
