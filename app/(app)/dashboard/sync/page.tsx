import type { Metadata } from 'next';
import Link from 'next/link';
import {
  RefreshCw, CheckCircle2, XCircle, AlertTriangle, CalendarClock,
  ListChecks, StickyNote, Plug,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  CAPABILITIES, PROVIDER_LABELS, type SyncProvider, type SyncItemKind,
} from '@/lib/sync/capabilities';

export const metadata: Metadata = { title: 'Sync' };
export const dynamic = 'force-dynamic';

const ITEM_KINDS: { key: SyncItemKind; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'calendar', label: 'Calendars', icon: CalendarClock },
  { key: 'reminder', label: 'Reminders', icon: ListChecks },
  { key: 'note', label: 'Notes', icon: StickyNote },
];

const CONNECTABLE: SyncProvider[] = ['google', 'microsoft', 'apple', 'amazon'];

function CapabilityCell({ provider, kind }: { provider: SyncProvider; kind: SyncItemKind }) {
  const c = CAPABILITIES[provider][kind];
  if (c.read && c.write) {
    return <Badge tone="success" title={c.limitation}>Two-way</Badge>;
  }
  if (c.write && !c.read) {
    return <Badge tone="accent" title={c.limitation}>Export only</Badge>;
  }
  if (c.read && !c.write) {
    return <Badge tone="brand" title={c.limitation}>Import only</Badge>;
  }
  return <Badge tone="neutral" title={c.limitation}>Not supported</Badge>;
}

export default async function SyncHubPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const [connections, calendars, openConflicts, recentRuns] = await Promise.all([
    supabase.from('sync_connections').select('id, provider, health, sync_status, last_synced_at, last_error').eq('family_id', familyId),
    supabase.from('sync_calendars').select('id, feed_enabled', { count: 'exact' }).eq('family_id', familyId),
    supabase.from('sync_conflicts').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'open'),
    supabase.from('sync_job_runs').select('id, provider, status, items_imported, items_exported, conflicts_found, finished_at').eq('family_id', familyId).order('started_at', { ascending: false }).limit(5),
  ]);

  const conns = connections.data ?? [];
  const healthy = conns.filter((c) => c.health === 'healthy').length;
  const errored = conns.filter((c) => c.health === 'error').length;
  const conflictCount = openConflicts.count ?? 0;
  const calendarCount = calendars.count ?? 0;
  const runs = recentRuns.data ?? [];

  return (
    <div className="module-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Sync</h1>
          <p className="mt-1 text-sm text-muted">
            Connect Google, Microsoft/Outlook, Apple, and Alexa to two-way sync your calendars, reminders, and notes.
          </p>
        </div>
        <Link href="/dashboard/sync/accounts" className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-medium text-brand-fg shadow-glow transition hover:opacity-90">
          <Plug className="h-4 w-4" /> Connect an account
        </Link>
      </div>

      {/* Health stats */}
      <div className="grid-stats">
        <div className="stat-card">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success"><CheckCircle2 className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{healthy}</p><p className="mt-1 text-xs text-muted">Healthy connections</p></div>
        </div>
        <div className="stat-card">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-danger/10 text-danger"><XCircle className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{errored}</p><p className="mt-1 text-xs text-muted">Connection errors</p></div>
        </div>
        <div className="stat-card">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-warning/10 text-warning"><AlertTriangle className="h-5 w-5" /></div>
          <Link href="/dashboard/sync/conflicts"><p className="text-xl font-bold leading-none">{conflictCount}</p><p className="mt-1 text-xs text-muted">Open conflicts</p></Link>
        </div>
        <div className="stat-card">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand"><CalendarClock className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{calendarCount}</p><p className="mt-1 text-xs text-muted">Synced calendars</p></div>
        </div>
      </div>

      {/* Capability matrix — the honest source of truth */}
      <Card>
        <h2 className="mb-1 text-base font-semibold">What each provider supports</h2>
        <p className="mb-4 text-xs text-muted">
          Based on each provider&rsquo;s real public API. Where two-way sync isn&rsquo;t possible we say so plainly rather than pretend.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="pb-2 pr-4 font-medium">Provider</th>
                {ITEM_KINDS.map((k) => (
                  <th key={k.key} className="pb-2 pr-4 font-medium">
                    <span className="inline-flex items-center gap-1.5"><k.icon className="h-3.5 w-3.5" /> {k.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(['google', 'microsoft', 'apple', 'amazon'] as SyncProvider[]).map((p) => (
                <tr key={p} className="border-t border-border">
                  <td className="py-2.5 pr-4 font-medium">{PROVIDER_LABELS[p]}</td>
                  {ITEM_KINDS.map((k) => (
                    <td key={k.key} className="py-2.5 pr-4"><CapabilityCell provider={p} kind={k.key} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Quick connect */}
      <Card>
        <h2 className="mb-4 text-base font-semibold">Connect an account</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {CONNECTABLE.map((p) => {
            const conn = conns.find((c) => c.provider === p);
            return (
              <Link
                key={p}
                href={`/dashboard/sync/accounts/${p}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-4 transition hover:border-brand/40"
              >
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand"><Plug className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{PROVIDER_LABELS[p]}</p>
                  <p className="text-xs text-muted">{conn ? `Status: ${conn.sync_status}` : 'Not connected'}</p>
                </div>
                {conn ? <Badge tone={conn.health === 'error' ? 'danger' : 'success'}>{conn.health}</Badge> : <Badge tone="neutral">Connect</Badge>}
              </Link>
            );
          })}
        </div>
      </Card>

      {/* Recent activity */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Recent sync activity</h2>
          <Link href="/dashboard/sync/history" className="text-xs text-brand hover:underline">View history</Link>
        </div>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">No sync runs yet. Connect an account to get started.</p>
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3 text-sm">
                <RefreshCw className="h-4 w-4 text-muted" />
                <span className="font-medium">{PROVIDER_LABELS[(r.provider as SyncProvider)] ?? r.provider}</span>
                <span className="text-xs text-muted">↓{r.items_imported} ↑{r.items_exported}{r.conflicts_found ? ` · ${r.conflicts_found} conflicts` : ''}</span>
                <Badge tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'neutral'} className="ml-auto">{r.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
