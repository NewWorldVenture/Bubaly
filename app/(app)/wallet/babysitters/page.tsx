import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { BabysitterWalletView, type BabysitterProfile, type BabysitterPayment } from '@/components/wallet/babysitter-wallet-view';

export const metadata: Metadata = { title: 'Babysitters — Bubaly Wallet' };

export default async function BabysittersPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const canManage = isManager(ctx.active.role);
  const supabase = await createServer();

  const [{ data: profiles }, { data: payments }] = await Promise.all([
    supabase.from('babysitter_profiles').select('id, name, phone, email, rate_cents, notes')
      .eq('family_id', familyId).eq('is_active', true).order('name'),
    supabase.from('babysitter_payments').select('id, babysitter_id, hours, rate_cents, tip_cents, amount_cents, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(200),
  ]);

  const babysitters: BabysitterProfile[] = (profiles ?? []).map((p) => ({
    id: p.id, name: p.name, phone: p.phone, email: p.email,
    rateCents: p.rate_cents, notes: p.notes,
  }));

  const pmts: BabysitterPayment[] = (payments ?? []).map((p) => ({
    id: p.id, babysitterId: p.babysitter_id, hours: p.hours,
    rateCents: p.rate_cents, tipCents: p.tip_cents, amountCents: p.amount_cents,
    createdAt: p.created_at,
  }));

  return (
    <BabysitterWalletView canManage={canManage} babysitters={babysitters} payments={pmts} />
  );
}
