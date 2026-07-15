import type { Metadata } from 'next';
import Link from 'next/link';
import { ScrollText } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDateTime } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Marketing · Audit', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function MarketingAuditPage() {
  const supabase = createServiceClient();
  const { data: logs, error: logsError } = await supabase.from('marketing_audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
  if (logsError) {
    console.error('[admin-marketing-audit] audit log read failed', logsError);
    return <AdminMarketingAuditReadError />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Every create, update, and status change in the Marketing module is recorded here.</p>
      {(logs ?? []).length === 0 ? (
        <EmptyState icon={ScrollText} title="No marketing activity yet" description="Actions you take in this module will appear here." />
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

function AdminMarketingAuditReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing Audit Log</h1>
        <p className="mt-1 text-sm text-muted">Review recorded marketing actions and status changes.</p>
      </div>
      <ErrorState message="Could not load marketing audit logs from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/audit" className="text-sm font-medium text-brand-text underline">Refresh audit log</Link>
    </div>
  );
}
