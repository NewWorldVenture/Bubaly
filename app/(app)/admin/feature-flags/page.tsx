import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { EmptyState } from '@/components/ui/states';
import { Flag } from 'lucide-react';
import { FeatureFlagsPanel, type FlagRow } from '@/components/admin/feature-flags-panel';

export const metadata: Metadata = { title: 'Feature Flags — Bubaly Admin', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function FeatureFlagsAdmin() {
  const supabase = createServiceClient();
  const { data } = await supabase.from('feature_flags').select('key, enabled, description').order('key');
  const flags = (data ?? []) as FlagRow[];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-fg">Feature Flags</h1>
        <p className="text-sm text-muted">Toggle platform capabilities in-app — no more editing the database by hand.</p>
      </div>

      {flags.length === 0 ? (
        <EmptyState icon={Flag} title="No feature flags found"
          description="Apply migration 0088 to seed the feature_flags table, then refresh." />
      ) : (
        <FeatureFlagsPanel flags={flags} />
      )}
    </div>
  );
}
