import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { ExpensesModule } from '@/components/modules/expenses-module';

export const metadata: Metadata = { title: 'Expense Splitting' };

export default async function ExpensesPage() {
  await requireFeature('/dashboard/expenses');
  return <ExpensesModule />;
}
