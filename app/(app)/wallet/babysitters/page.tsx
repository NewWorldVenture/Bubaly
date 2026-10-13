import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { ErrorState } from '@/components/ui/states';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { readsHouseholdMoney } from '@/lib/finance/household-money';
import { BabysittersView, type BabysitterRow, type PaymentRow } from '@/components/wallet/babysitters-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.babysitters') };
}

export default async function WalletBabysittersPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext(); refuseGuest(ctx, '/wallet/babysitters');
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  // The babysitter payouts are a parent's or adult's (the held 0514,
  // lib/finance/household-money.ts). A teen, a child or a caregiver (who may be
  // one of the sitters) was shown every sitter's pay history, tips, hours and
  // total paid; for them the payments are not read at all, and the page says
  // whose they are. The sitter list itself is not part of that rule.
  const seesPayouts = readsHouseholdMoney(ctx.active.role);

  const [{ data: profiles, error: profilesError }, { data: payments, error: paymentsError }] = await settleAll([
    supabase.from('babysitter_profiles')
      .select('id, name, phone, email, rate_cents, notes')
      .eq('family_id', familyId).eq('is_active', true).order('name'),
    seesPayouts
      ? supabase.from('babysitter_payments')
        .select('id, babysitter_id, hours, rate_cents, tip_cents, amount_cents, status, created_at')
        .eq('family_id', familyId).order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as { id: string; babysitter_id: string | null; hours: number | null; rate_cents: number | null; tip_cents: number; amount_cents: number; status: string; created_at: string }[], error: null }),
  ]);
  if (profilesError || paymentsError) {
    console.error('[wallet-babysitters] Read failed', profilesError ?? paymentsError);
    return <ErrorState message={t('babysitters.couldNotLoadBabysitterPayments')} />;
  }

  const sitters: BabysitterRow[] = (profiles ?? []).map((p) => ({
    id: p.id, name: p.name, phone: p.phone, email: p.email, rateCents: p.rate_cents, notes: p.notes,
  }));
  const paymentRows: PaymentRow[] = (payments ?? []).map((p) => ({
    id: p.id, babysitterId: p.babysitter_id, hours: p.hours, rateCents: p.rate_cents,
    tipCents: p.tip_cents, amountCents: p.amount_cents, status: p.status, createdAt: p.created_at,
  }));

  return <BabysittersView sitters={sitters} payments={paymentRows} canManage={isManager(ctx.active.role)} seesPayouts={seesPayouts} />;
}
