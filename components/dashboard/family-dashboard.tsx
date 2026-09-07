import Link from 'next/link';
import {
  Cake, Calendar, CheckCircle2, ChevronRight,
  ListChecks, Plus, ShoppingCart, Sparkles, Users,
  Wand2, ScanLine, Monitor, Sun, Bell, MessageCircle,
} from 'lucide-react';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import type { UserContext } from '@/lib/supabase/auth';
import { Avatar } from '@/components/ui/avatar';
import { DashboardWeather } from '@/components/dashboard/dashboard-weather';
import { fmtTime, firstName } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

const ACCENT = ['bg-violet-500', 'bg-emerald-500', 'bg-orange-500', 'bg-rose-500', 'bg-blue-500', 'bg-teal-500'];
const MEAL_EMOJIS: Record<string, string> = { breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snack: '🍎' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dayBounds() {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const in7 = new Date(start); in7.setDate(in7.getDate() + 7);
  const in14 = new Date(start); in14.setDate(in14.getDate() + 14);
  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
  return { start, end, in7, in14, weekStart, weekEnd };
}

function StatCard({ href, label, value, icon: Icon, bg, linkLabel }: {
  href: string; label: string; value: number; icon: React.ComponentType<{ className?: string }>;
  bg: string; linkLabel: string;
}) {
  return (
    <Link href={href} className="flex flex-col rounded-2xl border border-border bg-surface/40 p-5 transition hover:bg-elevated">
      <div className="flex items-center gap-3">
        <div className={cn('grid h-11 w-11 place-items-center rounded-xl', bg)}>
          <Icon className="h-5 w-5 text-fg" />
        </div>
        <div>
          <p className="text-2xl font-bold leading-none">{value}</p>
          <p className="mt-0.5 text-xs text-muted">{label}</p>
        </div>
      </div>
      <p className="mt-3 text-xs font-semibold text-brand-text">{linkLabel} →</p>
    </Link>
  );
}

export async function FamilyDashboard({ ctx }: { ctx: UserContext }) {
  const tr = await getTranslations();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const { start, end, in7, in14, weekStart, weekEnd } = dayBounds();

  const [
    { data: todayEvents },
    { count: openChores },
    { count: dueTodayCount },
    { data: upcomingEvents },
    { data: weekPlans },
    { data: members },
    { data: groceryItems },
    { data: dueTasks },
    { count: doneCount },
    { count: totalCount },
    { data: overdueReminders },
    { count: unreadMessages },
  ] = await Promise.all([
    supabase.from('calendar_events').select('*').eq('family_id', familyId)
      .gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString()).order('starts_at').limit(8),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('due_at', start.toISOString().slice(0, 10)).in('status', ['todo', 'in_progress']),
    supabase.from('calendar_events').select('id, title, starts_at, all_day, location, category')
      .eq('family_id', familyId).gte('starts_at', end.toISOString()).lte('starts_at', in14.toISOString())
      .order('starts_at').limit(5),
    supabase.from('meal_plans').select('plan_date, meal_type, meal_id')
      .eq('family_id', familyId)
      .gte('plan_date', weekStart.toISOString().slice(0, 10))
      .lt('plan_date', weekEnd.toISOString().slice(0, 10))
      .order('plan_date'),
    supabase.from('family_members').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('grocery_items').select('id, name, is_checked').eq('family_id', familyId)
      .eq('is_checked', false).order('created_at').limit(6),
    supabase.from('chore_assignments')
      .select('id, due_at, status, member_id, chore_id')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']).order('due_at').limit(4),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'done'),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId),
    supabase.from('family_reminders').select('id, title, remind_at').eq('family_id', familyId)
      .not('status', 'in', '(done,dismissed)').lt('remind_at', start.toISOString()).order('remind_at').limit(3),
    supabase.from('family_messages').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).not('read_by', 'cs', `{${ctx.active.member.user_id}}`),
  ]);

  // Resolve real chore titles for the "Tasks Due" list (no embedded join in types).
  const dueChoreIds = [...new Set((dueTasks ?? []).map((t) => t.chore_id))];
  const { data: dueChores } = dueChoreIds.length
    ? await supabase.from('chores').select('id, title').in('id', dueChoreIds)
    : { data: [] as { id: string; title: string }[] };
  const choreTitleById = new Map((dueChores ?? []).map((c) => [c.id, c.title]));

  // Birthdays in next 7 days
  const todayMMDD = start.toISOString().slice(5, 10);
  const in7MMDD = in7.toISOString().slice(5, 10);
  const birthdayCount = (members ?? []).filter((m) => {
    if (!m.birthday) return false;
    const bd = m.birthday.slice(5);
    return bd >= todayMMDD && bd <= in7MMDD;
  }).length;

  const total = totalCount ?? 0;
  const done = doneCount ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const r = 40; const circ = 2 * Math.PI * r;

  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';

  // Suggestions derived from real family data — never fabricated.
  const suggestions: { icon: typeof Calendar; text: string; cta: string }[] = [];
  if ((openChores ?? 0) > 0) {
    suggestions.push({ icon: CheckCircle2, text: `You have ${openChores} open ${openChores === 1 ? 'task' : 'tasks'} to wrap up.`, cta: 'View tasks' });
  }
  if ((weekPlans?.length ?? 0) > 0 && (groceryItems?.length ?? 0) === 0) {
    suggestions.push({ icon: ShoppingCart, text: 'Your week has meals planned but the grocery list is empty.', cta: 'Build list' });
  }
  if ((upcomingEvents?.length ?? 0) > 0) {
    suggestions.push({ icon: Calendar, text: `${upcomingEvents!.length} ${upcomingEvents!.length === 1 ? 'event is' : 'events are'} coming up in the next two weeks.`, cta: 'View calendar' });
  }
  if (birthdayCount > 0) {
    suggestions.push({ icon: Cake, text: `${birthdayCount} ${birthdayCount === 1 ? 'birthday is' : 'birthdays are'} coming up this week.`, cta: 'View members' });
  }
  if ((overdueReminders?.length ?? 0) > 0) {
    suggestions.push({ icon: Bell, text: `${overdueReminders!.length} ${overdueReminders!.length === 1 ? 'reminder is' : 'reminders are'} overdue.`, cta: 'Check reminders' });
  }
  if ((unreadMessages ?? 0) > 0) {
    suggestions.push({ icon: MessageCircle, text: `You have ${unreadMessages} unread ${(unreadMessages ?? 0) === 1 ? 'message' : 'messages'} from your family.`, cta: 'Open messages' });
  }

  // Week meal map — just show meal_type per slot (no join needed)
  type MealRow = { plan_date: string; meal_type: string; meal_id: string | null };
  const mealMap: Record<number, MealRow> = {};
  for (const p of (weekPlans ?? []) as MealRow[]) {
    const d = new Date(p.plan_date + 'T00:00:00');
    const idx = (d.getDay() + 6) % 7;
    if (!mealMap[idx]) mealMap[idx] = p;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {greeting}, {ctx.active.family.name}! <span>👋</span>
          </h1>
          <p className="mt-1 text-sm text-muted">{tr('familyDashboard.heresWhatsHappeningWithYourFamily')}</p>
        </div>
        <DashboardWeather />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard href="/dashboard/calendar" label={tr('familyDashboard.eventsToday')} value={todayEvents?.length ?? 0} icon={Calendar} bg="bg-violet-600" linkLabel="View calendar" />
        <StatCard href="/dashboard/chores" label={tr('familyDashboard.openTasks')} value={openChores ?? 0} icon={CheckCircle2} bg="bg-emerald-600" linkLabel="View tasks" />
        <StatCard href="/dashboard/chores" label={tr('familyDashboard.dueToday')} value={dueTodayCount ?? 0} icon={ListChecks} bg="bg-orange-500" linkLabel="View chores" />
        <StatCard href="/dashboard/settings#members" label={tr('familyDashboard.birthdaysSoon')} value={birthdayCount} icon={Cake} bg="bg-rose-500" linkLabel="View all" />
        <StatCard href="/dashboard/reminders" label={tr('familyDashboard.overdueAlerts')} value={overdueReminders?.length ?? 0} icon={Bell} bg="bg-amber-500" linkLabel="View reminders" />
        <StatCard href="/dashboard/messages" label={tr('familyDashboard.unreadMessages')} value={unreadMessages ?? 0} icon={MessageCircle} bg="bg-blue-600" linkLabel="Open messages" />
      </div>

      {/* AI tools */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { href: '/dashboard/inbox', label: 'Magic Import', desc: 'Paste anything → organized', icon: Wand2, bg: 'bg-violet-600' },
          { href: '/dashboard/scan', label: 'Scan Flyer', desc: 'Photo → calendar', icon: ScanLine, bg: 'bg-blue-600' },
          { href: '/dashboard/briefing', label: 'Daily Briefing', desc: "Today at a glance", icon: Sun, bg: 'bg-amber-500' },
          { href: '/dashboard/assistant', label: 'AI Assistant', desc: 'Ask anything', icon: Sparkles, bg: 'bg-emerald-600' },
          { href: '/display', label: 'Kitchen Display', desc: 'Full-screen kiosk', icon: Monitor, bg: 'bg-rose-500' },
        ].map((t) => (
          <Link key={t.href} href={t.href} className="group flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated">
            <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', t.bg)}>
              <t.icon className="h-5 w-5 text-fg" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{t.label}</p>
              <p className="truncate text-xs text-muted">{t.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      {/* Row 2: Schedule | Upcoming | AI widget */}
      <div className="grid gap-5 lg:grid-cols-3">
        {/* Today's schedule */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('familyDashboard.todaysSchedule')}</h2>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text">{tr('familyDashboard.viewCalendar')}</Link>
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
                  <div className="flex -space-x-1.5">
                    {(members ?? []).slice(0, 2).map((m) => (
                      <Avatar key={m.id} name={m.display_name} color={m.color} size={22} className="ring-1 ring-bg" />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Calendar className="h-8 w-8 text-muted/30" />
              <p className="mt-2 text-sm text-muted/60">{tr('familyDashboard.nothingScheduledToday')}</p>
            </div>
          )}
          <Link href="/dashboard/calendar" className="mt-4 flex items-center gap-1 text-xs text-muted hover:text-fg/80">
            {tr('familyDashboard.viewFullCalendar')} <ChevronRight className="h-3 w-3" />
          </Link>
        </div>

        {/* Upcoming Events */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('familyDashboard.upcomingEvents')}</h2>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text">{tr('familyDashboard.viewAll')}</Link>
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
              <p className="mt-2 text-sm text-muted/60">{tr('familyDashboard.noUpcomingEvents')}</p>
            </div>
          )}
          <Link href="/dashboard/calendar" className="mt-4 flex items-center gap-1 text-xs text-muted hover:text-fg/80">
            {tr('familyDashboard.viewFullCalendar')} <ChevronRight className="h-3 w-3" />
          </Link>
        </div>

        {/* AI Assistant widget */}
        <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand-text" />
              <h2 className="font-semibold">{tr('familyDashboard.aiAssistant')}</h2>
            </div>
          </div>
          <p className="mb-4 text-sm text-fg/70">
            {suggestions.length > 0 ? 'Here are some suggestions for your family:' : 'Everything looks on track. Ask the assistant anything.'}
          </p>
          {suggestions.length > 0 && (
            <div className="space-y-2.5">
              {suggestions.map(({ icon: Icon, text, cta }) => (
                <div key={text} className="flex gap-3 rounded-xl bg-surface/40 p-3">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-500/15">
                    <Icon className="h-4 w-4 text-brand-text" />
                  </div>
                  <div>
                    <p className="text-xs leading-5 text-fg/80">{text}</p>
                    <p className="text-xs font-semibold text-brand-text">{cta} →</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <Link href="/dashboard/assistant" className="mt-4 flex h-10 w-full items-center justify-center rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 text-sm font-bold shadow-glow">
            {tr('familyDashboard.askAnything')}
          </Link>
        </div>
      </div>

      {/* Meals this week */}
      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{tr('familyDashboard.mealsThisWeek')}</h2>
          <Link href="/dashboard/meals" className="text-xs font-semibold text-brand-text">{tr('familyDashboard.viewMealPlan')}</Link>
        </div>
        <div className="grid grid-cols-7 gap-2">
          {DAYS.map((day, i) => {
            const meal = mealMap[i];
            const name = meal?.meal_id ? meal.meal_type : null; // show emoji for any planned meal
            const type = meal?.meal_type ?? 'dinner';
            return (
              <div key={day} className="flex flex-col items-center gap-1.5">
                <Link href="/dashboard/meals" className={cn(
                  'flex h-14 w-full flex-col items-center justify-center rounded-xl text-2xl transition hover:bg-elevated',
                  name ? 'bg-elevated' : 'border border-dashed border-border'
                )}>
                  {name ? MEAL_EMOJIS[type] ?? '🍽️' : <Plus className="h-4 w-4 text-muted/40" />}
                </Link>
                <p className="text-[10px] text-muted">{day}</p>
                {name && <p className="line-clamp-2 text-center text-[10px] font-medium leading-tight text-muted">{name}</p>}
              </div>
            );
          })}
        </div>
        <Link href="/dashboard/grocery" className="mt-4 flex items-center gap-2 text-xs text-muted hover:text-fg/80">
          <ShoppingCart className="h-3.5 w-3.5" /> {tr('familyDashboard.addToGroceryList')}
        </Link>
      </div>

      {/* Row 3: Chores Progress + Grocery List */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Chores donut */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('familyDashboard.choresProgress')}</h2>
            <Link href="/dashboard/chores" className="text-xs font-semibold text-brand-text">{tr('familyDashboard.viewAll')}</Link>
          </div>
          <div className="flex items-center gap-8">
            <div className="relative h-32 w-32 shrink-0">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
                <circle cx="50" cy="50" r={r} fill="none" stroke="url(#pg)" strokeWidth="12"
                  strokeDasharray={`${circ * pct / 100} ${circ}`} strokeLinecap="round" />
                <defs>
                  <linearGradient id="pg" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#7c5dff" /><stop offset="100%" stopColor="#6355e6" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-black">{pct}%</span>
                <span className="text-[10px] text-muted">{tr('familyDashboard.completed')}</span>
              </div>
            </div>
            <div className="space-y-3">
              {[
                { color: 'bg-violet-500', label: 'Completed', val: done },
                { color: 'bg-yellow-400', label: 'In Progress', val: Math.max(0, total - done - (openChores ?? 0)) },
                { color: 'bg-elevated', label: 'Remaining', val: openChores ?? 0 },
              ].map(({ color, label, val }) => (
                <div key={label} className="flex items-center gap-3">
                  <div className={cn('h-3 w-3 rounded-full', color)} />
                  <div>
                    <p className="text-sm font-bold">{val}</p>
                    <p className="text-xs text-muted">{label}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Link href="/dashboard/chores" className="mt-4 flex items-center gap-1 text-xs text-muted hover:text-fg/80">
            {tr('familyDashboard.viewChores')} <ChevronRight className="h-3 w-3" />
          </Link>
        </div>

        {/* Grocery List */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('familyDashboard.groceryList')}</h2>
            <span className="rounded-full bg-violet-500/20 px-2.5 py-0.5 text-xs font-bold text-brand-text">
              {groceryItems?.length ?? 0} items
            </span>
          </div>
          {groceryItems && groceryItems.length > 0 ? (
            <ul className="space-y-2.5">
              {groceryItems.map((item) => (
                <li key={item.id} className="flex items-center gap-3 text-sm">
                  <div className="h-4 w-4 rounded border border-border" />
                  <span>{item.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <ShoppingCart className="h-8 w-8 text-muted/30" />
              <p className="mt-2 text-sm text-muted/60">{tr('familyDashboard.groceryListIsEmpty')}</p>
              <Link href="/dashboard/grocery" className="mt-2 text-xs font-semibold text-brand-text">{tr('familyDashboard.addItems')}</Link>
            </div>
          )}
          <Link href="/dashboard/grocery" className="mt-4 flex items-center gap-1 text-xs text-muted hover:text-fg/80">
            {tr('familyDashboard.viewFullList')} <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* Row 4: Tasks Due + Recent Activity + Family Members */}
      <div className="grid gap-5 lg:grid-cols-3">
        {/* Tasks due */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('familyDashboard.tasksDue')}</h2>
            <Link href="/dashboard/chores" className="text-xs font-semibold text-brand-text">{tr('familyDashboard.viewAll')}</Link>
          </div>
          {dueTasks && dueTasks.length > 0 ? (
            <ul className="space-y-3">
              {dueTasks.map((t) => {
                const isToday = t.due_at ? t.due_at.slice(0, 10) === start.toISOString().slice(0, 10) : false;
                const daysUntil = t.due_at ? Math.ceil((new Date(t.due_at).getTime() - start.getTime()) / 86400000) : null;
                const member = (members ?? []).find((m) => m.id === t.member_id);
                const choreTitle = choreTitleById.get(t.chore_id) ?? 'Task';
                return (
                  <li key={t.id} className="flex items-center gap-3">
                    <div className="h-4 w-4 shrink-0 rounded-full border-2 border-border" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{choreTitle}</p>
                      <p className={cn('text-xs', isToday ? 'font-semibold text-orange-400' : 'text-muted')}>
                        {isToday ? 'Due Today' : daysUntil != null ? `Due in ${daysUntil} days` : 'No due date'}
                      </p>
                    </div>
                    {member && (
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold text-fg', ACCENT[0])}>
                        {firstName(member.display_name)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-400/30" />
              <p className="mt-2 text-sm text-muted/60">{tr('familyDashboard.allCaughtUp')}</p>
            </div>
          )}
          <Link href="/dashboard/chores" className="mt-4 flex items-center gap-1 text-xs text-muted hover:text-fg/80">
            {tr('familyDashboard.viewAllTasks')} <ChevronRight className="h-3 w-3" />
          </Link>
        </div>

        {/* Recent Activity */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('familyDashboard.recentActivity')}</h2>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text">{tr('familyDashboard.viewAll')}</Link>
          </div>
          <ul className="space-y-3">
            {(todayEvents ?? []).slice(0, 3).map((e, i) => (
              <li key={e.id} className="flex items-start gap-3">
                <div className={cn('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg', ACCENT[i % ACCENT.length] + '/20')}>
                  <Calendar className={cn('h-4 w-4', ['text-emerald-300', 'text-brand-text', 'text-blue-300'][i])} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{e.title} added to calendar</p>
                  <p className="text-xs text-muted/60">{tr('familyDashboard.today')}</p>
                </div>
              </li>
            ))}
            {(members ?? []).slice(0, 3 - Math.min((todayEvents ?? []).length, 3)).map((m) => (
              <li key={m.id} className="flex items-start gap-3">
                <Avatar name={m.display_name} color={m.color} size={32} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{m.display_name} is a member</p>
                  <p className="text-xs text-muted/60">{tr('familyDashboard.recently')}</p>
                </div>
              </li>
            ))}
            {((todayEvents?.length ?? 0) === 0 && (members?.length ?? 0) === 0) && (
              <li className="py-6 text-center text-sm text-muted/60">{tr('familyDashboard.noRecentActivity')}</li>
            )}
          </ul>
        </div>

        {/* Family Members */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('familyDashboard.familyMembers')}</h2>
            {isManager(ctx.active.role) && (
              <Link href="/dashboard/settings#members" className="text-xs font-semibold text-brand-text">{tr('familyDashboard.manage')}</Link>
            )}
          </div>
          <ul className="space-y-2.5">
            {(members ?? []).map((m) => (
              <li key={m.id} className="flex items-center gap-3">
                <Avatar name={m.display_name} color={m.color} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{m.display_name}</p>
                  <p className="text-xs capitalize text-muted">
                    {m.role === 'parent' ? 'Admin' : m.role}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {isManager(ctx.active.role) && (
            <Link href="/dashboard/settings#members" className="mt-4 flex items-center gap-2 text-xs font-medium text-brand-text hover:text-violet-200">
              <Users className="h-3.5 w-3.5" /> {tr('familyDashboard.inviteAFamilyMember')}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
