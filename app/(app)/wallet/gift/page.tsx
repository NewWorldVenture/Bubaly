import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { GiftView, type GiftLinkRow, type PendingGift, type ChildOpt } from '@/components/wallet/gift-view';

export const metadata: Metadata = { title: 'Wallet Gifts' };

export default async function WalletGiftPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: links }, { data: pending }, { data: childWallets }, { data: members }] = await Promise.all([
    supabase.from('gift_links').select('id, child_wallet_id, token, occasion, is_active, created_at').eq('family_id', familyId).order('created_at', { ascending: false }),
    supabase.from('gift_payments').select('id, child_wallet_id, giver_name, amount_cents, message, occasion, status, created_at').eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
  ]);

  const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const nameByWallet = new Map((childWallets ?? []).map((c) => [c.id, nameByMember.get(c.member_id) ?? 'Child']));

  const linkRows: GiftLinkRow[] = (links ?? []).map((l) => ({
    id: l.id, token: l.token, occasion: l.occasion, isActive: l.is_active,
    childName: l.child_wallet_id ? nameByWallet.get(l.child_wallet_id) ?? null : null,
  }));
  const pendingGifts: PendingGift[] = (pending ?? []).map((p) => ({
    id: p.id, giverName: p.giver_name, amountCents: p.amount_cents, message: p.message, occasion: p.occasion,
    childName: p.child_wallet_id ? nameByWallet.get(p.child_wallet_id) ?? null : null,
  }));
  const childOptions: ChildOpt[] = (childWallets ?? []).map((c) => ({ id: c.id, name: nameByMember.get(c.member_id) ?? 'Child' }));

  return <GiftView links={linkRows} pending={pendingGifts} childOptions={childOptions} canManage={isManager(ctx.active.role)} />;
}
