import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { BudgetsView } from '@/components/finance/budgets-view';
export const metadata: Metadata = { title: 'Budget Planner' };
export default async function Page() { const ctx = await requireUserContext(); await requireAal2(ctx, 'money', '/dashboard/budgets'); return <BudgetsView />; }
