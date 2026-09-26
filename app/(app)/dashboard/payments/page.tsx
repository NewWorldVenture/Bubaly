import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { PaymentsView } from '@/components/finance/payments-view';
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.paymentHistory') };
}
export default async function Page() { const ctx = await requireUserContext(); await requireAal2(ctx, 'money', '/dashboard/payments'); return <PaymentsView />; }
