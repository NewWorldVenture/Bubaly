import type { Metadata } from 'next';
import { ErrorState } from '@/components/ui/states';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { BabysittersView, type BabysitterRow, type PaymentRow } from '@/components/wallet/babysitters-view';

export const metadata: Metadata = { title: 'Babysitters' };

export default async function WalletBabysittersPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: profiles, error: profilesError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from('babysitter_profiles')
      .select('id, name, phone, email, rate_cents, notes')
      .eq('family_id', familyId).eq('is_active', true).order('name'),
    supabase.from('babysitter_payments')
      .select('id, babysitter_id, hours, rate_cents, tip_cents, amount_cents, status, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(50),
  ]);
  if (profilesError || paymentsError) {
    console.error('[wallet-babysitters] Read failed', profilesError ?? paymentsError);
    return <ErrorState message="Could not load babysitter payments. Refresh and try again." />;
  }

  const sitters: BabysitterRow[] = (profiles ?? []).map((p) => ({
    id: p.id, name: p.name, phone: p.phone, email: p.email, rateCents: p.rate_cents, notes: p.notes,
  }));
  const paymentRows: PaymentRow[] = (payments ?? []).map((p) => ({
    id: p.id, babysitterId: p.babysitter_id, hours: p.hours, rateCents: p.rate_cents,
    tipCents: p.tip_cents, amountCents: p.amount_cents, status: p.status, createdAt: p.created_at,
  }));

  return <BabysittersView sitters={sitters} payments={paymentRows} canManage={isManager(ctx.active.role)} />;
}
