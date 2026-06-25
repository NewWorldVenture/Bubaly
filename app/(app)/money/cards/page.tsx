import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables, type StripeTables } from '@/lib/supabase/stripe-tables';
import { isManager } from '@/lib/constants/roles';
import { MoneyNav } from '@/components/money/money-nav';
import { CardManager } from '@/components/money/card-manager';

export const metadata: Metadata = { title: 'Cards — Bubaly Money' };

export default async function CardsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const manager = isManager(ctx.active.role);
  const supabase = await createServer();
  const db = withStripeTables(supabase);

  const [
    { data: cards },
    { data: controls },
    { data: childWallets },
    { data: members },
    { data: account },
    { data: designs },
  ] = await Promise.all([
    db.from('stripe_issuing_cards').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
    db.from('card_controls').select('*').eq('family_id', familyId),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    db.from('stripe_connected_accounts').select('account_id, charges_enabled').eq('family_id', familyId).maybeSingle(),
    db.from('card_designs').select('*').eq('is_active', true).order('sort_order'),
  ]);

  type Card = StripeTables['stripe_issuing_cards'];
  type CardCtrl = StripeTables['card_controls'];
  type Design = StripeTables['card_designs'];

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const controlsByCard = new Map(((controls ?? []) as CardCtrl[]).map((c) => [c.card_id, c]));
  const walletByMember = new Map((childWallets ?? []).map((w) => [w.member_id, w.id]));

  const cardViews = ((cards ?? []) as Card[]).map((c) => {
    const wallet = childWallets?.find((w) => w.id === c.child_wallet_id);
    const member = wallet ? memberById.get(wallet.member_id) : null;
    const ctrl = controlsByCard.get(c.card_id);
    return {
      ...c,
      memberName: member?.display_name ?? 'Child',
      memberColor: member?.color ?? null,
      controls: ctrl ?? null,
    };
  });

  const walletOptions = (childWallets ?? []).map((w) => {
    const member = memberById.get(w.member_id);
    return { id: w.id, memberId: w.member_id, memberName: member?.display_name ?? 'Child' };
  });

  return (
    <div className="space-y-6">
      <MoneyNav />
      <CardManager
        cards={cardViews}
        wallets={walletOptions}
        manager={manager}
        isReady={account?.charges_enabled ?? false}
        designs={((designs ?? []) as Design[]).map((d) => ({ id: d.id, name: d.name, stripeDesignId: d.stripe_design_id ?? null, requiresPhysical: d.requires_physical }))}
      />
    </div>
  );
}
