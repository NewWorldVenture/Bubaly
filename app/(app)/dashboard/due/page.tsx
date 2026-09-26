import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { BillsView } from '@/components/finance/bills-view';
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.dueReminders') };
}
export default async function Page() { await requireUserContext(); return <BillsView mode="due" />; }
