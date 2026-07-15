import type { Metadata } from 'next';
import { ErrorState } from '@/components/ui/states';
import { headers } from 'next/headers';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { GiftView, type GiftLinkRow, type PendingGift, type ChildOpt } from '@/components/wallet/gift-view';
import { PayHandleManager, type PayHandleRow } from '@/components/wallet/pay-handle-manager';

export const metadata: Metadata = { title: 'Wallet Gifts' };

export default async function WalletGiftPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [{ data: links, error: linksError }, { data: pending, error: pendingError }, { data: childWallets, error: childWalletsError }, { data: members, error: membersError }, { data: handles, error: handlesError }] = await Promise.all([
    supabase.from('gift_links').select('id, child_wallet_id, token, occasion, is_active, created_at').eq('family_id', familyId).order('created_at', { ascending: false }),
    supabase.from('gift_payments').select('id, child_wallet_id, giver_name, amount_cents, message, occasion, status, created_at').eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
    supabase.from('pay_handles').select('id, handle, child_wallet_id').eq('family_id', familyId).order('created_at', { ascending: false }),
  ]);
  if (linksError || pendingError || childWalletsError || membersError || handlesError) {
    console.error('[wallet-gift] Read failed', linksError ?? pendingError ?? childWalletsError ?? membersError ?? handlesError);
    return <ErrorState message="Could not load wallet gifts. Refresh and try again." />;
  }

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

  const payHandles: PayHandleRow[] = (handles ?? []).map((h) => ({
    id: h.id, handle: h.handle, childWalletId: h.child_wallet_id,
    childName: h.child_wallet_id ? nameByWallet.get(h.child_wallet_id) ?? null : null,
  }));

  // Public origin for displaying/copying Pay-ID URLs (falls back to canonical domain).
  const hdrs = await headers();
  const host = hdrs.get('x-forwarded-host') ?? hdrs.get('host') ?? 'www.bubaly.com';
  const proto = hdrs.get('x-forwarded-proto') ?? 'https';
  const baseUrl = `${proto}://${host}`;

  return (
    <div className="space-y-4">
      <PayHandleManager handles={payHandles} childOptions={childOptions} canManage={isManager(ctx.active.role)} baseUrl={baseUrl} />
      <GiftView links={linkRows} pending={pendingGifts} childOptions={childOptions} canManage={isManager(ctx.active.role)} />
    </div>
  );
}
