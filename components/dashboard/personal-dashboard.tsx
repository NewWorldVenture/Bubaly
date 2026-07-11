import Link from 'next/link';
import {
  Award, Bell, Calendar, CheckCircle2, ChevronRight, ClipboardCheck,
  Gift, LayoutDashboard, ListChecks, Sparkles, Star, Trophy, Users,
} from 'lucide-react';
import { createServer } from '@/lib/supabase/server';
import { isManager, ROLE_LABELS } from '@/lib/constants/roles';
import { personalDashboardLabel } from '@/lib/constants/dashboards';
import { roleGreeting, roleSurface } from '@/lib/ui/role-surface';
import { dayPhase } from '@/lib/home/time-of-day';
import type { UserContext } from '@/lib/supabase/auth';
import { Avatar } from '@/components/ui/avatar';
import { DashboardWeather } from '@/components/dashboard/dashboard-weather';
import { fmtTime } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

const ACCENT = ['bg-violet-500', 'bg-emerald-500', 'bg-orange-500', 'bg-rose-500', 'bg-blue-500', 'bg-teal-500'];

function dayBounds() {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const in14 = new Date(start); in14.setDate(in14.getDate() + 14);
  return { start, end, in14 };
}

function StatCard({ href, label, value, icon: Icon, bg }: {
  href: string; label: string; value: number | string;
  icon: React.ComponentType<{ className?: string }>; bg: string;
}) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-5 transition hover:bg-elevated">
      <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', bg)}>
        <Icon className="h-5 w-5 text-fg" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="mt-0.5 truncate text-xs text-muted">{label}</p>
      </div>
    </Link>
  );
}

