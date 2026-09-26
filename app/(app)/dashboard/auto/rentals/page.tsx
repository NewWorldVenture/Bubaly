import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getRentals } from '@/lib/auto/queries';
import { RentalsClient } from '@/components/auto/rentals-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('pageTitle.rentals')} · ${t('displayComfort.auto')}` };
}
export const dynamic = 'force-dynamic';

export default async function RentalsPage() {
  const ctx = await requirePlanLevel(1);
  const rentals = await getRentals(ctx.active.familyId);
  return <RentalsClient rentals={rentals} />;
}
