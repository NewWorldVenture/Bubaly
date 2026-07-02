import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { PaymentsView } from '@/components/finance/payments-view';
export const metadata: Metadata = { title: 'Payment History' };
export default async function Page() { await requireUserContext(); return <PaymentsView />; }
