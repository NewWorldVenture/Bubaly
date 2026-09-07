import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { BillsView } from '@/components/finance/bills-view';
export const metadata: Metadata = { title: 'Auto Pay' };
export default async function Page() { const ctx = await requireUserContext(); await requireAal2(ctx, 'money', '/dashboard/autopay'); return <BillsView mode="autopay" />; }
