import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { ExpensesModule } from '@/components/modules/expenses-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Expense Splitting' };

export default async function ExpensesPage() {
  const ctx = await requireFeature('/dashboard/expenses');
  await requireAal2(ctx, 'money', '/dashboard/expenses');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('expenses.expenseSplitting')}</h1>
      <ExpensesModule />
    </>
  );
}
