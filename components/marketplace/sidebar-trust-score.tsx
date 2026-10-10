'use client';

// The "Your Trust Score" card at the bottom of the marketplace rail (matches the
// design). Scored CLIENT-side by the same pure engine the server uses, from the
// member's live reviews + completed orders + listings — which the server reads
// (readTrustScoreInputsAction): the order read probes for a column the proposed
// economy SQL adds, and a browser making that probe gets a 400 that Chromium
// reports as a console error on every marketplace page, fallback or not.
// Best-effort, so a pre-0151 database just renders the "Building" baseline.

import { useEffect, useState } from 'react';
import { readTrustScoreInputsAction } from '@/app/(app)/marketplace/actions';
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
        const result = await readTrustScoreInputsAction();
        // A late answer, or one for the account this card no longer shows,
        // changes nothing here; the effect for the current account has its own.
        if (!active || (result.ok && result.memberId !== selfId)) return;
        if (!result.ok) {
          // The server logged the read that failed; the card says so below.
          setFailed(true);
          return;
        }
        setFailed(false);
        setListed(result.listingsPosted);
        setTrust(computeTrustScore({
          ratingsReceived: result.ratingsReceived, ordersCompleted: result.ordersCompleted, listingsPosted: result.listingsPosted,
        }));
      } catch {
        // The action could not be reached (network, a session that ended):
        // said, not scored, like any other failed read.
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
