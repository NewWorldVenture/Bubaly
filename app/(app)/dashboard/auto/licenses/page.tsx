import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getLicenses } from '@/lib/auto/queries';
import { LicensesClient } from '@/components/auto/licenses-client';

export const metadata: Metadata = { title: 'Licenses · Auto' };
export const dynamic = 'force-dynamic';

export default async function LicensesPage() {
  const ctx = await requirePlanLevel(1);
  const supabase = await createServer();
  const [licenses, { data: members }] = await Promise.all([
    getLicenses(ctx.active.familyId),
    supabase.from('family_members').select('id, display_name').eq('family_id', ctx.active.familyId).eq('is_active', true),
  ]);
  return <LicensesClient licenses={licenses} members={members ?? []} />;
}
