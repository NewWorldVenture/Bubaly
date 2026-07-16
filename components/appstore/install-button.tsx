'use client';

import { useState, useTransition } from 'react';
import { Check, Plus, Loader2 } from 'lucide-react';
import { installAppAction, uninstallAppAction } from '@/app/(app)/dashboard/app-store/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

export function InstallButton({ appId, installed: initial, available = true }: {
  appId: string; installed: boolean; available?: boolean;
}) {
  const [installed, setInstalled] = useState(initial);
  const [pending, start] = useTransition();
  const { success, error: toastError } = useToast();

  if (!available) {
    return <span className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted">Unavailable</span>;
  }

  const toggle = () => {
    if (pending) return;
    const next = !installed;
    setInstalled(next);
    start(async () => {
      const res = next ? await installAppAction(appId) : await uninstallAppAction(appId);
      if (res.ok) success(next ? 'Installed' : 'Removed');
      else { setInstalled(!next); toastError(res.error); }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-busy={pending}
      aria-pressed={installed}
      className={cn(
        'inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-60',
        installed
          ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15'
          : 'bg-brand text-brand-fg hover:opacity-90',
      )}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : installed ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
      {installed ? 'Installed' : 'Install'}
    </button>
  );
}
