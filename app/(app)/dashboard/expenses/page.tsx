import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { ExpensesModule } from '@/components/modules/expenses-module';

export const metadata: Metadata = { title: 'Expense Splitting' };

export default async function ExpensesPage() {
  const ctx = await requireFeature('/dashboard/expenses');
  await requireAal2(ctx, 'money', '/dashboard/expenses');
  return <ExpensesModule />;
}
