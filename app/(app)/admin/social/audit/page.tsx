import type { Metadata } from 'next';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { createServiceClient } from '@/lib/supabase/server';
import { AdminSocialSubnav } from '@/components/social/admin-subnav';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ClipboardList } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Social Audit', robots: { index: false } };
export const dynamic = 'force-dynamic';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <h1 className="text-2xl font-bold tracking-tight">{t('audit.auditLog')}</h1>
      <AdminSocialSubnav active="/admin/social/audit" />
      <ErrorState message={t('audit.couldNotLoadSocialAudit')} />
      <Link href="/admin/social/audit" className="text-sm font-medium text-brand-text underline">{t('audit.refreshSocialAudit')}</Link>
    </div>
  );
}

export default async function AdminAuditPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data: logs, error } = await supabase
    .from('social_audit_logs')
    .select('id, family_id, action, entity_type, summary, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('[admin-social-audit] audit read failed', error);
    return <ReadFailure />;
  }

  return (
    <div className="module-page">
      <h1 className="text-2xl font-bold tracking-tight">{t('adminSocialAudit.auditLog')}</h1>
      <AdminSocialSubnav active="/admin/social/audit" />
      <p className="text-sm text-muted">{t('adminSocialAudit.accountPostAndPublishResultMutations')}</p>
      {(logs ?? []).length === 0 ? (
        <EmptyState icon={ClipboardList} title={t('adminSocialAudit.noAuditEntriesYet')} description={t('audit.connectionDraftAndPublishActivity')} />
      ) : (
        <Card>
          <div className="space-y-1.5 text-sm">
            {(logs ?? []).map((l) => (
              <div key={l.id} className="flex items-center gap-2 border-b border-border/50 pb-1.5">
                <Badge tone="neutral">{l.action}</Badge>
                <span className="text-muted">{l.summary ?? l.entity_type}</span>
                <span className="ml-auto text-xs text-muted">{formatDistanceToNow(new Date(l.occurred_at))} ago</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
