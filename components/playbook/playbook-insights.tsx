'use client';

import { useState, useTransition } from 'react';
import { Sparkles, UtensilsCrossed, ShoppingCart, Repeat, Plus, Check, Loader2, X } from 'lucide-react';
import type { PlaybookInsight } from '@/lib/playbook/learn';
import { savePlaybookFactAction } from '@/app/(app)/dashboard/knowledge/actions';
import { cn } from '@/lib/utils/cn';

const ICON = (key: string) =>
  key.startsWith('meal:') ? UtensilsCrossed : key.startsWith('shopday:') ? ShoppingCart : Repeat;

// "What we've learned about your family" — surfaces Playbook insights derived
// from real behavior, each a one-tap save into the Knowledge Base. The family
// stays in control: nothing is saved until they accept it, and dismissals just
// hide the card for this view.
export function PlaybookInsights({ insights }: { insights: PlaybookInsight[] }) {
  const [items, setItems] = useState(insights);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (items.length === 0) return null;

  const save = (i: PlaybookInsight) => {
    setSavingKey(i.key);
    start(async () => {
      const res = await savePlaybookFactAction({ category: i.factCategory, label: i.label, value: i.value, detail: i.detail });
      setSavingKey(null);
      if (res.ok) {
        setSavedKeys((prev) => new Set(prev).add(i.key));
        setTimeout(() => setItems((prev) => prev.filter((x) => x.key !== i.key)), 900);
      }
    });
  };
  const dismiss = (key: string) => setItems((prev) => prev.filter((x) => x.key !== key));

  return (
    <section className="mb-5 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/[0.06] to-surface/40 p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand/15 text-brand"><Sparkles className="h-4 w-4" /></span>
        <div>
          <h2 className="text-sm font-semibold">What we’ve learned about your family</h2>
          <p className="text-xs text-muted">Patterns from how you actually live — save the ones worth keeping.</p>
        </div>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {items.map((i) => {
          const Icon = ICON(i.key);
          const saved = savedKeys.has(i.key);
          return (
            <div key={i.key} className="flex items-start gap-3 rounded-xl border border-border bg-surface/60 p-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand"><Icon className="h-3.5 w-3.5" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{i.label}: <span className="text-brand">{i.value}</span></p>
                <p className="text-xs text-muted">{i.detail}</p>
              </div>
              {saved ? (
                <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/12 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" /> Saved
                </span>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => save(i)}
                    disabled={pending && savingKey === i.key}
                    className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-brand/90 disabled:opacity-60"
                  >
                    {pending && savingKey === i.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Save
                  </button>
                  <button onClick={() => dismiss(i.key)} aria-label="Dismiss" className="grid h-6 w-6 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
