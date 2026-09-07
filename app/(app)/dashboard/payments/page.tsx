import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { PaymentsView } from '@/components/finance/payments-view';
export const metadata: Metadata = { title: 'Payment History' };
export default async function Page() { const ctx = await requireUserContext(); await requireAal2(ctx, 'money', '/dashboard/payments'); return <PaymentsView />; }
