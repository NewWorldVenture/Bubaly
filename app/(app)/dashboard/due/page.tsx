import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { BillsView } from '@/components/finance/bills-view';
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.dueReminders') };
}
// Every unpaid household bill and the total due: the rows /dashboard/bills and
// /dashboard/autopay render, behind the same two gates. The held 0509 still
// returns bills to a guest, so this page is what refuses one.
export default async function Page() { const ctx = await requireUserContext(); refuseGuest(ctx, '/dashboard/due'); await requireAal2(ctx, 'money', '/dashboard/due'); return <BillsView mode="due" />; }
