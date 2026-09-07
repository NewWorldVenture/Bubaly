'use client';

// Owner-facing offer inbox on a listing detail page. Accept hands the item off
// (one atomic, ownership-checked RPC that claims the listing, accepts this
// offer, declines the rest, and records the order); Decline drops a single
// offer. Both re-fetch the page so status/claimed state stays truthful.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, HandHeart } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';

export type InboxOffer = {
  id: string;
  name: string;
  kindLabel: string;
  amount: string;
  message: string;
};

export function OfferInbox({ offers }: { offers: InboxOffer[] }) {
  const t = useTranslations();
  const [rows, setRows] = useState(offers);
  const [busy, setBusy] = useState<string | null>(null);
  const { success, error: toastError } = useToast();
  const router = useRouter();

  async function act(id: string, action: 'accept' | 'decline') {
    if (busy) return;
    setBusy(id);
    try {
      const sb = createClient();
      const { error: err } =
        action === 'accept'
          ? await sb.rpc('marketplace_accept_offer', { p_offer: id })
          : await sb.rpc('marketplace_decline_offer', { p_offer: id });
      if (err) { toastError(describeDbError(err)); return; }
      setRows((r) => r.filter((x) => x.id !== id));
      success(action === 'accept' ? 'Accepted — handed off' : 'Offer declined');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return null;

  return (
    <div className="mt-5 w-full rounded-xl border border-border bg-surface/50 p-4">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-fg">
        <HandHeart className="h-4 w-4 text-brand-text" /> {t('offerInbox.offersOnYourListing')}
      </h2>
      <ul className="space-y-2.5">
        {rows.map((o) => (
          <li key={o.id} className="flex items-center gap-3 rounded-lg border border-border bg-elevated/50 p-2.5">
            <Avatar name={o.name} size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm">
                <span className="font-medium text-fg">{o.name}</span>
                <span className="text-xs text-muted">· {o.kindLabel}{o.amount ? ` · ${o.amount}` : ''}</span>
              </div>
              {o.message && <p className="line-clamp-1 text-xs text-muted">{o.message}</p>}
            </div>
            <Button size="sm" onClick={() => act(o.id, 'accept')} disabled={busy === o.id} aria-busy={busy === o.id} className="h-7 gap-1 text-xs">
              <Check className="h-3.5 w-3.5" /> Accept
            </Button>
            <button
              type="button"
              onClick={() => act(o.id, 'decline')}
              disabled={busy === o.id}
              aria-label={`Decline ${o.name}'s offer`}
              className="rounded p-1.5 text-muted transition hover:bg-elevated hover:text-amber-400 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
