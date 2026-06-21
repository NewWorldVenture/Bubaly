import type { Metadata } from 'next';
import { formatDistanceToNow } from 'date-fns';
import { createServiceClient } from '@/lib/supabase/server';
import { AdminSocialSubnav } from '@/components/social/admin-subnav';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { ClipboardList } from 'lucide-react';

export const metadata: Metadata = { title: 'Social Audit', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminAuditPage() {
  const supabase = createServiceClient();
  const { data: logs } = await supabase
    .from('social_audit_logs')
    .select('id, family_id, action, entity_type, summary, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(200);

  return (
    <div className="module-page">
      <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
      <AdminSocialSubnav active="/admin/social/audit" />
      <p className="text-sm text-muted">Account, post, and publish-result mutations across all families, written by database audit triggers.</p>
      {(logs ?? []).length === 0 ? (
        <EmptyState icon={ClipboardList} title="No audit entries yet" description="Connection, draft, and publish activity will be recorded here." />
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
