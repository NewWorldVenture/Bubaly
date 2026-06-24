'use client';

import { useState } from 'react';
import type { ReferralConfig } from '@/lib/referrals/core';

export function ReferralSettingsForm({ config, action }: {
  config: ReferralConfig;
  action: (formData: FormData) => Promise<void>;
}) {
  const [saved, setSaved] = useState(false);

  return (
    <form
      action={async (fd) => { await action(fd); setSaved(true); setTimeout(() => setSaved(false), 2000); }}
      className="space-y-3 text-sm"
    >
      <label className="flex items-center justify-between gap-2">
        <span>Program enabled</span>
        <input type="checkbox" name="enabled" defaultChecked={config.enabled} className="h-4 w-4 accent-[var(--brand)]" />
      </label>
      <label className="block">
        <span className="text-xs text-muted">Referrer reward ($)</span>
        <input type="number" name="referrerRewardDollars" min="0" step="0.5" defaultValue={(config.referrerRewardCents / 100).toString()}
          className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3" />
      </label>
      <label className="block">
        <span className="text-xs text-muted">Referred reward ($)</span>
        <input type="number" name="referredRewardDollars" min="0" step="0.5" defaultValue={(config.referredRewardCents / 100).toString()}
          className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3" />
      </label>
      <label className="block">
        <span className="text-xs text-muted">Reward label</span>
        <input type="text" name="rewardLabel" defaultValue={config.rewardLabel}
          className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3" />
      </label>
      <button type="submit" className="w-full rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand/90">
        {saved ? 'Saved ✓' : 'Save settings'}
      </button>
    </form>
  );
}
