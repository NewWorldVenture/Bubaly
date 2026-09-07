import type { Metadata } from 'next';
import Link from 'next/link';
import { Plug, ChevronRight } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import {
  CAPABILITIES, PROVIDER_LABELS, isSupported, type SyncProvider, type SyncItemKind,
} from '@/lib/sync/capabilities';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Sync accounts' };
export const dynamic = 'force-dynamic';

const PROVIDERS: SyncProvider[] = ['google', 'microsoft', 'apple'];
const KINDS: SyncItemKind[] = ['calendar', 'reminder', 'note'];

export default async function SyncAccountsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: accounts, error } = await supabase
    .from('sync_accounts')
    .select('id, provider, display_name, sync_status, external_id, last_synced_at')
    .eq('family_id', ctx.active.familyId);

  if (error) {
    console.error('[sync-accounts] connected-account read failed', error);
    return (
      <div className="module-page">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboardSyncAccounts.connectedAccounts')}</h1>
        <ErrorState message={t('accounts.couldNotLoadYourConnected')} />
        <Link href="/dashboard/sync/accounts" className="text-sm font-medium text-brand-text underline">{t('dashboardSyncAccounts.refreshConnectedAccounts')}</Link>
      </div>
    );
  }

  const byProvider = new Map((accounts ?? []).map((a) => [a.provider, a]));

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboardSyncAccounts.connectedAccounts')}</h1>
        <p className="mt-1 text-sm text-muted">{t('dashboardSyncAccounts.linkAProviderToStartSyncing')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((p) => {
          const account = byProvider.get(p);
          const supportedKinds = KINDS.filter((k) => isSupported(p, k));
          return (
            <Card key={p}>
              <div className="flex items-start gap-3">
                <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-text"><Plug className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{PROVIDER_LABELS[p]}</p>
                    {account
                      ? <Badge tone="success">{t('accounts.connected')}</Badge>
                      : <Badge tone="neutral">{t('accounts.notConnected')}</Badge>}
                  </div>
                  {account?.external_id && <p className="mt-0.5 truncate text-xs text-muted">{account.external_id}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {supportedKinds.length === 0
                      ? <span className="text-xs text-muted">{t('accounts.noSupportedItemTypes')}</span>
                      : supportedKinds.map((k) => (
                          <Badge key={k} tone="brand" title={CAPABILITIES[p][k].limitation}>{k}</Badge>
                        ))}
                  </div>
                </div>
              </div>
              <Link href={`/dashboard/sync/accounts/${p}`} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-text hover:underline">
                {account ? 'Manage' : 'Set up'} <ChevronRight className="h-4 w-4" />
              </Link>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
