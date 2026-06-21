import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getContractors } from '@/lib/home/queries';
import { ProsClient } from '@/components/home/pros-client';

export const metadata: Metadata = { title: 'Find a Pro · Home' };
export const dynamic = 'force-dynamic';

export default async function ProsPage({ searchParams }: { searchParams: Promise<{ trade?: string }> }) {
  const ctx = await requirePlanLevel(1);
  const { trade } = await searchParams;
  const contractors = await getContractors(ctx.active.familyId);
  return <ProsClient contractors={contractors} initialTrade={trade ?? ''} />;
}
