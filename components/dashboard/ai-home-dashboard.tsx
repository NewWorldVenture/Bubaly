import Link from 'next/link';
import {
  Sparkles, Calendar, CheckSquare, ShoppingCart, HeartPulse,
  ArrowRight, Bell, ChevronRight, Home, Pill, GraduationCap,
  Trophy, Sun, Clock, Users, MessageSquare, Plane, PhoneCall, AlarmClock, RefreshCw, CalendarClock,
} from 'lucide-react';
import { createServer } from '@/lib/supabase/server';
import type { UserContext } from '@/lib/supabase/auth';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { fmtTime } from '@/lib/utils/format';
import { Rocket, Gauge, ShieldCheck } from 'lucide-react';
import { successProbability } from '@/lib/autopilot/engine';
import { planLevel } from '@/lib/constants/plans';
import { tierForPlanLevel, FIXED_FEATURES } from '@/lib/dashboard/registry';
import { resolvePrimary, availableFeatures, lockedFeatures } from '@/lib/dashboard/layout';
import { normalizeSettings, canCustomizeDashboard, effectiveSavedKeys } from '@/lib/dashboard/permissions';
import { DashboardQuickActions } from '@/components/dashboard/quick-actions';
import { HomeAskBar } from '@/components/dashboard/home-ask-bar';
import { Heart } from 'lucide-react';
import { upcomingRelationship, formatCountdown, milestoneLabel, type RelKind } from '@/lib/relationship/dates';
import { reminderAttention } from '@/lib/dashboard/reminder-attention';
import { mergeUpcoming } from '@/lib/dashboard/upcoming';
import { topNeeds, summarizeNeeds, needsHeadline, type NeedItem } from '@/lib/home/needs-attention';
import { parentApprovalToNeed, renewalToNeed, type ParentApprovalRow, type RenewalRow } from '@/lib/home/needs-sources';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Render metadata (icon + accent + CTA + fallback subtitle) per NeedItem.kind.
type NeedRenderMeta = { icon: React.ComponentType<{ className?: string }>; iconBg: string; cta: string; subtitle: string };
const NEED_META: Record<string, NeedRenderMeta> = {
  approval: { icon: ShieldCheck, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', subtitle: 'A family member is waiting on your approval.' },
  calendar_conflict: { icon: CalendarClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Resolve', subtitle: 'Two events are double-booked.' },
  renewal: { icon: RefreshCw, iconBg: 'bg-orange-500/15 text-orange-400', cta: 'Renew', subtitle: 'Renew it before it lapses.' },
  chore_signoff: { icon: CheckSquare, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', subtitle: 'Chores are waiting for your sign-off.' },
  reminder_overdue: { icon: AlarmClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Catch up', subtitle: 'These were due earlier.' },
  meds: { icon: Pill, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'View', subtitle: 'Check the medication schedule.' },
  reminder_today: { icon: Bell, iconBg: 'bg-sky-500/15 text-sky-400', cta: 'View', subtitle: 'Coming up today.' },
  chores_todo: { icon: CheckSquare, iconBg: 'bg-violet-500/15 text-violet-400', cta: 'View', subtitle: 'Keep the momentum going.' },
  grocery: { icon: ShoppingCart, iconBg: 'bg-emerald-500/15 text-emerald-400', cta: 'Update', subtitle: 'Items may be running low.' },
  todos: { icon: CheckSquare, iconBg: 'bg-teal-500/15 text-teal-400', cta: 'View', subtitle: 'Personal items waiting for you.' },
};
const DEFAULT_NEED_META: NeedRenderMeta = { icon: Bell, iconBg: 'bg-brand/15 text-brand', cta: 'View', subtitle: '' };

/**
 * The unified Home "Needs you" decision queue: unions every cross-domain item
 * actually waiting on the family — money approvals, renewals due, chore
 * sign-offs, overdue/today reminders, meds, plus lighter to-dos — into one
 * ranked list (urgency then recency via rankNeedsAttention). Replaces the old
 * scattered ad-hoc cards so the family checks ONE place, not six.
 */
function buildHomeNeeds(data: {
  approvals: ParentApprovalRow[];
  renewals: RenewalRow[];
  conflicts: { id: string; assigneeName: string | null; count: number; startsAt: string }[];
  pendingApprovals: number;
  overdueMeds: boolean;
  overdueReminders: number;
  dueTodayReminders: number;
  pendingChores: number;
  lowGrocery: boolean;
  openTodos: number;
  now: Date;
}): NeedItem[] {
  const items: NeedItem[] = [];
  const nowIso = data.now.toISOString();
  const plural = (n: number) => (n > 1 ? 's' : '');

  for (const a of data.approvals) items.push(parentApprovalToNeed(a));
  for (const r of data.renewals) { const n = renewalToNeed(r, data.now); if (n) items.push(n); }
  for (const c of data.conflicts)
    items.push({
      id: `conflict:${c.id}`, kind: 'calendar_conflict',
      title: c.assigneeName ? `${c.assigneeName}: ${c.count} events overlap` : `${c.count} events overlap`,
      href: '/dashboard/calendar', urgency: 'urgent', createdAt: c.startsAt,
    });

  if (data.pendingApprovals > 0)
    items.push({ id: 'chore-signoff', kind: 'chore_signoff', title: `${data.pendingApprovals} chore${plural(data.pendingApprovals)} awaiting approval`, href: '/dashboard/chores', urgency: 'urgent', createdAt: nowIso });
  if (data.overdueMeds)
    items.push({ id: 'meds', kind: 'meds', title: 'Medication due today', href: '/dashboard/medications', urgency: 'urgent', createdAt: nowIso });
  if (data.overdueReminders > 0)
    items.push({ id: 'reminders-overdue', kind: 'reminder_overdue', title: `${data.overdueReminders} reminder${plural(data.overdueReminders)} overdue`, href: '/dashboard/reminders', urgency: 'urgent', createdAt: nowIso });
  else if (data.dueTodayReminders > 0)
    items.push({ id: 'reminders-today', kind: 'reminder_today', title: `${data.dueTodayReminders} reminder${plural(data.dueTodayReminders)} due today`, href: '/dashboard/reminders', urgency: 'normal', createdAt: nowIso });
  if (data.pendingChores > 0)
    items.push({ id: 'chores-todo', kind: 'chores_todo', title: `${data.pendingChores} task${plural(data.pendingChores)} to do today`, href: '/dashboard/chores', urgency: 'normal', createdAt: nowIso });
  if (data.lowGrocery)
    items.push({ id: 'grocery', kind: 'grocery', title: 'Grocery list needs updating', href: '/dashboard/grocery', urgency: 'normal', createdAt: nowIso });
  if (data.openTodos > 0)
    items.push({ id: 'todos', kind: 'todos', title: `${data.openTodos} to-do item${plural(data.openTodos)} open`, href: '/dashboard/todos', urgency: 'normal', createdAt: nowIso });

  return items;
}

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
    { data: layoutRows },
    { data: walletSub },
    { data: relDateRows },
    { data: dueReminderRows },
    { data: weekReminderRows },
    { data: approvalRows },
    { data: renewalRows },
    { data: conflictEventRows },
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
    supabase.from('dashboard_layouts').select('feature_keys, scope, user_id')
      .eq('family_id', familyId).is('deleted_at', null).in('scope', ['user', 'family']),
    supabase.from('subscriptions').select('plan, status').eq('family_id', familyId).in('status', ['active', 'trialing']).maybeSingle(),
    supabase.from('relationship_dates').select('id, kind, title, event_date, recurs_annually, reminder_days_before, status')
      .eq('family_id', familyId).neq('status', 'cancelled').limit(100),
    supabase.from('family_reminders').select('id, remind_at, status')
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null)
      .or(`member_id.eq.${myMemberId},member_id.is.null`)
      .lte('remind_at', todayEnd.toISOString()).limit(100),
    supabase.from('family_reminders').select('id, title, remind_at')
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null)
      .or(`member_id.eq.${myMemberId},member_id.is.null`)
      .gt('remind_at', todayEnd.toISOString())
      .lte('remind_at', new Date(Date.now() + 7 * 86400000).toISOString())
      .order('remind_at').limit(10),
    // Money decisions waiting on a parent (wallet/cards/allowance) — managers only.
    manager
      ? supabase.from('parent_approvals').select('id, kind, amount_cents, created_at')
          .eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(20)
      : Promise.resolve({ data: [] }),
    // Renewals approaching/expired so they surface on Home, not just in their module.
    supabase.from('renewals').select('id, title, expires_at, reminder_days, status, created_at')
      .eq('family_id', familyId).in('status', ['active', 'expired'])
      .lte('expires_at', new Date(Date.now() + 45 * 86400000).toISOString()).limit(50),
    // Upcoming assigned events (next 14d) → detect personal double-bookings.
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id')
      .eq('family_id', familyId).not('assignee_id', 'is', null)
      .gte('starts_at', todayStart.toISOString())
      .lte('starts_at', new Date(Date.now() + 14 * 86400000).toISOString())
      .order('starts_at').limit(200),
  ]);

  // Soonest relationship date inside its reminder window (gentle proactive nudge).
  const relReminder = upcomingRelationship(
    ((relDateRows ?? []) as { id: string; kind: RelKind; title: string; event_date: string; recurs_annually: boolean; reminder_days_before: number; status: string }[])
      .map((d) => ({ id: d.id, kind: d.kind, title: d.title, eventDate: d.event_date, recursAnnually: d.recurs_annually, reminderDaysBefore: d.reminder_days_before, status: d.status })),
  )[0];

  const openSuggestions = (autopilotOpen ?? []) as { id: string; title: string; detail: string | null; kind: string; urgency: number; confidence: number }[];
  const concierge = (activeConcierge ?? []) as { id: string; title: string; kind: string; status: string }[];
  const autopilotProbability = successProbability(openSuggestions.map((s) => ({ urgency: s.urgency as 1 | 2 | 3, confidence: s.confidence } as never)));
  const autopilotHandled = autopilotHandledCount ?? 0;
  const topSuggestions = openSuggestions.slice(0, 3);
  const showAutopilot = openSuggestions.length > 0 || autopilotHandled > 0;

  // ── Customizable, tier-aware quick actions ──
  const { data: dashSettingsRow } = await supabase
    .from('family_dashboard_settings').select('allow_child_customization, lock_to_family_default').eq('family_id', familyId).maybeSingle();
  const dashSettings = normalizeSettings(dashSettingsRow ? { allowChildCustomization: dashSettingsRow.allow_child_customization, lockToFamilyDefault: dashSettingsRow.lock_to_family_default } : null);
  // Super-admins are fully unlocked everywhere — no plan gating on Quick Access
  // (every tile available, nothing locked, no "Unlock more"), matching the nav
  // which already treats super-admins as having access to everything.
  const superAdmin = await isSuperAdmin();
  const dashTier = superAdmin ? 'plus' : tierForPlanLevel(planLevel(walletSub?.plan ?? null));
  const layouts = (layoutRows ?? []) as { feature_keys: string[]; scope: string; user_id: string | null }[];
  const myLayout = layouts.find((l) => l.scope === 'user' && l.user_id === ctx.user.id);
  const familyLayout = layouts.find((l) => l.scope === 'family');
  const savedKeys = effectiveSavedKeys(myLayout?.feature_keys ?? null, familyLayout?.feature_keys ?? null, dashSettings);
  const primaryButtons = resolvePrimary(savedKeys, dashTier);
  const primaryKeys = primaryButtons.map((f) => f.key);
  const availableButtons = availableFeatures(dashTier);
  const lockedButtons = lockedFeatures(dashTier);
  const canCustomize = canCustomizeDashboard(manager, dashSettings);

  const { overdue: overdueReminders, dueToday: dueTodayReminders } = reminderAttention(
    (dueReminderRows ?? []) as { remind_at: string | null; status: string }[], now,
  );

  // Personal double-bookings: detect per-assignee overlaps; a manager sees the
  // whole family's, everyone else just their own.
  const memberNameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const homeConflicts = detectConflicts((conflictEventRows ?? []) as ConflictEvent[])
    .filter((c) => manager || c.assigneeId === myMemberId)
    .map((c) => ({ id: c.eventIds[0], assigneeName: memberNameById.get(c.assigneeId) ?? null, count: c.eventIds.length, startsAt: c.startsAt }));

  const homeNeeds = buildHomeNeeds({
    approvals: (approvalRows ?? []) as ParentApprovalRow[],
    renewals: (renewalRows ?? []) as RenewalRow[],
    conflicts: homeConflicts,
    pendingApprovals: pendingApprovals ?? 0,
    overdueMeds: (overdueMedsCount ?? 0) > 0,
    overdueReminders,
    dueTodayReminders,
    pendingChores: pendingChores ?? 0,
    lowGrocery: (groceryCount ?? 0) > 0,
    openTodos: openTodos ?? 0,
    now,
  });
  const needs = topNeeds(homeNeeds, 5);
  const needsHeader = needsHeadline(summarizeNeeds(homeNeeds));

  const name = me.display_name ?? ctx.user.email?.split('@')[0] ?? 'there';
  const hasEvents = (todayEvents ?? []).length > 0;

  // "Coming Up" merges this week's calendar events and timed reminders.
  const upcomingItems = mergeUpcoming(
    (upcomingEvents ?? []) as { id: string; title: string; starts_at: string; all_day: boolean }[],
    (weekReminderRows ?? []) as { id: string; title: string; remind_at: string | null }[],
    5,
  );
  const hasUpcoming = upcomingItems.length > 0;

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

      {/* Ask-anything bar → deep-links to the assistant (auto-sends) */}
      <HomeAskBar />

      {/* Relationship reminder — gentle proactive nudge for an upcoming date */}
      {relReminder && (
        <Link href="/dashboard/relationship"
          className="flex items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 transition hover:bg-rose-500/10">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-500/15 text-rose-300"><Heart className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{relReminder.title} {formatCountdown(relReminder.days).toLowerCase()}</p>
            <p className="truncate text-xs text-muted">{milestoneLabel(relReminder) ?? 'Plan something special'} · tap for gift ideas</p>
          </div>
          <Sparkles className="h-4 w-4 shrink-0 text-rose-300" />
        </Link>
      )}

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

      {/* Needs you — the single, ranked cross-domain decision queue */}
      {needs.shown.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Needs you</h2>
          </div>
          <p className="-mt-1 text-sm text-fg/80">{needsHeader}</p>
          <div className="space-y-2.5">
            {needs.shown.map((item) => {
              const meta = NEED_META[item.kind] ?? DEFAULT_NEED_META;
              const Icon = meta.icon;
              const urgent = item.urgency === 'urgent' || item.urgency === 'emergency';
              return (
                <Link key={item.id} href={item.href}
                  className={cn(
                    'flex items-center gap-4 rounded-2xl border p-4 transition hover:bg-elevated',
                    urgent ? 'border-amber-500/20 bg-amber-500/5' : 'border-border bg-surface/40',
                  )}>
                  <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', meta.iconBg)}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{item.title}</p>
                    {meta.subtitle && <p className="mt-0.5 truncate text-xs text-muted">{meta.subtitle}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1 text-xs font-semibold text-brand">
                    {meta.cta} <ChevronRight className="h-3.5 w-3.5" />
                  </div>
                </Link>
              );
            })}
          </div>
          {needs.more > 0 && (
            <p className="text-xs text-muted">+{needs.more} more {needs.more === 1 ? 'item' : 'items'} need you.</p>
          )}
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
            {upcomingItems.map((item) => (
              <Link key={item.key} href={item.kind === 'reminder' ? '/dashboard/reminders' : '/dashboard/calendar'}
                className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5 transition hover:bg-elevated">
                {item.kind === 'reminder'
                  ? <Bell className="h-4 w-4 shrink-0 text-sky-400" />
                  : <Calendar className="h-4 w-4 shrink-0 text-muted" />}
                <span className="flex-1 truncate text-sm">{item.title}</span>
                <span className="text-xs text-muted">
                  {item.allDay
                    ? new Date(item.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : new Date(item.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Customizable, tier-aware quick actions */}
      <DashboardQuickActions
        fixed={FIXED_FEATURES}
        primaryKeys={primaryKeys}
        available={availableButtons}
        locked={lockedButtons}
        canCustomize={canCustomize}
        canManage={manager}
        settings={dashSettings}
      />

      {/* Empty state when no cards */}
      {homeNeeds.length === 0 && !hasEvents && (
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
