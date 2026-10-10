'use client';

// The "Your Trust Score" card at the bottom of the marketplace rail (matches the
// design). Computed CLIENT-side from the member's live reviews + completed orders
// + listings via the same pure engine the server uses — best-effort, so a
// pre-0151 database just renders the "Building" baseline.

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { settleAll } from '@/lib/supabase/settle';
import { readFamilyOrders } from '@/lib/marketplace/schema-compat';
import { useApp } from '@/components/app/app-context';
import { computeTrustScore, TRUST_BAND_LABEL_KEYS, type TrustScore } from '@/lib/marketplace/trust';
import { useTranslations } from '@/components/i18n/locale-provider';

export function SidebarTrustScore() {
  const tr = useTranslations();
  const { familyId, selfMember } = useApp();
  const selfId = selfMember?.id ?? null;
  const [trust, setTrust] = useState<TrustScore | null>(null);
  const [listed, setListed] = useState(0);
  // A failed read is said, not scored: a zero baseline is a real-looking
  // number the family would take as their standing.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!selfId) return;
    let active = true;
    (async () => {
      try {
        const sb = createClient();
        const [reviews, orders, listings] = await settleAll([
          sb.from('marketplace_reviews').select('rating').eq('family_id', familyId).eq('reviewee_member', selfId),
          // Either party's family, so an order this member won from another
          // household counts too (lib/marketplace/schema-compat.ts).
          readFamilyOrders(familyId, (scope) => scope(sb.from('marketplace_orders').select('status, buyer_member, seller_member'))),
          sb.from('marketplace_listings').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('member_id', selfId),
        ]);
        if (!active) return;
        if (reviews.error || orders.error || listings.error) {
          console.error('[marketplace] trust score read failed', reviews.error ?? orders.error ?? listings.error);
          setFailed(true);
          return;
        }
        setFailed(false);
        const ratings = (reviews.data ?? []).map((r) => r.rating as number);
        const completed = (orders.data ?? []).filter(
          (o) => o.status === 'completed' && (o.buyer_member === selfId || o.seller_member === selfId),
        ).length;
        const count = listings.count ?? 0;
        setListed(count);
        setTrust(computeTrustScore({ ratingsReceived: ratings, ordersCompleted: completed, listingsPosted: count }));
      } catch (error) {
        console.error('[marketplace] trust score read threw', error);
        if (active) setFailed(true);
      }
    })();
    return () => { active = false; };
  }, [familyId, selfId]);

  if (failed) {
    return (
      <div className="rounded-xl border border-border bg-surface/60 p-3">
        <p className="text-xs font-semibold">{tr('sidebarTrustScore.yourTrustScore')}</p>
        <p role="status" className="mt-1.5 text-[11px] text-muted">{tr('sidebarTrustScore.couldNotLoad')}</p>
      </div>
    );
  }
  const t = trust ?? computeTrustScore({ ratingsReceived: [], ordersCompleted: 0, listingsPosted: 0 });

  return (
    <div className="rounded-xl border border-border bg-surface/60 p-3">
      <p className="text-xs font-semibold">{tr('sidebarTrustScore.yourTrustScore')}</p>
      <div className="mt-1.5 flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 border-brand/40 bg-brand/10 text-sm font-bold text-brand-text">
          {t.stars.toFixed(1)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{tr(TRUST_BAND_LABEL_KEYS[t.band])}</p>
          <p className="text-[10px] text-muted">{t.score}/100</p>
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border/50">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${t.score}%` }} />
      </div>
      <p className="mt-1.5 text-[10px] text-muted">
        {listed === 1 ? tr('sidebarTrustScore.oneItemListed')
          : listed > 1 ? tr('sidebarTrustScore.itemsListed', { count: listed })
          : tr('sidebarTrustScore.listAnItem')}
      </p>
    </div>
  );
}
