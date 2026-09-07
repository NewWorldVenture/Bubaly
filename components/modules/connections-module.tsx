'use client';

// Family API hub (North Star pillar #9). One place to connect the services a
// family already uses (calendars, email, banking, grocery, smart home). The
// connection records are real + family-scoped; live data sync activates per
// provider as its OAuth keys are configured server-side. 100% Supabase.
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Network, Calendar, Mail, Landmark, ShoppingCart, Home, Plug, X, KeyRound,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { ErrorState, SkeletonList } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import {
  mergeConnections, groupByCategory, connectedCount, CATEGORY_LABELS, CONNECTION_STATUS_LABELS,
  type ConnectionLike, type ProviderState, type ConnectionStatus,
} from '@/lib/connections/providers';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Connection = Tables<'family_connections'>;

const PROVIDER_ICON: Record<string, typeof Network> = {
  calendar: Calendar, mail: Mail, bank: Landmark, cart: ShoppingCart, home: Home,
};
const STATUS_STYLE: Record<ConnectionStatus, string> = {
  connected: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  syncing: 'text-blue-300 bg-blue-500/10 border-blue-500/30',
  error: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  disconnected: 'text-muted border-border',
};

export function ConnectionsModule() {
  const t = useTranslations();
  const { familyId } = useApp();
  const router = useRouter();
  const { success, error: toastError } = useToast();

  const { data: rows, loading, error, refresh } = useRealtimeQuery<Connection>({
    table: 'family_connections', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_connections').select('*').eq('family_id', familyId),
  });

  const states = useMemo(() => mergeConnections((rows ?? []) as ConnectionLike[]), [rows]);
  const grouped = useMemo(() => groupByCategory(states), [states]);
  const connected = connectedCount(states);

  async function disconnect(p: ProviderState) {
    if (!confirm(`Disconnect ${p.name}?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('family_connections').delete().eq('family_id', familyId).eq('provider', p.id);
    if (err) { toastError(describeDbError(err)); return; }
    success(`${p.name} disconnected`);
  }

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={t('connectionsModule.couldNotLoadYourConnections')} onRetry={refresh} />;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={t('connections.connections')}
        description={t('connectionsModule.bubalyConnectsSupportedCalendarServices')}
      />

      <div className="mb-5 flex items-center gap-2 rounded-xl border border-border bg-surface/50 px-4 py-3 text-sm">
        <Network className="h-4 w-4 text-brand-text" />
        {connected > 0
          ? <span><span className="font-semibold text-fg">{connected}</span> {connected === 1 ? 'service' : 'services'} {t('connections.connectedAcross')} {grouped.length} categories.</span>
          : <span>{t('connections.nothingConnectedYetLinkASupported')}</span>}
      </div>

      <div className="space-y-6">
        {grouped.map(([cat, providers]) => (
          <section key={cat}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{CATEGORY_LABELS[cat]}</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {providers.map((p) => {
                const Icon = PROVIDER_ICON[p.icon] ?? Plug;
                return (
                  <li key={p.id} className="flex items-start gap-3 rounded-2xl border border-border bg-surface/50 p-4">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border text-fg"><Icon className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-fg">{p.name}</span>
                        <span className={cn('rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide', STATUS_STYLE[p.status])}>
                          {CONNECTION_STATUS_LABELS[p.status]}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">{p.description}</p>
                      {p.connected && p.accountLabel && <p className="mt-1 truncate text-xs text-muted">Account: {p.accountLabel}</p>}
                      <div className="mt-2">
                        {p.connected ? (
                          <button onClick={() => disconnect(p)} className="inline-flex items-center gap-1 text-xs font-medium text-muted transition hover:text-rose-400">
                            <X className="h-3.5 w-3.5" /> {t('connections.disconnect')}
                          </button>
                        ) : p.syncProvider ? (
                          <button onClick={() => router.push(`/dashboard/sync/accounts/${p.syncProvider}`)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-fg transition hover:border-brand/40 hover:bg-elevated">
                            <Plug className="h-3.5 w-3.5" /> {t('connections.openSecureSetup')}
                          </button>
                        ) : (
                          <span className="text-xs text-muted">{t('connections.liveConnectionSetupUnavailable')}</span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-6 flex items-start gap-2 rounded-xl border border-border bg-surface/40 p-3 text-xs text-muted">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
        Connecting records the integration and brings supported calendar data into your hubs. Secure keys
        are required before a live sync can run; nothing here stores your passwords.
      </p>

    </div>
  );
}
