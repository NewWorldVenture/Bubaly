'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Radio, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toast';
import {
  flagLabel, flagGroup, flagNeedsApproval, GROUP_LABELS, GROUP_ORDER, type FlagGroup,
} from '@/lib/wallet/feature-flags';
import { setFeatureFlagAction } from '@/app/(app)/admin/feature-flags/actions';

export type FlagRow = { key: string; enabled: boolean; description: string | null };

function Toggle({ on, busy, onClick }: { on: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50',
        on ? 'bg-brand' : 'bg-elevated border border-border',
      )}
    >
      <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition', on ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

export function FeatureFlagsPanel({ flags }: { flags: FlagRow[] }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [state, setState] = useState<Record<string, boolean>>(() => Object.fromEntries(flags.map((f) => [f.key, f.enabled])));
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function toggle(key: string) {
    const next = !state[key];
    setState((s) => ({ ...s, [key]: next })); // optimistic
    setBusyKey(key);
    const res = await setFeatureFlagAction({ key, enabled: next });
    setBusyKey(null);
    if (!res.ok) {
      setState((s) => ({ ...s, [key]: !next })); // revert
      toastError(res.error ?? 'Could not update flag');
      return;
    }
    success(`${flagLabel(key)} ${next ? 'enabled' : 'disabled'}`);
    router.refresh();
  }

  const byGroup = new Map<FlagGroup, FlagRow[]>();
  for (const f of flags) {
    const g = flagGroup(f.key);
    const arr = byGroup.get(g) ?? [];
    arr.push(f);
    byGroup.set(g, arr);
  }

  return (
    <div className="space-y-5">
      {GROUP_ORDER.filter((g) => byGroup.has(g)).map((group) => (
        <div key={group}>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
            {group === 'stripe' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
            {GROUP_LABELS[group]}
          </h3>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/40 divide-y divide-border">
            {(byGroup.get(group) ?? []).map((f) => {
              const on = state[f.key] ?? f.enabled;
              return (
                <div key={f.key} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">{flagLabel(f.key)}</span>
                      <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted">{f.key}</code>
                      {flagNeedsApproval(f.key) && (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-500">Stripe approval</span>
                      )}
                    </div>
                    {f.description && <p className="mt-0.5 text-xs text-muted">{f.description}</p>}
                  </div>
                  <span className={cn('text-xs font-medium', on ? 'text-brand' : 'text-muted')}>{on ? 'On' : 'Off'}</span>
                  <Toggle on={on} busy={busyKey === f.key} onClick={() => toggle(f.key)} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Radio className="h-3.5 w-3.5" />
        Changes apply immediately platform-wide. Only enable Stripe-gated flags once your Stripe account has the matching capability approved.
      </p>
    </div>
  );
}
