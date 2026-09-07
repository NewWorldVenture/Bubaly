import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  Plus, Calendar as CalendarIcon, CheckSquare, UtensilsCrossed, MoreHorizontal,
  ChevronRight, Clock, ListChecks, CalendarDays, ChefHat, ClipboardCheck,
  DollarSign, Image as ImageIcon, MessageCircle, Check, Sparkles, Rocket, ArrowRight,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { getOnboardingProgress, resolveCompleteness } from '@/lib/server/onboarding-progress';
import { isManager } from '@/lib/constants/roles';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { fmtTime, firstName } from '@/lib/utils/format';
import { familyScore } from '@/lib/home/family-score';
import { HomeMomentCard } from '@/components/moments/home-moment-card';
import { OnThisDayCard } from '@/components/memories/on-this-day-card';
import { TimeOfDayFocus } from '@/components/home/time-of-day-focus';
import { AskBar } from '@/components/home/ask-bar';
import { NeedsAttention } from '@/components/concierge/needs-attention';
import { WorkingOn } from '@/components/concierge/working-on';
import { CompletedByBubaly } from '@/components/concierge/completed-by-bubaly';
import {
  buildToday, mergeCompletedByBubaly, workingRunsFrom, WORKING_RUN_STATES,
  type AiActivityRow, type CompletedRunRow, type TodayChoreRow, type TodayEventRow, type TodayReminderRow, type TodayTodoRow,
  type WorkingRunRow, type WorkingStepRow,
} from '@/lib/home/today';
import { buildHomeNeeds } from '@/lib/home/needs-build';
import { needsHeadline, summarizeNeeds, topNeeds } from '@/lib/home/needs-attention';
import type { AwaitingRunRow, ParentApprovalRow, RecommendationRow } from '@/lib/home/needs-sources';
import { listPending } from '@/lib/services/approvals';
import { dayKeyInTz, scopeFromUserContext, zonedDayBoundsMs } from '@/lib/services/scope';
import { TimeSavedBanner } from '@/components/metric/time-saved-banner';
import { loadTimeSaved } from '@/lib/metric/time-saved-server';
import { dayPhase } from '@/lib/home/time-of-day';
import { roleGreeting, roleSurface } from '@/lib/ui/role-surface';
import {
  summarizeMonthFinances, usd, memberTagline, weekStrip, isoDate, type HomeTxn,
} from '@/lib/home/home-data';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

// ── Small shared UI ───────────────────────────────────────────────────────────
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn('flex flex-col rounded-2xl border border-border bg-surface/40 p-5', className)}>{children}</section>;
}

