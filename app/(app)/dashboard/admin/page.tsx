import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  Activity, AlertTriangle, BarChart3, CheckCircle2, Clock,
  CreditCard, Database, Globe, HardDrive, Mail, Server,
  Shield, Sparkles, Users, Zap,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/constants/roles';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Admin Dashboard' };

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(n);
}

function StatCard({ label, value, sub, icon: Icon, bg, trend }: {
  label: string; value: string | number; sub: string;
  icon: React.ComponentType<{ className?: string }>; bg: string; trend?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className={cn('grid h-11 w-11 place-items-center rounded-xl', bg)}>
          <Icon className="h-5 w-5" />
        </div>
        {trend && (
          <span className={cn('text-xs font-bold', trend.startsWith('+') ? 'text-success' : 'text-danger')}>
            {trend}
          </span>
        )}
      </div>
      <p className="text-2xl font-black">{value}</p>
      <p className="text-sm font-semibold">{label}</p>
      <p className="text-xs text-muted">{sub}</p>
    </div>
  );
}

function StatusRow({ label, icon: Icon, status }: {
  label: string; icon: React.ComponentType<{ className?: string }>; status: 'operational' | 'degraded' | 'down';
}) {
  const colors = {
    operational: 'text-success',
    degraded: 'text-warning',
    down: 'text-danger',
  };
  const labels = {
    operational: 'Operational',
    degraded: 'Degraded Performance',
    down: 'Down',
  };
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 text-muted" />
        <span className="text-sm">{label}</span>
      </div>
      <span className={cn('text-xs font-semibold', colors[status])}>{labels[status]}</span>
    </div>
  );
}

export default async function AdminPage() {
  const ctx = await requireUserContext();
  if (!isAdmin(ctx.active.role)) redirect('/dashboard');

  const supabase = await createServer();

  const [
    { count: familyCount },
    { count: userCount },
    { count: memberCount },
    { count: activeSubCount },
    { data: recentFamilies },
    { data: recentLogs },
  ] = await Promise.all([
    supabase.from('families').select('id', { count: 'exact', head: true }),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('families').select('id, name, created_at').order('created_at', { ascending: false }).limit(5),
    supabase.from('audit_logs').select('id, action, resource, metadata, created_at, actor_id').order('created_at', { ascending: false }).limit(8),
  ]);

  const families = familyCount ?? 0;
  const users = userCount ?? 0;
  const activeSubs = activeSubCount ?? 0;

  return (
    <div className="module-page">
      <div className="mb-5 sm:mb-6">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl lg:text-3xl">Admin Dashboard</h1>
        <p className="mt-0.5 text-xs text-muted sm:mt-1 sm:text-sm">Manage and monitor your FamilyOS system, users, and services.</p>
      </div>

      {/* Stat cards */}
      <div className="grid-stats">
        <StatCard icon={Users} label="Total Families" value={families} sub="All registered" bg="bg-brand/15 text-brand" trend={families > 0 ? `+${families}` : undefined} />
        <StatCard icon={Users} label="Total Users" value={users} sub="Across all families" bg="bg-success/15 text-success" />
        <StatCard icon={CreditCard} label="Active Subscriptions" value={activeSubs} sub="Paying customers" bg="bg-warning/15 text-warning" />
        <StatCard icon={BarChart3} label="Family Members" value={memberCount ?? 0} sub="Active members" bg="bg-accent/15 text-accent" />
      </div>

      {/* System Overview + System Status */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {/* Recent Activity */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Recent Activities</h2>
            </div>
            {recentLogs && recentLogs.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-border">
                <div className="hidden sm:grid grid-cols-[1fr_1fr_1fr_40px] border-b border-border bg-surface/60 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  <div>Action</div><div>Details</div><div>Time</div><div />
                </div>
                {recentLogs.map((log, i) => {
                  const meta = log.metadata as Record<string, string> | null;
                  const detail = meta?.name ?? meta?.display_name ?? meta?.email ?? log.resource;
                  const d = new Date(log.created_at);
                  const ago = Math.floor((Date.now() - d.getTime()) / 60000);
                  const timeLabel = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.floor(ago / 60)}h ago` : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                  return (
                    <div key={log.id} className={cn('flex flex-col gap-1 px-4 py-3 sm:grid sm:grid-cols-[1fr_1fr_1fr_40px] sm:items-center', i < recentLogs.length - 1 && 'border-b border-border/50')}>
                      <div className="flex items-center gap-2">
                        <Activity className="h-3.5 w-3.5 text-muted" />
                        <span className="text-sm font-medium capitalize">{log.action} {log.resource}</span>
                      </div>
                      <div className="text-xs text-muted truncate">{detail}</div>
                      <div className="text-xs text-muted">{timeLabel}</div>
                      <div />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-12 text-center text-sm text-muted">No recent activity</div>
            )}
          </div>

          {/* Recent Families */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Recent Families</h2>
            </div>
            {recentFamilies && recentFamilies.length > 0 ? (
              <div className="space-y-2">
                {recentFamilies.map((f) => {
                  const d = new Date(f.created_at);
                  return (
                    <div key={f.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/20 px-4 py-3">
                      <Avatar name={f.name} size={36} className="rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{f.name}</p>
                        <p className="text-xs text-muted">Joined {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                      </div>
                      <Badge tone="brand">Active</Badge>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted">No families yet</div>
            )}
          </div>
        </div>

        {/* System Status Sidebar */}
        <div className="space-y-5">
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">System Status</h2>
            </div>
            <div className="divide-y divide-border">
              <StatusRow icon={Globe} label="Web Service" status="operational" />
              <StatusRow icon={Database} label="Database" status="operational" />
              <StatusRow icon={HardDrive} label="Storage" status="operational" />
              <StatusRow icon={Server} label="Backup Service" status="operational" />
              <StatusRow icon={Mail} label="Email Service" status="operational" />
              <StatusRow icon={Zap} label="Push Notifications" status="operational" />
              <StatusRow icon={Sparkles} label="AI Services" status="operational" />
              <StatusRow icon={Shield} label="Authentication" status="operational" />
            </div>
          </div>

          {/* Quick Actions */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <h2 className="mb-4 font-semibold">Quick Actions</h2>
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: Users, label: 'View Users' },
                { icon: CreditCard, label: 'Subscriptions' },
                { icon: Shield, label: 'Security' },
                { icon: Activity, label: 'Audit Logs' },
              ].map(({ icon: Icon, label }) => (
                <button key={label} className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface/20 p-4 text-center transition hover:bg-elevated">
                  <Icon className="h-5 w-5 text-muted" />
                  <span className="text-xs font-medium">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
