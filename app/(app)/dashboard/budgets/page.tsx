import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { BudgetsView } from '@/components/finance/budgets-view';
export const metadata: Metadata = { title: 'Budget Planner' };
export default async function Page() { await requireUserContext(); return <BudgetsView />; }