function CardHead({ icon: Icon, title, href, action }: { icon: React.ComponentType<{ className?: string }>; title: string; href?: string; action?: string }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand-text" />
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      {href && (
        <Link href={href} className="flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline">
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
async function FinanceDonut({ income, expenses, remaining, size = 124, stroke = 14 }: { income: number; expenses: number; remaining: number; size?: number; stroke?: number }) {
  const i18nT = await getTranslations();
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
          <p className="text-[10px] text-muted">{i18nT('home.remaining')}</p>
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
  const i18nT = await getTranslations();
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  // The family's own day, not the server's: the Today section and its reads
  // resolve "today" in the family timezone.
  const tz = ctx.active.family.timezone || 'UTC';
  const todayKey = dayKeyInTz(now, tz);
  const dayBounds = zonedDayBoundsMs(todayKey, tz);
  const todayStart = new Date(dayBounds.start);
  const todayEnd = new Date(dayBounds.end);
  const todayIso = todayKey;
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
  const myFirstName = (me.display_name ?? ctx.user.email?.split('@')[0] ?? 'there').split(' ')[0];

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

  // §16 Command Center reads. The family's own day (not the server's): the
  // window and the day key come from the family timezone so "today" is today
  // for them. Every read is family-scoped and captures its error; a failed
  // read logs and renders as empty rather than as a false "all clear" — except
  // the approvals inbox, whose failure is shown, because "nothing needs you"
  // is a claim.
  const dayEndIso = todayEnd.toISOString();
  const since48h = new Date(now.getTime() - 2 * 86400000).toISOString();
  const manager = isManager(me.role);
  const [
    activeRunsRes, completedRunsRes, agentRes, autoDoneRes, recsRes, aiApprovalsRes,
    moneyApprovalsRes, choreSignoffRes, todosDueRes, choresDueRes, remindersDueRes,
  ] = await Promise.all([
    supabase.from('family_automation_runs').select('id, summary, state, plan_id, updated_at, created_at')
      .eq('family_id', familyId).in('state', [...WORKING_RUN_STATES]).order('updated_at', { ascending: false }).limit(8),
    supabase.from('family_automation_runs').select('id, summary, state, progress, completed_at, updated_at')
      .eq('family_id', familyId).in('state', ['completed', 'partially_completed'])
      .order('completed_at', { ascending: false, nullsFirst: false }).limit(6),
    // Specialist-agent actions completed recently — the Chief of Staff reports
    // its whole staff's work, not just the run executor's.
    supabase.from('agent_activity').select('id, title, detail, href, created_at')
      .eq('family_id', familyId).eq('kind', 'action').eq('status', 'done').gte('created_at', since48h)
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('autopilot_suggestions').select('id, title, created_at')
      .eq('family_id', familyId).eq('status', 'auto_executed').gte('created_at', since48h)
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('family_ai_recommendations').select('id, title, body, priority, cta_href, created_at')
      .eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(5),
    listPending(scopeFromUserContext(ctx, supabase)),
    manager
      ? supabase.from('parent_approvals').select('id, kind, amount_cents, created_at')
          .eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(20)
      : Promise.resolve({ data: [] as ParentApprovalRow[], error: null }),
    manager
      ? supabase.from('chore_assignments').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'submitted')
      : Promise.resolve({ count: 0, error: null }),
    supabase.from('todo_items').select('id, title, due_date, priority, assigned_to_id')
      .eq('family_id', familyId).eq('is_done', false).lte('due_date', todayKey).order('due_date', { ascending: true }).limit(20),
    supabase.from('chore_assignments').select('id, chore_id, member_id, status, due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']).lt('due_at', dayEndIso).order('due_at', { ascending: true }).limit(20),
    supabase.from('family_reminders').select('id, title, remind_at, member_id, priority')
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null).lte('remind_at', dayEndIso)
      .order('remind_at', { ascending: true }).limit(20),
  ]);
  for (const [label, res] of [
    ['active runs', activeRunsRes], ['completed runs', completedRunsRes], ['agent activity', agentRes], ['autopilot handled', autoDoneRes],
    ['recommendations', recsRes], ['money approvals', moneyApprovalsRes], ['chore sign-offs', choreSignoffRes],
    ['todos due', todosDueRes], ['chores due', choresDueRes], ['reminders due', remindersDueRes],
  ] as const) {
    if (res.error) console.error(`[home] ${label} read failed`, res.error);
  }
  if (!aiApprovalsRes.ok) console.error('[home] pending AI approvals read failed', aiApprovalsRes.error);

  const activeRuns = (activeRunsRes.data ?? []) as WorkingRunRow[];
  const activePlanIds = activeRuns.map((r) => r.plan_id).filter((x): x is string => !!x);
  const { data: activeStepRows, error: activeStepError } = activePlanIds.length
    ? await supabase.from('ai_plan_steps').select('plan_id, status').eq('family_id', familyId).in('plan_id', activePlanIds)
    : { data: [] as WorkingStepRow[], error: null };
  if (activeStepError) console.error('[home] active run steps read failed', activeStepError);
  const workingRuns = workingRunsFrom(activeRuns, (activeStepRows ?? []) as WorkingStepRow[]);

  const completedItems = mergeCompletedByBubaly(
    (completedRunsRes.data ?? []) as CompletedRunRow[],
    [
      ...((agentRes.data ?? []) as AiActivityRow[]),
      ...((autoDoneRes.data ?? []) as { id: string; title: string; created_at: string }[])
        .map((s) => ({ id: s.id, title: s.title, detail: null, href: '/dashboard/autopilot', created_at: s.created_at })),
    ],
  );

  const aiApprovals = aiApprovalsRes.ok ? aiApprovalsRes.data : [];
  const recommendations = (recsRes.data ?? []) as (RecommendationRow & { body: string | null })[];
  const homeNeeds = buildHomeNeeds({
    approvals: (moneyApprovalsRes.data ?? []) as ParentApprovalRow[],
    renewals: [], documents: [], conflicts: [],
    pendingApprovals: choreSignoffRes.count ?? 0,
    overdueMeds: false,
    overdueReminders: overdueReminders ?? 0,
    dueTodayReminders: 0,
    pendingChores: 0, lowGrocery: false, openTodos: 0,
    now,
    aiApprovals: aiApprovals.map((a) => ({ id: a.id, title: a.title, runId: a.runId, priority: a.priority ?? null, requestedAt: a.requestedAt, expiresAt: a.expiresAt })),
    awaitingRuns: activeRuns as AwaitingRunRow[],
    recommendations,
  });
  const needs = topNeeds(homeNeeds, 5);
  const needsHeader = needsHeadline(summarizeNeeds(homeNeeds));

  const choresDue = (choresDueRes.data ?? []) as TodayChoreRow[];
  const missingChoreIds = [...new Set(choresDue.map((c) => c.chore_id).filter((id) => !choreTitleById.has(id)))];
  if (missingChoreIds.length) {
    const { data: moreChores, error: moreChoresError } = await supabase.from('chores').select('id, title').in('id', missingChoreIds).eq('family_id', familyId);
    if (moreChoresError) console.error('[home] chore titles read failed', moreChoresError);
    for (const c of moreChores ?? []) choreTitleById.set(c.id, c.title);
  }
  const today = buildToday({
    events: ((todayEvents ?? []) as TodayEventRow[]),
    todos: (todosDueRes.data ?? []) as TodayTodoRow[],
    chores: choresDue,
    reminders: (remindersDueRes.data ?? []) as TodayReminderRow[],
    choreTitles: Object.fromEntries(choreTitleById),
    todayKey, tz, now,
  });

  // R11 — the category metric: how much family admin the system removed this week.
  const timeSaved = await loadTimeSaved(supabase, familyId, now);

  // Setup nudge — the ONLY route into /dashboard/setup (the re-onboarding
  // surface was otherwise unreachable). Managers only, and gated cheaply: one
  // indexed read of the lifecycle row skips everything for completed accounts;
  // the full completeness resolve runs only for the needs-setup / reset cohort.
  // Degrades to "no nudge" pre-migration.
  let setupNudge: { score: number; headline: string } | null = null;
  if (isManager(me.role)) {
    try {
      const adminClient = createServiceClient();
      const progress = await getOnboardingProgress(adminClient, ctx.user.id);
      if (progress?.status !== 'completed') {
        const { result } = await resolveCompleteness(adminClient, ctx.user.id, familyId);
        if (!result.isComplete) setupNudge = { score: result.score, headline: result.headline };
      }
    } catch { /* onboarding_progress not migrated yet → no nudge */ }
  }

  return (
    <div className="space-y-6 pb-28">
      {/* Header: greeting + quick actions */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-black sm:text-3xl">
            {roleGreeting(me.role, myFirstName, dayPhase(now))}
            {roleSurface(me.role).tone !== 'kid' && <span aria-hidden> 👋</span>}
          </h1>
          <p className="mt-1 text-sm text-muted">{tr('home.hereAposSWhatAposS')}</p>
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

      {/* Finish-setup nudge → /dashboard/setup (needs-setup / reset cohort). */}
      {setupNudge && (
        <Link
          href="/dashboard/setup"
          className="flex items-center gap-3 rounded-2xl border border-brand/30 bg-brand/5 px-4 py-3 transition hover:border-brand/50 hover:bg-brand/10"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
            <Rocket className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{setupNudge.headline}</span>
            <span className="block text-xs text-muted">{tr('home.aCoupleOfQuickQuestionsTailor')}</span>
          </span>
          <span className="hidden shrink-0 items-center gap-2 sm:flex">
            <span className="rounded-full bg-brand/15 px-2.5 py-1 text-xs font-bold text-brand-text tabular-nums">{setupNudge.score}{tr('home.setUp')}</span>
            <ArrowRight className="h-4 w-4 text-muted" />
          </span>
        </Link>
      )}

      {/* R6 — intent-based entry, made primary: one NL bar routes to the reasoning
          engine ("plan Emma's party"), a page, or the assistant. */}
      <AskBar />

      {/* §16 Command Center: what needs a person, what Bubaly is doing, the
          family's day, what is coming, and what Bubaly finished. */}
      <NeedsAttention
        items={needs.shown}
        more={needs.more}
        headline={needsHeader}
        approvals={Object.fromEntries(aiApprovals.map((a) => [a.id, a]))}
        moneyApprovalKinds={Object.fromEntries(((moneyApprovalsRes.data ?? []) as ParentApprovalRow[]).map((a) => [a.id, a.kind]))}
        recommendationBodies={Object.fromEntries(recommendations.map((r) => [r.id, r.body]))}
        canDecide={manager}
      />

      <WorkingOn familyId={familyId} initial={workingRuns} />

      <Card>
        <CardHead icon={Clock} title={tr('home.today')} href="/dashboard/calendar" action="View calendar" />
        {today.schedule.length === 0 && today.tasks.length === 0 && <EmptyRow>{tr('home.aClearDayNothingScheduledAnd')}</EmptyRow>}
        {today.schedule.length > 0 && (
          <ul className="space-y-3" aria-label={i18nT('home.todaysSchedule')}>
            {today.schedule.map((item) => {
              const who = item.memberId ? memberById.get(item.memberId) : undefined;
              return (
                <li key={item.key}>
                  <Link href={item.href} className="flex min-h-[44px] gap-3 rounded-xl focus-ring">
                    <div className="w-16 shrink-0 text-xs font-semibold text-brand-text">{item.allDay ? 'All day' : fmtTime(item.at)}</div>
                    <div className="min-w-0 flex-1 border-l border-border pl-3">
                      <p className="truncate text-sm font-semibold">{item.title}</p>
                      <p className="truncate text-xs text-muted">{item.kind === 'reminder' ? 'Reminder' : 'Event'}{who ? ` · ${firstName(who.display_name)}` : ''}</p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {today.tasks.length > 0 && (
          <ul className={cn('space-y-2.5', today.schedule.length > 0 && 'mt-4 border-t border-border pt-4')} aria-label={tr('home.dueToday')}>
            {today.tasks.map((item) => {
              const who = item.memberId ? memberById.get(item.memberId) : undefined;
              const overdue = item.bucket === 'overdue';
              return (
                <li key={item.key}>
                  <Link href={item.href} className="flex min-h-[44px] items-center gap-3 rounded-xl focus-ring">
                    <span className={cn('h-4 w-4 shrink-0 rounded-full border-2', overdue ? 'border-rose-400/70' : 'border-emerald-400/60')} aria-hidden />
                    <p className="min-w-0 flex-1 truncate text-sm">{item.title}</p>
                    <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold', overdue ? 'bg-rose-500/15 text-rose-400' : 'bg-amber-500/15 text-amber-400')}>{item.reason}</span>
                    {who && <Avatar name={who.display_name} color={who.color ?? undefined} size={22} className="shrink-0 rounded-full" />}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHead icon={CalendarDays} title={tr('home.comingUp')} href="/dashboard/calendar" action="View calendar" />
        <div className="space-y-2.5">
          {(upcomingEvents ?? []).length === 0 && <EmptyRow>{tr('home.nothingOnTheHorizonYet')}</EmptyRow>}
          {((upcomingEvents ?? []) as { id: string; title: string; starts_at: string; all_day: boolean; assignee_id: string | null }[]).map((e) => {
            const d = new Date(e.starts_at);
            const owner = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
            return (
              <Link key={e.id} href="/dashboard/calendar" className="flex min-h-[44px] items-center gap-3 rounded-xl focus-ring">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-elevated text-center">
                  <span className="text-[9px] font-bold uppercase text-muted leading-none">{d.toLocaleDateString('en-US', { month: 'short' })}</span>
                  <span className="text-sm font-black leading-none">{d.getDate()}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{e.title}</p>
                  <p className="truncate text-xs text-muted">{e.all_day ? 'All day' : fmtTime(e.starts_at)}</p>
                </div>
                {owner && <Avatar name={owner.display_name} color={owner.color ?? undefined} size={24} className="shrink-0 rounded-full" />}
              </Link>
            );
          })}
        </div>
      </Card>

      <CompletedByBubaly items={completedItems} />

      {/* R11 — the category metric: "N hours saved this week" */}
      <TimeSavedBanner data={timeSaved} />

      {/* Time-of-day "Focus now" strip — surfaces what matters at this hour
          (morning: schedule/weather/school · night: tomorrow/prep/reflect). */}
      <TimeOfDayFocus role={me.role} />

      {/* Anticipatory "Get ready" banner — the next imminent moment's prep, or
          nothing when the horizon is clear. See /dashboard/moments. */}
      <HomeMomentCard />

      {/* Delight: today's memories from past years, or nothing on an ordinary day. */}
      <OnThisDayCard />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* My Family */}
        <Card className="lg:col-span-2">
          <CardHead icon={Sparkles} title={tr('home.myFamily')} href="/dashboard/family-tree" />
          <div className="flex flex-wrap gap-5">
            {memberList.map((m) => (
              <div key={m.id} className="flex w-16 flex-col items-center gap-1.5 text-center">
                <Avatar name={m.display_name} color={m.color ?? undefined} size={52} className="rounded-full" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold">{firstName(m.display_name)}</p>
                  <p className="truncate text-[10px] text-muted">{memberTagline(m, ctx.user.id, now)}</p>
                </div>
              </div>
            ))}
            <Link href="/dashboard/settings#members" className="flex w-16 flex-col items-center gap-1.5 text-center text-muted hover:text-brand-text">
              <span className="grid h-[52px] w-[52px] place-items-center rounded-full border border-dashed border-border"><Plus className="h-5 w-5" /></span>
              <span className="text-[10px]">{tr('home.invite')}</span>
            </Link>
          </div>
        </Card>

        {/* Family Score */}
        <Card>
          <CardHead icon={Sparkles} title={tr('home.familyScore')} href="/dashboard/readiness" action="View insights" />
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

        {/* Tasks */}
        <Card>
          <CardHead icon={ListChecks} title={tr('home.tasks')} href="/dashboard/todos" />
          <div className="space-y-2.5">
            {(tasks ?? []).length === 0 && <EmptyRow>{tr('home.noOpenTasksNicelyDone')}</EmptyRow>}
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
          <Link href="/dashboard/todos" className="mt-3 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-semibold text-muted transition hover:text-brand-text">
            <Plus className="h-3.5 w-3.5" /> {tr('home.addANewTask')}
          </Link>
        </Card>

        {/* What's for Dinner */}
        <Card>
          <CardHead icon={ChefHat} title={i18nT('home.whatsForDinner')} href="/dashboard/meals" action="View meal plan" />
          <div className="flex-1">
            {todayMeal ? (
              <div>
                <p className="text-base font-bold">{todayMeal.name}</p>
                {todayMeal.notes && <p className="mt-0.5 text-xs text-muted line-clamp-2">{todayMeal.notes}</p>}
              </div>
            ) : (
              <EmptyRow>{tr('home.noDinnerPlannedForToday')}</EmptyRow>
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
          <CardHead icon={ClipboardCheck} title={tr('home.chores')} href="/dashboard/chores" />
          <div className="space-y-2.5">
            {(choreRows ?? []).length === 0 && <EmptyRow>{tr('home.noChoresAssigned')}</EmptyRow>}
            {choreList.map((c) => {
              const owner = memberById.get(c.member_id);
              const done = c.status === 'approved';
              return (
                <div key={c.id} className="flex items-center gap-3">
                  <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full border-2', done ? 'border-emerald-400 bg-emerald-400/20 text-emerald-400' : 'border-muted/50')}>
                    {done && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <p className={cn('min-w-0 flex-1 truncate text-sm', done && 'text-muted line-through')}>{choreTitleById.get(c.chore_id) ?? 'Chore'}</p>
                  {owner && <span className="shrink-0 text-xs text-muted">{firstName(owner.display_name)}</span>}
                </div>
              );
            })}
          </div>
          <Link href="/dashboard/chores" className="mt-3 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-semibold text-muted transition hover:text-brand-text">
            <Plus className="h-3.5 w-3.5" /> {tr('home.addAChore')}
          </Link>
        </Card>

        {/* Family Finances */}
        <Card>
          <CardHead icon={DollarSign} title={tr('home.familyFinances')} href="/dashboard/billing" action="View finances" />
          <p className="text-xs text-muted">{tr('home.thisMonth')} {monthStart.toLocaleDateString('en-US', { month: 'long' })}</p>
          <div className="mt-3 flex items-center gap-4">
            <FinanceDonut income={finances.income} expenses={finances.expenses} remaining={finances.remaining} />
            <div className="flex-1 space-y-2 text-sm">
              <Row label={tr('home.totalIncome')} value={usd(finances.income)} valueClass="text-emerald-400" />
              <Row label={tr('home.totalExpenses')} value={usd(finances.expenses)} valueClass="text-rose-400" />
              <Row label={tr('home.remaining')} value={usd(finances.remaining)} valueClass="text-brand-text font-bold" />
            </div>
          </div>
        </Card>

        {/* Recent Memories */}
        <Card className="lg:col-span-2">
          <CardHead icon={ImageIcon} title={tr('home.recentMemories')} href="/dashboard/memories" action="View all memories" />
          {(photos ?? []).length === 0 ? (
            <EmptyRow>{tr('home.noMemoriesYetCaptureYourFirst')}</EmptyRow>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {((photos ?? []) as { id: string; url: string | null; thumbnail_url: string | null; caption: string | null; taken_at: string | null; created_at: string }[]).map((p) => {
                const src = p.thumbnail_url || p.url;
                const when = new Date(p.taken_at || p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                return (
                  <Link key={p.id} href="/dashboard/memories" className="group relative aspect-square overflow-hidden rounded-xl bg-elevated">
                    {src
                      ? <Image src={src} alt={p.caption ?? 'Family memory'} fill sizes="(max-width: 640px) 50vw, 25vw" className="object-cover transition group-hover:scale-105" />
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
          <CardHead icon={MessageCircle} title={tr('home.familyMessages')} href="/dashboard/messages" />
          <div className="space-y-3">
            {msgs.length === 0 && <EmptyRow>{tr('home.noMessagesYet')}</EmptyRow>}
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
