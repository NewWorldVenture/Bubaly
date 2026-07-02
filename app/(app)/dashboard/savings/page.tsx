import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { SavingsView } from '@/components/finance/savings-view';
export const metadata: Metadata = { title: 'Savings Goals' };
export default async function Page() { await requireUserContext(); return <SavingsView />; }
