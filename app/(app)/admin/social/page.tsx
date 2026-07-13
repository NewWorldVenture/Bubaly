import type { Metadata } from 'next';
import { Users2, Newspaper, Send, AlertTriangle, Sparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { PLATFORMS, isProviderConfigured } from '@/lib/social/capabilities';
import { AdminSocialSubnav } from '@/components/social/admin-subnav';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = { title: 'Social Admin', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminSocialPage() {
  const supabase = createServiceClient();
  const [accounts, posts, published, failedResults, generations, errors] = await Promise.all([
    supabase.from('social_accounts').select('id', { count: 'exact', head: true }),
    supabase.from('social_posts').select('id', { count: 'exact', head: true }),
    supabase.from('social_publish_results').select('id', { count: 'exact', head: true }).eq('status', 'published'),
    supabase.from('social_publish_results').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('social_ai_generations').select('id', { count: 'exact', head: true }),
    supabase.from('social_provider_errors').select('id', { count: 'exact', head: true }),
  ]);

  const stats = [
    { label: 'Accounts (all families)', value: accounts.count ?? 0, icon: Users2 },
    { label: 'Posts', value: posts.count ?? 0, icon: Newspaper },
    { label: 'Confirmed publishes', value: published.count ?? 0, icon: Send },
    { label: 'Failed publishes', value: failedResults.count ?? 0, icon: AlertTriangle },
    { label: 'AI generations', value: generations.count ?? 0, icon: Sparkles },
    { label: 'Provider errors', value: errors.count ?? 0, icon: AlertTriangle },
  ];

  return (
    <div className="module-page">
      <h1 className="text-2xl font-bold tracking-tight">Social platform</h1>
      <AdminSocialSubnav active="/admin/social" />
      <div className="grid-stats">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text"><s.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-xl font-bold leading-none">{s.value}</p>
              <p className="mt-1 text-xs text-muted">{s.label}</p>
            </div>
          </div>
        ))}
      </div>
      <Card>
        <h2 className="mb-3 text-sm font-semibold">Provider credential readiness</h2>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs">
              <PlatformDot platform={p} />
              {isProviderConfigured(p) ? <Badge tone="success">Configured</Badge> : <Badge tone="neutral">Missing creds</Badge>}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
