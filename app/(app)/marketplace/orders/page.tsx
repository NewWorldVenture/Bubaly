import type { Metadata } from 'next';
import { AlertTriangle, Receipt } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { OrderControls, ReviewForm } from '@/components/marketplace/order-controls';
import { HandoffPanel, type HandoffData } from '@/components/marketplace/handoff-panel';
import type { HandoffStatus, HandoffRole, LocationKind } from '@/lib/marketplace/handoff';
import { formatCents } from '@/lib/marketplace/listings';
import { marketplaceServiceFeeCents, orderFeeBreakdown } from '@/lib/marketplace/fee-policy';
import { returnStatus, returnLabel } from '@/lib/marketplace/returns';
import { cn } from '@/lib/utils/cn';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Orders · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const RETURN_TONE: Record<string, string> = {
  muted: 'bg-border/60 text-muted',
  info: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  danger: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  ok: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
};

const STATUS_CHIP: Record<string, string> = {
  requested: 'bg-amber-500/12 text-amber-600 dark:text-amber-400',
  confirmed: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
  active: 'bg-brand/12 text-brand-text',
  returned: 'bg-violet-500/12 text-violet-600 dark:text-violet-400',
  completed: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  cancelled: 'bg-border/60 text-muted',
};

export default async function MarketplaceOrdersPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const selfId = ctx.active.member.id;
  const now = new Date();
  const dataWarnings: string[] = [];

  const { data: orders, error: ordersError } = await sb
    .from('marketplace_orders')
    .select('id, listing_id, buyer_member, seller_member, kind, status, amount_cents, ends_on, returned_at, created_at')
    .eq('family_id', familyId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (ordersError) {
    console.error('[marketplace-orders] Orders read failed', ordersError);
    return <ErrorState message="Could not load your marketplace orders. Refresh and try again." />;
  }

  // Honest fee disclosure: the Bubaly service fee is applied only when Super
  // Admin has enabled it (same non-secret config the billing page reads). When
  // off, the buyer pays exactly the sale price and the seller keeps all of it.
  let serviceFeeCents = 0;
  try {
    const { data: feeCfg, error: feeError } = await createServiceClient()
      .from('stripe_settings').select('enabled, service_fee_cents, service_fee_price_id').eq('id', 'singleton').maybeSingle();
    if (feeError) {
      console.error('[marketplace-orders] Service fee settings read failed', feeError);
      dataWarnings.push('Service fee settings');
    } else {
      serviceFeeCents = marketplaceServiceFeeCents(feeCfg);
    }
  } catch (error) {
    console.error('[marketplace-orders] Service fee settings read failed', error);
    dataWarnings.push('Service fee settings');
    /* stripe_settings may not exist yet — no fee */
  }

  const mine = (orders ?? []).filter((o) => o.buyer_member === selfId || o.seller_member === selfId);
  const listingIds = [...new Set(mine.map((o) => o.listing_id))];
  const { data: listings, error: listingsError } = listingIds.length
    ? await sb.from('marketplace_listings').select('id, title').in('id', listingIds)
    : { data: [], error: null };
  if (listingsError) {
    console.error('[marketplace-orders] Listing titles read failed', listingsError);
    dataWarnings.push('Listing titles');
  }
  const titleOf = new Map((listings ?? []).map((l) => [l.id, l.title]));

  const { data: members, error: membersError } = await sb.from('family_members').select('id, display_name').eq('family_id', familyId);
  if (membersError) {
    console.error('[marketplace-orders] Family members read failed', membersError);
    dataWarnings.push('Family members');
  }
  const nameOf = (id: string | null) => members?.find((m) => m.id === id)?.display_name ?? 'Someone';

  // Which completed orders have I already reviewed?
  const { data: myReviews, error: reviewsError } = await sb
    .from('marketplace_reviews')
    .select('order_id')
    .eq('family_id', familyId)
    .eq('reviewer_member', selfId);
  if (reviewsError) {
    console.error('[marketplace-orders] Review history read failed', reviewsError);
    dataWarnings.push('Review history');
  }
  const reviewed = new Set((myReviews ?? []).map((r) => r.order_id));

  // Pickup & hand-off coordination, one per order.
  const orderIds = mine.map((o) => o.id);
  const { data: handoffs, error: handoffsError } = orderIds.length
    ? await sb.from('marketplace_handoffs')
        .select('order_id, proposer_role, meet_at, location_label, location_kind, status, confirm_code, calendar_event_id, notes')
        .in('order_id', orderIds)
    : { data: [], error: null };
  if (handoffsError) {
    console.error('[marketplace-orders] Handoff coordination read failed', handoffsError);
    dataWarnings.push('Handoff coordination');
  }
  const handoffByOrder = new Map((handoffs ?? []).map((h) => [h.order_id, h]));
  const handoffFor = (orderId: string): HandoffData => {
    const h = handoffByOrder.get(orderId);
    if (!h) return null;
    return {
      status: h.status as HandoffStatus, proposerRole: h.proposer_role as HandoffRole,
      meetAt: h.meet_at, locationLabel: h.location_label, locationKind: h.location_kind as LocationKind,
      confirmCode: h.confirm_code, notes: h.notes, hasCalendar: !!h.calendar_event_id,
    };
  };

  return (
    <div>
      <PageHeader title={t('marketplaceOrders.orders')} description="Every exchange you’re part of — confirm, hand off, complete, and review." />
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={t('marketplaceOrders.marketplaceOrdersDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{t('marketplaceOrders.someOrderDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}{t('marketplaceOrders.theOrderListRemainsAvailable')}</p>
        </div>
      )}
      {mine.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          <Receipt className="mx-auto mb-2 h-6 w-6" />
          {t('marketplaceOrders.noOrdersYetAcceptAnOffer')}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {mine.map((o) => {
            const role = o.buyer_member === selfId ? 'buyer' : 'seller';
            const other = role === 'buyer' ? nameOf(o.seller_member) : nameOf(o.buyer_member);
            const fee = o.amount_cents > 0 ? orderFeeBreakdown(o.amount_cents, serviceFeeCents) : null;
            const retStatus = returnStatus({ kind: o.kind, status: o.status, endsOn: o.ends_on, returnedAt: o.returned_at }, now);
            const retLabel = retStatus === 'not_applicable' ? null : returnLabel(retStatus, o.ends_on, now);
            return (
              <li key={o.id} className="rounded-xl border border-border bg-surface/60 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', STATUS_CHIP[o.status] ?? STATUS_CHIP.cancelled)}>{o.status}</span>
                  {retLabel && (
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', RETURN_TONE[retLabel.tone])}>
                      {retLabel.text}
                    </span>
                  )}
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{titleOf.get(o.listing_id) ?? 'Listing'}</p>
                  {o.amount_cents > 0 && <span className="text-sm font-semibold text-brand-text">{formatCents(o.amount_cents)}</span>}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {role === 'buyer' ? `You’re getting this from ${other}` : `${other} is getting this from you`} · {o.kind}
                </p>
                {fee && (
                  <p className="mt-1 text-xs text-muted">
                    {role === 'buyer' ? (
                      <>{t('orders.youPay')}{' '}<span className="font-semibold text-brand-text">{formatCents(fee.buyerTotalCents)}</span>
                        {fee.serviceFeeCents > 0 && (
                          <span> · {formatCents(fee.subtotalCents)} item + {formatCents(fee.serviceFeeCents)} Bubaly service fee</span>
                        )}
                      </>
                    ) : (
                      <>{t('orders.youReceive')}{' '}<span className="font-semibold text-emerald-600 dark:text-emerald-400">{formatCents(fee.sellerNetCents)}</span>
                        <span> · Bubaly takes {formatCents(fee.platformReceivesCents)}</span>
                      </>
                    )}
                  </p>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <OrderControls orderId={o.id} status={o.status} />
                  {o.status === 'completed' && !reviewed.has(o.id) && <ReviewForm orderId={o.id} />}
                  {o.status === 'completed' && reviewed.has(o.id) && (
                    <p className="text-xs text-muted">{t('orders.youReviewedThisExchange')}</p>
                  )}
                </div>
                {/* Pickup coordination for physical exchanges still in flight. */}
                {['confirmed', 'active'].includes(o.status) && o.kind !== 'donate' && (
                  <HandoffPanel orderId={o.id} viewerRole={role === 'buyer' ? 'buyer' : 'seller'} handoff={handoffFor(o.id)} />
                )}
                {handoffFor(o.id)?.status === 'completed' && !['confirmed', 'active'].includes(o.status) && (
                  <HandoffPanel orderId={o.id} viewerRole={role === 'buyer' ? 'buyer' : 'seller'} handoff={handoffFor(o.id)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
