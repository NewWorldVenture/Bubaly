import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { ExpensesModule } from '@/components/modules/expenses-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.expenseSplitting') };
}

export default async function ExpensesPage() {
  const ctx = await requireFeature('/dashboard/expenses');
  await requireAal2(ctx, 'money', '/dashboard/expenses');
  return <ExpensesModule />;
}
