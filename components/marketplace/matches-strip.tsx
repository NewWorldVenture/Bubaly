'use client';

// The "Matches on the board" strip — marketplace supply↔demand intelligence.
// Renders the open "wanted" requests that the family's own supply already
// satisfies, each with a plain-language reason + Dismiss / Got it. Server computes
// + persists the matches; this only reflects + updates their status.

import { useState, useTransition } from 'react';
import { Sparkles, HandHeart, X, Check } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { setMatchStatusAction } from '@/app/(app)/marketplace/actions';
import type { EnrichedMatch } from '@/lib/marketplace/matches-server';

export function MarketplaceMatchesStrip({ matches }: { matches: EnrichedMatch[] }) {
  const { success, error: toastError } = useToast();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const visible = matches.filter((m) => !hidden.has(m.id));
  if (visible.length === 0) return null;

  const act = (id: string, status: 'dismissed' | 'actioned') => {
    setHidden((prev) => new Set(prev).add(id));
    startTransition(async () => {
      const res = await setMatchStatusAction(id, status);
      if (!res.ok) {
        setHidden((prev) => { const next = new Set(prev); next.delete(id); return next; });
        toastError(res.error);
      } else {
        success(status === 'actioned' ? 'Nice — marked as connected.' : 'Match dismissed.');
      }
    });
  };

  return (
    <section className="mb-5 rounded-2xl border border-brand/25 bg-brand/[0.04] p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-text" />
        <h2 className="text-sm font-semibold">Matches on the board</h2>
        <span className="ml-auto rounded-full bg-brand/12 px-2 py-0.5 text-xs font-medium text-brand-text">
          {visible.length}
        </span>
      </div>
      <ul className="space-y-2">
        {visible.slice(0, 6).map((m) => (
          <li
            key={m.id}
            className="flex items-start gap-3 rounded-xl border border-border bg-surface/60 p-3"
          >
            <HandHeart className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{m.reason}</p>
              <p className="mt-0.5 text-xs text-muted">
                {m.supplyKindLabel}
                {m.supplyMemberName ? ` · ${m.supplyMemberName}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => act(m.id, 'actioned')}
                disabled={pending}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-400"
                aria-label="Mark as connected"
              >
                <Check className="h-3 w-3" /> Got it
              </button>
              <button
                type="button"
                onClick={() => act(m.id, 'dismissed')}
                disabled={pending}
                className="inline-flex items-center rounded-lg border border-border px-2 py-1 text-xs text-muted hover:bg-elevated disabled:opacity-50"
                aria-label="Dismiss match"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
