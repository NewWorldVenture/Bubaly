import Link from 'next/link';
import {
  Sparkles, Calendar, CheckSquare, ShoppingCart, HeartPulse,
  ArrowRight, Bell, ChevronRight, Home, Pill, GraduationCap,
  Trophy, Sun, Clock, Users, MessageSquare, Plane, PhoneCall,
} from 'lucide-react';
import { createServer } from '@/lib/supabase/server';
import type { UserContext } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { fmtTime } from '@/lib/utils/format';
import { Rocket, Gauge, ShieldCheck } from 'lucide-react';
import { successProbability } from '@/lib/autopilot/engine';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

type ActionCard = {
  id: string;
  priority: 'high' | 'medium' | 'low';
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  title: string;
  subtitle: string;
  href: string;
  cta: string;
};

function buildActionCards(data: {
  pendingChores: number;
  todayEvents: { id: string; title: string; starts_at: string; all_day: boolean; location: string | null }[];
  lowGrocery: boolean;
  overdueMeds: boolean;
  pendingApprovals: number;
  openTodos: number;
}): ActionCard[] {
  const cards: ActionCard[] = [];

  if (data.todayEvents.length > 0) {
    const next = data.todayEvents[0];
    cards.push({
      id: 'today-event',
      priority: 'high',
      icon: Calendar,
      iconBg: 'bg-blue-500/15 text-blue-400',
      title: next.title,
      subtitle: next.all_day ? 'All day' : `Today at ${fmtTime(next.starts_at)}${next.location ? ` · ${next.location}` : ''}`,
      href: '/dashboard/calendar',
      cta: 'See calendar',
    });
  }

  if (data.pendingApprovals > 0) {
    cards.push({
      id: 'approvals',
      priority: 'high',
      icon: CheckSquare,
      iconBg: 'bg-amber-500/15 text-amber-400',
      title: `${data.pendingApprovals} chore${data.pendingApprovals > 1 ? 's' : ''} awaiting approval`,
      subtitle: 'Family members are waiting on you.',
      href: '/dashboard/chores',
      cta: 'Review now',
    });
  }

  if (data.overdueMeds) {
    cards.push({
      id: 'meds',
      priority: 'high',
      icon: Pill,
      iconBg: 'bg-rose-500/15 text-rose-400',
      title: 'Medication due today',
      subtitle: 'Check the medication schedule.',
      href: '/dashboard/medications',
      cta: 'View medications',
    });
  }

  if (data.pendingChores > 0) {
    cards.push({
      id: 'chores',
      priority: 'medium',
      icon: CheckSquare,
      iconBg: 'bg-violet-500/15 text-violet-400',
      title: `${data.pendingChores} task${data.pendingChores > 1 ? 's' : ''} to do today`,
      subtitle: 'Keep the momentum going.',
      href: '/dashboard/chores',
      cta: 'View tasks',
    });
  }

  if (data.lowGrocery) {
    cards.push({
      id: 'grocery',
      priority: 'medium',
      icon: ShoppingCart,
      iconBg: 'bg-emerald-500/15 text-emerald-400',
      title: 'Grocery list needs updating',
      subtitle: 'Items may be running low.',
      href: '/dashboard/grocery',
      cta: 'Update list',
    });
  }

  if (data.openTodos > 0) {
    cards.push({
      id: 'todos',
      priority: 'low',
      icon: CheckSquare,
      iconBg: 'bg-teal-500/15 text-teal-400',
      title: `${data.openTodos} to-do item${data.openTodos > 1 ? 's' : ''} open`,
      subtitle: 'Personal items waiting for you.',
      href: '/dashboard/todos',
      cta: 'View to-dos',
    });
  }

  return cards.slice(0, 5);
}

