'use client';

// The "Your Trust Score" card at the bottom of the marketplace rail (matches the
// design). Computed CLIENT-side from the member's live reviews + completed orders
// + listings via the same pure engine the server uses — best-effort, so a
// pre-0151 database just renders the "Building" baseline.

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useApp } from '@/components/app/app-context';
import { computeTrustScore, TRUST_BAND_LABELS, type TrustScore } from '@/lib/marketplace/trust';
import { useTranslations } from '@/components/i18n/locale-provider';

export function SidebarTrustScore() {
  const tr = useTranslations();
  const { familyId, selfMember } = useApp();
  const selfId = selfMember?.id ?? null;
  const [trust, setTrust] = useState<TrustScore | null>(null);
  const [listed, setListed] = useState(0);

  useEffect(() => {
    if (!selfId) return;
    let active = true;
    (async () => {
      try {
        const sb = createClient();
        const [reviews, orders, listings] = await Promise.all([
          sb.from('marketplace_reviews').select('rating').eq('family_id', familyId).eq('reviewee_member', selfId),
          sb.from('marketplace_orders').select('status, buyer_member, seller_member').eq('family_id', familyId),
          sb.from('marketplace_listings').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('member_id', selfId),
        ]);
        if (!active) return;
        const ratings = (reviews.data ?? []).map((r) => r.rating as number);
        const completed = (orders.data ?? []).filter(
          (o) => o.status === 'completed' && (o.buyer_member === selfId || o.seller_member === selfId),
        ).length;
        const count = listings.count ?? 0;
        setListed(count);
        setTrust(computeTrustScore({ ratingsReceived: ratings, ordersCompleted: completed, listingsPosted: count }));
      } catch {
        if (active) setTrust(computeTrustScore({ ratingsReceived: [], ordersCompleted: 0, listingsPosted: 0 }));
      }
    })();
    return () => { active = false; };
  }, [familyId, selfId]);

  const t = trust ?? computeTrustScore({ ratingsReceived: [], ordersCompleted: 0, listingsPosted: 0 });

  return (
    <div className="rounded-xl border border-border bg-surface/60 p-3">
      <p className="text-xs font-semibold">{tr('sidebarTrustScore.yourTrustScore')}</p>
      <div className="mt-1.5 flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 border-brand/40 bg-brand/10 text-sm font-bold text-brand-text">
          {t.stars.toFixed(1)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{TRUST_BAND_LABELS[t.band]}</p>
          <p className="text-[10px] text-muted">{t.score}/100</p>
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border/50">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${t.score}%` }} />
      </div>
      <p className="mt-1.5 text-[10px] text-muted">
        {listed > 0 ? `${listed} item${listed === 1 ? '' : 's'} listed` : 'List an item to start building trust'}
      </p>
    </div>
  );
}
