import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { TodosModule } from '@/components/modules/todos-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.toDoLists') };
}

export default function TodosPage() {
  return <TodosModule />;
}
