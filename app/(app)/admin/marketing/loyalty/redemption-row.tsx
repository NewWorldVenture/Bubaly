'use client';

import { useState, useTransition } from 'react';
import { Check, X, Loader2, Gift } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fulfillRedemptionAction, cancelRedemptionAction } from './actions';

export type Redemption = {
  id: string; reward_name: string; cost_points: number; status: string; code: string | null;
  notes: string | null; created_at: string; family_label: string;
};

const TONE: Record<string, 'warning' | 'success' | 'neutral'> = { pending: 'warning', fulfilled: 'success', cancelled: 'neutral' };
const inputCls = 'h-9 w-full rounded-lg border border-border bg-surface/60 px-3 text-sm focus-ring';

export function RedemptionRow({ redemption }: { redemption: Redemption }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const r = redemption;

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Gift className="h-4 w-4 text-brand" />
            <p className="font-semibold">{r.reward_name}</p>
            <Badge tone="brand">{r.cost_points.toLocaleString()} pts</Badge>
          </div>
          <p className="mt-1 text-xs text-muted">{r.family_label} · {new Date(r.created_at).toLocaleDateString()}</p>
          {r.code && <p className="mt-0.5 text-xs text-muted">Code: <span className="font-mono">{r.code}</span></p>}
          {r.notes && <p className="mt-0.5 text-xs text-muted">{r.notes}</p>}
        </div>
        <Badge tone={TONE[r.status] ?? 'neutral'} className="capitalize">{r.status}</Badge>
      </div>

      {r.status === 'pending' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2 text-xs">
          <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-success hover:underline"><Check className="h-3.5 w-3.5" /> Fulfill</button>
          <button onClick={() => start(async () => { await cancelRedemptionAction(r.id); })} disabled={pending} className="inline-flex items-center gap-1 text-muted hover:text-danger"><X className="h-3.5 w-3.5" /> Cancel &amp; refund</button>
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
        </div>
      )}

      {open && r.status === 'pending' && (
        <form action={(fd) => start(async () => { await fulfillRedemptionAction(fd); setOpen(false); })} className="mt-2 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="id" value={r.id} />
          <input name="code" placeholder="Fulfillment code (optional)" className={inputCls} />
          <input name="notes" placeholder="Notes (optional)" className={inputCls} />
          <div className="sm:col-span-2"><button className="inline-flex h-9 items-center rounded-lg bg-brand px-3 text-xs font-medium text-brand-fg">Mark fulfilled</button></div>
        </form>
      )}
    </div>
  );
}
