import type { Metadata } from 'next';
import Link from 'next/link';
import { ScrollText } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDateTime } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Audit', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function MarketingAuditPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data: logs, error: logsError } = await supabase.from('marketing_audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
  if (logsError) {
    console.error('[admin-marketing-audit] audit log read failed', logsError);
    return <AdminMarketingAuditReadError />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('adminMarketingAudit.everyCreateUpdateAndStatusChange')}</p>
      {(logs ?? []).length === 0 ? (
        <EmptyState icon={ScrollText} title={t('adminMarketingAudit.noMarketingActivityYet')} description={t('audit.actionsYouTakeInThis')} />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border/60">
            {(logs ?? []).map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 p-4 text-sm">
                <div className="min-w-0">
                  <p><span className="font-medium capitalize">{l.action.replace(/[:_]/g, ' ')}</span> · <span className="text-muted">{l.resource.replace('marketing_', '').replace(/_/g, ' ')}</span></p>
                  <p className="text-xs text-muted">{l.actor_email ?? 'system'}{l.resource_id ? ` · ${l.resource_id.slice(0, 8)}` : ''}</p>
                </div>
                <span className="shrink-0 text-xs text-muted">{fmtDateTime(l.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

async function AdminMarketingAuditReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('audit.marketingAuditLog')}</h1>
        <p className="mt-1 text-sm text-muted">{t('audit.reviewRecordedMarketingActionsAnd')}</p>
      </div>
      <ErrorState message={t('audit.couldNotLoadMarketingAudit')} />
      <Link href="/admin/marketing/audit" className="text-sm font-medium text-brand-text underline">{t('audit.refreshAuditLog')}</Link>
    </div>
  );
}