export async function PersonalDashboard({ ctx }: { ctx: UserContext }) {
  const familyId = ctx.active.familyId;
  const role = ctx.active.role;
  const me = ctx.active.member;
  const myMemberId = me.id;
  const manager = isManager(role);
  const isKid = role === 'child' || role === 'teen';
  const supabase = await createServer();
  const { start, end, in14 } = dayBounds();

  const [
    { data: myChores },
    { data: myEarned },
    { count: myOpenCount },
    { count: myDoneCount },
    { data: todayEvents },
    { data: upcomingEvents },
    { data: members },
  ] = await Promise.all([
    // My open / in-progress / submitted chores
    supabase.from('chore_assignments')
      .select('id, due_at, status, chore_id')
      .eq('family_id', familyId).eq('member_id', myMemberId)
      .in('status', ['todo', 'in_progress', 'submitted'])
      .order('due_at', { nullsFirst: false }).limit(8),
    // Points I've earned (approved/done assignments)
    supabase.from('chore_assignments')
      .select('points_awarded')
      .eq('family_id', familyId).eq('member_id', myMemberId)
      .in('status', ['approved', 'done']).limit(500),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('member_id', myMemberId).in('status', ['todo', 'in_progress']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('member_id', myMemberId).in('status', ['approved', 'done']),
    // Today's events assigned to me OR shared with the whole family
    supabase.from('calendar_events')
      .select('id, title, starts_at, all_day, location, assignee_id')
      .eq('family_id', familyId)
      .or(`assignee_id.eq.${myMemberId},assignee_id.is.null`)
      .gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString())
      .order('starts_at').limit(8),
    supabase.from('calendar_events')
      .select('id, title, starts_at, all_day, assignee_id')
      .eq('family_id', familyId)
      .or(`assignee_id.eq.${myMemberId},assignee_id.is.null`)
      .gte('starts_at', end.toISOString()).lte('starts_at', in14.toISOString())
      .order('starts_at').limit(5),
    supabase.from('family_members').select('id, display_name, color, role')
      .eq('family_id', familyId).eq('is_active', true).order('created_at'),
  ]);

  // Manager-only: chores submitted by anyone, awaiting approval.
  const { data: pendingApprovals } = manager
    ? await supabase.from('chore_assignments')
        .select('id, member_id, chore_id, submitted_at')
        .eq('family_id', familyId).eq('status', 'submitted')
        .order('submitted_at', { nullsFirst: false }).limit(6)
    : { data: [] as { id: string; member_id: string; chore_id: string; submitted_at: string | null }[] };

  // Kid-only: rewards they could redeem with their points.
  const { data: rewards } = isKid
    ? await supabase.from('rewards')
        .select('id, title, cost_points')
        .eq('family_id', familyId).is('redeemed_by', null)
        .order('cost_points').limit(5)
    : { data: [] as { id: string; title: string; cost_points: number }[] };

  // Resolve chore titles for every assignment we display.
  const choreIds = [...new Set([
    ...(myChores ?? []).map((c) => c.chore_id),
    ...(pendingApprovals ?? []).map((c) => c.chore_id),
  ])];
  const { data: chores } = choreIds.length
    ? await supabase.from('chores').select('id, title, points').in('id', choreIds)
    : { data: [] as { id: string; title: string; points: number }[] };
  const choreById = new Map((chores ?? []).map((c) => [c.id, c]));
  const memberById = new Map((members ?? []).map((m) => [m.id, m]));

  const myPoints = (myEarned ?? []).reduce((sum, a) => sum + (a.points_awarded ?? 0), 0);
  const openCount = myOpenCount ?? 0;
  const doneCount = myDoneCount ?? 0;

  // Role-tailored greeting (Friction #8): parents get a formal line, adults a
  // casual one, kids a warm emoji greeting — same treatment as Home, now on the
  // personal dashboard too.
  const firstName = (me.display_name || 'there').split(' ')[0];
  const greeting = roleGreeting(role, firstName, dayPhase(new Date()));
  const showWave = roleSurface(role).tone !== 'kid'; // kid greetings already carry an emoji

  const statusTone: Record<string, string> = {
    todo: 'text-muted',
    in_progress: 'text-blue-400',
    submitted: 'text-amber-400',
  };
  const statusLabel: Record<string, string> = {
    todo: 'To do',
    in_progress: 'In progress',
    submitted: 'Awaiting approval',
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Avatar name={me.display_name} color={me.color} size={48} />
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {greeting}{showWave && <span> 👋</span>}
            </h1>
            <p className="mt-0.5 text-sm text-muted">
              {personalDashboardLabel(role)} · <span className="capitalize">{ROLE_LABELS[role]}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <DashboardWeather />
          <Link
            href="/dashboard?view=family"
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg"
          >
            <LayoutDashboard className="h-4 w-4" /> Family Dashboard
          </Link>
        </div>
      </div>

      {/* Stat cards — role aware */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard href="/dashboard/chores" label="My Open Tasks" value={openCount} icon={ListChecks} bg="bg-violet-600" />
        <StatCard href="/dashboard/calendar" label="My Events Today" value={todayEvents?.length ?? 0} icon={Calendar} bg="bg-blue-600" />
        {isKid ? (
          <>
            <StatCard href="/dashboard/chores" label="Points Earned" value={myPoints} icon={Star} bg="bg-amber-500" />
            <StatCard href="/dashboard/chores" label="Tasks Done" value={doneCount} icon={Trophy} bg="bg-emerald-600" />
          </>
        ) : manager ? (
          <>
            <StatCard href="/dashboard/chores" label="Needs Approval" value={pendingApprovals?.length ?? 0} icon={ClipboardCheck} bg="bg-amber-500" />
            <StatCard href="/dashboard/settings#members" label="Family Members" value={members?.length ?? 0} icon={Users} bg="bg-emerald-600" />
          </>
        ) : (
          <>
            <StatCard href="/dashboard/chores" label="Tasks Done" value={doneCount} icon={CheckCircle2} bg="bg-emerald-600" />
            <StatCard href="/dashboard/calendar" label="Coming Up" value={upcomingEvents?.length ?? 0} icon={Bell} bg="bg-amber-500" />
          </>
        )}
      </div>

      {/* Row: My Day | My Tasks | (Approvals | Rewards | Coming up) */}
      <div className="grid gap-5 lg:grid-cols-3">
        {/* My Day */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">My Day</h2>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand">Calendar</Link>
          </div>
          {todayEvents && todayEvents.length > 0 ? (
            <ul className="space-y-3">
              {todayEvents.map((e, i) => (
                <li key={e.id} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-xs text-muted tabular-nums">
                    {e.all_day ? 'All Day' : fmtTime(e.starts_at)}
                  </span>
                  <div className={cn('h-2.5 w-2.5 shrink-0 rounded-full', ACCENT[i % ACCENT.length])} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{e.title}</p>
                    {e.location && <p className="truncate text-xs text-muted">{e.location}</p>}
                  </div>
                  {e.assignee_id === myMemberId && (
                    <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-bold text-brand">Mine</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Calendar className="h-8 w-8 text-muted/30" />
              <p className="mt-2 text-sm text-muted/60">Nothing on your schedule today</p>
            </div>
          )}
        </div>

        {/* My Tasks */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{isKid ? 'My Chores' : 'My Tasks'}</h2>
            <Link href="/dashboard/chores" className="text-xs font-semibold text-brand">View all</Link>
          </div>
          {myChores && myChores.length > 0 ? (
            <ul className="space-y-3">
              {myChores.map((t) => {
                const chore = choreById.get(t.chore_id);
                const isToday = t.due_at ? t.due_at.slice(0, 10) === start.toISOString().slice(0, 10) : false;
                return (
                  <li key={t.id} className="flex items-center gap-3">
                    <div className="h-4 w-4 shrink-0 rounded-full border-2 border-border" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{chore?.title ?? 'Task'}</p>
                      <p className={cn('text-xs', isToday ? 'font-semibold text-orange-400' : statusTone[t.status] ?? 'text-muted')}>
                        {isToday ? 'Due today' : statusLabel[t.status] ?? t.status}
                      </p>
                    </div>
                    {isKid && chore?.points ? (
                      <span className="flex items-center gap-0.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-400">
                        <Star className="h-3 w-3" /> {chore.points}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-400/30" />
              <p className="mt-2 text-sm text-muted/60">{isKid ? 'No chores — nice work!' : 'All caught up!'}</p>
            </div>
          )}
        </div>

        {/* Third column: manager approvals / kid rewards / coming-up */}
        {manager ? (
          <div className="rounded-2xl border border-amber-400/25 bg-amber-500/5 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-semibold">
                <ClipboardCheck className="h-4 w-4 text-amber-400" /> Needs Your Approval
              </h2>
              <Link href="/dashboard/chores" className="text-xs font-semibold text-brand">Review</Link>
            </div>
            {pendingApprovals && pendingApprovals.length > 0 ? (
              <ul className="space-y-3">
                {pendingApprovals.map((a) => {
                  const member = memberById.get(a.member_id);
                  const chore = choreById.get(a.chore_id);
                  return (
                    <li key={a.id} className="flex items-center gap-3">
                      {member && <Avatar name={member.display_name} color={member.color} size={28} />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{chore?.title ?? 'Task'}</p>
                        <p className="truncate text-xs text-muted">{member?.display_name ?? 'Member'} submitted</p>
                      </div>
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-400">Review</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-400/30" />
                <p className="mt-2 text-sm text-muted/60">Nothing waiting on you</p>
              </div>
            )}
          </div>
        ) : isKid ? (
          <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-semibold">
                <Gift className="h-4 w-4 text-brand" /> My Rewards
              </h2>
              <Link href="/dashboard/chores" className="text-xs font-semibold text-brand">Chores</Link>
            </div>
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-surface/40 p-3">
              <Award className="h-5 w-5 text-amber-400" />
              <p className="text-sm">You have <span className="font-bold text-amber-400">{myPoints}</span> points to spend</p>
            </div>
            {rewards && rewards.length > 0 ? (
              <ul className="space-y-2.5">
                {rewards.map((rw) => {
                  const affordable = myPoints >= rw.cost_points;
                  return (
                    <li key={rw.id} className="flex items-center gap-3 rounded-xl bg-surface/40 p-3">
                      <Star className={cn('h-4 w-4', affordable ? 'text-amber-400' : 'text-muted/40')} />
                      <p className="min-w-0 flex-1 truncate text-sm">{rw.title}</p>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', affordable ? 'bg-emerald-500/15 text-emerald-400' : 'bg-surface/50 text-muted')}>
                        {rw.cost_points} pts
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted/60">No rewards set up yet</p>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Coming Up</h2>
              <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand">View all</Link>
            </div>
            {upcomingEvents && upcomingEvents.length > 0 ? (
              <ul className="space-y-3">
                {upcomingEvents.map((e, i) => {
                  const d = new Date(e.starts_at);
                  return (
                    <li key={e.id} className="flex items-center gap-3">
                      <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-lg text-center text-fg', ACCENT[i % ACCENT.length])}>
                        <div>
                          <p className="text-[9px] font-bold uppercase">{d.toLocaleDateString('en-US', { month: 'short' })}</p>
                          <p className="text-base font-black leading-none">{d.getDate()}</p>
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{e.title}</p>
                        <p className="text-xs text-muted">{e.all_day ? 'All Day' : fmtTime(e.starts_at)}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Calendar className="h-8 w-8 text-muted/30" />
                <p className="mt-2 text-sm text-muted/60">Nothing coming up</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { href: '/dashboard/chores', label: isKid ? 'My Chores' : 'Tasks & Chores', icon: ListChecks, bg: 'bg-violet-600' },
          { href: '/dashboard/calendar', label: 'My Calendar', icon: Calendar, bg: 'bg-blue-600' },
          { href: '/dashboard/assistant', label: 'AI Assistant', icon: Sparkles, bg: 'bg-emerald-600' },
          { href: '/dashboard?view=family', label: 'Family Dashboard', icon: LayoutDashboard, bg: 'bg-rose-500' },
        ].map((t) => (
          <Link key={t.label} href={t.href} className="group flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated">
            <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', t.bg)}>
              <t.icon className="h-5 w-5 text-fg" />
            </div>
            <p className="min-w-0 truncate text-sm font-semibold">{t.label}</p>
            <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted" />
          </Link>
        ))}
      </div>
    </div>
  );
}
