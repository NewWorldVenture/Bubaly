'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, ChevronDown } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import type { ContactBand, ContactScoreFactor } from '@/lib/marketing/contact-score';
import { recomputeLeadScoresAction } from './actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function RecomputeButton() {
  const [pending, startTransition] = useTransition();
  const { success, error } = useToast();
  return (
    <button
      onClick={() => startTransition(async () => {
        try { const { scored } = await recomputeLeadScoresAction(); success(`Recomputed ${scored} lead score${scored === 1 ? '' : 's'}`); }
        catch { error('Could not recompute scores'); }
      })}
      disabled={pending}
      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-60"
    >
      <RefreshCw className={cn('h-4 w-4', pending && 'animate-spin')} /> {pending ? 'Recomputing…' : 'Recompute'}
    </button>
  );
}

export function LeadRow({
  name, email, lifecycle, score, band, bandLabel, bandTint, factors,
}: {
  name: string;
  email: string | null;
  lifecycle: string;
  score: number;
  band: ContactBand;
  bandLabel: string;
  bandTint: string;
  factors: ContactScoreFactor[];
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-elevated/50">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-sm font-black tabular-nums ring-1 ring-white/10">
          {score}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', bandTint)}>{bandLabel}</span>
          </span>
          <span className="block truncate text-xs text-muted">{email ?? 'no email'} · {lifecycle}</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t border-border bg-bg/40 px-4 py-3">
          {/* Score bar */}
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-brand" style={{ width: `${score}%` }} />
          </div>
          {factors.length === 0 ? (
            <p className="text-xs text-muted">{t('adminMarketingLeadScoresLeadScoresClient.noPositiveSignalsYetThisContact')}</p>
          ) : (
            <ul className="space-y-1.5">
              {factors.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-fg">{f.label}</span>
                  <span className="font-bold tabular-nums text-emerald-400">+{f.points}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-muted">{t('adminMarketingLeadScoresLeadScoresClient.theScoreIsTheSumOf')}</p>
        </div>
      )}
    </li>
  );
}
