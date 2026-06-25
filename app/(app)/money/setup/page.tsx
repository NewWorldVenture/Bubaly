import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables } from '@/lib/supabase/stripe-tables';
import { isManager } from '@/lib/constants/roles';
import { redirect } from 'next/navigation';
import { MoneySetup } from '@/components/money/stripe-setup';

export const metadata: Metadata = { title: 'Bubaly Money Setup' };

export default async function MoneySetupPage({ searchParams }: { searchParams: Promise<{ refresh?: string; return?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) redirect('/money');

  const supabase = await createServer();
  const db = withStripeTables(supabase);
  const familyId = ctx.active.familyId;

  const { data: account } = await db
    .from('stripe_connected_accounts')
    .select('account_id, status, charges_enabled, payouts_enabled, details_submitted')
    .eq('family_id', familyId)
    .maybeSingle();

  return (
    <MoneySetup
      account={account ?? null}
      returnedFromStripe={!!sp.return}
      refreshRequested={!!sp.refresh}
    />
  );
}
