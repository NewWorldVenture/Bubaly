import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { BillsView } from '@/components/finance/bills-view';
export const metadata: Metadata = { title: 'Auto Pay' };
export default async function Page() { await requireUserContext(); return <BillsView mode="autopay" />; }
