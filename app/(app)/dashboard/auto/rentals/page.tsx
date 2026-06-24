import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getRentals } from '@/lib/auto/queries';
import { RentalsClient } from '@/components/auto/rentals-client';

export const metadata: Metadata = { title: 'Rentals · Auto' };
export const dynamic = 'force-dynamic';

export default async function RentalsPage() {
  const ctx = await requirePlanLevel(1);
  const rentals = await getRentals(ctx.active.familyId);
  return <RentalsClient rentals={rentals} />;
}
