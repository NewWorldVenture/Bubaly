import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { NotesModule } from '@/components/modules/notes-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.notes') };
}

export default function NotesPage() {
  return <NotesModule />;
}
