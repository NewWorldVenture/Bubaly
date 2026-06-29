import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Plus, Calendar as CalendarIcon, CheckSquare, UtensilsCrossed, MoreHorizontal,
  ChevronRight, Clock, ListChecks, CalendarDays, ChefHat, ClipboardCheck,
  DollarSign, Image as ImageIcon, MessageCircle, Check, Sparkles,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { fmtTime } from '@/lib/utils/format';
import { familyScore } from '@/lib/home/family-score';
import {
  summarizeMonthFinances, usd, memberTagline, weekStrip, isoDate, type HomeTxn,
} from '@/lib/home/home-data';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ── Small shared UI ───────────────────────────────────────────────────────────
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn('flex flex-col rounded-2xl border border-border bg-surface/40 p-5', className)}>{children}</section>;
}

function CardHead({ icon: Icon, title, href, action }: { icon: React.ComponentType<{ className?: string }>; title: string; href?: string; action?: string }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand" />
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      {href && (
        <Link href={href} className="flex items-center gap-0.5 text-xs font-semibold text-brand hover:underline">
          {action ?? 'View all'} <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted">{children}</p>;
}

// A circular progress ring (SVG) used by the Family Score widget.
function Ring({ value, size = 92, stroke = 8, children }: { value: number; size?: number; stroke?: number; children: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const dash = (pct / 100) * c;
  const color = pct >= 80 ? 'text-emerald-400' : pct >= 60 ? 'text-amber-400' : 'text-rose-400';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="fill-none stroke-white/10" />
        <circle
          cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} strokeLinecap="round"
          className={cn('fill-none transition-all', color)} stroke="currentColor"
          strokeDasharray={`${dash} ${c - dash}`}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

// A two-slice income/expense donut with the remaining balance in the center.
function FinanceDonut({ income, expenses, remaining, size = 124, stroke = 14 }: { income: number; expenses: number; remaining: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = Math.max(income, income + Math.max(0, -remaining), 1);
  const expSeg = Math.min(1, expenses / (income > 0 ? income : Math.max(expenses, 1)));
  const expDash = expSeg * c;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="fill-none stroke-emerald-400/80" />
        <circle
          cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke}
          className="fill-none stroke-rose-400/80" strokeDasharray={`${expDash} ${c - expDash}`}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="text-[10px] text-muted">Remaining</p>
          <p className="text-sm font-black">{usd(remaining)}</p>
        </div>
      </div>
      <span className="sr-only">Income {usd(income)}, expenses {usd(expenses)}, total {usd(total)}</span>
    </div>
  );
}

// ── Top action buttons ────────────────────────────────────────────────────────
const ACTIONS = [
  { href: '/capture', label: 'Add', icon: Plus, primary: true },
  { href: '/dashboard/calendar', label: 'Calendar', icon: CalendarIcon },
  { href: '/dashboard/todos', label: 'Task', icon: CheckSquare },
  { href: '/dashboard/meals', label: 'Meal', icon: UtensilsCrossed },
  { href: '/dashboard/more', label: 'More', icon: MoreHorizontal },
];

type Member = { id: string; display_name: string; color: string | null; role: string; birthday: string | null; user_id: string | null };

export default async function HomePage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);
  const todayIso = isoDate(now);
  const week = weekStrip(now);
  const weekStartIso = week[0].date;
  const weekEndIso = week[6].date;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    { data: members },
    { data: todayEvents },
    { data: upcomingEvents },
    { data: tasks },
    { data: choreRows },
    { data: dinnerPlans },
    { data: txns },
    { data: photos },
    { data: messages },
    { count: choresToday },
    { count: choresDone },
    { count: tasksOverdue },
    { count: overdueReminders },
  ] = await Promise.all([
    supabase.from('family_members').select('id, display_name, color, role, birthday, user_id')
      .eq('family_id', familyId).eq('is_active', true).order('created_at').limit(12),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, location, assignee_id')
      .eq('family_id', familyId).gte('starts_at', todayStart.toISOString()).lt('starts_at', todayEnd.toISOString())
      .order('starts_at').limit(8),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id')
      .eq('family_id', familyId).gte('starts_at', todayEnd.toISOString())
      .lte('starts_at', new Date(Date.now() + 30 * 86400000).toISOString()).order('starts_at').limit(5),
    supabase.from('todo_items').select('id, title, due_date, is_done, assigned_to_id')
      .eq('family_id', familyId).eq('is_done', false).order('due_date', { ascending: true, nullsFirst: false }).limit(6),
    supabase.from('chore_assignments').select('id, status, member_id, chore_id, due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress', 'submitted', 'approved'])
      .order('created_at', { ascending: false }).limit(6),
    supabase.from('meal_plans').select('plan_date, meal_id, meal_type')
      .eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', weekStartIso).lte('plan_date', weekEndIso),
    supabase.from('transactions').select('type, amount, date')
      .eq('family_id', familyId).gte('date', isoDate(monthStart)).limit(1000),
    supabase.from('family_photos').select('id, url, thumbnail_url, caption, taken_at, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(4),
    supabase.from('family_messages').select('id, sender_id, sender_name, sender_avatar, content, created_at, read_by')
      .eq('family_id', familyId).is('deleted_at', null).order('created_at', { ascending: false }).limit(4),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).gte('due_at', todayStart.toISOString()).lt('due_at', todayEnd.toISOString()),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'approved').gte('due_at', todayStart.toISOString()).lt('due_at', todayEnd.toISOString()),
    supabase.from('todo_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_done', false).lt('due_date', todayIso),
    supabase.from('family_reminders').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null).lt('remind_at', now.toISOString()),
  ]);

  const memberList = (members ?? []) as Member[];
  const memberById = new Map(memberList.map((m) => [m.id, m]));
  const me = ctx.active.member;
  const firstName = (me.display_name ?? ctx.user.email?.split('@')[0] ?? 'there').split(' ')[0];

  const score = familyScore({
    choresToday: choresToday ?? 0,
    choresDone: choresDone ?? 0,
    tasksOverdue: tasksOverdue ?? 0,
    overdueReminders: overdueReminders ?? 0,
  });

  const finances = summarizeMonthFinances((txns ?? []) as HomeTxn[], now);

  // Resolve this week's dinner meals → today's pick + which days are planned.
  const plans = (dinnerPlans ?? []) as { plan_date: string; meal_id: string | null }[];
  const mealIds = [...new Set(plans.map((p) => p.meal_id).filter((x): x is string => !!x))];
  const { data: meals } = mealIds.length
    ? await supabase.from('meals').select('id, name, notes, recipe_url').in('id', mealIds)
    : { data: [] as { id: string; name: string; notes: string | null; recipe_url: string | null }[] };
  const mealById = new Map((meals ?? []).map((m) => [m.id, m]));
  const plannedDates = new Set(plans.filter((p) => p.meal_id).map((p) => p.plan_date));
  const todayPlan = plans.find((p) => p.plan_date === todayIso);
  const todayMeal = todayPlan?.meal_id ? mealById.get(todayPlan.meal_id) : undefined;

  // Resolve chore titles for the listed assignments in one query.
  const choreList = (choreRows ?? []) as { id: string; status: string; member_id: string; chore_id: string }[];
  const choreIds = [...new Set(choreList.map((c) => c.chore_id))];
  const { data: choreDefs } = choreIds.length
    ? await supabase.from('chores').select('id, title').in('id', choreIds).eq('family_id', familyId)
    : { data: [] as { id: string; title: string }[] };
  const choreTitleById = new Map((choreDefs ?? []).map((c) => [c.id, c.title]));

  const msgs = (messages ?? []) as { id: string; sender_id: string | null; sender_name: string | null; sender_avatar: string | null; content: string | null; created_at: string; read_by: string[] }[];

  return (
    <div className="space-y-6 pb-28">
      {/* Header: greeting + quick actions */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-black sm:text-3xl">{greeting()}, {firstName}! <span aria-hidden>👋</span></h1>
          <p className="mt-1 text-sm text-muted">Here&apos;s what&apos;s happening with your family today.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ACTIONS.map((a) => (
            <Link key={a.label} href={a.href}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition',
                a.primary ? 'bg-brand text-white hover:opacity-90' : 'border border-border bg-surface/40 hover:bg-elevated',
              )}>
              <a.icon className="h-4 w-4" /> {a.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* My Family */}
        <Card className="lg:col-span-2">
          <CardHead icon={Sparkles} title="My Family" href="/dashboard/family-tree" />
          <div className="flex flex-wrap gap-5">
            {memberList.map((m) => (
              <div key={m.id} className="flex w-16 flex-col items-center gap-1.5 text-center">
                <Avatar name={m.display_name} color={m.color ?? undefined} size={52} className="rounded-full" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold">{m.display_name.split(' ')[0]}</p>
                  <p className="truncate text-[10px] text-muted">{memberTagline(m, ctx.user.id, now)}</p>
                </div>
              </div>
            ))}
            <Link href="/dashboard/settings#members" className="flex w-16 flex-col items-center gap-1.5 text-center text-muted hover:text-brand">
              <span className="grid h-[52px] w-[52px] place-items-center rounded-full border border-dashed border-border"><Plus className="h-5 w-5" /></span>
              <span className="text-[10px]">Invite</span>
            </Link>
          </div>
        </Card>

        {/* Family Score */}
        <Card>
          <CardHead icon={Sparkles} title="Family Score" href="/dashboard/readiness" action="View insights" />
          <div className="flex flex-1 items-center gap-4">
            <Ring value={score.score}>
              <div>
                <p className="text-2xl font-black leading-none">{score.score}</p>
                <p className="text-[10px] text-muted">{score.grade}</p>
              </div>
            </Ring>
            <p className="text-sm text-muted">{score.message}</p>
          </div>
        </Card>

        {/* Today's Schedule */}
        <Card>
          <CardHead icon={Clock} title="Today's Schedule" href="/dashboard/calendar" action="View calendar" />
          <div className="space-y-3">
            {(todayEvents ?? []).length === 0 && <EmptyRow>Nothing scheduled today.</EmptyRow>}
            {((todayEvents ?? []) as { id: string; title: string; starts_at: string; all_day: boolean; location: string | null }[]).map((e) => (
              <div key={e.id} className="flex gap-3">
                <div className="w-16 shrink-0 text-xs font-semibold text-brand">{e.all_day ? 'All day' : fmtTime(e.starts_at)}</div>
                <div className="min-w-0 flex-1 border-l border-border pl-3">
                  <p className="truncate text-sm font-semibold">{e.title}</p>
                  {e.location && <p className="truncate text-xs text-muted">{e.location}</p>}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Tasks */}
        <Card>
          <CardHead icon={ListChecks} title="Tasks" href="/dashboard/todos" />
          <div className="space-y-2.5">
            {(tasks ?? []).length === 0 && <EmptyRow>No open tasks. Nicely done.</EmptyRow>}
            {((tasks ?? []) as { id: string; title: string; due_date: string | null; assigned_to_id: string | null }[]).map((t) => {
              const owner = t.assigned_to_id ? memberById.get(t.assigned_to_id) : undefined;
              const due = t.due_date ? (t.due_date === todayIso ? 'Today' : new Date(t.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : null;
              return (
                <div key={t.id} className="flex items-center gap-3">
                  <span className="h-4 w-4 shrink-0 rounded-full border-2 border-emerald-400/60" />
                  <p className="min-w-0 flex-1 truncate text-sm">{t.title}</p>
                  {due && <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold', due === 'Today' ? 'bg-amber-500/15 text-amber-400' : 'text-muted')}>{due}</span>}
                  {owner && <Avatar name={owner.display_name} color={owner.color ?? undefined} size={22} className="shrink-0 rounded-full" />}
                </div>
              );
            })}
          </div>
          <Link href="/dashboard/todos" className="mt-3 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-semibold text-muted transition hover:text-brand">
            <Plus className="h-3.5 w-3.5" /> Add a new task
          </Link>
        </Card>

        {/* Upcoming Events */}
        <Card>
          <CardHead icon={CalendarDays} title="Upcoming Events" href="/dashboard/calendar" action="View calendar" />
          <div className="space-y-2.5">
            {(upcomingEvents ?? []).length === 0 && <EmptyRow>No upcoming events.</EmptyRow>}
            {((upcomingEvents ?? []) as { id: string; title: string; starts_at: string; all_day: boolean; assignee_id: string | null }[]).map((e) => {
              const d = new Date(e.starts_at);
              const owner = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
              return (
                <div key={e.id} className="flex items-center gap-3">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-elevated text-center">
                    <span className="text-[9px] font-bold uppercase text-muted leading-none">{d.toLocaleDateString('en-US', { month: 'short' })}</span>
                    <span className="text-sm font-black leading-none">{d.getDate()}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{e.title}</p>
                    <p className="truncate text-xs text-muted">{e.all_day ? 'All day' : fmtTime(e.starts_at)}</p>
                  </div>
                  {owner && <Avatar name={owner.display_name} color={owner.color ?? undefined} size={24} className="shrink-0 rounded-full" />}
                </div>
              );
            })}
          </div>
        </Card>

        {/* What's for Dinner */}
        <Card>
          <CardHead icon={ChefHat} title="What's for Dinner?" href="/dashboard/meals" action="View meal plan" />
          <div className="flex-1">
            {todayMeal ? (
              <div>
                <p className="text-base font-bold">{todayMeal.name}</p>
                {todayMeal.notes && <p className="mt-0.5 text-xs text-muted line-clamp-2">{todayMeal.notes}</p>}
              </div>
            ) : (
              <EmptyRow>No dinner planned for today.</EmptyRow>
            )}
            <div className="mt-4 flex justify-between gap-1">
              {week.map((d) => (
                <div key={d.date} className={cn(
                  'flex h-12 w-10 flex-col items-center justify-center rounded-xl text-center',
                  d.isToday ? 'bg-brand text-white' : plannedDates.has(d.date) ? 'bg-emerald-500/15 text-emerald-400' : 'bg-elevated text-muted',
                )}>
                  <span className="text-[9px] font-bold uppercase leading-none">{d.dow}</span>
                  <span className="text-sm font-black leading-none">{d.dom}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* Chores */}
        <Card>
          <CardHead icon={ClipboardCheck} title="Chores" href="/dashboard/chores" />
          <div className="space-y-2.5">
            {(choreRows ?? []).length === 0 && <EmptyRow>No chores assigned.</EmptyRow>}
            {choreList.map((c) => {
              const owner = memberById.get(c.member_id);
              const done = c.status === 'approved';
              return (
                <div key={c.id} className="flex items-center gap-3">
                  <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full border-2', done ? 'border-emerald-400 bg-emerald-400/20 text-emerald-400' : 'border-muted/50')}>
                    {done && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <p className={cn('min-w-0 flex-1 truncate text-sm', done && 'text-muted line-through')}>{choreTitleById.get(c.chore_id) ?? 'Chore'}</p>
                  {owner && <span className="shrink-0 text-xs text-muted">{owner.display_name.split(' ')[0]}</span>}
                </div>
              );
            })}
          </div>
          <Link href="/dashboard/chores" className="mt-3 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-semibold text-muted transition hover:text-brand">
            <Plus className="h-3.5 w-3.5" /> Add a chore
          </Link>
        </Card>

        {/* Family Finances */}
        <Card>
          <CardHead icon={DollarSign} title="Family Finances" href="/dashboard/billing" action="View finances" />
          <p className="text-xs text-muted">This Month · {monthStart.toLocaleDateString('en-US', { month: 'long' })}</p>
          <div className="mt-3 flex items-center gap-4">
            <FinanceDonut income={finances.income} expenses={finances.expenses} remaining={finances.remaining} />
            <div className="flex-1 space-y-2 text-sm">
              <Row label="Total Income" value={usd(finances.income)} valueClass="text-emerald-400" />
              <Row label="Total Expenses" value={usd(finances.expenses)} valueClass="text-rose-400" />
              <Row label="Remaining" value={usd(finances.remaining)} valueClass="text-brand font-bold" />
            </div>
          </div>
        </Card>

        {/* Recent Memories */}
        <Card className="lg:col-span-2">
          <CardHead icon={ImageIcon} title="Recent Memories" href="/dashboard/memories" action="View all memories" />
          {(photos ?? []).length === 0 ? (
            <EmptyRow>No memories yet — capture your first moment.</EmptyRow>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {((photos ?? []) as { id: string; url: string | null; thumbnail_url: string | null; caption: string | null; taken_at: string | null; created_at: string }[]).map((p) => {
                const src = p.thumbnail_url || p.url;
                const when = new Date(p.taken_at || p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                return (
                  <Link key={p.id} href="/dashboard/memories" className="group relative aspect-square overflow-hidden rounded-xl bg-elevated">
                    {src
                      ? <img src={src} alt={p.caption ?? 'Family memory'} className="h-full w-full object-cover transition group-hover:scale-105" />
                      : <span className="grid h-full w-full place-items-center text-muted"><ImageIcon className="h-6 w-6" /></span>}
                    <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-white">{when}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        {/* Family Messages */}
        <Card>
          <CardHead icon={MessageCircle} title="Family Messages" href="/dashboard/messages" />
          <div className="space-y-3">
            {msgs.length === 0 && <EmptyRow>No messages yet.</EmptyRow>}
            {msgs.map((m) => {
              const sender = m.sender_id ? memberById.get(m.sender_id) : undefined;
              const name = m.sender_name ?? sender?.display_name ?? 'Someone';
              const unread = !!m.sender_id && m.sender_id !== ctx.user.id && !(m.read_by ?? []).includes(ctx.user.id);
              return (
                <div key={m.id} className="flex items-start gap-3">
                  <Avatar name={name} color={sender?.color ?? undefined} src={m.sender_avatar ?? undefined} size={32} className="shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-semibold">{name.split(' ')[0]}</p>
                      <span className="shrink-0 text-[10px] text-muted">{fmtTime(m.created_at)}</span>
                    </div>
                    <p className="truncate text-xs text-muted">{m.content ?? '—'}</p>
                  </div>
                  {unread && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className={cn('font-semibold', valueClass)}>{value}</span>
    </div>
  );
}
