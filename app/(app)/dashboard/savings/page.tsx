import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { SavingsView } from '@/components/finance/savings-view';
export const metadata: Metadata = { title: 'Savings Goals' };
export default async function Page() { const ctx = await requireUserContext(); await requireAal2(ctx, 'money', '/dashboard/savings'); return <SavingsView />; }
