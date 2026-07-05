import type { Metadata } from 'next';
import { RefreshCw, Plug, AlertTriangle, Webhook, KeyRound } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CAPABILITIES, PROVIDER_LABELS, type SyncProvider, type SyncItemKind } from '@/lib/sync/capabilities';
import { hasEncryptionKey } from '@/lib/sync/crypto';

export const metadata: Metadata = { title: 'Sync Admin', robots: { index: false } };
export const dynamic = 'force-dynamic';

const KINDS: SyncItemKind[] = ['calendar', 'reminder', 'note'];

export default async function AdminSyncPage() {
  const supabase = createServiceClient();

  const [conns, errors, deadJobs, webhookFails, providers] = await Promise.all([
    supabase.from('sync_connections').select('id, health', { count: 'exact' }),
    supabase.from('sync_provider_errors').select('id', { count: 'exact', head: true }).eq('is_fatal', true),
    supabase.from('sync_jobs').select('id', { count: 'exact', head: true }).eq('status', 'dead_letter'),
    supabase.from('sync_webhook_events').select('id', { count: 'exact', head: true }).eq('signature_ok', false),
    supabase.from('sync_providers').select('provider, label, is_enabled, auth_kind'),
  ]);

  const connRows = conns.data ?? [];
  const activeConns = conns.count ?? connRows.length;
  const erroredConns = connRows.filter((c) => c.health === 'error').length;

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Sync Platform</h1>
        <p className="mt-1 text-sm text-muted">Provider health, failed jobs, and connection status across all families.</p>
      </div>

      <div className="grid-stats">
        <Stat icon={Plug} label="Active connections" value={activeConns} tone="bg-brand/10 text-brand" />
        <Stat icon={AlertTriangle} label="Connections in error" value={erroredConns} tone="bg-danger/10 text-danger" />
        <Stat icon={RefreshCw} label="Dead-letter jobs" value={deadJobs.count ?? 0} tone="bg-warning/10 text-warning" />
        <Stat icon={Webhook} label="Bad webhook signatures" value={webhookFails.count ?? 0} tone="bg-accent/10 text-accent" />
      </div>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted" />
          <h2 className="text-base font-semibold">Credential encryption</h2>
          {hasEncryptionKey()
            ? <Badge tone="success">SYNC_TOKEN_KEY configured</Badge>
            : <Badge tone="danger">SYNC_TOKEN_KEY missing</Badge>}
        </div>
        <p className="text-xs text-muted">
          Provider tokens are AES-256-GCM encrypted before storage. Without a key, no OAuth connection can be persisted —
          this is intentional fail-closed behaviour, not a silent fallback to plaintext.
        </p>
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-semibold">Provider catalog</h2>
        <div className="table-responsive">
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-3 py-2 font-medium">Provider</th>
                <th className="px-3 py-2 font-medium">Auth</th>
                <th className="px-3 py-2 font-medium">Calendar</th>
                <th className="px-3 py-2 font-medium">Reminder</th>
                <th className="px-3 py-2 font-medium">Note</th>
                <th className="px-3 py-2 font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {(['google', 'microsoft', 'apple', 'amazon'] as SyncProvider[]).map((p) => {
                const dbRow = (providers.data ?? []).find((r) => r.provider === p);
                return (
                  <tr key={p}>
                    <td className="px-3 py-2.5 font-medium">{PROVIDER_LABELS[p]}</td>
                    <td className="px-3 py-2.5 text-muted">{dbRow?.auth_kind ?? '—'}</td>
                    {KINDS.map((k) => {
                      const c = CAPABILITIES[p][k];
                      const tone = c.read && c.write ? 'success' : c.read || c.write ? 'brand' : 'neutral';
                      const label = c.read && c.write ? 'Two-way' : c.write ? 'Export' : c.read ? 'Import' : 'No';
                      return <td key={k} className="px-3 py-2.5"><Badge tone={tone}>{label}</Badge></td>;
                    })}
                    <td className="px-3 py-2.5">
                      <Badge tone={dbRow?.is_enabled === false ? 'neutral' : 'success'}>{dbRow?.is_enabled === false ? 'Off' : 'On'}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </div>
      </Card>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon className="h-5 w-5" /></div>
      <div><p className="text-xl font-bold leading-none">{value.toLocaleString()}</p><p className="mt-1 text-xs text-muted">{label}</p></div>
    </div>
  );
}
