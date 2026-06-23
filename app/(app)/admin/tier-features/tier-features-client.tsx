'use client';

import { useState, useTransition } from 'react';
import { Power, Gift, Star, Crown, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toast';
import { FEATURE_CATALOG, FEATURE_SECTIONS, type FeatureTier } from '@/lib/constants/feature-catalog';
import { TIER_LABELS } from '@/lib/features/tiers';
import { setFeatureTierAction, resetFeatureTiersAction } from './actions';

const TIERS: { tier: FeatureTier; icon: typeof Power; on: string }[] = [
  { tier: 'off', icon: Power, on: 'bg-slate-600 text-white' },
  { tier: 'free', icon: Gift, on: 'bg-emerald-600 text-white' },
  { tier: 'basic', icon: Star, on: 'bg-blue-600 text-white' },
  { tier: 'plus', icon: Crown, on: 'bg-violet-600 text-white' },
];

export function TierFeaturesClient({ resolved }: { resolved: Record<string, FeatureTier> }) {
  const { success, error } = useToast();
  const [state, setState] = useState<Record<string, FeatureTier>>(resolved);
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  function choose(key: string, tier: FeatureTier) {
    if (state[key] === tier) return;
    const prev = state[key];
    setState((s) => ({ ...s, [key]: tier }));
    setBusyKey(key);
    startTransition(async () => {
      const res = await setFeatureTierAction(key, tier);
      setBusyKey(null);
      if (!res.ok) {
        setState((s) => ({ ...s, [key]: prev }));
        error('Could not update — admin only');
      } else {
        success(`Saved · pricing updated`);
      }
    });
  }

  function resetAll() {
    if (!confirm('Reset every feature back to the default tier?')) return;
    startTransition(async () => {
      const res = await resetFeatureTiersAction();
      if (res.ok) { window.location.reload(); } else { error('Could not reset'); }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Set the minimum tier for each service. <strong className="text-fg">Off</strong> hides it everywhere;
          changes flow live to the pricing page and in-app gating.
        </p>
        <button onClick={resetAll} disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-fg">
          <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
        </button>
      </div>

      {FEATURE_SECTIONS.map((section) => {
        const items = FEATURE_CATALOG.filter((f) => f.section === section);
        if (items.length === 0) return null;
        return (
          <div key={section} className="rounded-2xl border border-border bg-surface/30 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">{section}</h2>
            <div className="space-y-2">
              {items.map((f) => (
                <div key={f.key} className="flex flex-col gap-2 rounded-xl border border-border bg-surface/50 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">{f.label}</p>
                    <p className="text-xs text-muted">default: {TIER_LABELS[f.defaultTier]}{f.href ? ` · ${f.href}` : ''}</p>
                  </div>
                  <div className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-bg p-0.5">
                    {TIERS.map(({ tier, icon: Icon, on }) => {
                      const active = state[f.key] === tier;
                      return (
                        <button key={tier} onClick={() => choose(f.key, tier)} disabled={pending && busyKey === f.key}
                          className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition',
                            active ? on : 'text-muted hover:text-fg')}>
                          <Icon className="h-3.5 w-3.5" /> {TIER_LABELS[tier].replace(' Tier', '')}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