const QUICK_LINKS = [
  { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar, bg: 'bg-blue-500/10 text-blue-400' },
  { href: '/dashboard/chores', label: 'Tasks', icon: CheckSquare, bg: 'bg-violet-500/10 text-violet-400' },
  { href: '/dashboard/grocery', label: 'Grocery', icon: ShoppingCart, bg: 'bg-emerald-500/10 text-emerald-400' },
  { href: '/dashboard/health', label: 'Health', icon: HeartPulse, bg: 'bg-rose-500/10 text-rose-400' },
  { href: '/dashboard/home', label: 'Home', icon: Home, bg: 'bg-orange-500/10 text-orange-400' },
  { href: '/dashboard/school', label: 'School', icon: GraduationCap, bg: 'bg-indigo-500/10 text-indigo-400' },
  { href: '/dashboard/sports', label: 'Sports', icon: Trophy, bg: 'bg-yellow-500/10 text-yellow-400' },
  { href: '/dashboard/health', label: 'Medical', icon: HeartPulse, bg: 'bg-pink-500/10 text-pink-400' },
];

export async function AiHomeDashboard({ ctx }: { ctx: UserContext }) {
  const familyId = ctx.active.familyId;
  const me = ctx.active.member;
  const myMemberId = me.id;
  const manager = isManager(ctx.active.role);
  const supabase = await createServer();

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);

  const [
    { count: pendingChores },
    { data: todayEvents },
    { count: groceryCount },
    { count: overdueMedsCount },
    { count: pendingApprovals },
    { count: openTodos },
    { data: members },
    { data: upcomingEvents },
    { data: recentActivity },
    { data: autopilotOpen },
    { count: autopilotHandledCount },
    { count: unreadCommsCount },
    { data: activeConcierge },
    { count: unreadCallsCount },
  ] = await Promise.all([
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('member_id', myMemberId).in('status', ['todo', 'in_progress']),
    supabase.from('calendar_events')
      .select('id, title, starts_at, all_day, location')
      .eq('family_id', familyId)
      .or(`assignee_id.eq.${myMemberId},assignee_id.is.null`)
      .gte('starts_at', todayStart.toISOString()).lt('starts_at', todayEnd.toISOString())
      .order('starts_at').limit(5),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_checked', false),
    supabase.from('medications').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_active', true).limit(1),
    manager
      ? supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
          .eq('family_id', familyId).eq('status', 'submitted')
      : Promise.resolve({ count: 0 }),
    supabase.from('todo_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_done', false),
    supabase.from('family_members').select('id, display_name, color, role')
      .eq('family_id', familyId).eq('is_active', true).order('created_at').limit(6),
    supabase.from('calendar_events')
      .select('id, title, starts_at, all_day')
      .eq('family_id', familyId)
      .or(`assignee_id.eq.${myMemberId},assignee_id.is.null`)
      .gte('starts_at', todayEnd.toISOString())
      .lte('starts_at', new Date(Date.now() + 7 * 86400000).toISOString())
      .order('starts_at').limit(5),
    supabase.from('audit_logs').select('id, action, entity_type, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(5),
    supabase.from('autopilot_suggestions')
      .select('id, title, detail, kind, urgency, confidence')
      .eq('family_id', familyId).eq('status', 'open')
      .order('urgency', { ascending: false }).order('confidence', { ascending: false }).limit(20),
    supabase.from('autopilot_suggestions').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('status', ['auto_executed', 'executed', 'approved']),
    supabase.from('family_communications').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'unread'),
    supabase.from('concierge_plans').select('id, title, kind, status')
      .eq('family_id', familyId).in('status', ['planning', 'booked', 'confirmed'])
      .order('created_at', { ascending: false }).limit(2),
    supabase.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_read', false),
  ]);

  const openSuggestions = (autopilotOpen ?? []) as { id: string; title: string; detail: string | null; kind: string; urgency: number; confidence: number }[];
  const concierge = (activeConcierge ?? []) as { id: string; title: string; kind: string; status: string }[];
  const autopilotProbability = successProbability(openSuggestions.map((s) => ({ urgency: s.urgency as 1 | 2 | 3, confidence: s.confidence } as never)));
  const autopilotHandled = autopilotHandledCount ?? 0;
  const topSuggestions = openSuggestions.slice(0, 3);
  const showAutopilot = openSuggestions.length > 0 || autopilotHandled > 0;

  const actionCards = buildActionCards({
    pendingChores: pendingChores ?? 0,
    todayEvents: todayEvents ?? [],
    lowGrocery: (groceryCount ?? 0) > 0,
    overdueMeds: (overdueMedsCount ?? 0) > 0,
    pendingApprovals: pendingApprovals ?? 0,
    openTodos: openTodos ?? 0,
  });

  const name = me.display_name ?? ctx.user.email?.split('@')[0] ?? 'there';
  const hasEvents = (todayEvents ?? []).length > 0;
  const hasUpcoming = (upcomingEvents ?? []).length > 0;

  return (
    <div className="space-y-6 pb-32">
      {/* Greeting header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted">{todayLabel()}</p>
          <h1 className="mt-0.5 text-2xl font-bold sm:text-3xl">{greeting()}, {name.split(' ')[0]}.</h1>
        </div>
        <Link href="/dashboard/assistant" className="flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand/20 transition">
          <Sparkles className="h-3.5 w-3.5" /> Ask AI
        </Link>
      </div>

      {/* Family members strip */}
      {(members ?? []).length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
          {(members ?? []).map((m) => (
            <div key={m.id} className="flex shrink-0 flex-col items-center gap-1">
              <Avatar name={m.display_name ?? '?'} color={m.color ?? undefined} size={40} className="rounded-full" />
              <span className="text-[10px] text-muted max-w-[48px] truncate text-center">{(m.display_name ?? '?').split(' ')[0]}</span>
            </div>
          ))}
        </div>
      )}

      {/* Family Autopilot — Control Tower summary */}
      {showAutopilot && (
        <Link href="/dashboard/autopilot"
          className="block rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-5 transition hover:border-brand/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15">
                <Rocket className="h-5 w-5 text-brand" />
              </div>
              <div>
                <p className="text-sm font-bold">Family Autopilot</p>
                <p className="text-xs text-muted">Bubaly is watching over today</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-brand" />
          </div>

          <div className="mt-4 flex items-center gap-5">
            <div className="flex items-center gap-2">
              <Gauge className={cn('h-4 w-4', autopilotProbability >= 85 ? 'text-emerald-400' : autopilotProbability >= 60 ? 'text-amber-400' : 'text-rose-400')} />
              <span className="text-lg font-black">{autopilotProbability}%</span>
              <span className="text-[11px] text-muted">on track</span>
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span className="text-lg font-black">{autopilotHandled}</span>
              <span className="text-[11px] text-muted">handled</span>
            </div>
            {openSuggestions.length > 0 && (
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-amber-400" />
                <span className="text-lg font-black">{openSuggestions.length}</span>
                <span className="text-[11px] text-muted">to review</span>
              </div>
            )}
          </div>

          {topSuggestions.length > 0 && (
            <div className="mt-4 space-y-1.5 border-t border-border/40 pt-3">
              {topSuggestions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-xs">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.urgency === 3 ? 'bg-rose-400' : s.urgency === 2 ? 'bg-amber-400' : 'bg-muted')} />
                  <span className="truncate text-fg/90">{s.title}</span>
                </div>
              ))}
            </div>
          )}
        </Link>
      )}

      {/* Front Desk + Communications + Concierge widgets */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Link href="/dashboard/front-desk"
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated hover:border-brand/20">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-green-500/10">
            <PhoneCall className="h-5 w-5 text-green-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Front Desk</p>
            <p className="truncate text-xs text-muted">
              {(unreadCallsCount ?? 0) > 0 ? `${unreadCallsCount} new call${unreadCallsCount === 1 ? '' : 's'}` : 'All calls handled'}
            </p>
          </div>
          {(unreadCallsCount ?? 0) > 0 && (
            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-[10px] font-bold text-white shrink-0">
              {unreadCallsCount}
            </span>
          )}
        </Link>
        <Link href="/dashboard/inbox"
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated hover:border-brand/20">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-500/10">
            <MessageSquare className="h-5 w-5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Inbox</p>
            <p className="text-xs text-muted">
              {(unreadCommsCount ?? 0) > 0 ? `${unreadCommsCount} unread` : 'No new messages'}
            </p>
          </div>
          {(unreadCommsCount ?? 0) > 0 && (
            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white shrink-0">
              {unreadCommsCount}
            </span>
          )}
        </Link>
        <Link href="/dashboard/concierge"
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated hover:border-brand/20">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500/10">
            <Plane className="h-5 w-5 text-violet-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Concierge</p>
            <p className="truncate text-xs text-muted">
              {concierge.length > 0 ? concierge[0].title : 'Plan something fun'}
            </p>
          </div>
        </Link>
      </div>

      {/* AI Action Cards */}
      {actionCards.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Needs Your Attention</h2>
          </div>
          <div className="space-y-2.5">
            {actionCards.map((card) => (
              <Link
                key={card.id}
                href={card.href}
                className={cn(
                  'flex items-center gap-4 rounded-2xl border p-4 transition hover:bg-elevated',
                  card.priority === 'high'
                    ? 'border-amber-500/20 bg-amber-500/5'
                    : 'border-border bg-surface/40',
                )}
              >
                <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', card.iconBg)}>
                  <card.icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{card.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">{card.subtitle}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1 text-xs font-semibold text-brand">
                  {card.cta} <ChevronRight className="h-3.5 w-3.5" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Today's schedule */}
      {hasEvents && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sun className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Today</h2>
            </div>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand hover:underline">View all</Link>
          </div>
          <div className="space-y-2">
            {(todayEvents ?? []).map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10">
                  <Clock className="h-4 w-4 text-blue-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{ev.title}</p>
                  <p className="text-xs text-muted">{ev.all_day ? 'All day' : fmtTime(ev.starts_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming this week */}
      {hasUpcoming && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Coming Up</h2>
            </div>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand hover:underline">Calendar</Link>
          </div>
          <div className="space-y-1.5">
            {(upcomingEvents ?? []).map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5">
                <Calendar className="h-4 w-4 shrink-0 text-muted" />
                <span className="flex-1 truncate text-sm">{ev.title}</span>
                <span className="text-xs text-muted">
                  {new Date(ev.starts_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick links grid */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Quick Access</h2>
        </div>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-4">
          {QUICK_LINKS.slice(0, 8).map(({ href, label, icon: Icon, bg }) => (
            <Link
              key={href + label}
              href={href}
              className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-surface/40 py-4 text-center transition hover:bg-elevated hover:border-brand/20"
            >
              <div className={cn('grid h-9 w-9 place-items-center rounded-xl', bg)}>
                <Icon className="h-4 w-4" />
              </div>
              <span className="text-[11px] font-semibold">{label}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* Empty state when no cards */}
      {actionCards.length === 0 && !hasEvents && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-surface/40 py-12 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-brand/10">
            <Sparkles className="h-8 w-8 text-brand" />
          </div>
          <div>
            <p className="font-semibold">You&apos;re all caught up!</p>
            <p className="mt-1 text-sm text-muted">No urgent items. Add something via the + button.</p>
          </div>
          <Link href="/capture" className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand/90">
            Capture something
          </Link>
        </div>
      )}

      {/* AI nudge */}
      <Link href="/dashboard/assistant"
        className="flex items-center gap-4 rounded-2xl border border-brand/20 bg-gradient-to-r from-brand/10 to-violet-500/10 p-5 transition hover:border-brand/40">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand/20">
          <Sparkles className="h-6 w-6 text-brand" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">Ask your AI Chief of Staff</p>
          <p className="mt-0.5 text-xs text-muted">Plan meals, resolve schedule conflicts, draft messages…</p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-brand" />
      </Link>
    </div>
  );
}
