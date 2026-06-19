import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Calendar, CheckSquare, UtensilsCrossed, Bell, Sparkles, ClipboardCheck,
  ArrowRight, Plus, FolderClock,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/states';
import { fmtTime, fmtRelative } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Dashboard' };

function dayBounds() {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const in7 = new Date(start); in7.setDate(in7.getDate() + 7);
  const in30 = new Date(start); in30.setDate(in30.getDate() + 30);
  return { now, start, end, in7, in30 };
}

function StatCard({ href, icon: Icon, label, value, tone }: {
  href: string; icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone: string;
}) {
  return (
    <Link href={href} className="glass-card flex items-center gap-4 p-4 transition hover:-translate-y-0.5 hover:shadow-glow">
      <div className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-6 w-6" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </Link>
  );
}

export default async function DashboardPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const { start, end, in7, in30 } = dayBounds();

  const [
    { data: todayEvents },
    { count: todoCount },
    { count: approvalCount },
    { data: todayPlans },
    { data: reminders },
    { count: expiringDocs },
    { data: familyMembers },
  ] = await Promise.all([
    supabase.from('calendar_events').select('*').eq('family_id', familyId)
      .gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at'),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'submitted'),
    supabase.from('meal_plans').select('*').eq('family_id', familyId)
      .eq('plan_date', start.toISOString().slice(0, 10)),
    supabase.from('reminders').select('*').eq('family_id', familyId)
      .eq('is_done', false).lte('remind_at', in7.toISOString()).order('remind_at').limit(6),
    supabase.from('documents').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).not('expires_at', 'is', null)
      .lte('expires_at', in30.toISOString().slice(0, 10)),
    supabase.from('family_members').select('*').eq('family_id', familyId)
      .eq('is_active', true).order('created_at'),
  ]);

  // Resolve today's meal names (embedded joins aren't typed; do a second small query).
  const mealIds = (todayPlans ?? []).map((p) => p.meal_id).filter((x): x is string => !!x);
  const { data: meals } = mealIds.length
    ? await supabase.from('meals').select('id, name, meal_type').in('id', mealIds)
    : { data: [] as { id: string; name: string; meal_type: string }[] };
  const mealById = new Map((meals ?? []).map((m) => [m.id, m]));

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  })();

  const firstName = (ctx.active.member.display_name || 'there').split(' ')[0];
  const manager = isManager(ctx.active.role);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{greeting}, {firstName}.</h1>
        <p className="mt-1 text-sm text-muted">Here’s what’s happening with the {ctx.active.family.name}.</p>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard href="/dashboard/calendar" icon={Calendar} label="Events today" value={todayEvents?.length ?? 0} tone="bg-brand/10 text-brand" />
        <StatCard href="/dashboard/chores" icon={CheckSquare} label="Chores to do" value={todoCount ?? 0} tone="bg-accent/10 text-accent" />
        <StatCard href="/dashboard/chores" icon={ClipboardCheck} label="Awaiting approval" value={approvalCount ?? 0} tone="bg-warning/10 text-warning" />
        <StatCard href="/dashboard/documents" icon={FolderClock} label="Docs expiring" value={expiringDocs ?? 0} tone="bg-danger/10 text-danger" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Today */}
        <Card className="lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">Today</h2>
            <Link href="/dashboard/calendar" className="text-sm font-medium text-brand hover:underline">
              View calendar
            </Link>
          </div>
          {todayEvents && todayEvents.length > 0 ? (
            <ul className="space-y-2">
              {todayEvents.map((e) => (
                <li key={e.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                  <div className="w-16 shrink-0 text-sm font-medium text-muted">{e.all_day ? 'All day' : fmtTime(e.starts_at)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{e.title}</p>
                    {e.location && <p className="truncate text-xs text-muted">{e.location}</p>}
                  </div>
                  <Badge tone="neutral">{e.category}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Calendar} title="Nothing scheduled today" description="Enjoy the calm — or add something to the calendar." />
          )}

          {/* Today's meals */}
          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <UtensilsCrossed className="h-4 w-4 text-brand" /> On the menu
            </div>
            {todayPlans && todayPlans.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {todayPlans.map((p) => (
                  <Badge key={p.id} tone="brand">
                    {p.meal_type}: {mealById.get(p.meal_id ?? '')?.name ?? 'Planned'}
                  </Badge>
                ))}
              </div>
            ) : (
              <Link href="/dashboard/meals" className="text-sm text-muted hover:text-fg">No meals planned — plan dinner →</Link>
            )}
          </div>
        </Card>

        {/* Right column */}
        <div className="space-y-6">
          {/* AI quick entry */}
          <Card className="bg-gradient-to-br from-brand/10 to-accent/10">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-brand" />
              <h2 className="text-base font-semibold">Ask your assistant</h2>
            </div>
            <p className="mt-2 text-sm text-muted">“Summarize our week” or “plan dinners and build a grocery list.”</p>
            <Link href="/dashboard/assistant" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline">
              Open assistant <ArrowRight className="h-4 w-4" />
            </Link>
          </Card>

          {/* Reminders */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Upcoming reminders</h2>
              <Bell className="h-4 w-4 text-muted" />
            </div>
            {reminders && reminders.length > 0 ? (
              <ul className="space-y-2">
                {reminders.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    <span className="shrink-0 text-xs text-muted">{fmtRelative(r.remind_at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">You’re all caught up.</p>
            )}
          </Card>

          {/* Members */}
          <Card>
            <h2 className="mb-3 text-base font-semibold">Family</h2>
            <div className="flex flex-wrap items-center gap-2">
              {(familyMembers ?? []).map((m) => (
                <div key={m.id} className="flex items-center gap-1.5 rounded-full border border-border bg-surface/50 py-1 pl-1 pr-2.5">
                  <Avatar name={m.display_name} color={m.color} size={24} />
                  <span className="text-xs font-medium">{m.display_name.split(' ')[0]}</span>
                </div>
              ))}
              {manager && (
                <Link href="/dashboard/settings#members" className="flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted hover:text-fg">
                  <Plus className="h-3.5 w-3.5" /> Add
                </Link>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
