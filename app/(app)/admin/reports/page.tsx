import type { Metadata } from 'next';
import { Users, FolderKanban, Home, TrendingUp, Activity, FileDown } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { GrowthChart } from '@/components/admin/growth-chart';
import { RoleDonut } from '@/components/admin/role-donut';
import { EngagementHeatmap } from '@/components/admin/engagement-heatmap';
import { ReportsToolbar } from '@/components/admin/reports-toolbar';
import type { MemberRole } from '@/lib/constants/roles';
import { PLANS } from '@/lib/constants/plans';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Reports & Analytics', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'User Analytics' },
  { key: 'content', label: 'Content Analytics' },
  { key: 'subscriptions', label: 'Subscription Analytics' },
] as const;
type TabKey = (typeof TABS)[number]['key'];
type Params = { searchParams: Promise<{ tab?: string }> };

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function typeLabel(mime: string | null): string {
  if (!mime) return 'File';
  if (mime.startsWith('image/')) return 'Photo';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('word') || mime.includes('document')) return 'Document';
  return 'File';
}

export default async function AdminReportsPage({ searchParams }: Params) {
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'overview';
  const supabase = createServiceClient();

  const [
    { data: profiles }, { data: members }, { data: families }, { data: subscriptions }, { data: documents },
    authUsers,
    { data: calendarTimes }, { data: choreTimes }, { data: noteTimes }, { data: auditTimes },
  ] = await Promise.all([
    supabase.from('profiles').select('id, full_name, email, created_at').order('created_at', { ascending: false }),
    supabase.from('family_members').select('user_id, family_id, role').eq('is_active', true),
    supabase.from('families').select('id, name'),
    supabase.from('subscriptions').select('family_id, plan, status, created_at'),
    supabase.from('documents').select('id, title, family_id, category, mime_type, size_bytes, created_at').order('created_at', { ascending: false }),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from('calendar_events').select('created_at').order('created_at', { ascending: false }).limit(800),
    supabase.from('chore_assignments').select('created_at').order('created_at', { ascending: false }).limit(800),
    supabase.from('notes').select('created_at').order('created_at', { ascending: false }).limit(400),
    supabase.from('audit_logs').select('created_at').order('created_at', { ascending: false }).limit(800),
  ]);

  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const docs = documents ?? [];
  const totalBytes = docs.reduce((s, d) => s + (d.size_bytes ?? 0), 0);

  const roleCounts = new Map<MemberRole, number>();
  for (const m of members ?? []) if (m.role) roleCounts.set(m.role as MemberRole, (roleCounts.get(m.role as MemberRole) ?? 0) + 1);
  const memberUserIds = new Set((members ?? []).map((m) => m.user_id).filter(Boolean));

  const docCountByFamily = new Map<string, number>();
  for (const d of docs) docCountByFamily.set(d.family_id, (docCountByFamily.get(d.family_id) ?? 0) + 1);
  const topFamiliesByContent = [...docCountByFamily.entries()]
    .map(([familyId, count]) => ({ name: familyNameById.get(familyId) ?? 'Unknown family', count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const categoryCount = new Map<string, number>();
  for (const d of docs) categoryCount.set(d.category ?? 'other', (categoryCount.get(d.category ?? 'other') ?? 0) + 1);
  const topCategories = [...categoryCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const users = authUsers.data?.users ?? [];
  const now = Date.now();
  const activeWindow = (ms: number) => users.filter((u) => u.last_sign_in_at && now - new Date(u.last_sign_in_at).getTime() <= ms).length;
  const active24h = activeWindow(86400000);
  const active7d = activeWindow(7 * 86400000);
  const active30d = activeWindow(30 * 86400000);

  const heatmapTimestamps = [
    ...(calendarTimes ?? []).map((r) => r.created_at),
    ...(choreTimes ?? []).map((r) => r.created_at),
    ...(noteTimes ?? []).map((r) => r.created_at),
    ...(auditTimes ?? []).map((r) => r.created_at),
  ];

  const planById = (id: string) => PLANS.find((p) => p.id === id);
  const mrr = (subscriptions ?? []).filter((s) => s.status === 'active').reduce((sum, s) => sum + (planById(s.plan)?.priceMonthly ?? 0), 0);

  const userRows = (profiles ?? []).map((p) => [p.full_name ?? '', p.email ?? '', '', '', fmtDate(p.created_at, 'yyyy-MM-dd')]);
  const familyRows = (subscriptions ?? []).map((s) => [familyNameById.get(s.family_id) ?? '', s.plan, s.status, fmtDate(s.created_at, 'yyyy-MM-dd')]);
  const contentRows = docs.slice(0, 200).map((d) => [d.title, familyNameById.get(d.family_id) ?? '', d.category ?? 'other', d.size_bytes ?? 0, fmtDate(d.created_at, 'yyyy-MM-dd')]);

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Reports & Analytics</h1>
        <p className="mt-1 text-sm text-muted">Real insights computed from live data — every chart here reflects what&rsquo;s actually in the database right now.</p>
      </div>

      <div className="tab-bar border-b border-border pb-px">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/reports?tab=${t.key}`} className={`tab-item ${tab === t.key ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {t.label}
          </a>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid-stats">
            <StatCard icon={Users} label="Total users" value={(profiles?.length ?? 0).toLocaleString()} tone="bg-brand/10 text-brand" />
            <StatCard icon={Home} label="Active families" value={(families?.length ?? 0).toLocaleString()} tone="bg-accent/10 text-accent" />
            <StatCard icon={FolderKanban} label="Content items" value={docs.length.toLocaleString()} tone="bg-success/10 text-success" />
            <StatCard icon={Activity} label="Active in last 7 days" value={active7d.toLocaleString()} tone="bg-warning/10 text-warning" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <Card>
              <h2 className="mb-4 text-base font-semibold">User growth <span className="text-muted">(last 30 days, cumulative)</span></h2>
              <GrowthChart timestamps={(profiles ?? []).map((p) => p.created_at)} />
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">User Distribution</h2>
              <RoleDonut counts={roleCounts} total={memberUserIds.size} />
            </Card>
          </div>

          <Card>
            <div className="mb-4 flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted" />
              <h2 className="text-base font-semibold">Engagement heatmap <span className="text-muted">(real activity timestamps, last ~2,800 events)</span></h2>
            </div>
            <EngagementHeatmap timestamps={heatmapTimestamps} />
          </Card>

          <Card>
            <div className="mb-3 flex items-center gap-2">
              <FileDown className="h-4 w-4 text-muted" />
              <h2 className="text-base font-semibold">Quick reports</h2>
            </div>
            <ReportsToolbar userRows={userRows} familyRows={familyRows} contentRows={contentRows} />
          </Card>
        </>
      )}

      {tab === 'users' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-base font-semibold">Active users</h2>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Last 24h" value={active24h} />
              <Stat label="Last 7 days" value={active7d} />
              <Stat label="Last 30 days" value={active30d} />
            </div>
            <p className="mt-3 text-xs text-muted">Based on each account&rsquo;s real last sign-in time.</p>
          </Card>
          <Card>
            <h2 className="mb-3 text-base font-semibold">By role</h2>
            <RoleDonut counts={roleCounts} total={memberUserIds.size} />
          </Card>
        </div>
      )}

      {tab === 'content' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h2 className="mb-4 text-base font-semibold">Top categories</h2>
            <ul className="space-y-2">
              {topCategories.map(([cat, count]) => (
                <li key={cat} className="flex items-center justify-between text-sm">
                  <span className="capitalize">{cat}</span>
                  <Badge tone="neutral">{count}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted">{fmtBytes(totalBytes)} stored across {docs.length} items.</p>
          </Card>
          <Card>
            <h2 className="mb-4 text-base font-semibold">Most active families by content</h2>
            <ul className="space-y-2">
              {topFamiliesByContent.map((f) => (
                <li key={f.name} className="flex items-center justify-between text-sm">
                  <span>{f.name}</span>
                  <span className="font-medium">{f.count} item{f.count !== 1 ? 's' : ''}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="lg:col-span-2">
            <h2 className="mb-4 text-base font-semibold">Recent content</h2>
            <ul className="space-y-2">
              {docs.slice(0, 8).map((d) => (
                <li key={d.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">{d.title}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone="neutral">{typeLabel(d.mime_type)}</Badge>
                    <span className="text-xs text-muted">{fmtDate(d.created_at, 'MMM d')}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tab === 'subscriptions' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-base font-semibold">Revenue</h2>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="MRR" value={`$${(mrr / 100).toLocaleString()}`} />
              <Stat label="Active subscriptions" value={(subscriptions ?? []).filter((s) => s.status === 'active').length} />
            </div>
          </Card>
          <Card>
            <h2 className="mb-4 text-base font-semibold flex items-center gap-2"><TrendingUp className="h-4 w-4 text-muted" /> Growth</h2>
            <GrowthChart timestamps={(subscriptions ?? []).map((s) => s.created_at)} />
          </Card>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-border bg-surface/40 p-3 text-center">
      <p className="text-xl font-bold">{value}</p>
      <p className="mt-1 text-xs text-muted">{label}</p>
    </div>
  );
}
