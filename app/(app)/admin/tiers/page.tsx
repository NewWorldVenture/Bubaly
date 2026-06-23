import type { Metadata } from 'next';
import { SlidersHorizontal, Lock } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import {
  featuresByGroup, effectiveTier, FEATURE_TIERS, TIER_LABELS,
  type FeatureOverrides, type FeatureTier,
} from '@/lib/features/catalog';
import { setFeatureTierAction } from '../actions';

export const metadata: Metadata = { title: 'Admin · Tier & Features', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TIER_BTN: Record<FeatureTier, string> = {
  free: 'bg-emerald-500 text-white border-emerald-500',
  basic: 'bg-sky-500 text-white border-sky-500',
  plus: 'bg-violet-500 text-white border-violet-500',
  off: 'bg-zinc-500 text-white border-zinc-500',
};

export default async function TiersPage() {
  const supabase = createServiceClient();
  const { data: rows } = await supabase.from('feature_settings').select('key, tier');
  const overrides: FeatureOverrides = {};
  for (const r of rows ?? []) {
    if ((FEATURE_TIERS as string[]).includes(r.tier)) overrides[r.key] = r.tier as FeatureTier;
  }
  const groups = featuresByGroup();

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="h-5 w-5 text-brand" />
        <div>
          <h1 className="text-lg font-bold">Tier &amp; Features</h1>
          <p className="text-xs text-muted">Control which subscription tier unlocks each feature, across the whole platform.</p>
        </div>
      </div>

      <Card className="text-sm">
        <p className="font-medium">How it works</p>
        <ul className="mt-2 space-y-1 text-muted">
          <li><span className="font-semibold text-emerald-500">Free</span> — visible to Free, Basic &amp; Plus.</li>
          <li><span className="font-semibold text-sky-500">Basic</span> — visible to Basic &amp; Plus; <span className="inline-flex items-center gap-0.5"><Lock className="h-3 w-3" />locked</span> for Free.</li>
          <li><span className="font-semibold text-violet-500">Plus</span> — visible to Plus only; locked for Basic &amp; Free.</li>
          <li><span className="font-semibold text-zinc-500">Off</span> — hidden for everyone (super-admins still preview).</li>
        </ul>
      </Card>

      {groups.map((group) => (
        <Card key={group.group}>
          <h2 className="mb-3 text-sm font-semibold">{group.group}</h2>
          <div className="space-y-2">
            {group.items.map((f) => {
              const current = effectiveTier(f.key, overrides);
              const isOverridden = overrides[f.key] != null;
              return (
                <div key={f.key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{f.label}</p>
                    <p className="truncate font-mono text-[11px] text-muted">
                      {f.key} · default {TIER_LABELS[f.defaultTier]}{isOverridden ? ' · overridden' : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {FEATURE_TIERS.map((tier) => (
                      <form key={tier} action={setFeatureTierAction}>
                        <input type="hidden" name="key" value={f.key} />
                        <input type="hidden" name="tier" value={tier} />
                        <button
                          className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                            current === tier ? TIER_BTN[tier] : 'border-border text-muted hover:bg-elevated'
                          }`}
                          aria-pressed={current === tier}
                        >
                          {TIER_LABELS[tier]}
                        </button>
                      </form>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}
