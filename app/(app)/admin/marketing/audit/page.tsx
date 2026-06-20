import type { Metadata } from 'next';
import { ScrollText } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { fmtDateTime } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Marketing · Audit', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function MarketingAuditPage() {
  const supabase = createServiceClient();
  const { data: logs } = await supabase.from('marketing_audit_logs').select('*').order('created_at', { ascending: false }).limit(200);

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
