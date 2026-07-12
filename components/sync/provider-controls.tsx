'use client';

import { useState } from 'react';
import { RefreshCw, Unplug, CheckCircle2, AlertTriangle } from 'lucide-react';

type RunResult = { imported: number; exported: number; skipped: number; conflicts: number; error?: string };

/**
 * Sync-now + Disconnect for ANY registry provider (R9) — the generic sibling of
 * GoogleControls. "Sync now" drives the provider-agnostic /api/sync/run;
 * Disconnect posts to the generic revoke route.
 */
export function ProviderControls({ provider }: { provider: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function syncNow() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/sync/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json()) as RunResult & { error?: string };
      if (!res.ok || data.error) setError(data.error ?? `Sync failed (${res.status})`);
      setResult(data);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={syncNow}
          disabled={busy}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg shadow-glow transition hover:opacity-90 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <form action={`/api/sync/${provider}/disconnect`} method="post">
          <button
            type="submit"
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium transition hover:bg-elevated"
          >
            <Unplug className="h-4 w-4" /> Disconnect
          </button>
        </form>
      </div>

      {result && !error && (
        <div className="flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 p-3 text-sm text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            Synced — imported {result.imported}, exported {result.exported}, skipped {result.skipped}
            {result.conflicts ? `, ${result.conflicts} conflict(s) need review` : ''}.
          </span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-danger/25 bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}
    </div>
  );
}
