import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { AdminSocialSubnav } from '@/components/social/admin-subnav';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { Gauge } from 'lucide-react';

export const metadata: Metadata = { title: 'Social Usage', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminUsagePage() {
  const supabase = createServiceClient();
  const { data: events } = await supabase
    .from('social_usage_events')
    .select('kind, quantity')
    .limit(5000);

  const totals = new Map<string, number>();
  for (const e of events ?? []) {
    totals.set(e.kind, (totals.get(e.kind) ?? 0) + Number(e.quantity));
  }
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="module-page">
      <h1 className="text-2xl font-bold tracking-tight">Usage</h1>
      <AdminSocialSubnav active="/admin/social/usage" />
      <p className="text-sm text-muted">Metered events (AI generations, publishes, media uploads, feed syncs) across all families.</p>
      {rows.length === 0 ? (
        <EmptyState icon={Gauge} title="No usage recorded yet" description="Usage events accrue as families generate AI content and publish." />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="px-2 py-1.5 font-medium">Event</th><th className="px-2 py-1.5 font-medium">Total</th></tr></thead>
            <tbody>
              {rows.map(([kind, total]) => (
                <tr key={kind} className="border-t border-border">
                  <td className="px-2 py-1.5 capitalize">{kind.replace(/_/g, ' ')}</td>
                  <td className="px-2 py-1.5 font-medium">{total.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
