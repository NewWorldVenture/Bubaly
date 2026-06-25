import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables, type StripeTables } from '@/lib/supabase/stripe-tables';
import { isManager } from '@/lib/constants/roles';
import { notFound, redirect } from 'next/navigation';
import { MoneyNav } from '@/components/money/money-nav';
import { CardDetail } from '@/components/money/card-detail';

export const metadata: Metadata = { title: 'Card Details — Bubaly Money' };

export default async function CardDetailPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params;
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) redirect('/money/cards');

  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withStripeTables(supabase);

  const [{ data: card }, { data: controls }, { data: auths }] = await Promise.all([
    db.from('stripe_issuing_cards')
      .select('*, child_wallets(id, member_id, family_members(display_name, color))')
      .eq('card_id', cardId)
      .eq('family_id', familyId)
      .maybeSingle(),
    db.from('card_controls').select('*').eq('card_id', cardId).maybeSingle(),
    db.from('stripe_authorizations')
      .select('*')
      .eq('card_id', cardId)
      .order('authorized_at', { ascending: false })
      .limit(50),
  ]);

  if (!card) notFound();

  type StripeCard = StripeTables['stripe_issuing_cards'];
  type StripeAuth = StripeTables['stripe_authorizations'];
  type CardCtrl = StripeTables['card_controls'];

  const typedCard = card as unknown as StripeCard & { child_wallets?: { family_members?: { display_name: string; color: string | null } } };
  const typedControls = controls as unknown as CardCtrl | null;
  const typedAuths = (auths ?? []) as unknown as StripeAuth[];

  const member = typedCard?.child_wallets?.family_members;

  return (
    <div className="space-y-6">
      <MoneyNav />
      <CardDetail
        card={{
          cardId: typedCard.card_id,
          type: typedCard.type as 'virtual' | 'physical',
          status: typedCard.status as 'active' | 'inactive' | 'canceled',
          last4: typedCard.last4,
          brand: typedCard.brand,
          expMonth: typedCard.exp_month,
          expYear: typedCard.exp_year,
          memberName: member?.display_name ?? 'Child',
          memberColor: member?.color ?? null,
        }}
        controls={typedControls}
        authorizations={typedAuths.map((a) => ({
          id: a.id,
          status: a.status as 'pending' | 'approved' | 'declined' | 'reversed' | 'closed',
          decision: a.decision as 'approved' | 'declined' | null,
          amountCents: a.amount_cents,
          merchantName: a.merchant_name,
          merchantCategory: a.merchant_category,
          authorizedAt: a.authorized_at,
        }))}
      />
    </div>
  );
}
